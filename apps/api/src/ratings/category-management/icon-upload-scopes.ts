import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { CategoryIconMediaRecoveryRepository } from '../../media/category-icon-recovery-repository.js';
import {
  CATEGORY_ICON_MEDIA_PROTOCOL,
  categoryIconMediaRequestHash,
  type CategoryIconMediaRecovery,
} from '../../media/contracts-category-icon.js';
import { scopedId } from '../scoped/contracts.js';
import {
  categoryIconAppearanceSchema,
  categoryIconUploadScopeRequestHash,
  ratingCategoryIconUploadScopeRecoverySchema,
  ratingCategoryIconUploadScopeResultSchema,
  ratingCategoryIconUploadScopeSchema,
  type CategoryIconAppearance,
  type RatingCategoryIconUploadScopeInput,
} from './icon-contracts.js';
import { categoryIconDigest } from './icon-extension.js';

export const CATEGORY_ICON_UPLOAD_SCOPE_OPERATION =
  'prepare_category_icon_upload_scope' as const;

export interface AuthorizedCategoryIconUploadScope {
  readonly categoryId: string;
  readonly identityId: string;
  readonly origin: CategoryIconAppearance['origin'];
  readonly contextId: string;
  readonly expiresAt: Date;
}
export interface CategoryIconUploadScopeAuthority {
  /** The authenticated original owner validates all affected management scopes,
   * the exact text plan and slot, then enrolls its current transaction facts.
   * A persisted receipt or actor-free request hash is never this authority. */
  authorize(
    actor: string,
    sessionId: string,
    input: RatingCategoryIconUploadScopeInput,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconUploadScope>;
}
export type CategoryIconUploadScopeResult = ReturnType<
  typeof ratingCategoryIconUploadScopeResultSchema.parse
>;
export type CategoryIconUploadScopeRecoveryInput = ReturnType<
  typeof ratingCategoryIconUploadScopeRecoverySchema.parse
>;
export interface CategoryIconUploadScopeRecovery {
  readonly scope: CategoryIconUploadScopeResult | null;
  readonly recovery: CategoryIconMediaRecovery | null;
  readonly state: 'known' | 'unknown' | 'cancelled';
}
interface ScopeRow {
  id: string;
  actor_id: string;
  client_request_id: string;
  command_request_id: string;
  scope_revision: string;
  scope_request_hash: string;
  request_hash: string;
  input: RatingCategoryIconUploadScopeInput;
  declaration: RatingCategoryIconUploadScopeInput['declaration'];
  context_id: string;
  session_id: string;
  category_id: string;
  identity_id: string;
  origin: CategoryIconAppearance['origin'];
  expires_at: Date;
}
interface ScopeFence {
  request_hash: string;
}
interface ScopeRecord {
  row: ScopeRow | null;
  scope: CategoryIconUploadScopeResult | null;
  fence: ScopeFence | null;
}
const conflict = (): never => {
  throw new ApplicationError('REQUEST_CONFLICT');
};
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};

/** The same canonical body is independently reproducible by owner SQL. */
export function categoryIconUploadScopeRevision(
  actor: string,
  sessionId: string,
  id: string,
  input: RatingCategoryIconUploadScopeInput,
  authorized: AuthorizedCategoryIconUploadScope,
): string {
  return categoryIconDigest('upload-scope', {
    id,
    actorId: actor,
    sessionId,
    input,
    categoryId: authorized.categoryId,
    identityId: authorized.identityId,
    origin: authorized.origin,
    contextId: authorized.contextId,
    expiresAt: authorized.expiresAt.toISOString(),
  });
}
function mediaHash(
  actor: string,
  row: Pick<
    ScopeRow,
    'id' | 'client_request_id' | 'scope_revision' | 'declaration'
  >,
): string {
  return categoryIconMediaRequestHash(actor, {
    protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
    clientRequestId: row.client_request_id,
    editScopeId: row.id,
    scopeRevision: row.scope_revision,
    slot: 'icon',
    declaration: row.declaration,
  });
}
function validateAuthority(
  input: RatingCategoryIconUploadScopeInput,
  authority: AuthorizedCategoryIconUploadScope,
): AuthorizedCategoryIconUploadScope {
  const value = {
    categoryId: scopedId.parse(authority.categoryId),
    identityId: scopedId.parse(authority.identityId),
    origin: categoryIconAppearanceSchema.shape.origin.parse(authority.origin),
    contextId: scopedId.parse(authority.contextId),
    expiresAt: new Date(authority.expiresAt.getTime()),
  };
  if (
    !Number.isFinite(value.expiresAt.getTime()) ||
    value.contextId !== input.context.id ||
    (input.slot.kind !== 'new' && value.categoryId !== input.slot.categoryId) ||
    (input.slot.kind === 'override'
      ? value.origin.kind !== 'override' ||
        value.origin.campusId !== input.slot.campusId
      : value.origin.kind !== 'base')
  )
    unavailable();
  return value;
}

