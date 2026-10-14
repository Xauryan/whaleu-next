import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';

export const RATING_GROUP_PROMOTION_RUNTIME = Symbol(
  'RATING_GROUP_PROMOTION_RUNTIME',
);
export const promotionId = z.uuid().transform((v) => v.toLowerCase());
export const promotionHash = z.string().regex(/^[a-f0-9]{64}$/);
export const promotionType = z.enum(['course', 'canteen']);
export const previewInput = z
  .strictObject({
    type: promotionType,
    mode: z.enum(['normal', 'test']),
    testDestinationId: promotionId.optional(),
    expectedProgramRevision: promotionId,
  })
  .refine((v) => (v.mode === 'test') === (v.testDestinationId !== undefined));
export const intentInput = z.strictObject({
  previewId: promotionId,
  copyMode: z.enum(['deterministic', 'assisted']),
  linkMode: z.enum(['native', 'shortlink_optional', 'shortlink_required']),
});
export const campaignInput = z.strictObject({
  requestId: promotionId,
  intentTicket: z.string().max(1024),
  requestHash: promotionHash,
});
export const sealInput = z.strictObject({
  cancelRequestId: promotionId,
  requestHash: promotionHash,
});
export const cancelInput = z.strictObject({ requestId: promotionId });
export const reconcileInput = cancelInput.extend({ effectId: promotionId });
export const pageInput = z.strictObject({ cursor: promotionId.optional() });
export const sourceBindingSchema = z.strictObject({
  categoryId: promotionId,
  categoryRevision: promotionId,
  catalogContext: z.strictObject({ regionId: promotionId.nullable() }),
  systemKey: promotionType,
  locatorMappingId: promotionId,
  locatorMappingRevision: promotionId,
  exportPolicyId: promotionId,
  exportPolicyRevision: promotionId,
});
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type PromotionType = z.infer<typeof promotionType>;
export type PreviewInput = z.infer<typeof previewInput>;
export type IntentInput = z.infer<typeof intentInput>;
export type CampaignInput = z.infer<typeof campaignInput>;
export type AudienceKind = 'school_treehole' | 'default_treehole' | 'test';
export type EffectStage = 'generation' | 'shortlink' | 'delivery';
export type EffectState =
  | 'pending'
  | 'preparing'
  | 'dispatch_unknown'
  | 'confirmed'
  | 'retry_wait'
  | 'suppressed_unsent'
  | 'parked_unknown';
