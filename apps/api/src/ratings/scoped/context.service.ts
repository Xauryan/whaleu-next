import {
  ratingTargetCoverContextSchema,
  type RatingCurrentContext,
  type RatingTargetCoverContext,
} from './target-cover-contracts.js';
import { retainRatingReadByteCount } from '../target-cover-current.js';
import { targetCoverCapabilities } from './target-cover-capability.js';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.js';
import type { SessionView } from '../../identity/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { RatingsAccessService } from '../access.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingAuthorizationFacade } from '../../authorization/rating-grants.facade.js';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import type { RatingScopedCampusProof } from '../../campus/rating-scoped-context.facade.js';
import type { PublicationAffiliationMetadata } from '../../campus/community-policy/contracts.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import {
  canonicalEqual,
  canonicalJson,
} from '../../community/content-review/contracts.js';
import { RatingScopedSourceFacade } from './source.facade.js';
import { ratingScopedDigest } from './protocol-registry.js';
import {
  ratingScopedContextRequestSchema,
  ratingScopedContextSchema,
  ratingScopedLocatorSchema,
  ratingScopedReadQuerySchema,
  scopedId,
} from './contracts.js';
import type {
  RatingScopedContextRequest,
  RatingScopedContext,
  RatingNavigationSelector,
} from './contracts.js';
import {
  RATING_SCOPED_CAPABILITY_VERSION,
  RATING_SCOPED_REQUIRED_CAPABILITIES,
  RATING_SCOPED_SCOPE_LIMIT,
  RATING_SCOPED_BYTE_LIMIT,
} from './constants.js';

export interface RatingScopedCatalog {
  readonly id: string;
  readonly scopeKey: string;
  readonly regionId: string | null;
  readonly campusId: string | null;
  readonly headRevision: string;
  readonly sourceDigest: string;
}
export interface RatingScopedProtocolTuple {
  readonly scopeKey: string;
  readonly versionId: string;
  readonly generation: string;
}
declare const resolvedBrand: unique symbol;
export interface ResolvedRatingScope {
  readonly [resolvedBrand]: true;
  readonly actor: string;
  readonly actorId: string;
  readonly session: SessionView;
  readonly context: RatingCurrentContext;
  readonly catalog: RatingScopedCatalog;
  readonly campusProof: RatingScopedCampusProof;
  readonly deadline: number;
  readonly contextId: string;
  readonly selector: RatingNavigationSelector;
  readonly protocolGeneration: string;
  readonly catalogRevision: string;
  readonly headRevision: string;
  readonly scopeRevision: string;
  readonly sourceDigest: string;
  readonly authorized: boolean;
  readonly write: boolean;
  readonly targetCoverCapable: boolean;
}
/** Internal recipient proof has no bearer token, synthetic session, or public context. */
export interface ResolvedRatingRecipientScope {
  readonly [resolvedBrand]: true;
  readonly actor: string;
  readonly catalog: RatingScopedCatalog;
  readonly campusProof: RatingScopedCampusProof;
  readonly selector: RatingNavigationSelector;
  readonly protocolGeneration: string;
  readonly deadline: number;
  readonly authorized: boolean;
  readonly write: false;
}
export type ResolvedRatingReadScope =
  ResolvedRatingScope | ResolvedRatingRecipientScope;
