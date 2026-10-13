import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  windowDetailSchema,
  windowPageSchema,
  windowReceiptSchema,
} from './contracts.js';
import type {
  WindowQuery,
  WindowSetScore,
  WindowReceipt,
  WindowCancel,
} from './contracts.js';
import { WindowRepository } from './repository.js';
import { WindowCursors, windowCursorScope } from './cursor.js';
import {
  catalogSource,
  windowSource,
  windowEpoch,
  retainWindows,
} from './proof.js';
export function windowIntentHash(
  actorId: string,
  windowId: string,
  command: WindowSetScore,
) {
  return createHash('sha256')
    .update(
      'whaleu:window-score-set:v1\n' +
        canonicalJson({ actorId, windowId, command }),
    )
    .digest('hex');
}
@Injectable()
export class WindowRatingsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(WindowRepository) private readonly records: WindowRepository,
    @Inject(WindowCursors) private readonly cursors: WindowCursors,
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
            ('constraint' in error &&
              error.constraint === 'window_score_causal'))
        )
          throw new ApplicationError('WINDOW_HISTORY_UNAVAILABLE');
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
  @AccountPolicy('browse', 'entry')
  catalog(token: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.eligible(session.accountId, tx);
      const source = await catalogSource(tx),
        epoch = await windowEpoch(tx),
        result = await this.records.catalog(source.catalog, tx);
      await retainWindows(
        session.accountId,
        session.sessionId,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return result;
    });
  }
  @AccountPolicy('browse', 'entry')
  page(token: string, query: WindowQuery) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        access = await this.eligible(session.accountId, tx),
        source = await catalogSource(tx),
        epoch = await windowEpoch(tx);
      const scope = windowCursorScope([
        'window-directory-v1',
        session.accountId,
        session.sessionId,
        access,
        source,
        epoch,
        query.canteenIds ?? null,
        query.floorId ?? null,
        query.minRating && query.minRating > 0 ? query.minRating : null,
        query.limit,
      ]);
      const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        until = await this.records.orderingDeadline(source.catalog, query, tx),
        rows = await this.records.page(source.catalog, query, after, tx),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        last = chosen.at(-1);
      const nextCursor =
        more && last
          ? await this.cursors.create(
              session.accountId,
              scope,
              {
                v: 1,
                kind: 'window-directory-v1',
                id: last.window_id,
                rank: last.rank,
                mean: last.mean,
                count: last.count,
                validUntil: until,
              },
              tx,
            )
          : null;
      await retainWindows(
        session.accountId,
        session.sessionId,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return windowPageSchema.parse({
        catalogRevision: source.catalog,
        scoreRevision: epoch,
        items: chosen.map((row) => this.records.project(row)),
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.eligible(session.accountId, tx);
      const source = await catalogSource(tx),
        epoch = await windowEpoch(tx),
        window = await this.records.detail(source.catalog, id, tx),
        myScore = await this.records.own(id, session.accountId, tx);
      await retainWindows(
        session.accountId,
        session.sessionId,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return windowDetailSchema.parse({
        catalogRevision: source.catalog,
        window,
        myScore,
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  async own(token: string, id: string) {
    return (await this.detail(token, id)).myScore;
  }
  @AccountPolicy('browse', 'entry')
  async summary(token: string, id: string) {
    return (await this.detail(token, id)).window.summary;
  }
  private async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_ratings.window_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  private async record(
    actor: string,
    session: string,
    id: string,
    command: WindowSetScore,
    receipt: WindowReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_ratings.window_commands(actor_id,request_id,session_id,window_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor,
        command.clientRequestId,
        session,
        id,
        command,
        windowIntentHash(actor, id, command),
        receipt,
      ],
    );
  }
  private async replay(
    actor: string,
    id: string,
    command: WindowSetScore,
    tx: PoolClient,
  ) {
    const prior = await this.prior(actor, command.clientRequestId, tx);
    if (!prior) return null;
    if (prior.intent_hash !== windowIntentHash(actor, id, command))
      throw new ApplicationError('REQUEST_CONFLICT');
    return windowReceiptSchema.parse(prior.receipt);
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  setScore(
    token: string,
    id: string,
    command: WindowSetScore,
  ): Promise<WindowReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      await tx.query('SELECT whaleu_ratings.window_lock($1,$2,$3)', [
        actor,
        command.clientRequestId,
        id,
      ]);
      const prior = await this.replay(actor, id, command, tx);
      if (prior) {
        await this.identity.session(token, tx);
        return prior;
      }
      await this.eligible(actor, tx);
      const catalog = await catalogSource(tx),
        source = await windowSource(id, tx);
      if (!source.history)
        throw new ApplicationError('WINDOW_HISTORY_UNAVAILABLE');
      const own = await this.records.score(id, actor, tx),
        base = {
          requestId: command.clientRequestId,
          operation: 'window.score.set.v1' as const,
          windowId: id,
        };
      let receipt: WindowReceipt;
      if (
        source.catalog !== command.expectedCatalogRevision ||
        source.revision !== command.expectedWindowRevision
      )
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'WINDOW_REVISION_CONFLICT',
        };
      else if ((own?.id ?? null) !== command.expectedOwnScoreRevision)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'WINDOW_SCORE_REVISION_CONFLICT',
        };
      else if (own && own.score === command.score)
        receipt = {
          ...base,
          outcome: 'noop',
          score: own.score,
          scoreRevision: own.id,
          recordedAt: own.recorded_at.toISOString(),
        };
      else {
        const revision = randomUUID(),
          event = (
            await tx.query<{ recorded_at: Date }>(
              'INSERT INTO whaleu_ratings.window_score_events(id,window_id,actor_id,request_id,previous_revision,catalog_id,window_revision,history_assertion_id,score) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING recorded_at',
              [
                revision,
                id,
                actor,
                command.clientRequestId,
                own?.id ?? null,
                source.catalog,
                source.revision,
                source.history,
                command.score,
              ],
            )
          ).rows[0]!;
        if (own)
          await tx.query(
            'UPDATE whaleu_ratings.window_score_heads SET revision=$3 WHERE window_id=$1 AND actor_id=$2',
            [id, actor, revision],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_ratings.window_score_heads(window_id,actor_id,revision) VALUES($1,$2,$3)',
            [id, actor, revision],
          );
        receipt = {
          ...base,
          outcome: 'applied',
          score: command.score,
          scoreRevision: revision,
          recordedAt: event.recorded_at.toISOString(),
        };
      }
      await this.record(actor, session.sessionId, id, command, receipt, tx);
      await retainWindows(actor, session.sessionId, catalog, tx);
      await this.identity.session(token, tx);
      return windowReceiptSchema.parse(receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  receipt(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        prior = await this.prior(session.accountId, id, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return windowReceiptSchema.parse(prior.receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, id: string, body: WindowCancel) {
    return this.run(async (tx) => {
      if (id !== body.command.clientRequestId)
        throw new ApplicationError('REQUEST_CONFLICT');
      const session = await this.session(token, tx),
        actor = session.accountId;
      await tx.query('SELECT whaleu_ratings.window_lock($1,$2,$3)', [
        actor,
        id,
        body.windowId,
      ]);
      const prior = await this.replay(actor, body.windowId, body.command, tx);
      if (prior) {
        await this.identity.session(token, tx);
        return prior;
      }
      const receipt: WindowReceipt = {
        requestId: id,
        operation: 'window.score.set.v1',
        windowId: body.windowId,
        outcome: 'rejected',
        code: 'WINDOW_SCORE_CANCELLED',
      };
      await this.record(
        actor,
        session.sessionId,
        body.windowId,
        body.command,
        receipt,
        tx,
      );
      await this.identity.session(token, tx);
      return receipt;
    });
  }
}
