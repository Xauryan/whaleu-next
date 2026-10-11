import { z } from 'zod';
import type { PoolClient } from 'pg';

export const ERRAND_GROUP_RUNTIME = Symbol('ERRAND_GROUP_RUNTIME');
export const ERRAND_GROUP_SOURCE = Symbol('ERRAND_GROUP_SOURCE');
export type GroupStage = 'errand' | 'forum';
export type GroupStatus =
  'pending' | 'confirmed' | 'retryable' | 'suppressed' | 'expired' | 'unknown';
export const groupDestinationSchema = z.strictObject({
  id: z.string().regex(/^synthetic:[a-z0-9:_-]{1,100}$/),
  revision: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  targetRegionId: z.uuid(),
  stage: z.enum(['errand', 'forum']),
});
export type GroupDestination = z.infer<typeof groupDestinationSchema>;
export const nativeErrandLocator = (id: string) =>
  `pages/errand-detail/errand-detail?orderId=${z.uuid().parse(id)}`;
export const publicGroupPayloadSchema = z.strictObject({
  title: z.string().min(1).max(100),
  reward: z.string().regex(/^\d+\.\d{2}$/),
  expectedTime: z.string().max(100).optional(),
  sourceLabel: z.string().max(480).nullable(),
  locator: z.string().max(300),
});
export type PublicGroupPayload = z.infer<typeof publicGroupPayloadSchema>;
export interface GroupPublication {
  eventId: string;
  orderId: string;
  targetRegionId: string;
  publishedAt: number;
  firstConfirmedAt: number | null;
}
export interface ErrandGroupSourcePort {
  current(
    publication: GroupPublication,
    stage: GroupStage,
    tx: PoolClient,
  ): Promise<PublicGroupPayload>;
}
/** Authority is independent of public QR/join data and account school roles.
 * Implementations retain exact current authority through final transaction proofs. */
export interface SyntheticGroupAuthorityPort {
  destinations(
    targetRegionId: string,
    stage: GroupStage,
    tx: PoolClient,
  ): Promise<readonly GroupDestination[] | null>;
  requireCurrent(destination: GroupDestination, tx: PoolClient): Promise<void>;
}
export type SyntheticAck =
  | {
      status: 'confirmed';
      key: string;
      destinationId: string;
      receiptId: string;
      confirmedAt: number;
    }
  | { status: 'not_accepted'; key: string; destinationId: string }
  | { status: 'unknown' };
export interface GroupPermit {
  readonly attemptId: string;
  readonly fence: string;
  readonly key: string;
  readonly destination: GroupDestination;
  readonly payload: PublicGroupPayload;
  /** Monotonic, process-local. Never persisted or reusable after restart. */
  readonly expiresAt: number;
}
export interface PreparedSyntheticGroupSend {
  readonly key: string;
  readonly destinationId: string;
  readonly expiresAt: number;
  /** Intentionally synchronous synthetic acceptance. No real adapter is shipped.
   * No readiness wait or unbounded network work is permitted in this boundary. */
  dispatch(permit: GroupPermit): SyntheticAck;
}
export interface SyntheticGroupSendPort {
  prepare(
    key: string,
    destination: GroupDestination,
  ): Promise<PreparedSyntheticGroupSend>;
  reconcile(key: string, destinationId: string): Promise<SyntheticAck>;
}
export interface SyntheticGroupShortlinkPort {
  /** No identity/contact/body is supplied. Return a locator bound to this exact
   * native route, or null. The caller validates it and retains a safe fallback. */
  resolve(
    nativeLocator: string,
  ): Promise<{ nativeLocator: string; locator: string } | null>;
}
export interface ErrandGroupRuntime {
  readonly mode: 'synthetic-only';
  readonly authority: SyntheticGroupAuthorityPort;
  readonly sender: SyntheticGroupSendPort;
  readonly shortlinks: SyntheticGroupShortlinkPort | null;
  /** Business eligibility only; never an authorization or lease clock. */
  now(): number;
}
export function businessTime(runtime: ErrandGroupRuntime): number {
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw Error('Invalid synthetic business clock');
  return now;
}
export function groupWindow(
  publication: GroupPublication,
  stage: GroupStage,
  now: number,
): 'eligible' | 'waiting' | 'expired' {
  const anchor =
    stage === 'errand' ? publication.publishedAt : publication.firstConfirmedAt;
  if (anchor === null) return 'waiting';
  const age = now - anchor;
  if (age < (stage === 'errand' ? 0 : 15 * 60000)) return 'waiting';
  return age <= (stage === 'errand' ? 16 * 60000 : 30 * 60000)
    ? 'eligible'
    : 'expired';
}
/** Source-faithful title differences; exact decimal half-up avoids binary drift. */
export function groupTitle(title: string, stage: GroupStage): string {
  const first = title.split('\n')[0]!;
  return stage === 'errand' && title.includes('\n')
    ? first
    : [...first].slice(0, 28).join('');
}
export function groupReward(reward: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(reward)) throw Error('Invalid reward');
  const [whole, fraction = ''] = reward.split('.');
  const cents =
    BigInt(whole!) * 100n +
    BigInt((fraction + '00').slice(0, 2)) +
    (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
