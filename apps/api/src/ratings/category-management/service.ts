import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { CampusRatingCategoryScopeFacade } from '../../campus/rating-category-scope.facade.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { canonicalRatingCategoryEnvelope } from '../../community/content-review/rating-category-contracts.js';
import type { RatingCategoryEnvelope } from '../../community/content-review/rating-category-contracts.js';
import { RatingCategoryContentReviewFacade } from '../../community/content-review/rating-category-content-review.facade.js';
import { RatingsAccessService } from '../access.js';
import { retainCategoryHeads } from './proof.js';
import { ratingCategoryIntentHash } from './requests.js';
import {
  prepareRatingCategoriesSchema,
  ratingCategoryManagementContextSchema,
  ratingCategoryPreparationSchema,
  ratingCategoryReceiptSchema,
  ratingCategoryRejectionSchema,
  RATING_CATEGORY_RELEASE_SCOPE_LIMIT,
} from './contracts.js';
import type {
  PrepareRatingCategories,
  CommitRatingCategories,
  RatingCategoryReceipt,
  RatingCreatedCategory,
} from './contracts.js';
interface Head {
  regionId: string | null;
  catalogId: string | null;
  campusIds: readonly string[];
}
interface Parent {
  id: string;
  revision: string;
  name: string;
  level: 1 | 2;
  parent_id: string | null;
  envelope: RatingCategoryEnvelope;
}
interface Preparation {
  account_id: string;
  request_id: string;
  intent_hash: string;
  session_id: string;
  context_revision: string;
  release_id: string;
  scope_version_id: string;
  topology_snapshot_id: string;
  campus_ids: string[];
  intent: PrepareRatingCategories;
  nodes: RatingCategoryEnvelope['categories'];
  catalogs: RatingCategoryEnvelope['catalogs'];
  envelope: RatingCategoryEnvelope;
  valid_until: Date;
}
type Rejection = Extract<
  RatingCategoryReceipt,
  { outcome: 'rejected' }
