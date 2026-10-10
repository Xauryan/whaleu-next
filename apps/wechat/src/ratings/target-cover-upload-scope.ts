import { sha256 } from 'js-sha256';
import { exact } from '../community/contract';
import { invalidRating, ratingId } from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedCommandContext,
  type RatingScopedCommandContext,
} from './scoped-contract';
import {
  decodeRatingCoverDeclaration,
  decodeRatingCoverMediaStatus,
  decodeRatingCoverPrepare,
  decodeRatingCoverRecovery,
  ratingCoverPrepareHash,
  type RatingCoverPrepare,
  type RatingCoverMediaStatus,
  type RatingCoverRecovery,
} from './target-cover-media-contract';
import {
  uploadDigest,
  uploadInteger,
  type UploadDeclaration,
} from '../media/upload-contracts';
export interface RatingCoverScopeInput {
  readonly protocolVersion: 3;
  readonly context: RatingScopedCommandContext;
  readonly clientRequestId: string;
  readonly commandRequestId: string;
  readonly draftRevision: string;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly target: null | {
    readonly targetId: string;
    readonly expectedTargetRevision: string;
    readonly expectedDefinitionRevision: string;
    readonly expectedContentVersion: number;
  };
  readonly declaration: UploadDeclaration;
}
export interface RatingCoverScope {
  readonly protocolVersion: 3;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly targetId: string;
  readonly expiresAt: string;
  readonly prepare: RatingCoverPrepare;
}
/** No bytes, file paths, upload grants, descriptors or refresh credentials are journaled. */
export interface PendingRatingCoverUpload {
  readonly version: 11;
  readonly phase: 'upload';
  readonly accountId: string;
  readonly scopeInput: RatingCoverScopeInput;
  readonly scope: RatingCoverScope | null;
  readonly status: RatingCoverMediaStatus | null;
}
export function decodeRatingCoverScopeInput(v: unknown): RatingCoverScopeInput {
  exact(v, [
    'protocolVersion',
    'context',
    'clientRequestId',
    'commandRequestId',
    'draftRevision',
    'categoryId',
    'expectedCategoryRevision',
    'target',
    'declaration',
  ]);
  if (v.protocolVersion !== 3) invalidRating();
  for (const key of [
    'clientRequestId',
    'commandRequestId',
    'draftRevision',
    'categoryId',
    'expectedCategoryRevision',
  ])
    if (!ratingId(v[key])) invalidRating();
  let target: RatingCoverScopeInput['target'] = null;
  if (v.target !== null) {
    exact(v.target, [
      'targetId',
      'expectedTargetRevision',
      'expectedDefinitionRevision',
      'expectedContentVersion',
    ]);
    if (
      !ratingId(v.target.targetId) ||
      !ratingId(v.target.expectedTargetRevision) ||
      !ratingId(v.target.expectedDefinitionRevision) ||
      !uploadInteger(v.target.expectedContentVersion, 1, 2147483646)
    )
      invalidRating();
    target = Object.freeze({
      targetId: v.target.targetId,
      expectedTargetRevision: v.target.expectedTargetRevision,
      expectedDefinitionRevision: v.target.expectedDefinitionRevision,
      expectedContentVersion: v.target.expectedContentVersion,
    });
  }
  return Object.freeze({
    ...v,
    protocolVersion: 3,
    context: decodeRatingScopedCommandContext(v.context),
    target,
    declaration: decodeRatingCoverDeclaration(v.declaration),
  }) as unknown as RatingCoverScopeInput;
}
export function decodeRatingCoverScope(v: unknown): RatingCoverScope {
  exact(v, [
    'protocolVersion',
    'scopeId',
    'scopeRevision',
    'targetId',
    'expiresAt',
    'prepare',
  ]);
  const prepare = decodeRatingCoverPrepare(v.prepare);
  if (
    v.protocolVersion !== 3 ||
    !ratingId(v.scopeId) ||
    !uploadDigest(v.scopeRevision) ||
    !ratingId(v.targetId) ||
    !ratingTimestamp(v.expiresAt) ||
    prepare.editScopeId !== v.scopeId ||
    prepare.scopeRevision !== v.scopeRevision
  )
    invalidRating();
  return Object.freeze({
    protocolVersion: 3,
    scopeId: v.scopeId,
    scopeRevision: v.scopeRevision,
    targetId: v.targetId,
    expiresAt: v.expiresAt,
    prepare,
  });
}
export function matchRatingCoverScope(
  input: RatingCoverScopeInput,
  scope: RatingCoverScope,
): void {
  if (
    scope.prepare.clientRequestId !== input.clientRequestId ||
    canonicalRatingScopedJson(scope.prepare.declaration) !==
      canonicalRatingScopedJson(input.declaration) ||
    (input.target !== null && scope.targetId !== input.target.targetId)
  )
    invalidRating();
}
export function decodePendingRatingCoverUpload(
  v: unknown,
  accountId: string,
): PendingRatingCoverUpload {
  exact(v, ['version', 'phase', 'accountId', 'scopeInput', 'scope', 'status']);
  if (
    v.version !== 11 ||
    v.phase !== 'upload' ||
    v.accountId !== accountId ||
    !ratingId(accountId)
  )
    invalidRating();
  const scopeInput = decodeRatingCoverScopeInput(v.scopeInput),
    scope = v.scope === null ? null : decodeRatingCoverScope(v.scope),
    status = v.status === null ? null : decodeRatingCoverMediaStatus(v.status);
  if (scope) matchRatingCoverScope(scopeInput, scope);
  if (
    status &&
    (!scope ||
      status.editScopeId !== scope.scopeId ||
      status.requestId !== scope.prepare.clientRequestId ||
      status.requestHash !== ratingCoverPrepareHash(accountId, scope.prepare))
  )
    invalidRating();
  return Object.freeze({
    version: 11,
    phase: 'upload',
    accountId,
    scopeInput,
    scope,
    status,
  });
}