/** Owner-only storage/recovery, always within the caller's authenticated
 * transaction. The caller starts and finishes Category mutation collection;
 * this helper never mints credentials, current read authority or publication. */
export class CategoryIconUploadScopes {
  constructor(
    private readonly authority: CategoryIconUploadScopeAuthority,
    private readonly media: Pick<
      CategoryIconMediaRecoveryRepository,
      'recover' | 'cancelRequest'
    >,
  ) {}

  async create(
    actor: string,
    sessionId: string,
    raw: RatingCategoryIconUploadScopeInput,
    tx: PoolClient,
  ): Promise<CategoryIconUploadScopeResult> {
    const input = ratingCategoryIconUploadScopeSchema.parse(raw);
    scopedId.parse(sessionId);
    const requestHash = categoryIconUploadScopeRequestHash(input);
    await this.lock(actor, input.clientRequestId, tx);
    const prior = await this.read(
      actor,
      input.clientRequestId,
      requestHash,
      tx,
    );
    if (prior.row && canonicalJson(prior.row.input) !== canonicalJson(input))
      conflict();
    // Neither stale context nor a newer session can erase an immutable receipt.
    // Cancellation is checked before any current-context validation as well.
    if (prior.fence) throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
    if (prior.scope) return prior.scope;

    const authorized = validateAuthority(
      input,
      await this.authority.authorize(actor, sessionId, input, tx),
    );
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]?.now.getTime();
    if (
      now === undefined ||
      !Number.isFinite(now) ||
      authorized.expiresAt.getTime() <= now ||
      authorized.expiresAt.getTime() > now + 5 * 60 * 1000
    )
      unavailable();
    const id = randomUUID();
    const row: ScopeRow = {
      id,
      actor_id: actor,
      client_request_id: input.clientRequestId,
      command_request_id: input.payload.clientRequestId,
      scope_revision: categoryIconUploadScopeRevision(
        actor,
        sessionId,
        id,
        input,
        authorized,
      ),
      scope_request_hash: requestHash,
      request_hash: '',
      input,
      declaration: input.declaration,
      context_id: authorized.contextId,
      session_id: sessionId,
      category_id: authorized.categoryId,
      identity_id: authorized.identityId,
      origin: authorized.origin,
      expires_at: authorized.expiresAt,
    };
    row.request_hash = mediaHash(actor, row);
    await this.claim(actor, input.clientRequestId, requestHash, tx);
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_upload_scopes
       (id,actor_id,client_request_id,command_request_id,scope_revision,scope_request_hash,request_hash,
        input,declaration,context_id,session_id,category_id,identity_id,origin,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15)`,
      [
        row.id,
        actor,
        row.client_request_id,
        row.command_request_id,
        row.scope_revision,
        requestHash,
        row.request_hash,
        canonicalJson(input),
        canonicalJson(input.declaration),
        row.context_id,
        sessionId,
        row.category_id,
        row.identity_id,
        canonicalJson(row.origin),
        row.expires_at,
      ],
    );
    registerTransactionDeadline(
      tx,
      authorized.expiresAt.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    return this.result(row);
  }

  async recover(
    actor: string,
    raw: CategoryIconUploadScopeRecoveryInput,
    tx: PoolClient,
  ): Promise<CategoryIconUploadScopeRecovery> {
    const input = ratingCategoryIconUploadScopeRecoverySchema.parse(raw);
    this.requireTransaction(actor, tx);
    const record = await this.read(
      actor,
      input.clientRequestId,
      input.requestHash,
      tx,
    );
    return this.recovered(actor, input.clientRequestId, record, tx);
  }

  async cancel(
    actor: string,
    raw: CategoryIconUploadScopeRecoveryInput,
    tx: PoolClient,
  ): Promise<CategoryIconUploadScopeRecovery> {
    const input = ratingCategoryIconUploadScopeRecoverySchema.parse(raw);
    await this.lock(actor, input.clientRequestId, tx);
    const record = await this.read(
      actor,
      input.clientRequestId,
      input.requestHash,
      tx,
    );
    await this.claim(actor, input.clientRequestId, input.requestHash, tx);
    if (!record.fence) {
      await tx.query(
        `INSERT INTO whaleu_ratings.category_icon_upload_scope_fences(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)`,
        [actor, input.clientRequestId, input.requestHash],
      );
      record.fence = { request_hash: input.requestHash };
    }
    if (!record.row) return { scope: null, recovery: null, state: 'cancelled' };
    // The owner hash is not a Media prepare hash. Only an exact stored scope
    // supplies the latter, including when Media prepare itself has not happened.
    const recovery = await this.media.cancelRequest(
      actor,
      input.clientRequestId,
      {
        protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
        requestHash: record.row.request_hash,
      },
      tx,
    );
    this.checkRecovery(record.row, recovery);
    return { scope: record.scope, recovery, state: 'cancelled' };
  }

  private requireTransaction(actor: string, tx: PoolClient): void {
    scopedId.parse(actor);
    if (!transactionReadEpoch(tx)) unavailable();
  }
  private async lock(
    actor: string,
    key: string,
    tx: PoolClient,
  ): Promise<void> {
    this.requireTransaction(actor, tx);
    // Same original Media actor reservation key and owner request key. NOWAIT
    // advisory acquisition gives a bounded retry instead of an unbounded wait.
    for (const name of [
      `whaleu:media-reservation:v1:${actor}`,
      `whaleu:ratings-category-icon-upload-scope:v1:${actor}:${key}`,
    ]) {
      const locked = (
        await tx.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',
          [name],
        )
      ).rows[0]?.locked;
      if (locked !== true) unavailable();
    }
  }
  private async claim(
    actor: string,
    key: string,
    hash: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_ratings.command_claims(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [actor, key, CATEGORY_ICON_UPLOAD_SCOPE_OPERATION, hash],
    );
    const claim = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 FOR UPDATE NOWAIT',
        [actor, key],
      )
    ).rows[0];
    if (
      !claim ||
      claim.operation !== CATEGORY_ICON_UPLOAD_SCOPE_OPERATION ||
      claim.intent_hash !== hash
    )
      conflict();
  }
  private async read(
    actor: string,
    key: string,
    hash: string,
    tx: PoolClient,
  ): Promise<ScopeRecord> {
    const row =
      (
        await tx.query<ScopeRow>(
          'SELECT * FROM whaleu_ratings.category_icon_upload_scopes WHERE actor_id=$1 AND client_request_id=$2',
          [actor, key],
        )
      ).rows[0] ?? null;
    const fence =
      (
        await tx.query<ScopeFence>(
          'SELECT request_hash FROM whaleu_ratings.category_icon_upload_scope_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor, key],
        )
      ).rows[0] ?? null;
    if (
      (row && row.scope_request_hash !== hash) ||
      (fence && fence.request_hash !== hash)
    )
      conflict();
    const claim = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
    if (
      claim &&
      (claim.operation !== CATEGORY_ICON_UPLOAD_SCOPE_OPERATION ||
        claim.intent_hash !== hash)
    )
      conflict();
    if (row) {
      const input = ratingCategoryIconUploadScopeSchema.parse(row.input);
      const authority = validateAuthority(input, {
        categoryId: row.category_id,
        identityId: row.identity_id,
        origin: row.origin,
        contextId: row.context_id,
        expiresAt: row.expires_at,
      });
      if (
        row.actor_id !== actor ||
        row.client_request_id !== key ||
        input.clientRequestId !== key ||
        row.command_request_id !== input.payload.clientRequestId ||
        categoryIconUploadScopeRequestHash(input) !== hash ||
        canonicalJson(row.declaration) !== canonicalJson(input.declaration) ||
        categoryIconUploadScopeRevision(
          actor,
          row.session_id,
          row.id,
          input,
          authority,
        ) !== row.scope_revision ||
        mediaHash(actor, row) !== row.request_hash
      )
        unavailable();
    }
    await this.checkNamespace(actor, key, row, tx);
    return { row, scope: row ? this.result(row) : null, fence };
  }
  private async checkNamespace(
    actor: string,
    key: string,
    row: ScopeRow | null,
    tx: PoolClient,
  ): Promise<void> {
    const occupied = (
      await tx.query<{ occupied: boolean }>(
        `SELECT EXISTS(
        SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2
          AND ($3::text IS NULL OR protocol_namespace IS DISTINCT FROM 8 OR request_hash IS DISTINCT FROM $3)
        UNION ALL SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2
          AND ($3::text IS NULL OR protocol_version<>8 OR owner_kind<>'ratings' OR resource_kind<>'category_icon'
            OR target_kind<>'edit' OR slot<>'icon' OR ordinal<>0 OR request_hash IS DISTINCT FROM $3
            OR resource_id IS DISTINCT FROM $4::uuid OR scope_revision IS DISTINCT FROM $5::text)
        UNION ALL SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=$1 AND client_request_id=$2
          AND ($3::text IS NULL OR request_hash IS DISTINCT FROM $3)
        UNION ALL SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=$1 AND client_request_id=$2
        UNION ALL SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=$1 AND client_request_id=$2
        UNION ALL SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=$1 AND client_request_id=$2
        UNION ALL SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=$1 AND batch_request_id=$2
        UNION ALL SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND command_request_id=$2
        UNION ALL SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2
      ) occupied`,
        [
          actor,
          key,
          row?.request_hash ?? null,
          row?.id ?? null,
          row?.scope_revision ?? null,
        ],
      )
    ).rows[0]?.occupied;
    if (occupied === true) conflict();
    if (occupied !== false) unavailable();
  }
  private result(row: ScopeRow): CategoryIconUploadScopeResult {
    return ratingCategoryIconUploadScopeResultSchema.parse({
      editScopeId: row.id,
      scopeRevision: row.scope_revision,
      categoryId: row.category_id,
      identityId: row.identity_id,
      expiresAt: row.expires_at.toISOString(),
    });
  }
  private checkRecovery(
    row: ScopeRow,
    recovery: CategoryIconMediaRecovery,
  ): void {
    if (
      recovery.requestId !== row.client_request_id ||
      (recovery.state !== 'not_recorded' &&
        recovery.requestHash !== row.request_hash) ||
      (recovery.state === 'recorded' &&
        (recovery.status.editScopeId !== row.id ||
          recovery.status.requestId !== row.client_request_id ||
          recovery.status.requestHash !== row.request_hash))
    )
      conflict();
  }
  private async recovered(
    actor: string,
    key: string,
    record: ScopeRecord,
    tx: PoolClient,
  ): Promise<CategoryIconUploadScopeRecovery> {
    if (!record.row)
      return {
        scope: null,
        recovery: null,
        state: record.fence ? 'cancelled' : 'unknown',
      };
    const recovery = await this.media.recover(actor, key, tx);
    this.checkRecovery(record.row, recovery);
    return {
      scope: record.scope,
      recovery,
      state: record.fence ? 'cancelled' : 'known',
    };
  }
}
