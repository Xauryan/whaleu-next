import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SessionView } from '../../identity/contracts.js';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../../community/content-review/rating-contracts.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository, ratingIso } from '../repository.js';
import { RatingCatalogWriter } from './catalog-writer.js';
import { RatingNativeTargetSourceFacade } from './native-source.facade.js';
import { retainCreation } from './proof.js';
import {
  prepareRatingTargetSchema,
  ratingTargetCreationReceiptSchema,
  ratingTargetPreparationSchema,
} from './contracts.js';
import type { PrepareRatingTarget, CreateRatingTarget } from './contracts.js';
export function ratingTargetCreateHash(intent: PrepareRatingTarget) {
  return createHash('sha256')
    .update(
      'whaleu:rating-target-create:v1\n' +
        canonicalJson({ operation: 'create_target', intent }),
    )
    .digest('hex');
}
interface Preparation {
  account_id: string;
  request_id: string;
  intent_hash: string;
  session_id: string;
  target_id: string;
  revision: string;
  context_revision: string;
  policy_id: string;
  origin_evidence_id: string | null;
  intent: PrepareRatingTarget;
  envelope: RatingContentEnvelope;
  valid_until: Date;
}
@Injectable()
export class RatingManagementService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingCatalogWriter) private readonly catalogs: RatingCatalogWriter,
    @Inject(RatingNativeTargetSourceFacade)
    private readonly sources: RatingNativeTargetSourceFacade,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
  ) {}
  private async enter(token: string, tx: PoolClient) {
    // Must precede session, request and owner locks: never upgrade shared to exclusive.
    await lockSafetyPolicy(tx, true);
    await tx.query("SET LOCAL statement_timeout='5s'");
    return this.access.authenticate(token, tx);
  }
  private async claim(
    actor: string,
    intent: PrepareRatingTarget,
    hash: string,
    tx: PoolClient,
  ) {
    const existing = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (
      existing &&
      (existing.operation !== 'create_target' || existing.intent_hash !== hash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  private async preparation(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Preparation>(
        'SELECT * FROM whaleu_ratings.target_preparations WHERE account_id=$1 AND request_id=$2 FOR SHARE',
        [actor, id],
      )
    ).rows[0];
  }
  private view(p: Preparation) {
    return ratingTargetPreparationSchema.parse({
      requestId: p.request_id,
      targetId: p.target_id,
      revision: p.revision,
      contextRevision: p.context_revision,
    });
  }
  private async context(
    actor: string,
    intent: PrepareRatingTarget,
    hash: string,
    tx: PoolClient,
  ) {
    await this.access.resolveAccount(actor, intent.regionId, tx, {
      phone: true,
    });
    const catalog = await this.catalogs.current(
      intent.regionId,
      intent.expectedCatalogRevision,
      tx,
    );
    const category = await this.records.categoryForMutation(
      catalog,
      intent.categoryId,
      tx,
    );
    if (category.revision !== intent.expectedCategoryRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const source = await this.sources.resolve(
      actor,
      intent.clientRequestId,
      hash,
      intent.regionId,
      category.kind,
      tx,
    );
    return { catalog, category, source };
  }
  async prepare(token: string, intent: PrepareRatingTarget) {
    const result = await this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          hash = ratingTargetCreateHash(intent);
        await this.claim(session.accountId, intent, hash, tx);
        const prior = (
          await tx.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [session.accountId, intent.clientRequestId],
          )
        ).rows[0]?.receipt;
        if (prior) {
          const receipt = ratingTargetCreationReceiptSchema.parse(prior);
          if (receipt.outcome === 'rejected') {
            await this.access.recheck(token, tx);
            return receipt;
          }
        }
        const old = await this.preparation(
          session.accountId,
          intent.clientRequestId,
          tx,
        );
        if (old) {
          await this.access.recheck(token, tx);
          return this.view(old);
        }
        let resolved: Awaited<ReturnType<RatingManagementService['context']>>;
        try {
          resolved = await this.context(session.accountId, intent, hash, tx);
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'RATING_REVISION_CONFLICT'
          )
            return this.terminal(
              session.accountId,
              intent,
              hash,
              'RATING_CREATION_CONTEXT_CHANGED',
              token,
              tx,
            );
          throw error;
        }
        const { source } = resolved;
        const targetId = randomUUID(),
          revision = randomUUID();
        const envelope = canonicalRatingEnvelope({
          version: 1,
          purpose: 'publish_rating_target',
          accountId: session.accountId,
          clientRequestId: intent.clientRequestId,
          targetId,
          targetRevision: revision,
          categoryId: intent.categoryId,
          categoryRevision: intent.expectedCategoryRevision,
          catalogRevision: intent.expectedCatalogRevision,
          scope: { regionId: intent.regionId },
          name: intent.name,
          description: intent.description,
          assetIds: [],
        });
        const p = (
          await tx.query<Preparation>(
            `INSERT INTO whaleu_ratings.target_preparations(account_id,request_id,intent_hash,session_id,target_id,revision,context_revision,policy_id,origin_evidence_id,intent,envelope,valid_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,least(clock_timestamp()+interval '10 minutes',to_timestamp($12::double precision/1000),$13::timestamptz,coalesce($14::timestamptz,'infinity'::timestamptz))) RETURNING *`,
            [
              session.accountId,
              intent.clientRequestId,
              hash,
              session.sessionId,
              targetId,
              revision,
              randomBytes(32).toString('base64url'),
              source.policy_id,
              source.origin_id,
              canonicalJson(intent),
              canonicalJson(envelope),
              session.expiresAt,
              source.policy_until,
              source.origin_until,
            ],
          )
        ).rows[0]!;
        await retainCreation(
          {
            actor: session.accountId,
            requestId: intent.clientRequestId,
            intentHash: hash,
            policyId: source.policy_id,
            originId: source.origin_id,
            catalogId: intent.expectedCatalogRevision,
            beforeCatalogId: intent.expectedCatalogRevision,
            targetId: null,
            revision: null,
          },
          tx,
        );
        await this.access.recheck(token, tx);
        return this.view(p);
      },
      { isolationLevel: 'read committed' },
    );
    if ('outcome' in result)
      throw new ApplicationError(
        result.outcome === 'rejected' ? result.code : 'RATING_UNAVAILABLE',
      );
    return result;
  }
  private async preflight(
    session: SessionView,
    intent: PrepareRatingTarget,
    hash: string,
    expectedContextRevision: string,
    tx: PoolClient,
  ) {
    const p = await this.preparation(
      session.accountId,
      intent.clientRequestId,
      tx,
    );
    if (
      !p ||
      p.context_revision !== expectedContextRevision ||
      p.session_id !== session.sessionId
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const valid = (
      await tx.query('SELECT 1 WHERE clock_timestamp()<$1::timestamptz', [
        p.valid_until,
      ])
    ).rows[0];
    if (!valid) throw new ApplicationError('RATING_REVISION_CONFLICT');
    registerTransactionDeadline(
      tx,
      p.valid_until.getTime(),
      'RATING_UNAVAILABLE',
    );
    const { source } = await this.context(session.accountId, intent, hash, tx);
    if (
      source.policy_id !== p.policy_id ||
      source.origin_id !== p.origin_evidence_id
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const accepted = await this.review.accepted(p.envelope, tx);
    return { p, source, accepted };
  }
  private async terminal(
    actor: string,
    intent: PrepareRatingTarget,
    hash: string,
    code:
      | 'RATING_CREATION_CONTEXT_CHANGED'
      | 'CONTENT_REJECTED'
      | 'RATING_CREATION_CANCELLED',
    token: string,
    tx: PoolClient,
  ) {
    const receipt = ratingTargetCreationReceiptSchema.parse({
      requestId: intent.clientRequestId,
      operation: 'create_target',
      outcome: 'rejected',
      code,
    });
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_target',$3)",
      [actor, intent.clientRequestId, hash],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.target_creation_closures(account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,$5)',
      [actor, intent.clientRequestId, hash, canonicalJson(intent), code],
    );
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [actor, intent.clientRequestId, canonicalJson(receipt)],
    );
    await this.access.recheck(token, tx);
    return receipt;
  }
  cancel(token: string, intent: PrepareRatingTarget) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          hash = ratingTargetCreateHash(intent);
        await this.claim(session.accountId, intent, hash, tx);
        const prior = (
          await tx.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [session.accountId, intent.clientRequestId],
          )
        ).rows[0]?.receipt;
        if (prior) {
          await this.access.recheck(token, tx);
          return ratingTargetCreationReceiptSchema.parse(prior);
        }
        return this.terminal(
          session.accountId,
          intent,
          hash,
          'RATING_CREATION_CANCELLED',
          token,
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  create(token: string, command: CreateRatingTarget) {
    const { expectedContextRevision, ...raw } = command,
      intent = prepareRatingTargetSchema.parse(raw),
      hash = ratingTargetCreateHash(intent);
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx);
        await this.claim(session.accountId, intent, hash, tx);
        const receipt = (
          await tx.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [session.accountId, intent.clientRequestId],
          )
        ).rows[0]?.receipt;
        if (receipt) {
          await this.access.recheck(token, tx);
          return ratingTargetCreationReceiptSchema.parse(receipt);
        }
        let context: Awaited<ReturnType<RatingManagementService['preflight']>>;
        try {
          context = await this.preflight(
            session,
            intent,
            hash,
            expectedContextRevision,
            tx,
          );
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            (error.code === 'RATING_REVISION_CONFLICT' ||
              error.code === 'CONTENT_REJECTED')
          )
            return this.terminal(
              session.accountId,
              intent,
              hash,
              error.code === 'CONTENT_REJECTED'
                ? 'CONTENT_REJECTED'
                : 'RATING_CREATION_CONTEXT_CHANGED',
              token,
              tx,
            );
          throw error;
        }
        const { p, source, accepted } = context;
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_target',$3)",
          [session.accountId, intent.clientRequestId, hash],
        );
        const now = (
          await tx.query<{ time: string }>(
            `SELECT ${ratingIso('clock_timestamp()')} time`,
          )
        ).rows[0]!.time;
        const after = randomUUID(),
          sourceId = randomUUID(),
          baselineId = randomUUID(),
          originId = randomUUID(),
          reference = `rating-create:${session.accountId}:${intent.clientRequestId}`;
        await this.catalogs.copy(
          intent.expectedCatalogRevision,
          after,
          reference,
          source.policy_reference,
          now,
          tx,
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted',$3,$4,$5)`,
          [sourceId, p.target_id, reference, source.policy_reference, now],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb,$10)`,
          [
            p.target_id,
            p.revision,
            intent.categoryId,
            session.accountId,
            intent.regionId,
            sourceId,
            intent.name,
            intent.description,
            canonicalJson(p.envelope),
            now,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,$4,$5)`,
          [
            p.target_id,
            baselineId,
            sourceId,
            reference,
            source.policy_reference,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.target_origin_sources(id,target_id,revision,state,origin_campus_id,coverage_state,provenance_state,source_reference,policy_reference,source_version,effective_at,expiry_kind,valid_until)
    VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,1,$9,'at',$10)`,
          [
            originId,
            p.target_id,
            source.origin_state,
            source.origin_campus_id,
            source.origin_id ? 'complete' : 'missing',
            source.origin_id ? 'accepted' : 'unknown',
            source.origin_source_reference ?? reference,
            source.origin_policy_reference ?? source.policy_reference,
            now,
            source.origin_until ?? source.policy_until,
          ],
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.target_origin_heads VALUES($1,$2,1)',
          [p.target_id, originId],
        );
        await this.review.bind(accepted, 'target', p.target_id, p.envelope, tx);
        await this.catalogs.publish(
          intent.expectedCatalogRevision,
          after,
          p.target_id,
          intent.categoryId,
          intent.regionId,
          tx,
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.target_create_transitions(target_id,account_id,request_id,source_id,baseline_id,origin_source_id,policy_id,before_catalog_id,after_catalog_id,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            p.target_id,
            session.accountId,
            intent.clientRequestId,
            sourceId,
            baselineId,
            originId,
            source.policy_id,
            intent.expectedCatalogRevision,
            after,
            p.revision,
            now,
          ],
        );
        const result = ratingTargetCreationReceiptSchema.parse({
          requestId: intent.clientRequestId,
          operation: 'create_target',
          outcome: 'applied',
          targetId: p.target_id,
          revision: p.revision,
          catalogRevision: after,
          occurredAt: now,
        });
        await tx.query(
          'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [session.accountId, intent.clientRequestId, canonicalJson(result)],
        );
        await retainCreation(
          {
            actor: session.accountId,
            requestId: intent.clientRequestId,
            intentHash: hash,
            policyId: source.policy_id,
            originId: source.origin_id,
            catalogId: after,
            beforeCatalogId: intent.expectedCatalogRevision,
            targetId: p.target_id,
            revision: p.revision,
          },
          tx,
        );
        await this.access.recheck(token, tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, id: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ receipt: unknown }>(
            "SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND operation='create_target' AND receipt IS NOT NULL",
            [session.accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        await this.access.recheck(token, tx);
        return ratingTargetCreationReceiptSchema.parse(row.receipt);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
