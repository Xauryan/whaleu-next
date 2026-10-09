import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionView } from '../../../identity/contracts.js';
import { DatabaseService } from '../../../database/database.js';
import { registerTransactionDeadline } from '../../../database/transaction-deadlines.js';
import { ApplicationError } from '../../../http/application-error.js';
import { lockSafetyPolicy } from '../../../safety/locks.js';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../../community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../../../community/content-review/rating-contracts.js';
import { RatingContentReviewFacade } from '../../../community/content-review/rating-content-review.facade.js';
import { RatingsAccessService } from '../../access.js';
import { RatingsRepository, ratingIso } from '../../repository.js';
import { RatingTargetEditRepository } from './repository.js';
import { retainTargetEditSnapshot } from './proof.js';
import { ratingTargetEditIntentHash } from './requests.js';
import {
  prepareRatingTargetEditSchema,
  ratingTargetEditContextSchema,
  ratingTargetEditPreparationSchema,
  ratingTargetEditReceiptSchema,
  ratingTargetEditRejectionSchema,
} from './contracts.js';
import type {
  PrepareRatingTargetEdit,
  CommitRatingTargetEdit,
  RatingTargetEditReceipt,
} from './contracts.js';
interface Preparation {
  account_id: string;
  request_id: string;
  intent_hash: string;
  session_id: string;
  context_revision: string;
  target_id: string;
  before_revision: string;
  before_definition_revision: string;
  before_content_version: number;
  after_revision: string;
  definition_revision: string;
  content_version: number;
  intent: PrepareRatingTargetEdit;
  envelope: RatingContentEnvelope;
  valid_until: Date;
}
type RejectionCode = Extract<
  RatingTargetEditReceipt,
  { outcome: 'rejected' }
