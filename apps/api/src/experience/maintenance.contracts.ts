import { createHash } from 'node:crypto';
import { z } from 'zod';
import { experienceIdSchema } from './contracts.js';
import { levelFor, titles } from './catalog.js';

export const maintenanceOperations = [
  'repair_level_titles',
  'repair_default_title',
] as const;
export type MaintenanceOperation = (typeof maintenanceOperations)[number];
export const maintenanceSchema = z.union([
  z.strictObject({
    requestId: experienceIdSchema,
    operation: z.enum(maintenanceOperations),
  }),
  z.strictObject({
    requestId: experienceIdSchema,
    previousRequestId: experienceIdSchema,
  }),
]);
export type MaintenanceIntent = z.infer<typeof maintenanceSchema>;
export interface MaintenanceReceipt {
  requestId: string;
  operation: MaintenanceOperation;
  runId: string;
  previousRequestId: string | null;
  visited: number;
  updatedOwners: number;
  grantedTitles: number;
  skippedUnknownLevel: number;
  skippedIneligible: number;
  done: boolean;
}
/** Only nonsecret canonical intent, separate from the owner's request namespace. */
export function maintenanceIntentHash(input: MaintenanceIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        'operation' in input
          ? ['title-maintenance-v1', 'start', input.operation]
          : ['title-maintenance-v1', 'continue', input.previousRequestId],
      ),
    )
    .digest('hex');
}
/** Missing history never implies level one; known zero legitimately does. */
export function maintenanceTitleKeys(
  operation: MaintenanceOperation,
  balance: string | null,
  eligible: boolean,
): string[] {
  if (operation === 'repair_default_title')
    return eligible ? ['default_jingxiaoyu'] : [];
  if (balance === null) return [];
  const level = levelFor(BigInt(balance));
  return titles
    .filter(
      (title) =>
        title.kind === 'level' &&
        title.unlockLevel !== null &&
        title.unlockLevel <= level,
    )
    .map((title) => title.key);
}
