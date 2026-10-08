import type { PoolClient } from 'pg';
export type ErrandRestrictionAction = 'publish' | 'accept' | 'all';
export type ErrandRestrictionState =
  'active' | 'released' | 'expired' | 'superseded';
export type ErrandRestrictionDuration =
  | { kind: 'permanent' }
  | { kind: 'finite'; unit: 'hours' | 'days'; value: number };
/** Server-derived evidence only. Callers hold the outer exclusive Safety gate,
 * authenticate common policy, select fresh authority, and register Authorization's
 * final unprotected-target proof for every new issue before invoking this owner. */
export interface ErrandRestrictionContext {
  actorId: string;
  sessionId: string;
  grantId: string;
  requestId: string;
  kind: 'global' | 'order';
  operation: 'issue' | 'release' | 'admin_delete' | 'restrict_accepter';
  orderId?: string;
  targetRegionId?: string;
}
export interface ErrandRestrictionNotice {
  recipientAccountId: string;
  kind: 'feature_restricted' | 'feature_released';
  restrictionId: string;
  eventId: string;
  action: ErrandRestrictionAction;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  releasedAt?: string;
  recordedAt: string;
}
export interface ErrandRestrictionMutation {
  restrictionId: string;
  eventId: string;
  occurredAt: string;
  notice: ErrandRestrictionNotice;
}
export type ErrandRestrictionGlobalReceipt =
  | {
      requestId: string;
      operation: 'issue' | 'release';
      outcome: 'applied';
      restrictionId: string;
      eventId: string;
      occurredAt: string;
    }
  | {
      requestId: string;
      operation: 'issue' | 'release';
      outcome: 'rejected';
      code: string;
    };
export interface StoredErrandRestriction {
  id: string;
  subjectId: string;
  action: ErrandRestrictionAction;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  origin: 'local' | 'baseline';
  recordedAt: string;
  actorId: string | null;
  sourceOrderId: string | null;
  state: ErrandRestrictionState;
  terminal:
    | null
    | { kind: 'baseline_released'; effectiveAt: string }
    | {
        kind: 'manually_released' | 'superseded';
        eventId: string;
        effectiveAt: string;
        reason: string | null;
        replacementRestrictionId: string | null;
      };
}
export interface StoredErrandRestrictionEvent {
  id: string;
  kind: 'issued' | 'observed_baseline' | 'manually_released' | 'superseded';
  effectiveAt: string;
  recordedAt: string;
  reason: string | null;
  actorId: string | null;
  replacementRestrictionId: string | null;
}
export interface ErrandRestrictionSeek {
  recordedAt: string;
  id: string;
}
export interface ErrandRestrictionFilter {
  subjectId?: string;
  action?: ErrandRestrictionAction;
  state: ErrandRestrictionState | 'all';
  checkedAt: string;
}
export interface ErrandRestrictionPage extends ErrandRestrictionFilter {
  after?: ErrandRestrictionSeek;
  limit: number;
}
export type ErrandRestrictionCount =
  { status: 'known'; value: string } | { status: 'unavailable' };
export type ErrandRestrictionTransaction = PoolClient;
