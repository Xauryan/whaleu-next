import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { RatingCategoryManagementAuthorityFacade } from '../../authorization/rating-category-management.facade.js';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import { RatingsAccessService } from '../access.js';
import { assertRatingCommandClaim } from '../management/requests.js';
import { RatingScopedReleaseRepository } from '../scoped/release.repository.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import type { RatingNavigationSelector } from '../scoped/contracts.js';
import { RatingCategoryManagementReader } from './scoped-reader.repository.js';
import { RatingCategorySourceIssuer } from './source-issuer.js';
import { planCategoryManagement, type CategoryManagementPlan } from './plan.js';
import * as C from './scoped-contracts.js';
interface Prepared {
  account_id: string;
  request_id: string;
  intent_hash: string;
  intent: C.RatingCategoryScopedIntent;
  session_id: string;
  context_revision: string;
  category_plan: CategoryManagementPlan;
  valid_until: Date;
}
async function fenceSnapshot(keys: string[], tx: PoolClient) {
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT jsonb_build_object('source',(SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton),'protocol',(SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton),'heads',whaleu_ratings.scoped_head_tuples($1::text[]),'vector',whaleu_ratings.scoped_current_source_vector($1::text[])) state`,
        [keys],
      )
    ).rows[0].state,
  );
}
const proof: RequiredTransactionProof<{ keys: string[]; fingerprint: string }> =
  {
    maximumFacts: 1,
    failureCode: 'RATING_SCOPE_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
        if (facts.length !== 1)
          throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
        await read.query(
          'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN ROW SHARE MODE NOWAIT',
        );
        await read.query(
          'SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton FOR SHARE NOWAIT',
        );
        await read.query(
          'SELECT epoch FROM whaleu_ratings.scope_protocol_epoch WHERE singleton FOR SHARE NOWAIT',
        );
        await read.query(
          'LOCK TABLE whaleu_ratings.scoped_catalog_heads IN SHARE MODE NOWAIT',
        );
        if (
          facts[0]!.fingerprint !== (await fenceSnapshot(facts[0]!.keys, read))
        )
          throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      }),
  };
async function retain(keys: string[], tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'category-management',
    Object.freeze({ keys, fingerprint: await fenceSnapshot(keys, tx) }),
  );
}
const queryScope = (s: RatingNavigationSelector) =>
  s.kind === 'global' ? 'global' : `campus:${s.campusId}`;

@Injectable()
export class RatingCategoryScopedManagementService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingCategoryManagementAuthorityFacade)
    private readonly authority: RatingCategoryManagementAuthorityFacade,
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingCategoryManagementReader)
    private readonly reader: RatingCategoryManagementReader,
    @Inject(RatingCategorySourceIssuer)
    private readonly issuer: RatingCategorySourceIssuer,
    @Inject(RatingScopedReleaseRepository)
    private readonly releases: RatingScopedReleaseRepository,
  ) {}
  private run<T>(fn: (tx: PoolClient) => Promise<T>) {
    return this.db.transaction(fn, { isolationLevel: 'read committed' });
  }
  private async enter(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    await tx.query("SET LOCAL statement_timeout='5s'");
    return this.access.authenticate(token, tx);
  }
  private async management(
    actor: string,
    selector: RatingNavigationSelector,
    tx: PoolClient,
  ) {
    await this.access.requireDeletionActor(actor, tx);
    const authority = await this.authority.resolve(actor, tx),
      domain = await this.campus.resolveCategoryManagementDomain(
        { accountId: actor },
        selector,
        authority,
        tx,
      );
    return { authority, domain };
  }
  context(token: string, input: { selector: RatingNavigationSelector }) {
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        { authority, domain } = await this.management(
          session.accountId,
          input.selector,
          tx,
        ),
        key = queryScope(input.selector),
        snapshot = await this.reader.snapshot(key, tx);
      const policies = snapshot.sources.filter(
        (s) =>
          s.source_kind === C.RATING_CATEGORY_MANAGEMENT_POLICY &&
          s.current &&
          s.scope_keys.includes(key) &&
          s.payload['enabled'] === true,
      );
      if (policies.length !== 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const policy = policies[0]!,
        operations = C.ratingCategoryScopedOperations.filter(
          (op) =>
            Array.isArray(policy.payload['operations']) &&
            policy.payload['operations'].includes(op),
        );
      if (!operations.length)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const logical = domain.view?.regionId ?? 'global',
        protocol = (
          await tx.query<{ versionId: string; generation: string }>(
            `SELECT p.id "versionId",p.generation FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=$1 AND p.phase='adopted'`,
            [logical],
          )
        ).rows[0];
      if (!protocol) throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const head = snapshot.heads.find((h) => h.scopeKey === key)!,
        id = randomUUID(),
        raw = randomBytes(32).toString('base64url'),
        tokenDigest = createHash('sha256').update(raw).digest('hex'),
        now = (await tx.query<{ at: Date }>('SELECT clock_timestamp() at'))
          .rows[0]!.at;
      const expires = new Date(
        Math.min(
          now.getTime() + 300000,
          snapshot.validUntil,
          domain.validUntil ?? Infinity,
          authority.validUntil ?? Infinity,
          policy.valid_until.getTime(),
        ),
      );
      const commandContext = {
        id,
        token: raw,
        tokenDigest,
        selector: input.selector,
        scopeRevision: ratingScopedDigest('category-context', {
          snapshot: snapshot.snapshotRevision,
          authority: authority.fingerprint,
          inventory: domain.inventoryFingerprint,
        }),
        protocolGeneration: protocol.generation,
        catalogRevision: head.catalogRevision,
        headRevision: head.headRevision,
        sourceDigest: snapshot.sourceDigest,
      };
      const context = {
        protocolVersion: 2,
        ...commandContext,
        actorId: session.accountId,
        purpose: 'manage_categories',
        mode: 'management',
        heads: [head],
        managementSnapshot: snapshot.snapshotRevision,
        expiresAt: expires.toISOString(),
        operations,
      };
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_contexts(id,account_id,session_id,token_digest,context,authority,protocol_tuples,issued_at,valid_until) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
        [
          id,
          session.accountId,
          session.sessionId,
          tokenDigest,
          canonicalJson(context),
          canonicalJson({
            topologySnapshotId: domain.topologySnapshotId,
            inventoryFingerprint: domain.inventoryFingerprint,
            authorizationMode: 'category_management',
            authorizationFingerprint: authority.fingerprint,
          }),
          canonicalJson([{ scopeKey: logical, ...protocol }]),
          now,
          expires,
        ],
      );
      registerTransactionDeadline(
        tx,
        expires.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
      await retain([key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategoryManagementContextSchema.parse({
        protocolVersion: 2,
        commandContext,
        expiresAt: expires.toISOString(),
        snapshotRevision: snapshot.snapshotRevision,
        campusIds: authority.campusIds,
        canManageGlobal: authority.global,
        operations,
      });
    });
  }
  private async load(
    token: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
  ) {
    const session = await this.access.authenticate(token, tx),
      row = (
        await tx.query<{
          session_id: string;
          context: Record<string, unknown>;
          authority: Record<string, unknown>;
          valid_until: Date;
          record_digest: string;
          current: boolean;
        }>(
          `SELECT *,whaleu_ratings.scoped_context_current(id,$2,$3,clock_timestamp()) current FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND account_id=$2 AND token_digest=$4 FOR SHARE`,
          [
            query.contextId,
            session.accountId,
            session.sessionId,
            createHash('sha256').update(query.contextToken).digest('hex'),
          ],
        )
      ).rows[0];
    if (
      !row?.current ||
      row.session_id !== session.sessionId ||
      row.context['purpose'] !== 'manage_categories' ||
      row.context['mode'] !== 'management'
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    const selector = row.context['selector'] as RatingNavigationSelector,
      { authority, domain } = await this.management(
        session.accountId,
        selector,
        tx,
      ),
      key = queryScope(selector),
      snapshot = await this.reader.snapshot(key, tx);
    if (
      snapshot.snapshotRevision !== row.context['managementSnapshot'] ||
      authority.fingerprint !== row.authority['authorizationFingerprint'] ||
      domain.inventoryFingerprint !== row.authority['inventoryFingerprint']
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    registerTransactionDeadline(
      tx,
      row.valid_until.getTime(),
      'RATING_SCOPED_CONTEXT_CHANGED',
    );
    return { session, row, selector, authority, domain, key, snapshot };
  }
  list(token: string, query: { contextId: string; contextToken: string }) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      const result = C.ratingManagedCategoriesSchema.parse({
        items: s.snapshot.categories
          .filter((r) => r.scopeKey === s.key)
          .map((r) => this.reader.view(r, s.snapshot)),
        snapshotRevision: s.snapshot.snapshotRevision,
        complete: true,
      });
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  detail(
    token: string,
    query: { contextId: string; contextToken: string },
    id: string,
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx),
        row = s.snapshot.categories.find(
          (r) => r.scopeKey === s.key && r.expected.body.id === id,
        );
      if (!row) throw new ApplicationError('RATING_NOT_FOUND');
      const view = this.reader.view(row, s.snapshot);
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return view;
    });
  }
  systemOptions(
    token: string,
    query: { contextId: string; contextToken: string },
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      const items = s.authority.global
        ? s.snapshot.sources
            .filter(
              (r) =>
                r.source_kind === C.RATING_CATEGORY_SYSTEM_REGISTRY &&
                r.current &&
                r.payload['enabled'] === true &&
                r.payload['kind'] === 'general' &&
                r.payload['consumer'] === 'ratings_general_v1',
            )
            .map((r) => ({
              systemKey: r.payload['systemKey'],
              kind: r.payload['kind'],
              maximumDepth: r.payload['maximumDepth'],
              allowCampusOverride: r.payload['allowCampusOverride'] === true,
              allowDisable: r.payload['allowDisable'] === true,
            }))
        : [];
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategorySystemOptionsSchema.parse({ items });
    });
  }
  history(
    token: string,
    query: {
      contextId: string;
      contextToken: string;
      cursor?: string | undefined;
    },
    id: string,
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      if (
        !s.snapshot.categories.some(
          (r) => r.scopeKey === s.key && r.expected.body.id === id,
        )
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      const rows = (
        await tx.query<{
          requestId: string;
          operation: string;
          outcome: string;
          releaseId: string | null;
          occurredAt: Date;
          cursor: string;
        }>(
          `SELECT whaleu_ratings.category_management_artifact(o.intent_hash,'category-history:'||o.account_id::text||':'||o.request_id::text) cursor,o.request_id "requestId",o.operation,o.outcome,o.result->>'releaseId' "releaseId",o.occurred_at "occurredAt" FROM whaleu_ratings.scoped_command_outcomes o JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(o.account_id,o.request_id) WHERE p.command_family='category' AND p.category_plan->'categoryIds' @> to_jsonb(ARRAY[$1::text]) AND p.category_plan->'affectedScopeKeys' @> to_jsonb(ARRAY[$4::text]) AND ($2::uuid IS NULL OR (o.occurred_at,o.account_id,o.request_id)<(SELECT previous.occurred_at,previous.account_id,previous.request_id FROM whaleu_ratings.scoped_command_outcomes previous JOIN whaleu_ratings.scoped_command_preparations prior ON (prior.account_id,prior.request_id)=(previous.account_id,previous.request_id) WHERE whaleu_ratings.category_management_artifact(previous.intent_hash,'category-history:'||previous.account_id::text||':'||previous.request_id::text)=$2 AND prior.category_plan->'categoryIds' @> to_jsonb(ARRAY[$1::text]) AND prior.category_plan->'affectedScopeKeys' @> to_jsonb(ARRAY[$4::text]) AND previous.operation IN (SELECT jsonb_array_elements_text($3::jsonb)) LIMIT 1)) ORDER BY o.occurred_at DESC,o.account_id DESC,o.request_id DESC LIMIT 101`,
          [
            id,
            query.cursor ?? null,
            canonicalJson(C.ratingCategoryScopedOperations),
            s.key,
          ],
        )
      ).rows;
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategoryManagementHistorySchema.parse({
        items: rows.slice(0, 100).map(({ cursor: _cursor, ...r }) => ({
          ...r,
          occurredAt: r.occurredAt.toISOString(),
        })),
        nextCursor: rows.length > 100 ? rows[99]!.cursor : null,
      });
    });
  }
  private async claim(
    actor: string,
    i: C.RatingCategoryScopedIntent,
    tx: PoolClient,
    request = false,
  ) {
    const hash = C.ratingCategoryScopedIntentHash(i);
    await assertRatingCommandClaim(
      actor,
      i.payload.clientRequestId,
      i.operation,
      hash,
      tx,
    );
    if (request)
      await tx.query(
        'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [actor, i.payload.clientRequestId, i.operation, hash],
      );
    const old = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        `SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
        [actor, i.payload.clientRequestId],
      )
    ).rows[0];
    if (old && (old.operation !== i.operation || old.intent_hash !== hash))
      throw new ApplicationError('REQUEST_CONFLICT');
    return old?.receipt
      ? C.ratingCategoryScopedReceiptSchema.parse(old.receipt)
      : null;
  }
  private async prepared(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Prepared>(
        "SELECT * FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2 AND command_family='category' FOR SHARE",
        [actor, id],
      )
    ).rows[0];
  }
  private preview(p: Prepared) {
    const v = p.category_plan;
    return C.ratingCategoryScopedPreparationSchema.parse({
      requestId: p.request_id,
      contextRevision: p.context_revision,
      categoryIds: v.categoryIds,
      affectedScopeKeys: v.affectedScopeKeys,
      changedSourceCount: v.sourceIssues.length,
      affectedTargetCount: v.affectedTargetCount,
      previewDigest: v.previewDigest,
      summary: `${v.categoryIds.length} categories; ${v.affectedScopeKeys.length} scopes; ${v.sourceIssues.length} exact source changes`,
      changes: v.changes,
      expiresAt: p.valid_until.toISOString(),
    });
  }
  prepare(token: string, raw: C.RatingCategoryScopedIntent) {
    const i = C.ratingCategoryScopedIntentSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        prior = await this.claim(session.accountId, i, tx);
      if (prior) {
        await this.access.recheck(token, tx);
        return prior;
      }
      const s = await this.load(
        token,
        { contextId: i.context.id, contextToken: i.context.token },
        tx,
      );
      this.intentContext(i, s);
      const old = await this.prepared(
        session.accountId,
        i.payload.clientRequestId,
        tx,
      );
      if (old) {
        if (
          old.intent_hash !== C.ratingCategoryScopedIntentHash(i) ||
          old.session_id !== session.sessionId ||
          old.valid_until.getTime() <= Date.now()
        )
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        const refreshed = planCategoryManagement(
          session.accountId,
          i,
          C.ratingCategoryScopedIntentHash(i),
          s.snapshot,
        );
        if (canonicalJson(refreshed) !== canonicalJson(old.category_plan))
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        this.authority.require(
          s.authority,
          refreshed.affectedScopeKeys
            .filter((k) => k !== 'global')
            .map((k) => k.slice(7)),
          refreshed.globalRequired,
          tx,
        );
        registerTransactionDeadline(
          tx,
          old.valid_until.getTime(),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        await retain(old.category_plan.affectedScopeKeys, tx);
        await this.access.recheck(token, tx);
        return this.preview(old);
      }
      const hash = C.ratingCategoryScopedIntentHash(i),
        plan = planCategoryManagement(session.accountId, i, hash, s.snapshot);
      this.authority.require(
        s.authority,
        plan.affectedScopeKeys
          .filter((k) => k !== 'global')
          .map((k) => k.slice(7)),
        plan.globalRequired,
        tx,
      );
      const expiry = new Date(
          Math.min(s.row.valid_until.getTime(), Date.parse(plan.validUntil)),
        ),
        contextRevision = randomBytes(32).toString('base64url');
      registerTransactionDeadline(
        tx,
        expiry.getTime(),
        'RATING_SCOPED_CONTEXT_CHANGED',
      );
      const p = (
        await tx.query<Prepared>(
          `INSERT INTO whaleu_ratings.scoped_command_preparations(account_id,request_id,operation,intent_hash,intent,context_id,session_id,context_revision,before_state,envelope,policy_source_id,policy_source_revision,valid_until,command_family,category_plan) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,NULL,$10,$11,$12,'category',$13::jsonb) RETURNING *`,
          [
            session.accountId,
            i.payload.clientRequestId,
            i.operation,
            hash,
            canonicalJson(i),
            i.context.id,
            session.sessionId,
            contextRevision,
            canonicalJson({
              heads: plan.beforeHeads,
              vector: plan.beforeVector,
              digest: plan.beforeDigest,
            }),
            plan.policySourceId,
            plan.policySourceRevision,
            expiry,
            canonicalJson(plan),
          ],
        )
      ).rows[0]!;
      await retain(plan.affectedScopeKeys, tx);
      await this.access.recheck(token, tx);
      return this.preview(p);
    });
  }
  private intentContext(
    i: C.RatingCategoryScopedIntent,
    s: Awaited<ReturnType<RatingCategoryScopedManagementService['load']>>,
  ) {
    const stored = s.row.context;
    const picked = Object.fromEntries(
      Object.keys(i.context).map((k) => [
        k,
        k === 'token' ? i.context.token : stored[k],
      ]),
    );
    if (
      canonicalJson(i.context) !== canonicalJson(picked) ||
      i.payload.expectedSnapshot !== s.snapshot.snapshotRevision
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
  }
  private async outcome(
    actor: string,
    i: C.RatingCategoryScopedIntent,
    value:
      | { outcome: 'applied' | 'noop'; result: unknown }
      | { outcome: 'closed'; code: string },
    tx: PoolClient,
  ) {
    const hash = C.ratingCategoryScopedIntentHash(i),
      receipt = C.ratingCategoryScopedReceiptSchema.parse({
        protocolVersion: 2,
        requestId: i.payload.clientRequestId,
        operation: i.operation,
        intentHash: hash,
        ...value,
      });
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result,code) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
      [
        actor,
        i.payload.clientRequestId,
        i.operation,
        hash,
        canonicalJson(i),
        value.outcome,
        'result' in value ? canonicalJson(value.result) : null,
        'code' in value ? value.code : null,
      ],
    );
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL',
      [actor, i.payload.clientRequestId, canonicalJson(receipt)],
    );
    return receipt;
  }
  commit(
    token: string,
    raw: {
      intent: C.RatingCategoryScopedIntent;
      preparationContextRevision: string;
    },
  ) {
    const input = C.ratingCategoryScopedCommitSchema.parse(raw),
      i = input.intent;
    return this.run(async (tx) => {
      const session = await this.enter(token, tx, true),
        prior = await this.claim(session.accountId, i, tx, true);
      if (prior) {
        await this.access.recheck(token, tx);
        return prior;
      }
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT category_management');
      let receipt: C.RatingCategoryScopedReceipt;
      try {
        const p = await this.prepared(
          session.accountId,
          i.payload.clientRequestId,
          tx,
        );
        if (
          !p ||
          p.context_revision !== input.preparationContextRevision ||
          p.intent_hash !== C.ratingCategoryScopedIntentHash(i) ||
          canonicalJson(p.intent) !== canonicalJson(i) ||
          p.session_id !== session.sessionId ||
          p.valid_until.getTime() <= Date.now()
        )
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        const s = await this.load(
          token,
          { contextId: i.context.id, contextToken: i.context.token },
          tx,
        );
        this.intentContext(i, s);
        const plan = planCategoryManagement(
          session.accountId,
          i,
          p.intent_hash,
          s.snapshot,
        );
        if (canonicalJson(plan) !== canonicalJson(p.category_plan))
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        this.authority.require(
          s.authority,
          plan.affectedScopeKeys
            .filter((k) => k !== 'global')
            .map((k) => k.slice(7)),
          plan.globalRequired,
          tx,
        );
        registerTransactionDeadline(
          tx,
          p.valid_until.getTime(),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        const domains = await this.campus.resolveCategoryManagementDomains(
          { accountId: session.accountId },
          plan.affectedScopeKeys.map((key) =>
            key === 'global'
              ? ({ kind: 'global' } as const)
              : ({ kind: 'campus', campusId: key.slice(7) } as const),
          ),
          s.authority,
          tx,
        );
        const executionId = ratingScopedDigest('category-execution', {
          accountId: session.accountId,
          requestId: p.request_id,
          planDigest: plan.previewDigest,
        });
        await tx.query(
          `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'category_execution',$3,$3,$4::jsonb)`,
          [
            session.accountId,
            p.request_id,
            i.context.id,
            canonicalJson({
              intentHash: p.intent_hash,
              planDigest: plan.previewDigest,
              contextRevision: p.context_revision,
              executionDigest: executionId,
            }),
          ],
        );
        let releaseId: string | null = null,
          heads = plan.beforeHeads;
        if (!plan.noop) {
          await this.issuer.issue(plan, tx);
          const release = await this.releases.publishMany(
            domains,
            {
              kind: 'category_management',
              accountId: session.accountId,
              requestId: p.request_id,
            },
            tx,
          );
          releaseId = release.releaseId;
          heads = release.outputs.map((o) => ({
            scopeKey: o.scopeKey,
            catalogRevision: o.id,
            headRevision: o.headRevision,
          }));
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'category_release',$3,$3,$4::jsonb)`,
            [
              session.accountId,
              p.request_id,
              releaseId,
              canonicalJson({ planDigest: plan.previewDigest, heads }),
            ],
          );
        }
        const occurredAt = (
          await tx.query<{ at: Date }>('SELECT clock_timestamp() at')
        ).rows[0]!.at.toISOString();
        receipt = await this.outcome(
          session.accountId,
          i,
          {
            outcome: plan.noop ? 'noop' : 'applied',
            result: {
              releaseId,
              categoryIds: plan.categoryIds,
              heads,
              occurredAt,
            },
          },
          tx,
        );
        await retain(plan.affectedScopeKeys, tx);
        await tx.query('RELEASE SAVEPOINT category_management');
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !C.ratingCategoryScopedReceiptSchema.options[1].shape.code.safeParse(
            error.code,
          ).success
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT category_management');
        restoreTransactionDeadlines(tx, checkpoint);
        receipt = await this.outcome(
          session.accountId,
          i,
          { outcome: 'closed', code: error.code },
          tx,
        );
      }
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
  cancel(token: string, raw: C.RatingCategoryScopedIntent) {
    const i = C.ratingCategoryScopedIntentSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        prior = await this.claim(session.accountId, i, tx, true),
        receipt =
          prior ??
          (await this.outcome(
            session.accountId,
            i,
            { outcome: 'closed', code: 'RATING_CATEGORY_CANCELLED' },
            tx,
          ));
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
}