export interface RatingCoverScopeCancellation {
  readonly protocolVersion: 3;
  readonly clientRequestId: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly prepare: RatingCoverPrepare;
  readonly recovery: RatingCoverRecovery;
}
export function ratingCoverScopeIdentity(
  actor: string,
  raw: RatingCoverScopeInput,
): { scopeId: string; scopeRevision: string } {
  if (!ratingId(actor)) invalidRating();
  const input = decodeRatingCoverScopeInput(raw);
  const scopeRevision = sha256(
    'whaleu:rating-target-cover-upload-scope:v1\n' +
      actor +
      '\n' +
      canonicalRatingScopedJson(input),
  );
  let hex = sha256(
    'whaleu:rating-scoped-artifact:v1\n' +
      scopeRevision +
      '\ncover-upload-scope',
  ).slice(0, 32);
  hex =
    hex.slice(0, 12) +
    '4' +
    hex.slice(13, 16) +
    ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16) +
    hex.slice(17);
  return {
    scopeRevision,
    scopeId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}
export function decodeRatingCoverScopeCancellation(
  v: unknown,
  actor: string,
  raw: RatingCoverScopeInput,
): RatingCoverScopeCancellation {
  exact(v, [
    'protocolVersion',
    'clientRequestId',
    'scopeId',
    'scopeRevision',
    'prepare',
    'recovery',
  ]);
  const input = decodeRatingCoverScopeInput(raw),
    expected = ratingCoverScopeIdentity(actor, input),
    prepare = decodeRatingCoverPrepare(v.prepare),
    recovery = decodeRatingCoverRecovery(v.recovery);
  if (
    v.protocolVersion !== 3 ||
    v.clientRequestId !== input.clientRequestId ||
    v.scopeId !== expected.scopeId ||
    v.scopeRevision !== expected.scopeRevision ||
    prepare.editScopeId !== expected.scopeId ||
    prepare.scopeRevision !== expected.scopeRevision ||
    prepare.clientRequestId !== input.clientRequestId ||
    canonicalRatingScopedJson(prepare.declaration) !==
      canonicalRatingScopedJson(input.declaration) ||
    recovery.requestId !== input.clientRequestId ||
    (recovery.state === 'recorded' &&
      recovery.status.editScopeId !== expected.scopeId) ||
    (recovery.state !== 'not_recorded' &&
      recovery.requestHash !== ratingCoverPrepareHash(actor, prepare))
  )
    invalidRating();
  return Object.freeze({
    protocolVersion: 3,
    clientRequestId: input.clientRequestId,
    ...expected,
    prepare,
    recovery,
  });
}
