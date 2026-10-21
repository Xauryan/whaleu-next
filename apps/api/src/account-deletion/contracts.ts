import { createHash } from 'node:crypto';
import { z } from 'zod';
export const SYNTHETIC_POLICY = 'synthetic-deletion-policy-v1' as const;
export const INVENTORY_VERSION = 'account-deletion-local-0173-v1' as const;
export const COOLING_MS = 7 * 24 * 60 * 60 * 1000;
export const REREGISTRATION_MS = 30 * 24 * 60 * 60 * 1000;
export const ownerKeys = [
  'identity',
  'profile',
  'timetable',
  'follow-social',
  'native-baseline',
  'unsupported-inventory',
  'media',
] as const;
export type OwnerKey = (typeof ownerKeys)[number];
const uuid = z.uuid();
const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
export const requestCommandSchema = z
  .object({
    version: z.literal(1),
    requestId: uuid,
    expectedGeneration: revision,
    consent: z.literal('account-deletion-explicit-v1'),
  })
  .strict();
export const cancelCommandSchema = z
  .object({
    version: z.literal(1),
    commandId: uuid,
    requestId: uuid,
    expectedRevision: revision,
    action: z.literal('explicitly_cancel_account_deletion'),
  })
  .strict();
export type RequestCommand = z.infer<typeof requestCommandSchema>;
export type CancelCommand = z.infer<typeof cancelCommandSchema>;
export type Phase =
  'cooling' | 'erasing' | 'waiting' | 'cancelled' | 'completed';
export interface DeletionStatus {
  requestId: string;
  phase: Phase;
  revision: string;
  requestedAt: number;
  eligibleAt: number;
  irreversibleAt: number | null;
  completedAt: number | null;
  reregisterAfter: number | null;
  pending: readonly string[];
}
export interface OwnerEvidence {
  owner: OwnerKey;
  requestId: string;
  generation: string;
  inventory: string;
  proof: string;
}
export interface CancellationPolicy {
  cutoff: 'deadline' | 'worker-claim';
  coolingAccess: 'deny' | 'read-only';
}
export const syntheticCancellationPolicy: CancellationPolicy = Object.freeze({
  cutoff: 'deadline',
  coolingAccess: 'deny',
});
export function intentHash(command: RequestCommand | CancelCommand): string {
  const canonical =
    'commandId' in command
      ? [
          command.version,
          command.commandId,
          command.requestId,
          command.expectedRevision,
          command.action,
        ]
      : [
          command.version,
          command.requestId,
          command.expectedGeneration,
          command.consent,
        ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
export class DeletionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeletionError';
  }
}
/** No route can select the synthetic policy or claim these release gates passed. */
export function accountDeletionCapability() {
  return Object.freeze({
    status: 'unavailable' as const,
    reason: 'REAL_OWNER_POLICY_AND_PROVIDER_COVERAGE_UNPROVEN',
    inventory: INVENTORY_VERSION,
  });
}