>['code'];
@Injectable()
export class RatingTargetEditService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly catalogs: RatingsRepository,
    @Inject(RatingTargetEditRepository)
    private readonly records: RatingTargetEditRepository,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
  ) {}
  private async enter(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx, true);
    await tx.query(
      'LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE',
    );
    await tx.query("SET LOCAL statement_timeout='5s'");
    return this.access.authenticate(token, tx);
  }
  private async claim(
    actor: string,
    intent: PrepareRatingTargetEdit,
    hash: string,
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (row && (row.operation !== 'edit_target' || row.intent_hash !== hash))
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  private async prior(
    actor: string,
    intent: PrepareRatingTargetEdit,
    hash: string,
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        'SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.operation !== 'edit_target' || row.intent_hash !== hash)
      throw new ApplicationError('REQUEST_CONFLICT');
    return row.receipt === null
      ? null
      : ratingTargetEditReceiptSchema.parse(row.receipt);
  }
  private async request(
    actor: string,
    intent: PrepareRatingTargetEdit,
    hash: string,
    tx: PoolClient,
  ) {
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'edit_target',$3) ON CONFLICT DO NOTHING",
      [actor, intent.clientRequestId, hash],
    );
    const row = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        'SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (
      !row ||
      row.operation !== 'edit_target' ||
      row.intent_hash !== hash ||
      row.receipt !== null
    )
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  private async preparation(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Preparation>(
        'SELECT * FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2 FOR SHARE',
        [actor, id],
      )
    ).rows[0];
  }
  private view(p: Preparation) {
    return ratingTargetEditPreparationSchema.parse({
      requestId: p.request_id,
      targetId: p.target_id,
      revision: p.after_revision,
      definitionRevision: p.definition_revision,
      contentVersion: p.content_version,
      contextRevision: p.context_revision,
    });
  }
  private async snapshot(
    actor: string,
    targetId: string,
    tx: PoolClient,
    intent?: PrepareRatingTargetEdit,
  ) {
    const identity = await this.records.identity(targetId, actor, tx, !!intent);
    await this.access.resolveOwnerEditAccount(actor, identity.region_id, tx);
    this.catalogs.enable(tx);
    // Catalog itself never changes in this operation, so its ordinary head fact
    // remains valid. Do not call public target() or navigation() here.
    const catalog = await this.catalogs.catalog(identity.region_id, tx);
    const category = await this.catalogs.categoryForMutation(
      catalog,
      identity.category_id,
      tx,
    );
    if (category.kind !== 'general')
      throw new ApplicationError('RATING_NOT_FOUND');
    const membership = (
      await tx.query(
        'SELECT 1 FROM whaleu_ratings.target_memberships WHERE catalog_id=$1 AND target_id=$2 AND category_id=$3',
        [catalog.id, targetId, category.id],
      )
    ).rows[0];
    if (!membership) throw new ApplicationError('RATING_NOT_FOUND');
    const row = await this.records.definition(identity, tx);
    const decision = await this.review.currentTargetDefinition(
      row.definition,
      tx,
    );
    if (decision.kind === 'deny')
      throw new ApplicationError('RATING_NOT_FOUND');
    if (decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      intent &&
      (intent.regionId !== row.region_id ||
        intent.categoryId !== row.category_id ||
        intent.expectedTargetRevision !== row.revision ||
        intent.expectedDefinitionRevision !==
          row.definition.definitionRevision ||
        intent.expectedContentVersion !== row.definition.contentVersion ||
        intent.expectedCategoryRevision !== category.revision ||
        intent.expectedCatalogRevision !== catalog.id)
    ) {
      await retainTargetEditSnapshot(row, catalog.id, tx);
      throw new ApplicationError('RATING_EDIT_CONTEXT_CHANGED');
    }
    return { row, category, catalog };
  }
  context(token: string, targetId: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const { row, category, catalog } = await this.snapshot(
          session.accountId,
          targetId,
          tx,
        );
        await retainTargetEditSnapshot(row, catalog.id, tx);
        await this.access.recheck(token, tx);
        return ratingTargetEditContextSchema.parse({
          targetId: row.id,
          revision: row.revision,
          definitionRevision: row.definition.definitionRevision,
          contentVersion: row.definition.contentVersion,
          regionId: row.region_id,
          categoryId: row.category_id,
          categoryRevision: category.revision,
          catalogRevision: catalog.id,
          name: row.name,
          description: row.description,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  private rejection(error: unknown): RejectionCode | null {
    if (!(error instanceof ApplicationError)) return null;
    const code =
      error.code === 'RATING_REVISION_CONFLICT'
        ? 'RATING_EDIT_CONTEXT_CHANGED'
        : error.code;
    const parsed = ratingTargetEditRejectionSchema.safeParse(code);
    return parsed.success ? parsed.data : null;
  }
  private async save(
    actor: string,
    requestId: string,
    receipt: RatingTargetEditReceipt,
    tx: PoolClient,
  ) {
    const result = await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL',
      [actor, requestId, canonicalJson(receipt)],
    );
    if (result.rowCount !== 1) throw new ApplicationError('RATING_UNAVAILABLE');
  }
  private async close(
    actor: string,
    intent: PrepareRatingTargetEdit,
    hash: string,
    code: RejectionCode,
    tx: PoolClient,
    hasRequest = false,
  ) {
    if (!hasRequest) await this.request(actor, intent, hash, tx);
    await tx.query(
      'INSERT INTO whaleu_ratings.target_edit_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,$5)',
      [actor, intent.clientRequestId, hash, canonicalJson(intent), code],
    );
    const receipt = ratingTargetEditReceiptSchema.parse({
      requestId: intent.clientRequestId,
      operation: 'edit_target',
      outcome: 'rejected',
      code,
    });
    await this.save(actor, intent.clientRequestId, receipt, tx);
    return receipt;
  }
  prepare(token: string, intent: PrepareRatingTargetEdit) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          actor = session.accountId,
          hash = ratingTargetEditIntentHash(intent);
        await this.claim(actor, intent, hash, tx);
        const prior = await this.prior(actor, intent, hash, tx);
        if (prior?.outcome === 'rejected') {
          await this.access.recheck(token, tx);
          return prior;
        }
        const old = await this.preparation(actor, intent.clientRequestId, tx);
        if (old) {
          await this.access.recheck(token, tx);
          return this.view(old);
        }
        if (prior) throw new ApplicationError('RATING_UNAVAILABLE');
        let current: Awaited<ReturnType<RatingTargetEditService['snapshot']>>;
        try {
          current = await this.snapshot(actor, intent.targetId, tx, intent);
        } catch (error) {
          const code = this.rejection(error);
          if (!code) throw error;
          const receipt = await this.close(actor, intent, hash, code, tx);
          await this.access.recheck(token, tx);
          return receipt;
        }
        const afterRevision = randomUUID(),
          definitionRevision = randomUUID(),
          nextVersion = current.row.definition.contentVersion + 1;
        const envelope = canonicalRatingEnvelope({
          version: 3,
          purpose: 'edit_rating_target',
          accountId: actor,
          clientRequestId: intent.clientRequestId,
          targetId: intent.targetId,
          previousTargetRevision: current.row.revision,
          targetRevision: afterRevision,
          previousDefinitionRevision: current.row.definition.definitionRevision,
          definitionRevision,
          contentVersion: nextVersion,
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
            `INSERT INTO whaleu_ratings.target_edit_preparations(account_id,request_id,intent_hash,session_id,context_revision,target_id,before_revision,before_definition_revision,before_content_version,after_revision,definition_revision,content_version,intent,envelope,valid_until)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,least(clock_timestamp()+interval '5 minutes',to_timestamp($15::double precision/1000))) RETURNING *`,
            [
              actor,
              intent.clientRequestId,
              hash,
              session.sessionId,
              randomBytes(32).toString('base64url'),
              intent.targetId,
              current.row.revision,
              current.row.definition.definitionRevision,
              current.row.definition.contentVersion,
              afterRevision,
              definitionRevision,
              nextVersion,
              canonicalJson(intent),
              canonicalJson(envelope),
              session.expiresAt,
            ],
          )
        ).rows[0]!;
        registerTransactionDeadline(
          tx,
          p.valid_until.getTime(),
          'RATING_UNAVAILABLE',
        );
        await retainTargetEditSnapshot(current.row, current.catalog.id, tx, {
          requestId: intent.clientRequestId,
          intentHash: hash,
          contextRevision: p.context_revision,
          sessionId: session.sessionId,
          outcome: 'prepared',
        });
        await this.access.recheck(token, tx);
        return this.view(p);
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async preflight(
    session: SessionView,
    intent: PrepareRatingTargetEdit,
    hash: string,
    contextRevision: string,
    tx: PoolClient,
  ) {
    const p = await this.preparation(
      session.accountId,
      intent.clientRequestId,
      tx,
    );
    if (
      !p ||
      p.intent_hash !== hash ||
      p.session_id !== session.sessionId ||
      p.context_revision !== contextRevision ||
      canonicalJson(p.intent) !== canonicalJson(intent)
    )
      throw new ApplicationError('RATING_EDIT_CONTEXT_CHANGED');
    if (
      !(
        await tx.query('SELECT 1 WHERE clock_timestamp()<$1::timestamptz', [
          p.valid_until,
        ])
      ).rows[0]
    )
      throw new ApplicationError('RATING_EDIT_CONTEXT_CHANGED');
    registerTransactionDeadline(
      tx,
      p.valid_until.getTime(),
      'RATING_UNAVAILABLE',
    );
    const current = await this.snapshot(
      session.accountId,
      intent.targetId,
      tx,
      intent,
    );
    const equal =
      current.row.name === intent.name &&
      current.row.description === intent.description;
    const accepted = equal
      ? null
      : await this.review.acceptedTargetEdit(
          p.envelope as Extract<
            RatingContentEnvelope,
            { purpose: 'edit_rating_target' }
          >,
          tx,
        );
    return { p, ...current, accepted };
  }
  commit(token: string, command: CommitRatingTargetEdit) {
    const { expectedContextRevision, ...raw } = command,
      intent = prepareRatingTargetEditSchema.parse(raw),
      hash = ratingTargetEditIntentHash(intent);
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          actor = session.accountId;
        await this.claim(actor, intent, hash, tx);
        const prior = await this.prior(actor, intent, hash, tx);
        if (prior) {
          await this.access.recheck(token, tx);
          return prior;
        }
        await this.request(actor, intent, hash, tx);
        let current: Awaited<ReturnType<RatingTargetEditService['preflight']>>;
        try {
          current = await this.preflight(
            session,
            intent,
            hash,
            expectedContextRevision,
            tx,
          );
        } catch (error) {
          const code = this.rejection(error);
          if (!code) throw error;
          const receipt = await this.close(actor, intent, hash, code, tx, true);
          await this.access.recheck(token, tx);
          return receipt;
        }
        const { p, catalog, accepted } = current;
        let row = current.row,
          occurredAt: string,
          outcome: 'applied' | 'noop';
        if (!accepted) {
          outcome = 'noop';
          occurredAt = (
            await tx.query<{ occurred_at: string }>(
              `INSERT INTO whaleu_ratings.target_edit_noops(actor_account_id,request_id,intent_hash,intent,target_id,revision,definition_revision,content_version,context_revision)
           VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING ${ratingIso('occurred_at')} occurred_at`,
              [
                actor,
                intent.clientRequestId,
                hash,
                canonicalJson(intent),
                row.id,
                row.revision,
                row.definition.definitionRevision,
                row.definition.contentVersion,
                p.context_revision,
              ],
            )
          ).rows[0]!.occurred_at;
        } else {
          outcome = 'applied';
          occurredAt = (
            await tx.query<{ occurred_at: string }>(
              `INSERT INTO whaleu_ratings.target_edit_transitions(id,actor_account_id,request_id,intent_hash,intent,target_id,before_revision,after_revision,before_definition_revision,after_definition_revision,before_content_version,after_content_version,context_revision)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${ratingIso('occurred_at')} occurred_at`,
              [
                randomUUID(),
                actor,
                intent.clientRequestId,
                hash,
                canonicalJson(intent),
                row.id,
                row.revision,
                p.after_revision,
                row.definition.definitionRevision,
                p.definition_revision,
                row.definition.contentVersion,
                p.content_version,
                p.context_revision,
              ],
            )
          ).rows[0]!.occurred_at;
          await tx.query(
            `INSERT INTO whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision,applied_target_revision,name,description,envelope,publication_transaction,published_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,pg_current_xact_id(),$8::timestamptz)`,
            [
              row.id,
              p.content_version,
              p.definition_revision,
              p.after_revision,
              intent.name,
              intent.description,
              canonicalJson(p.envelope),
              occurredAt,
            ],
          );
          if (
            (
              await tx.query(
                'UPDATE whaleu_ratings.targets SET revision=$3 WHERE id=$1 AND revision=$2 AND active',
                [row.id, row.revision, p.after_revision],
              )
            ).rowCount !== 1
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
          if (
            (
              await tx.query(
                'UPDATE whaleu_ratings.target_definition_heads SET content_version=$4,definition_revision=$5 WHERE target_id=$1 AND content_version=$2 AND definition_revision=$3',
                [
                  row.id,
                  row.definition.contentVersion,
                  row.definition.definitionRevision,
                  p.content_version,
                  p.definition_revision,
                ],
              )
            ).rowCount !== 1
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
          row = await this.records.definition(
            { ...row, revision: p.after_revision },
            tx,
          );
          await this.review.bindTargetDefinition(accepted, row.definition, tx);
        }
        const receipt = ratingTargetEditReceiptSchema.parse({
          requestId: intent.clientRequestId,
          operation: 'edit_target',
          outcome,
          targetId: row.id,
          revision: row.revision,
          definitionRevision: row.definition.definitionRevision,
          contentVersion: row.definition.contentVersion,
          occurredAt,
        });
        await this.save(actor, intent.clientRequestId, receipt, tx);
        await retainTargetEditSnapshot(row, catalog.id, tx, {
          requestId: intent.clientRequestId,
          intentHash: hash,
          contextRevision: p.context_revision,
          sessionId: session.sessionId,
          outcome,
        });
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  cancel(token: string, intent: PrepareRatingTargetEdit) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          hash = ratingTargetEditIntentHash(intent);
        await this.claim(session.accountId, intent, hash, tx);
        const prior = await this.prior(session.accountId, intent, hash, tx);
        const receipt =
          prior ??
          (await this.close(
            session.accountId,
            intent,
            hash,
            'RATING_EDIT_CANCELLED',
            tx,
          ));
        await this.access.recheck(token, tx);
        return receipt;
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
            "SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND operation='edit_target' AND receipt IS NOT NULL",
            [session.accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const receipt = ratingTargetEditReceiptSchema.parse(row.receipt);
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