>['code'];
@Injectable()
export class RatingCategoryManagementService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(CampusRatingCategoryScopeFacade)
    private readonly campus: CampusRatingCategoryScopeFacade,
    @Inject(RatingCategoryContentReviewFacade)
    private readonly review: RatingCategoryContentReviewFacade,
  ) {}
  private async enter(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx, true);
    await tx.query(
      'LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE',
    );
    await tx.query("SET LOCAL statement_timeout='5s'");
    return this.access.authenticate(token, tx);
  }
  private async prior(
    actor: string,
    intent: PrepareRatingCategories,
    hash: string,
    tx: PoolClient,
  ) {
    const claim = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (
      claim &&
      (claim.operation !== 'create_categories' || claim.intent_hash !== hash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
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
      row &&
      (row.operation !== 'create_categories' || row.intent_hash !== hash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    return row?.receipt ? ratingCategoryReceiptSchema.parse(row.receipt) : null;
  }
  private async request(
    actor: string,
    intent: PrepareRatingCategories,
    hash: string,
    tx: PoolClient,
  ) {
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_categories',$3) ON CONFLICT DO NOTHING",
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
      row.operation !== 'create_categories' ||
      row.intent_hash !== hash ||
      row.receipt !== null
    )
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  private async preparation(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Preparation>(
        'SELECT * FROM whaleu_ratings.category_command_preparations WHERE account_id=$1 AND request_id=$2 FOR SHARE',
        [actor, id],
      )
    ).rows[0];
  }
  private view(row: Preparation) {
    return ratingCategoryPreparationSchema.parse({
      requestId: row.request_id,
      contextRevision: row.context_revision,
      categories: row.nodes.map(({ key, id, revision, parentId, level }) => ({
        key,
        id,
        revision,
        parentId,
        level,
      })),
    });
  }
  private rejection(error: unknown): Rejection | null {
    if (!(error instanceof ApplicationError)) return null;
    const code = ratingCategoryRejectionSchema.safeParse(
      error.code === 'RATING_REVISION_CONFLICT'
        ? 'RATING_CATEGORY_CONTEXT_CHANGED'
        : error.code,
    );
    return code.success ? code.data : null;
  }
  private async close(
    actor: string,
    intent: PrepareRatingCategories,
    hash: string,
    code: Rejection,
    tx: PoolClient,
    hasRequest = false,
  ) {
    if (!hasRequest) await this.request(actor, intent, hash, tx);
    await tx.query(
      'INSERT INTO whaleu_ratings.category_command_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,$5)',
      [actor, intent.clientRequestId, hash, canonicalJson(intent), code],
    );
    const receipt = ratingCategoryReceiptSchema.parse({
      requestId: intent.clientRequestId,
      operation: 'create_categories',
      outcome: 'rejected',
      code,
    });
    const result = await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL',
      [actor, intent.clientRequestId, canonicalJson(receipt)],
    );
    if (result.rowCount !== 1) throw new ApplicationError('RATING_UNAVAILABLE');
    return receipt;
  }
  private async snapshot(
    actor: string,
    regionId: string | null,
    tx: PoolClient,
    lock: boolean,
    intent?: PrepareRatingCategories,
  ) {
    const authority = await this.access.resolveCategoryManager(
      actor,
      regionId,
      tx,
    );
    const scope = await this.campus.scope(regionId, tx);
    const wanted =
      regionId === null
        ? [{ regionId: null, campusIds: scope.campusIds }, ...scope.regions]
        : scope.regions;
    if (
      wanted.length < 1 ||
      wanted.length > RATING_CATEGORY_RELEASE_SCOPE_LIMIT
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const heads: Head[] = [];
    for (const selected of wanted) {
      const row = (
        await tx.query<{
          id: string;
          valid_until: Date | null;
          valid: boolean;
        }>(
          `SELECT c.id,c.valid_until,
        coalesce(c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.region_id IS NOT DISTINCT FROM $1::uuid AND c.effective_at<=clock_timestamp()
        AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp()) AND whaleu_ratings.category_catalog_compat_current(c.id),false) valid
        FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id WHERE h.scope_key=coalesce($1::uuid::text,'global') FOR ${lock ? 'UPDATE' : 'SHARE'} OF h`,
          [selected.regionId],
        )
      ).rows[0];
      if (row && !row.valid) throw new ApplicationError('RATING_UNAVAILABLE');
      registerTransactionDeadline(
        tx,
        row?.valid_until?.getTime() ?? null,
        'RATING_UNAVAILABLE',
      );
      heads.push({
        regionId: selected.regionId,
        catalogId: row?.id ?? null,
        campusIds: selected.campusIds,
      });
    }
    const selected = heads.find((head) => head.regionId === regionId)!;
    // A missing regional head is not evidence of an empty global dependency.
    if (
      regionId !== null &&
      selected.catalogId === null &&
      (
        await tx.query(
          "SELECT 1 FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.catalog_category_lineage l ON l.catalog_id=h.catalog_id WHERE h.scope_key='global' AND l.source_kind='native' LIMIT 1",
        )
      ).rows[0]
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const rows =
      selected.catalogId === null
        ? []
        : (
            await tx.query<Parent>(
              `SELECT c.id,c.revision,c.name,c.level,c.parent_id,b.envelope FROM whaleu_ratings.categories c
      JOIN whaleu_ratings.catalog_category_lineage l ON l.catalog_id=c.catalog_id AND l.category_id=c.id AND l.source_kind='native'
      JOIN whaleu_ratings.category_base_heads h ON h.category_id=c.id AND h.revision=l.base_revision
      JOIN whaleu_ratings.category_base_versions b ON b.category_id=h.category_id AND b.revision=h.revision
      JOIN whaleu_ratings.category_scope_versions s ON s.id=b.scope_version_id
      WHERE c.catalog_id=$1 AND c.kind='general' AND c.level<3 AND c.active AND NOT c.hidden AND s.region_id IS NOT DISTINCT FROM $2::uuid
      AND s.campus_ids=$3::uuid[] ORDER BY c.level,c.ordinal LIMIT 10001`,
              [selected.catalogId, regionId, scope.campusIds],
            )
          ).rows;
    if (rows.length > 10000) throw new ApplicationError('RATING_UNAVAILABLE');
    const parents: Parent[] = [];
    for (let start = 0; start < rows.length; start += 512) {
      const batch = rows.slice(start, start + 512);
      const decisions = await this.review.currentBatch(
        batch.map((row) => ({
          categoryId: row.id,
          baseRevision: row.revision,
          envelope: row.envelope,
        })),
        tx,
      );
      for (const [index, decision] of decisions.entries()) {
        if (decision.kind === 'unavailable')
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        const row = batch[index]!;
        if (
          decision.kind === 'allow' &&
          (row.parent_id === null ||
            parents.some((parent) => parent.id === row.parent_id))
        )
          parents.push(row);
      }
    }
    const scopeRevision = createHash('sha256')
      .update(
        canonicalJson([
          'rating-category-management-context:v1',
          actor,
          authority.fingerprint,
          scope.fingerprint,
          heads,
          parents.map(({ id, revision, parent_id, level }) => ({
            id,
            revision,
            parentId: parent_id,
            level,
          })),
        ]),
      )
      .digest('base64url');
    if (
      intent &&
      (intent.expectedCatalogRevision !== selected.catalogId ||
        intent.expectedScopeRevision !== scopeRevision)
    ) {
      await retainCategoryHeads(heads, tx);
      throw new ApplicationError('RATING_CATEGORY_CONTEXT_CHANGED');
    }
    const parent = intent?.parentId
      ? parents.find((row) => row.id === intent.parentId)
      : null;
    if (
      intent?.parentId &&
      (!parent || parent.revision !== intent.expectedParentRevision)
    ) {
      await retainCategoryHeads(heads, tx);
      throw new ApplicationError('RATING_CATEGORY_CONTEXT_CHANGED');
    }
    return { scope, heads, selected, parents, scopeRevision, parent };
  }
  context(token: string, regionId: string | null) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const current = await this.snapshot(
          session.accountId,
          regionId,
          tx,
          false,
        );
        await retainCategoryHeads(current.heads, tx);
        await this.access.recheck(token, tx);
        return ratingCategoryManagementContextSchema.parse({
          regionId,
          catalogRevision: current.selected.catalogId,
          scopeRevision: current.scopeRevision,
          campusIds: current.scope.campusIds,
          parents: current.parents.map(({ id, revision, name, level }) => ({
            id,
            revision,
            name,
            level,
          })),
          maximumNodes: 32,
          maximumDepth: 3,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  prepare(token: string, intent: PrepareRatingCategories) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          actor = session.accountId,
          hash = ratingCategoryIntentHash(intent);
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
        let current: Awaited<
          ReturnType<RatingCategoryManagementService['snapshot']>
        >;
        try {
          current = await this.snapshot(
            actor,
            intent.regionId,
            tx,
            true,
            intent,
          );
        } catch (error) {
          const code = this.rejection(error);
          if (!code) throw error;
          const receipt = await this.close(actor, intent, hash, code, tx);
          await this.access.recheck(token, tx);
          return receipt;
        }
        const releaseId = randomUUID(),
          scopeVersionId = randomUUID(),
          categories: RatingCategoryEnvelope['categories'] = [],
          assigned = new Map<string, RatingCreatedCategory>();
        for (const node of intent.nodes) {
          const parent = node.parentKey
            ? assigned.get(node.parentKey)!
            : current.parent;
          const level = (parent?.level ?? 0) + 1;
          if (level > 3) {
            await retainCategoryHeads(current.heads, tx);
            const receipt = await this.close(
              actor,
              intent,
              hash,
              'RATING_CATEGORY_CONTEXT_CHANGED',
              tx,
            );
            await this.access.recheck(token, tx);
            return receipt;
          }
          const category = {
            key: node.key,
            id: randomUUID(),
            revision: randomUUID(),
            parentId: parent?.id ?? null,
            level: level as 1 | 2 | 3,
            name: node.name,
            description: node.description,
            scopeVersionId,
          };
          categories.push(category);
          assigned.set(category.key, category);
        }
        const catalogs = current.heads.map((head) => ({
          regionId: head.regionId,
          beforeCatalogId: head.catalogId,
          afterCatalogId: randomUUID(),
          campusIds: [...head.campusIds],
        }));
        const envelope = canonicalRatingCategoryEnvelope({
          version: 4,
          purpose: 'publish_rating_categories',
          accountId: actor,
          clientRequestId: intent.clientRequestId,
          releaseId,
          intent,
          scope: {
            regionId: intent.regionId,
            topologySnapshotId: current.scope.topologySnapshotId,
            campusIds: [...current.scope.campusIds],
            scopeRevision: current.scopeRevision,
          },
          categories,
          catalogs,
          assetIds: [],
        });
        const p = (
          await tx.query<Preparation>(
            `INSERT INTO whaleu_ratings.category_command_preparations(account_id,request_id,intent_hash,session_id,context_revision,release_id,scope_version_id,topology_snapshot_id,campus_ids,intent,nodes,catalogs,envelope,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,least(clock_timestamp()+interval '5 minutes',to_timestamp($14::double precision/1000))) RETURNING *`,
            [
              actor,
              intent.clientRequestId,
              hash,
              session.sessionId,
              randomBytes(32).toString('base64url'),
              releaseId,
              scopeVersionId,
              current.scope.topologySnapshotId,
              current.scope.campusIds,
              canonicalJson(intent),
              canonicalJson(categories),
              canonicalJson(catalogs),
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
        await retainCategoryHeads(current.heads, tx, {
          actor,
          requestId: intent.clientRequestId,
          intentHash: hash,
          sessionId: session.sessionId,
          contextRevision: p.context_revision,
          releaseId,
          outcome: 'prepared',
        });
        await this.access.recheck(token, tx);
        return this.view(p);
      },
      { isolationLevel: 'read committed' },
    );
  }
  commit(token: string, command: CommitRatingCategories) {
    const { expectedContextRevision, ...raw } = command,
      intent = prepareRatingCategoriesSchema.parse(raw),
      hash = ratingCategoryIntentHash(intent);
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          actor = session.accountId;
        const prior = await this.prior(actor, intent, hash, tx);
        if (prior) {
          await this.access.recheck(token, tx);
          return prior;
        }
        await this.request(actor, intent, hash, tx);
        let beforeHeads: Head[] | undefined;
        let p: Preparation,
          accepted: Awaited<
            ReturnType<RatingCategoryContentReviewFacade['accepted']>
          >;
        try {
          const prepared = await this.preparation(
            actor,
            intent.clientRequestId,
            tx,
          );
          if (
            !prepared ||
            prepared.intent_hash !== hash ||
            prepared.session_id !== session.sessionId ||
            prepared.context_revision !== expectedContextRevision ||
            canonicalJson(prepared.intent) !== canonicalJson(intent) ||
            !(
              await tx.query(
                'SELECT 1 WHERE clock_timestamp()<$1::timestamptz',
                [prepared.valid_until],
              )
            ).rows[0]
          )
            throw new ApplicationError('RATING_CATEGORY_CONTEXT_CHANGED');
          p = prepared;
          registerTransactionDeadline(
            tx,
            p.valid_until.getTime(),
            'RATING_UNAVAILABLE',
          );
          const current = await this.snapshot(
            actor,
            intent.regionId,
            tx,
            true,
            intent,
          );
          beforeHeads = current.heads;
          if (
            current.scope.topologySnapshotId !== p.topology_snapshot_id ||
            canonicalJson(
              current.heads.map((head) => ({
                regionId: head.regionId,
                beforeCatalogId: head.catalogId,
                campusIds: head.campusIds,
              })),
            ) !==
              canonicalJson(
                p.catalogs.map(({ regionId, beforeCatalogId, campusIds }) => ({
                  regionId,
                  beforeCatalogId,
                  campusIds,
                })),
              )
          )
            throw new ApplicationError('RATING_CATEGORY_CONTEXT_CHANGED');
          accepted = await this.review.accepted(p.envelope, tx);
        } catch (error) {
          const code = this.rejection(error);
          if (!code) throw error;
          if (beforeHeads) await retainCategoryHeads(beforeHeads, tx);
          const receipt = await this.close(actor, intent, hash, code, tx, true);
          await this.access.recheck(token, tx);
          return receipt;
        }
        const result = (
          await tx.query<{ receipt: unknown }>(
            'SELECT whaleu_ratings.category_command_publish($1,$2,$3,$4) receipt',
            [
              actor,
              intent.clientRequestId,
              p.context_revision,
              accepted.decisionId,
            ],
          )
        ).rows[0];
        const receipt = ratingCategoryReceiptSchema.parse(result?.receipt);
        if (receipt.outcome !== 'applied')
          throw new ApplicationError('RATING_UNAVAILABLE');
        await retainCategoryHeads(
          p.catalogs.map((row) => ({
            regionId: row.regionId,
            catalogId: row.afterCatalogId,
          })),
          tx,
          {
            actor,
            requestId: intent.clientRequestId,
            intentHash: hash,
            sessionId: session.sessionId,
            contextRevision: p.context_revision,
            releaseId: p.release_id,
            outcome: 'applied',
          },
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  cancel(token: string, intent: PrepareRatingCategories) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          hash = ratingCategoryIntentHash(intent),
          prior = await this.prior(session.accountId, intent, hash, tx);
        const receipt =
          prior ??
          (await this.close(
            session.accountId,
            intent,
            hash,
            'RATING_CATEGORY_CANCELLED',
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
            "SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND operation='create_categories' AND receipt IS NOT NULL",
            [session.accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const receipt = ratingCategoryReceiptSchema.parse(row.receipt);
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