export interface ResolvedRatingRandomScope {
  readonly actor: string;
  readonly session: SessionView;
  readonly context: RatingCurrentContext;
  readonly campusProof: RatingScopedCampusProof;
  readonly deadline: number;
  readonly scopes: readonly ResolvedRatingScope[];
  readonly observedBytes: number;
}
interface HeadTuple {
  scopeKey: string;
  catalogId: string;
  headRevision: string;
  releaseId: string;
}
interface Snapshot {
  epochs: string;
  heads: readonly HeadTuple[];
  protocols: readonly RatingScopedProtocolTuple[];
}
interface RootState {
  tx: PoolClient;
  readEpoch: object;
  contextId: string;
  scopeKeys: readonly string[];
  logicalKeys: readonly string[];
  write: boolean;
  retained: boolean;
}
const resolved = new WeakMap<object, RootState>();
const randomResolved = new WeakMap<object, RootState>();
export function assertResolvedRatingScope(
  scope: ResolvedRatingReadScope,
  tx: PoolClient,
  allowDenied = false,
): void {
  const state = resolved.get(scope);
  if (!state || state.tx !== tx || state.readEpoch !== transactionReadEpoch(tx))
    unavailable();
  if (!allowDenied && !scope.authorized)
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
export function assertResolvedRatingRandomScope(
  scope: ResolvedRatingRandomScope,
  tx: PoolClient,
): void {
  const state = randomResolved.get(scope);
  if (!state || state.tx !== tx || state.readEpoch !== transactionReadEpoch(tx))
    unavailable();
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
function changed(): never {
  throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
const key = (selector: RatingNavigationSelector) =>
  selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`;
async function epochs(tx: PoolClient): Promise<string> {
  const rows = (
    await tx.query<{
      kind: string;
      singleton: boolean;
      version: number;
      epoch: string;
    }>(`SELECT 'source' kind,singleton,version,epoch::text FROM whaleu_ratings.scoped_source_epoch
 UNION ALL SELECT 'protocol',singleton,version,epoch::text FROM whaleu_ratings.scope_protocol_epoch ORDER BY kind`)
  ).rows;
  if (
    rows.length !== 2 ||
    rows[0]?.kind !== 'protocol' ||
    rows[1]?.kind !== 'source' ||
    rows.some(
      (r) =>
        r.singleton !== true ||
        r.version !== 1 ||
        !/^(0|[1-9][0-9]*)$/.test(r.epoch) ||
        BigInt(r.epoch) > 9223372036854775807n,
    )
  )
    unavailable();
  return ownerFingerprint(rows);
}
async function snapshot(
  scopeKeys: readonly string[],
  logicalKeys: readonly string[],
  tx: PoolClient,
): Promise<Snapshot> {
  const fingerprint = await epochs(tx);
  const heads = (
    await tx.query<HeadTuple>(
      `SELECT scope_key "scopeKey",catalog_id "catalogId",head_revision "headRevision",release_id "releaseId"
 FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key=ANY($1::text[]) ORDER BY scope_key COLLATE "C"`,
      [[...scopeKeys].sort()],
    )
  ).rows;
  const protocols = (
    await tx.query<RatingScopedProtocolTuple>(
      `SELECT h.logical_scope_key "scopeKey",v.id "versionId",v.generation
 FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id AND v.logical_scope_key=h.logical_scope_key
 WHERE h.logical_scope_key=ANY($1::text[]) AND v.phase='adopted' ORDER BY h.logical_scope_key COLLATE "C"`,
      [[...logicalKeys].sort()],
    )
  ).rows;
  if (
    heads.length !== scopeKeys.length ||
    protocols.length !== logicalKeys.length
  )
    unavailable();
  return freeze({ epochs: fingerprint, heads, protocols });
}
interface SnapshotFact {
  scopeKeys: readonly string[];
  logicalKeys: readonly string[];
  snapshot: Snapshot;
}
const snapshotProof: RequiredTransactionProof<SnapshotFact> = {
  maximumFacts: 4,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN ROW SHARE MODE NOWAIT',
      );
      // Source/protocol statement writers update these retained rows before
      // business mutation. Exact shared row fences admit VACUUM while excluding
      // those writes; the complete fixed-shape epoch snapshot below still
      // rejects missing, extra, malformed or changed rows.
      await read.query(
        'SELECT singleton,version,epoch FROM whaleu_ratings.scoped_source_epoch FOR SHARE NOWAIT',
      );
      await read.query(
        'SELECT singleton,version,epoch FROM whaleu_ratings.scope_protocol_epoch FOR SHARE NOWAIT',
      );
      // Catalog-head writers advance navigation/random rather than source, so
      // their whole relation fence remains necessary for this snapshot owner.
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_catalog_heads,whaleu_ratings.scope_protocol_heads IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          !canonicalEqual(
            fact.snapshot,
            await snapshot(fact.scopeKeys, fact.logicalKeys, read),
          )
        )
          unavailable();
    }),
};
function retainSnapshot(
  state: RootState,
  value: Snapshot,
  tx: PoolClient,
): void {
  enableRequiredTransactionProof(tx, snapshotProof);
  registerRequiredTransactionFact(
    tx,
    snapshotProof,
    `${state.contextId}:${ownerFingerprint(value)}`,
    freeze({
      scopeKeys: state.scopeKeys,
      logicalKeys: state.logicalKeys,
      snapshot: value,
    }),
  );
  state.retained = true;
}
/** An authorized writer retains only the after source/head epochs, while the
 * immutable original context, source tuples and owner authority remain proved. */
export async function retainResolvedRatingScopeAfter(
  scope: ResolvedRatingReadScope,
  tx: PoolClient,
): Promise<void> {
  assertResolvedRatingScope(scope, tx, true);
  const state = resolved.get(scope)!;
  if (state.retained) return;
  retainSnapshot(
    state,
    await snapshot(state.scopeKeys, state.logicalKeys, tx),
    tx,
  );
}
interface ContextRow {
  id: string;
  account_id: string;
  session_id: string;
  token_digest: string;
  context: unknown;
  authority: unknown;
  protocol_tuples: unknown;
  issued_at: Date;
  valid_until: Date;
}
interface ContextFact {
  id: string;
  accountId: string;
  sessionId: string;
  tokenDigest: string;
  digest: string;
}
const contextProof: RequiredTransactionProof<ContextFact> = {
  maximumFacts: 8,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      // Immutable contexts need only their exact rows, not exclusion of other
      // issuances. Explicit ROW SHARE NOWAIT also bounds relation-lock conflicts
      // before the exact row fence (including concurrent DDL/TRUNCATE attempts).
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_contexts IN ROW SHARE MODE NOWAIT',
      );
      const rows = (
        await read.query<{
          id: string;
          account_id: string;
          session_id: string;
          token_digest: string;
          digest: string;
          valid: boolean;
        }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
   SELECT c.id,c.account_id,c.session_id,c.token_digest,c.record_digest digest,
   isfinite(c.issued_at) AND c.issued_at<=instant.now AND isfinite(c.valid_until) AND c.valid_until>instant.now valid
   FROM whaleu_ratings.scoped_contexts c CROSS JOIN instant WHERE c.id=ANY($1::uuid[]) FOR SHARE OF c NOWAIT`,
          [facts.map((f) => f.id)],
        )
      ).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const f of facts) {
        const r = byId.get(f.id);
        if (
          !r ||
          !r.valid ||
          r.account_id !== f.accountId ||
          r.session_id !== f.sessionId ||
          r.token_digest !== f.tokenDigest ||
          r.digest !== f.digest
        )
          unavailable();
      }
    }),
};
interface CatalogRead {
  id: string;
  scope_key: string;
  campus_id: string | null;
  region_id: string | null;
  head_revision: string;
  release_id: string;
  source_digest: string;
  valid_until: Date;
  valid: boolean;
}
interface AuthorityCapture {
  campus: RatingScopedCampusProof;
  catalogs: CatalogRead[];
  protocols: RatingScopedProtocolTuple[];
  logicalKeys: string[];
  sourceDigest: string;
  authority: Record<string, unknown>;
  deadline: number;
  snapshot: Snapshot;
  observedBytes: number;
}
interface Capture extends AuthorityCapture {
  session: SessionView;
  scopeRevision: string;
}
@Injectable()
export class RatingScopedContextService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingAuthorizationFacade)
    private readonly authorization: RatingAuthorizationFacade,
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingScopedSourceFacade)
    private readonly sources: RatingScopedSourceFacade,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
  ) {}
  private protocolGeneration(
    selector: RatingScopedContextRequest['selector'],
    captured: AuthorityCapture,
  ): string {
    const campusId =
      selector.kind === 'global'
        ? null
        : selector.kind === 'campus'
          ? selector.campusId
          : selector.anchorCampusId;
    const logical =
      campusId === null
        ? 'global'
        : captured.campus.mappings.find((m) => m.campusId === campusId)
            ?.regionId;
    const generation = captured.protocols.find(
      (p) => p.scopeKey === logical,
    )?.generation;
    if (!generation) unavailable();
    return generation;
  }
  private sessionGeneration(token: string, session: SessionView): string {
    return ratingScopedDigest('session', {
      accountId: session.accountId,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      tokenDigest: createHash('sha256').update(token).digest('hex'),
    });
  }
  private async captureAuthority(
    accountId: string,
    request: RatingScopedContextRequest,
    tx: PoolClient,
    protocolVersion: 2 | 3 = 2,
  ): Promise<AuthorityCapture> {
    const base = await this.access.resolveAccount(accountId, null, tx, {
      phone: true,
    });
    const phone = await this.verification.phone(accountId, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    let affiliation: PublicationAffiliationMetadata | null = null,
      affiliationFingerprint: string | null = null,
      grantFingerprint: string | null = null;
    const needsCampus = request.selector.kind !== 'global';
    if (request.mode === 'public' && needsCampus) {
      const result = await this.verification.affiliation(accountId, tx);
      affiliationFingerprint = result.fingerprint;
      if (result.status === 'unverified')
        throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
      if (result.status !== 'verified')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      affiliation = result;
    }
    let campus: RatingScopedCampusProof;
    if (request.mode === 'admin_preview') {
      const grant = await this.authorization.scope(accountId, tx);
      grantFingerprint = grant.fingerprint;
      if (request.purpose !== 'read') unavailable();
      campus = await this.campus.resolveManagedNavigation(
        { accountId: accountId, affiliation: null },
        request.selector,
        grant,
        tx,
      );
    } else if (request.purpose === 'random')
      campus = await this.campus.resolveRandomCandidates(
        { accountId: accountId, affiliation },
        request.selector,
        tx,
      );
    else
      campus = await this.campus.resolveNavigation(
        { accountId: accountId, affiliation },
        request.selector,
        tx,
      );
    if (
      campus.scopeKeys.length < 1 ||
      campus.scopeKeys.length > RATING_SCOPED_SCOPE_LIMIT
    )
      unavailable();
    const logicalKeys = [
      ...new Set(
        campus.scopeKeys.map((scopeKey) => {
          if (scopeKey === 'global') return 'global';
          const mapping = campus.mappings.find(
            (m) => `campus:${m.campusId}` === scopeKey && m.isActive,
          );
          if (!mapping) unavailable();
          return mapping.regionId;
        }),
      ),
    ].sort();
    const beforeEpoch = await epochs(tx);
    const protocolRows = (
      await tx.query<
        RatingScopedProtocolTuple & { valid_until: Date; valid: boolean }
      >(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
   SELECT h.logical_scope_key "scopeKey",v.id "versionId",v.generation,least(r.valid_until,s.valid_until) valid_until,
   coalesce(v.phase='adopted' AND r.cause_kind='protocol_activation' AND r.cause->>'generation'=v.generation::text
    AND s.source_kind='scope_capabilities' AND s.payload->>'capabilityVersion'=$2
    AND s.payload->'protocolVersion'='2'::jsonb AND s.payload->'reviewVersion'='5'::jsonb AND s.payload->'journalVersion'='9'::jsonb
    AND s.payload->>'routesDigest' ~ '^[a-f0-9]{64}$' AND s.payload->>'nativeDigest' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(s.payload->'capabilities')='array' AND s.payload->'capabilities' @> $3::jsonb AND whaleu_ratings.scoped_source_current(s.id,s.revision,instant.now)
    AND isfinite(r.valid_until) AND r.valid_until>instant.now,false) valid
   FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON (v.id,v.logical_scope_key)=(h.version_id,h.logical_scope_key)
   JOIN whaleu_ratings.scoped_releases r ON r.id=v.release_id JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(v.capability_source_id,v.capability_source_revision)
   CROSS JOIN instant WHERE h.logical_scope_key=ANY($1::text[]) ORDER BY h.logical_scope_key COLLATE "C"`,
        [
          logicalKeys,
          RATING_SCOPED_CAPABILITY_VERSION,
          JSON.stringify(RATING_SCOPED_REQUIRED_CAPABILITIES),
        ],
      )
    ).rows;
    if (
      protocolRows.length !== logicalKeys.length ||
      protocolRows.some(
        (r, i) =>
          r.scopeKey !== logicalKeys[i] ||
          r.valid !== true ||
          !scopedId.safeParse(r.versionId).success ||
          !scopedId.safeParse(r.generation).success ||
          !(r.valid_until instanceof Date),
      )
    )
      unavailable();
    const catalogs = (
      await tx.query<CatalogRead>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
   SELECT c.id,c.scope_key,c.campus_id,c.region_id,c.head_revision,c.release_id,c.source_digest,c.valid_until,
    whaleu_ratings.scoped_catalog_current(c.id,instant.now) valid FROM whaleu_ratings.scoped_catalog_heads h
   JOIN whaleu_ratings.scoped_catalogs c ON (c.id,c.scope_key,c.release_id,c.head_revision)=(h.catalog_id,h.scope_key,h.release_id,h.head_revision)
   CROSS JOIN instant WHERE h.scope_key=ANY($1::text[]) ORDER BY h.scope_key COLLATE "C" FOR SHARE OF h,c`,
        [[...campus.scopeKeys].sort()],
      )
    ).rows;
    if (
      catalogs.length !== campus.scopeKeys.length ||
      catalogs.some(
        (r, i) =>
          r.scope_key !== [...campus.scopeKeys].sort()[i] ||
          r.valid !== true ||
          !scopedId.safeParse(r.id).success ||
          !scopedId.safeParse(r.head_revision).success ||
          !(r.valid_until instanceof Date),
      )
    )
      unavailable();
    for (const catalog of catalogs) {
      const mapping =
        catalog.scope_key === 'global'
          ? null
          : campus.mappings.find(
              (m) => `campus:${m.campusId}` === catalog.scope_key,
            );
      if (
        catalog.campus_id !== (mapping?.campusId ?? null) ||
        catalog.region_id !== (mapping?.regionId ?? null)
      )
        unavailable();
    }
    const source = await this.sources.readExactSourceVector(
      campus.scopeKeys,
      tx,
    );
    for (const catalog of catalogs) {
      const vector = source.rows
        .filter((r) => r.scope_keys.includes(catalog.scope_key))
        .map((r) => ({
          id: r.id,
          revision: r.revision,
          kind: r.source_kind,
          key: r.source_key,
          digest: r.digest,
        }));
      if (catalog.source_digest !== ratingScopedDigest('vector', vector))
        unavailable();
    }
    let creationPolicy: Record<string, unknown> | null = null;
    if (request.purpose === 'create_target') {
      const policy = await this.sources.requireCreationPolicy(
        key(request.selector),
        tx,
      );
      creationPolicy = {
        id: policy.id,
        revision: policy.revision,
        digest: policy.digest,
      };
    }
    const protocols = protocolRows.map(
      ({ scopeKey, versionId, generation }) => ({
        scopeKey,
        versionId,
        generation,
      }),
    );
    const sourceDigest = ratingScopedDigest('vector', source.vector);
    const coverCapabilities =
      protocolVersion === 3
        ? await targetCoverCapabilities(
            protocols.map((p) => p.versionId),
            tx,
          )
        : null;
    const authority = {
      baseFingerprint: base.fingerprint,
      phoneFingerprint: phone.fingerprint,
      campusFingerprint: campus.fingerprint,
      inventoryFingerprint: campus.inventoryFingerprint,
      topologySnapshotId: campus.topologySnapshotId,
      origin: campus.origin,
      identity: campus.identity,
      affiliationFingerprint,
      grantFingerprint,
      sourceVector: source.vector,
      creationPolicy,
      ...(protocolVersion === 3
        ? {
            contextAuthority: 'ratings-target-cover-context-v1',
            targetCoverCapabilities: coverCapabilities,
          }
        : {}),
    };
    const deadline = Math.min(
      campus.validUntil ?? Infinity,
      source.validUntil,
      ...catalogs.map((c) => c.valid_until.getTime()),
      ...protocolRows.map((r) => r.valid_until.getTime()),
      ...(coverCapabilities ?? []).flatMap((capability) =>
        capability.current && 'validUntil' in capability
          ? [Date.parse(capability.validUntil!)]
          : [],
      ),
    );
    if (!Number.isFinite(deadline)) unavailable();
    registerTransactionDeadline(tx, deadline, 'RATING_SCOPE_UNAVAILABLE');
    await this.review.navigation(tx);
    const finalSnapshot = await snapshot(campus.scopeKeys, logicalKeys, tx);
    if (
      beforeEpoch !== finalSnapshot.epochs ||
      !canonicalEqual(protocols, finalSnapshot.protocols) ||
      !canonicalEqual(
        catalogs.map((c) => ({
          scopeKey: c.scope_key,
          catalogId: c.id,
          headRevision: c.head_revision,
          releaseId: c.release_id,
        })),
        finalSnapshot.heads,
      )
    )
      unavailable();
    const observedBytes =
      source.budget.snapshot().bytes +
      Buffer.byteLength(
        canonicalJson({ campus, catalogs, protocols, authority }),
        'utf8',
      );
    if (observedBytes > RATING_SCOPED_BYTE_LIMIT) unavailable();
    retainRatingReadByteCount(tx, observedBytes);
    return {
      campus,
      catalogs,
      protocols,
      logicalKeys,
      sourceDigest,
      authority,
      deadline,
      snapshot: finalSnapshot,
      observedBytes,
    };
  }
  private async capture(
    token: string,
    request: RatingScopedContextRequest,
    tx: PoolClient,
    protocolVersion: 2 | 3 = 2,
  ): Promise<Capture> {
    const session = await this.access.authenticate(token, tx);
    const captured = await this.captureAuthority(
      session.accountId,
      request,
      tx,
      protocolVersion,
    );
    const authority = {
      ...captured.authority,
      sessionGeneration: this.sessionGeneration(token, session),
    };
    const scopeRevision = ratingScopedDigest(
      protocolVersion === 3 ? 'target-cover-context' : 'context',
      {
        actorId: session.accountId,
        purpose: request.purpose,
        mode: request.mode,
        selector: request.selector,
        authority,
        protocols: captured.protocols,
        heads: captured.catalogs.map((c) => ({
          scopeKey: c.scope_key,
          catalogId: c.id,
          headRevision: c.head_revision,
          releaseId: c.release_id,
          sourceDigest: c.source_digest,
        })),
      },
    );
    const deadline = Math.min(session.expiresAt, captured.deadline);
    registerTransactionDeadline(tx, deadline, 'RATING_SCOPE_UNAVAILABLE');
    const observedBytes =
      captured.observedBytes +
      Buffer.byteLength(canonicalJson(authority), 'utf8') -
      Buffer.byteLength(canonicalJson(captured.authority), 'utf8');
    if (observedBytes > RATING_SCOPED_BYTE_LIMIT) unavailable();
    return {
      ...captured,
      session,
      authority,
      scopeRevision,
      deadline,
      observedBytes,
    };
  }
  /** The captured cause selects global versus campus semantics. A campus recipient
   * is resolved through their own current explicit identity selection, never the
   * sender's campus, a region guess, or the first currently readable campus. */
  async resolveRecipient(
    accountId: string,
    causeSelector: RatingNavigationSelector,
    tx: PoolClient,
  ): Promise<ResolvedRatingRecipientScope> {
    let selector: RatingNavigationSelector = causeSelector;
    if (causeSelector.kind === 'campus') {
      await this.access.resolveAccount(accountId, null, tx, { phone: true });
      const affiliation = await this.verification.affiliation(accountId, tx);
      if (affiliation.status !== 'verified')
        throw new ApplicationError(
          affiliation.status === 'unverified'
            ? 'AFFILIATION_VERIFICATION_REQUIRED'
            : 'VERIFICATION_UNAVAILABLE',
        );
      const identity = await this.campus.resolveNavigation(
        { accountId, affiliation },
        { kind: 'global' },
        tx,
      );
      if (!identity.identity)
        throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
      selector = { kind: 'campus', campusId: identity.identity.campusId };
    }
    const captured = await this.captureAuthority(
      accountId,
      { selector, purpose: 'read', mode: 'public' },
      tx,
    );
    if (captured.catalogs.length !== 1) unavailable();
    const catalog = captured.catalogs[0]!;
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) unavailable();
    const state: RootState = {
      tx,
      readEpoch,
      contextId: `recipient:${accountId}:${key(selector)}`,
      scopeKeys: captured.campus.scopeKeys,
      logicalKeys: captured.logicalKeys,
      write: false,
      retained: false,
    };
    retainSnapshot(state, captured.snapshot, tx);
    const result = freeze({
      actor: accountId,
      selector,
      catalog: {
        id: catalog.id,
        scopeKey: catalog.scope_key,
        regionId: catalog.region_id,
        campusId: catalog.campus_id,
        headRevision: catalog.head_revision,
        sourceDigest: catalog.source_digest,
      },
      campusProof: captured.campus,
      protocolGeneration: this.protocolGeneration(selector, captured),
      deadline: captured.deadline,
      authorized:
        catalog.campus_id === null ||
        captured.campus.authorization.some(
          (entry) =>
            entry.campusId === catalog.campus_id && entry.decision === 'allow',
        ),
      write: false as const,
    }) as ResolvedRatingRecipientScope;
    resolved.set(result, state);
    return result;
  }
  private retainContext(
    row: ContextRow,
    context: RatingCurrentContext,
    tx: PoolClient,
  ): void {
    enableRequiredTransactionProof(tx, contextProof);
    const digest = ratingScopedDigest(
      context.protocolVersion === 3
        ? 'target-cover-context-record'
        : 'context-record',
      {
        context: row.context,
        authority: row.authority,
        protocolTuples: row.protocol_tuples,
      },
    );
    registerRequiredTransactionFact(
      tx,
      contextProof,
      row.id,
      freeze({
        id: row.id,
        accountId: row.account_id,
        sessionId: row.session_id,
        tokenDigest: row.token_digest,
        digest,
      }),
    );
    registerTransactionDeadline(
      tx,
      Date.parse(context.expiresAt),
      'RATING_SCOPE_UNAVAILABLE',
    );
  }
  private async issue(
    token: string,
    input: RatingScopedContextRequest,
    tx: PoolClient,
    protocolVersion: 2 | 3 = 2,
  ): Promise<RatingCurrentContext> {
    const request = ratingScopedContextRequestSchema.parse(input),
      captured = await this.capture(token, request, tx, protocolVersion);
    const instant = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now;
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()))
      unavailable();
    const contextId = randomUUID(),
      secret = randomBytes(32).toString('base64url'),
      expiresAt = Math.min(instant.getTime() + 300000, captured.deadline);
    if (expiresAt <= instant.getTime()) unavailable();
    const generation = this.protocolGeneration(request.selector, captured);
    const context = (
      protocolVersion === 3
        ? ratingTargetCoverContextSchema
        : ratingScopedContextSchema
    ).parse({
      protocolVersion,
      id: contextId,
      token: secret,
      tokenDigest: createHash('sha256').update(secret).digest('hex'),
      actorId: captured.session.accountId,
      sessionGeneration: this.sessionGeneration(token, captured.session),
      selector: request.selector,
      purpose: request.purpose,
      mode: request.mode,
      scopeRevision: captured.scopeRevision,
      protocolGeneration: generation,
      heads: captured.catalogs.map((c) => ({
        scopeKey: c.scope_key,
        catalogRevision: c.id,
        headRevision: c.head_revision,
      })),
      sourceDigest: captured.sourceDigest,
      identityCampusId: captured.campus.identity?.campusId ?? null,
      issuedAt: instant.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      capabilities:
        request.mode === 'admin_preview'
          ? ['read']
          : request.purpose === 'random'
            ? ['random']
            : [
                request.purpose,
                ...(protocolVersion === 3 &&
                (
                  captured.authority['targetCoverCapabilities'] as {
                    current: boolean;
                  }[]
                ).every((c) => c.current)
                  ? ['target_cover']
                  : []),
              ],
    });
    const row = (
      await tx.query<ContextRow>(
        `INSERT INTO whaleu_ratings.scoped_contexts(id,account_id,session_id,token_digest,context,authority,protocol_tuples,issued_at,valid_until)
   VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9) RETURNING *`,
        [
          context.id,
          captured.session.accountId,
          captured.session.sessionId,
          context.tokenDigest,
          canonicalJson(context),
          canonicalJson(captured.authority),
          canonicalJson(captured.protocols),
          instant,
          new Date(expiresAt),
        ],
      )
    ).rows[0];
    if (!row) unavailable();
    this.retainContext(row, context, tx);
    const state: RootState = {
      tx,
      readEpoch: transactionReadEpoch(tx)!,
      contextId: context.id,
      scopeKeys: captured.campus.scopeKeys,
      logicalKeys: captured.logicalKeys,
      write: false,
      retained: false,
    };
    retainSnapshot(state, captured.snapshot, tx);
    await this.access.recheck(token, tx);
    return freeze(context);
  }
  create(
    token: string,
    request: RatingScopedContextRequest,
    tx?: PoolClient,
  ): Promise<RatingScopedContext> {
    return tx
      ? this.issue(token, request, tx).then((c) =>
          ratingScopedContextSchema.parse(c),
        )
      : this.db.transaction(
          async (client) =>
            ratingScopedContextSchema.parse(
              await this.issue(token, request, client),
            ),
          {
            isolationLevel: 'read committed',
          },
        );
  }
  createCover(
    token: string,
    request: RatingScopedContextRequest,
    tx?: PoolClient,
  ): Promise<RatingTargetCoverContext> {
    const run = async (client: PoolClient) =>
      ratingTargetCoverContextSchema.parse(
        await this.issue(token, request, client, 3),
      );
    return tx
      ? run(tx)
      : this.db.transaction(run, { isolationLevel: 'read committed' });
  }
  private async load(
    token: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
    write: boolean,
    expectedProtocol: 2 | 3 = 2,
  ) {
    // Route-specific strict schemas already validate pagination/filter fields.
    // This owner consumes only the authentication tuple, never those filters.
    const input = ratingScopedReadQuerySchema.parse({
      contextId: query.contextId,
      contextToken: query.contextToken,
    });
    const row = (
      await tx.query<ContextRow>(
        'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND token_digest=$2',
        [
          input.contextId,
          createHash('sha256').update(input.contextToken).digest('hex'),
        ],
      )
    ).rows[0];
    if (!row) changed();
    let context: RatingCurrentContext;
    try {
      const storedVersion = (row.context as { protocolVersion?: unknown })
        .protocolVersion;
      context = (
        storedVersion === 3
          ? ratingTargetCoverContextSchema
          : ratingScopedContextSchema
      ).parse(row.context);
      if (context.protocolVersion !== expectedProtocol) changed();
      if (
        context.protocolVersion === 3 &&
        (row.authority as Record<string, unknown>)['contextAuthority'] !==
          'ratings-target-cover-context-v1'
      )
        unavailable();
    } catch {
      unavailable();
    }
    if (
      context.token !== input.contextToken ||
      row.token_digest !== context.tokenDigest ||
      row.id !== context.id ||
      row.account_id !== context.actorId ||
      !(row.issued_at instanceof Date) ||
      !(row.valid_until instanceof Date) ||
      row.issued_at.getTime() !== Date.parse(context.issuedAt) ||
      row.valid_until.getTime() !== Date.parse(context.expiresAt)
    )
      unavailable();
    if (
      write &&
      (context.purpose === 'create_target' || context.purpose === 'edit_target')
    )
      await lockSafetyPolicy(tx, true);
    const request = ratingScopedContextRequestSchema.parse({
      purpose: context.purpose,
      selector: context.selector,
      mode: context.mode,
    });
    const captured = await this.capture(
      token,
      request,
      tx,
      context.protocolVersion,
    );
    if (
      captured.session.accountId !== row.account_id ||
      captured.session.sessionId !== row.session_id ||
      this.sessionGeneration(token, captured.session) !==
        context.sessionGeneration ||
      captured.scopeRevision !== context.scopeRevision ||
      captured.sourceDigest !== context.sourceDigest ||
      !canonicalEqual(captured.authority, row.authority) ||
      !canonicalEqual(captured.protocols, row.protocol_tuples) ||
      !canonicalEqual(
        captured.catalogs.map((c) => ({
          scopeKey: c.scope_key,
          catalogRevision: c.id,
          headRevision: c.head_revision,
        })),
        context.heads,
      ) ||
      context.protocolGeneration !==
        this.protocolGeneration(context.selector, captured)
    )
      changed();
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now;
    if (
      !(now instanceof Date) ||
      Date.parse(context.expiresAt) <= now.getTime()
    )
      changed();
    this.retainContext(row, context, tx);
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) unavailable();
    const state: RootState = {
      tx,
      readEpoch,
      contextId: context.id,
      scopeKeys: captured.campus.scopeKeys,
      logicalKeys: captured.logicalKeys,
      write,
      retained: false,
    };
    if (!write) retainSnapshot(state, captured.snapshot, tx);
    return { context, captured, state };
  }
  private scope(
    context: RatingCurrentContext,
    captured: Capture,
    state: RootState,
    catalog: CatalogRead,
  ): ResolvedRatingScope {
    const selector: RatingNavigationSelector =
      catalog.campus_id === null
        ? { kind: 'global' }
        : { kind: 'campus', campusId: catalog.campus_id };
    const logical = catalog.region_id ?? 'global',
      protocol = captured.protocols.find((p) => p.scopeKey === logical);
    if (!protocol) unavailable();
    const authorized =
      catalog.campus_id === null ||
      captured.campus.authorization.find(
        (a) => a.campusId === catalog.campus_id,
      )?.decision === 'allow';
    const result = freeze({
      actor: captured.session.accountId,
      actorId: captured.session.accountId,
      session: captured.session,
      context,
      targetCoverCapable:
        context.protocolVersion === 3 &&
        (
          (captured.authority['targetCoverCapabilities'] ?? []) as {
            protocolVersionId: string;
            current: boolean;
          }[]
        ).some((c) => c.protocolVersionId === protocol.versionId && c.current),
      catalog: {
        id: catalog.id,
        scopeKey: catalog.scope_key,
        regionId: catalog.region_id,
        campusId: catalog.campus_id,
        headRevision: catalog.head_revision,
        sourceDigest: catalog.source_digest,
      },
      campusProof: captured.campus,
      deadline: Math.min(captured.deadline, Date.parse(context.expiresAt)),
      contextId: context.id,
      selector,
      protocolGeneration: protocol.generation,
      catalogRevision: catalog.id,
      headRevision: catalog.head_revision,
      scopeRevision: context.scopeRevision,
      sourceDigest: context.sourceDigest,
      authorized,
      write: state.write,
    }) as ResolvedRatingScope;
    resolved.set(result, state);
    return result;
  }
  async resolve(
    token: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
    options: {
      purpose?: RatingScopedContextRequest['purpose'];
      write?: boolean;
      protocolVersion?: 2 | 3;
    } = {},
  ): Promise<ResolvedRatingScope> {
    const loaded = await this.load(
      token,
      query,
      tx,
      options.write ?? false,
      options.protocolVersion ?? 2,
    );
    if (
      loaded.context.purpose === 'random' ||
      loaded.captured.catalogs.length !== 1 ||
      (options.purpose && loaded.context.purpose !== options.purpose)
    )
      changed();
    if (options.write && loaded.context.mode !== 'public') changed();
    return this.scope(
      loaded.context,
      loaded.captured,
      loaded.state,
      loaded.captured.catalogs[0]!,
    );
  }
  async resolveRandom(
    token: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
    protocolVersion: 2 | 3 = 2,
  ): Promise<ResolvedRatingRandomScope> {
    const loaded = await this.load(token, query, tx, false, protocolVersion);
    if (loaded.context.purpose !== 'random' || loaded.context.mode !== 'public')
      changed();
    const scopes = loaded.captured.catalogs.map((c) =>
      this.scope(loaded.context, loaded.captured, loaded.state, c),
    );
    const result = freeze({
      actor: loaded.captured.session.accountId,
      session: loaded.captured.session,
      context: loaded.context,
      campusProof: loaded.captured.campus,
      deadline: Math.min(
        loaded.captured.deadline,
        Date.parse(loaded.context.expiresAt),
      ),
      scopes,
      observedBytes: loaded.captured.observedBytes,
    });
    randomResolved.set(result, loaded.state);
    return result;
  }
  async resolveLocator(
    token: string,
    input: z.infer<typeof ratingScopedLocatorSchema>,
    purpose: 'read' | 'interact' | 'edit_target' = 'read',
    tx?: PoolClient,
  ) {
    const run = async (client: PoolClient) => {
      const locator = ratingScopedLocatorSchema.parse(input),
        context = await this.issue(
          token,
          { purpose, selector: locator.selector, mode: 'public' },
          client,
        );
      if (context.protocolGeneration !== locator.protocolGeneration) changed();
      return { locator, context };
    };
    return tx
      ? run(tx)
      : this.db.transaction(run, { isolationLevel: 'read committed' });
  }
}
