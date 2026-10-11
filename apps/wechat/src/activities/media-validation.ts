import { ClientError } from '../api/errors';
import { isUuid } from '../profile/contract';
export const activityMediaSlots = [
  'cover',
  'gallery0',
  'gallery1',
  'gallery2',
  'gallery3',
  'gallery4',
  'gallery5',
  'gallery6',
  'gallery7',
  'gallery8',
] as const;
export type ActivityMediaSlot = (typeof activityMediaSlots)[number];
export function invalidActivityMedia(): never {
  throw new ClientError('protocol', 'Invalid activity image response');
}
export function activityMediaUuid(value: unknown): string {
  if (!isUuid(value)) invalidActivityMedia();
  return value;
}
export function activityMediaSlot(value: unknown): ActivityMediaSlot {
  if (
    typeof value !== 'string' ||
    !(activityMediaSlots as readonly string[]).includes(value)
  )
    invalidActivityMedia();
  return value as ActivityMediaSlot;
}
export function activityMediaRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidActivityMedia();
  return value;
}
