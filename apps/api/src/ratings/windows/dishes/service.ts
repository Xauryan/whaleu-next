import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.js';
import { IdentityService } from '../../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../../safety/locks.js';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import {
  DishReviewFacade,
  dishIdentity,
} from '../../../community/content-review/dish-review.facade.js';
import { ApplicationError } from '../../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../../database/transaction-deadlines.js';
import { catalogSource } from '../proof.js';
import {
  dishPageSchema,
  dishOwnSchema,
  dishReceiptSchema,
} from './contracts.js';
import type {
  DishQuery,
  DishCommand,
  DishReceipt,
  DishOperation,
  DishCancel,
} from './contracts.js';
import { dishSource, dishEpoch, retainDishes } from './proof.js';
import { DishCursors, dishCursorScope } from './cursor.js';
export function dishIntentHash(
  actorId: string,
  windowId: string,
  operation: DishOperation,
  command: DishCommand,
) {
  return createHash('sha256')
    .update(
      'whaleu:window-dish-command:v1\n' +
        canonicalJson({ actorId, windowId, operation, command }),
    )
    .digest('hex');
}
interface Own {
  id: string;
  active: boolean;
  recorded_at: Date;
  catalog_id: string;
  window_revision: string;
}
@Injectable()
export class DishRecommendationsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(DishReviewFacade) private readonly review: DishReviewFacade,
    @Inject(DishCursors) private readonly cursors: DishCursors,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db
      .transaction(f, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error && error.constraint === 'dish_causal'))
        )
          throw new ApplicationError('DISH_HISTORY_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    return this.identity.session(token, tx);
  }
  private async eligible(actor: string, tx: PoolClient) {
    const phone = await this.verification.phone(actor, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(actor, tx);
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  private async membership(
    actor: string,
    id: string,
    name: string,
    tx: PoolClient,
  ) {
    return (
      await tx.query<Own>(
        `SELECT e.id,e.active,e.recorded_at,coalesce(e.catalog_id,p.catalog_id) catalog_id,coalesce(e.window_revision,p.window_revision) window_revision FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision LEFT JOIN whaleu_ratings.dish_events p ON p.id=e.previous_revision WHERE h.actor_id=$1 AND h.window_id=$2 AND h.name_bytes=convert_to($3,'UTF8')`,
        [actor, id, name],
      )
    ).rows[0];
  }
  private async history(id: string, tx: PoolClient) {
    const row = (
      await tx.query<{ history: string | null; until: string | null }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.dish_history($1,'membership',instant.now)::text history,(SELECT min(boundary.value)::text FROM whaleu_ratings.dish_history_heads h JOIN whaleu_ratings.dish_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.window_id=$1 AND h.kind='membership' AND boundary.value>instant.now) until FROM instant`,
        [id],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(tx, row.until, 'DISH_HISTORY_UNAVAILABLE');
    return row.history;
  }
  own(token: string, id: string, name: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        epoch = await dishEpoch(tx),
        own = await this.membership(session.accountId, id, name, tx),
        history = own ? null : await this.history(id, tx);
      await retainDishes(session.accountId, session.sessionId, id, tx, {
        epoch,
        ...(history ? { history } : {}),
      });
      await this.identity.session(token, tx);
      return dishOwnSchema.parse(
        own
          ? {
              kind: 'recorded',
              active: own.active,
              revision: own.id,
              recordedAt: own.recorded_at.toISOString(),
              catalogRevision: own.catalog_id,
              windowRevision: own.window_revision,
            }
          : { kind: history ? 'not_recommended' : 'unavailable' },
      );
    });
  }
  page(token: string, id: string, query: DishQuery) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        access = await this.eligible(session.accountId, tx),
        catalog = await catalogSource(tx),
        source = await dishSource(id, tx),
        epoch = await dishEpoch(tx);
      const scope = dishCursorScope([
        'window-dishes-v1',
        session.accountId,
        session.sessionId,
        id,
        access,
        catalog,
        source,
        epoch,
        query.limit,
      ]);
      const after = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx)
        : null;
      // Bounded complete candidate scan, never a truncated aggregate. One exact
      // instant captures all positive/negative visibility and future boundaries.
      const snapshot = (
        await tx.query<{
          candidates: { name: string; identity: string; status: string }[];
          until: string | null;
        }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now),candidates AS MATERIALIZED(SELECT e.id,e.dish_name name,encode(e.name_bytes,'hex') identity FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision WHERE h.window_id=$1 AND e.active ORDER BY e.id LIMIT 1001) SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('name',c.name,'identity',c.identity,'status',whaleu_ratings.dish_visibility(c.id,instant.now)) ORDER BY c.id) FROM candidates c),'[]'::jsonb) candidates,whaleu_ratings.dish_deadline($1,instant.now)::text until FROM instant`,
          [id],
        )
      ).rows[0]!;
      if (snapshot.candidates.length > 1000)
        throw new ApplicationError('DISH_BUDGET_UNAVAILABLE');
      if (snapshot.candidates.some((c) => c.status === 'unavailable'))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      registerTransactionExactDeadline(
        tx,
        snapshot.until,
        'DISH_HISTORY_UNAVAILABLE',
      );
      const groups = new Map<
        string,
        { dishName: string; dishIdentity: string; recommendationCount: number }
      >();
      for (const c of snapshot.candidates)
        if (c.status === 'allow') {
          const current = groups.get(c.identity);
          if (current) current.recommendationCount++;
          else
            groups.set(c.identity, {
              dishName: c.name,
              dishIdentity: c.identity,
              recommendationCount: 1,
            });
        }
      const ranked = [...groups.values()].sort(
        (a, b) =>
          b.recommendationCount - a.recommendationCount ||
          (a.dishIdentity < b.dishIdentity
            ? -1
            : a.dishIdentity > b.dishIdentity
              ? 1
              : 0),
      );
      const remaining = after
        ? ranked.filter(
            (c) =>
              c.recommendationCount < after.count ||
              (c.recommendationCount === after.count &&
                c.dishIdentity > after.identity),
          )
        : ranked;
      const more = remaining.length > query.limit,
        chosen = remaining.slice(0, query.limit),
        last = chosen.at(-1);
      const owns = (
        await tx.query<{ identity: string; id: string; active: boolean }>(
          `SELECT encode(h.name_bytes,'hex') identity,e.id,e.active FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision WHERE h.window_id=$1 AND h.actor_id=$2 AND encode(h.name_bytes,'hex')=ANY($3::text[])`,
          [id, session.accountId, chosen.map((c) => c.dishIdentity)],
        )
      ).rows;
      const nextCursor =
        more && last
          ? await this.cursors.create(
              session.accountId,
              scope,
              {
                v: 1,
                kind: 'window-dishes-v1',
                identity: last.dishIdentity,
                count: last.recommendationCount,
                validUntil: snapshot.until,
              },
              tx,
            )
          : null;
      await retainDishes(session.accountId, session.sessionId, id, tx, {
        source,
        catalog,
        epoch,
      });
      await this.identity.session(token, tx);
      return dishPageSchema.parse({
        windowId: id,
        catalogRevision: source.catalog,
        windowRevision: source.revision,
        membershipRevision: epoch.membership,
        items: chosen.map((c) => {
          const own = owns.find((o) => o.identity === c.dishIdentity);
          return {
            ...c,
            isRecommended: own?.active ?? false,
            myMembershipRevision: own?.id ?? null,
          };
        }),
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  private async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_ratings.dish_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  private async record(
    actor: string,
    session: string,
    id: string,
    operation: DishOperation,
    command: DishCommand,
    receipt: DishReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_ratings.dish_commands(actor_id,request_id,session_id,window_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor,
        command.clientRequestId,
        session,
        id,
        operation,
        command,
        dishIntentHash(actor, id, operation, command),
        receipt,
      ],
    );
  }
  recommend(token: string, id: string, command: DishCommand) {
    return this.mutate(token, id, 'window.dish.recommend.v1', command, false);
  }
  retract(token: string, id: string, command: DishCommand) {
    return this.mutate(token, id, 'window.dish.retract.v1', command, false);
  }
  cancel(token: string, key: string, body: DishCancel) {
    if (key !== body.command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.mutate(
      token,
      body.windowId,
      body.operation,
      body.command,
      true,
    );
  }
  private mutate(
    token: string,
    id: string,
    operation: DishOperation,
    command: DishCommand,
    cancel: boolean,
  ) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId,
        hash = dishIntentHash(actor, id, operation, command);
      await tx.query('SELECT whaleu_ratings.dish_lock($1,$2,$3,$4)', [
        actor,
        command.clientRequestId,
        id,
        command.dishName,
      ]);
      const prior = await this.prior(actor, command.clientRequestId, tx);
      if (prior) {
        if (prior.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return dishReceiptSchema.parse(prior.receipt);
      }
      const add = operation === 'window.dish.recommend.v1',
        base = {
          requestId: command.clientRequestId,
          operation,
          windowId: id,
          dishIdentity: dishIdentity(command.dishName),
        };
      if (cancel) {
        const receipt: DishReceipt = {
          ...base,
          outcome: 'rejected',
          code: 'DISH_CANCELLED',
        };
        await this.record(
          actor,
          session.sessionId,
          id,
          operation,
          command,
          receipt,
          tx,
        );
        await this.identity.session(token, tx);
        return receipt;
      }
      const own = await this.membership(actor, id, command.dishName, tx);
      let source: Awaited<ReturnType<typeof dishSource>> | undefined,
        catalog: unknown,
        history: string | null = null;
      if (add) {
        await this.eligible(actor, tx);
        catalog = await catalogSource(tx);
        source = await dishSource(id, tx);
      } else if (!own) {
        history = await this.history(id, tx);
        if (!history) throw new ApplicationError('DISH_HISTORY_UNAVAILABLE');
      }
      let receipt: DishReceipt;
      if (
        source &&
        (source.catalog !== command.expectedCatalogRevision ||
          source.revision !== command.expectedWindowRevision)
      )
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'WINDOW_REVISION_CONFLICT',
        };
      else if ((own?.id ?? null) !== command.expectedMembershipRevision)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'DISH_MEMBERSHIP_REVISION_CONFLICT',
        };
      else if (add && own?.active)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'DISH_ALREADY_RECOMMENDED',
        };
      else if (!add && !own?.active)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'DISH_NOT_RECOMMENDED',
        };
      else {
        const decision = add
          ? await this.review.consume(
              {
                version: 1,
                purpose: 'window.dish.recommend.v1',
                actorId: actor,
                requestId: command.clientRequestId,
                windowId: id,
                catalogRevision: command.expectedCatalogRevision,
                windowRevision: command.expectedWindowRevision,
                dishName: command.dishName,
                dishIdentity: base.dishIdentity,
              },
              tx,
            )
          : null;
        if (decision?.status === 'reject')
          receipt = { ...base, outcome: 'rejected', code: 'CONTENT_REJECTED' };
        else {
          const revision = randomUUID(),
            event = (
              await tx.query<{ recorded_at: Date }>(
                'INSERT INTO whaleu_ratings.dish_events(id,window_id,actor_id,request_id,dish_name,previous_revision,active,catalog_id,window_revision,population_assertion_id,membership_assertion_id,review_decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING recorded_at',
                [
                  revision,
                  id,
                  actor,
                  command.clientRequestId,
                  command.dishName,
                  own?.id ?? null,
                  add,
                  source?.catalog ?? null,
                  source?.revision ?? null,
                  source?.population ?? null,
                  source?.membership ?? null,
                  decision?.decisionId ?? null,
                ],
              )
            ).rows[0]!;
          if (own)
            await tx.query(
              "UPDATE whaleu_ratings.dish_heads SET revision=$4 WHERE window_id=$1 AND actor_id=$2 AND name_bytes=convert_to($3,'UTF8')",
              [id, actor, command.dishName, revision],
            );
          else
            await tx.query(
              "INSERT INTO whaleu_ratings.dish_heads(window_id,actor_id,name_bytes,revision) VALUES($1,$2,convert_to($3,'UTF8'),$4)",
              [id, actor, command.dishName, revision],
            );
          receipt = {
            ...base,
            outcome: 'applied',
            active: add,
            membershipRevision: revision,
            recordedAt: event.recorded_at.toISOString(),
          };
        }
      }
      await this.record(
        actor,
        session.sessionId,
        id,
        operation,
        command,
        receipt,
        tx,
      );
      await retainDishes(actor, session.sessionId, id, tx, {
        ...(source ? { source, catalog } : {}),
        ...(history ? { history } : {}),
      });
      await this.identity.session(token, tx);
      return dishReceiptSchema.parse(receipt);
    });
  }
  receipt(token: string, key: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        prior = await this.prior(session.accountId, key, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return dishReceiptSchema.parse(prior.receipt);
    });
  }
}