export interface Command extends PreviewInput, IntentInput {
  programId: string;
  principalLineage: string;
  requestId: string;
  sourceBindingHash: string;
  audienceEpoch: string;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function commandHash(c: Command): string {
  return digest([
    'rating-promotion-command-v1',
    c.programId,
    c.principalLineage,
    c.requestId,
    c.previewId,
    c.type,
    c.mode,
    c.testDestinationId ?? null,
    c.expectedProgramRevision,
    c.sourceBindingHash,
    c.audienceEpoch,
    c.copyMode,
    c.linkMode,
  ]);
}
export function nativeLocator(binding: SourceBinding): string {
  const b = sourceBindingSchema.parse(binding);
  return `pages/rating-catalog/rating-catalog?parentId=${b.categoryId}${b.catalogContext.regionId ? `&regionId=${b.catalogContext.regionId}` : ''}`;
}
export const deterministicCopy = (type: PromotionType) =>
  type === 'course'
    ? '同学们来给上过的课打个分吧'
    : '今天的饭菜合你胃口吗，来打个分吧';
export function qualifiedLiteral(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.normalize('NFC') &&
    [...value].length >= 1 &&
    [...value].length <= 28 &&
    Buffer.byteLength(value) <= 112 &&
    !/[\p{Cc}\p{Cs}\p{Cf}<>@{}[\]`]|https?:|www\.|:\/\//iu.test(value)
  );
}
export interface FrozenPayload {
  profileVersion: 'rating-group-v1';
  type: PromotionType;
  copy: string;
  locator: string;
  nativeLocatorHash: string;
  sourceBindingHash: string;
}
export const payloadHash = (p: FrozenPayload) =>
  digest([
    p.profileVersion,
    p.type,
    p.copy,
    p.locator,
    p.nativeLocatorHash,
    p.sourceBindingHash,
  ]);
export function validatePayload(p: FrozenPayload): void {
  if (!qualifiedLiteral(p.copy) || Buffer.byteLength(JSON.stringify(p)) > 1024)
    throw new ApplicationError('PROMOTION_UNAVAILABLE');
}
export interface Program {
  id: string;
  lineage: string;
  revision: string;
  type: PromotionType;
  source_binding: SourceBinding;
  source_hash: string;
  audience_epoch: string;
  scope_ids: string[];
  include_default: boolean;
  account_lineage: string;
  profile_id: string;
  grant_epoch: string;
  valid_until: Date;
  timezone: string;
}
export interface CurrentSource {
  label: string;
  locator: string;
  fingerprint: string;
}
/** Implementations are owner facades and must register exact required transaction proofs.
 * An injected result flag is not source/export or current account authority. */
export interface PromotionSourcePort {
  current(
    program: Program,
    tx: PoolClient,
    mode?: 'normal' | 'test',
  ): Promise<CurrentSource>;
}
export interface PromotionPrincipalPort {
  current(
    actor: string,
    program: Program,
    action: 'preview' | 'send' | 'test' | 'inspect',
    tx: PoolClient,
  ): Promise<string>;
  service(program: Program, grantId: string, tx: PoolClient): Promise<string>;
  receiver(
    program: Program,
    destination: Destination,
    tx: PoolClient,
  ): Promise<string>;
}
export interface Destination {
  id: string;
  account_lineage: string;
  canonical_hash: string;
  opaque_ref: string;
  revision: string;
  enrollment_revision: string;
  audience_kind: AudienceKind;
  school_scope_id: string | null;
  valid_until: Date;
}
export interface QualificationPort {
  current(
    program: Program,
    payload: FrozenPayload,
    tx: PoolClient,
  ): Promise<string>;
}
export interface EffectIdentity {
  effectId: string;
  attemptId: string;
  key: string;
  stage: EffectStage;
  profileId: string;
  accountLineage: string;
  destinationId: string | null;
  inputHash: string;
  payloadHash: string | null;
  fence: string;
}
export interface Evidence extends EffectIdentity {
  kind: 'accepted' | 'not_accepted';
  receiptId: string;
  acceptedAt: number;
  observedAt: number;
  proofHash: string;
  output?: string;
}
export interface Permit extends EffectIdentity {
  readonly authorityDigest: string;
  readonly expiresAt: number;
}
export interface ReceiptSubscription {
  subscribe(receive: (evidence: Evidence) => void): void;
  dispose(): void;
}
export interface PreparedEffect {
  readonly identity: EffectIdentity;
  /** Synchronous fixed synthetic acceptance only. No network/await/busy wait. */
  dispatch(permit: Permit): Evidence | ReceiptSubscription | null;
  /** Discard a preparation that never crossed the acceptance boundary. */
  dispose?(): void;
}
export interface SyntheticStoreIdentity {
  domainId: string;
  storeId: string;
  ledgerInstanceId: string | null;
  restoreEpoch: string | null;
}
export interface SyntheticEffectPort {
  storageIdentity(): Promise<SyntheticStoreIdentity>;
  prepare(
    identity: EffectIdentity,
    input:
      | Readonly<FrozenPayload>
      | Readonly<{
          purpose: 'rating_push';
          label: string;
          date: string;
          type: PromotionType;
        }>
      | Readonly<{ nativeLocator: string }>,
    signal: AbortSignal,
  ): Promise<PreparedEffect>;
  reconcile(
    identity: EffectIdentity,
    signal: AbortSignal,
  ): Promise<Evidence | null>;
  authenticate(evidence: Evidence): boolean;
}
export interface RatingGroupPromotionRuntime {
  readonly mode: 'synthetic-only';
  readonly domainId: string;
  readonly source: PromotionSourcePort;
  readonly authority: PromotionPrincipalPort;
  readonly qualification: QualificationPort;
  readonly sender: SyntheticEffectPort;
  readonly generation: SyntheticEffectPort | null;
  readonly shortlinks: SyntheticEffectPort | null;
  readonly ticketSecret: Buffer;
}
export const limits = Object.freeze({
  recipients: 10000,
  scopes: 2000,
  programs: 256,
  enrollmentBatch: 128,
  maintenanceBatch: 128,
  claims: 16,
  drainMs: 10000,
  startMs: 7000,
  receiptMs: 5000,
  settlementMs: 500,
  leaseMs: 30000,
  permitMs: 100,
  campaignDaily: 20,
  operatorDaily: 100,
  deploymentDaily: 1000,
  outstandingProgram: 20,
  outstandingDeployment: 200,
  retentionDays: 180,
  purgeBatch: 500,
  previewMs: 300000,
  ticketMs: 900000,
});
export function effectKey(
  campaignId: string,
  stage: EffectStage,
  profile: string,
  input: string,
  destination: string | null = null,
): string {
  return stage === 'delivery'
    ? digest([
        'rating-group-v1',
        campaignId,
        stage,
        profile,
        destination,
        input,
      ])
    : digest(['rating-group-v1', campaignId, stage, profile, input]);
}

export function effectIdentity(value: EffectIdentity): EffectIdentity {
  return {
    effectId: value.effectId,
    attemptId: value.attemptId,
    key: value.key,
    stage: value.stage,
    profileId: value.profileId,
    accountLineage: value.accountLineage,
    destinationId: value.destinationId,
    inputHash: value.inputHash,
    payloadHash: value.payloadHash,
    fence: value.fence,
  };
}
