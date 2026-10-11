import { ClientError } from '../api/errors';
import { isUuid } from '../profile/contract';
export const errandMediaSlots = [
  'public0',
  'public1',
  'public2',
  'private0',
  'private1',
  'private2',
] as const;
export type ErrandMediaSlot = (typeof errandMediaSlots)[number];
export function invalidErrandMedia(): never {
  throw new ClientError('protocol', 'Invalid errand image response');
}
export function errandMediaUuid(value: unknown): string {
  if (!isUuid(value)) invalidErrandMedia();
  return value;
}
export function errandMediaSlot(value: unknown): ErrandMediaSlot {
  if (
    typeof value !== 'string' ||
    !(errandMediaSlots as readonly string[]).includes(value)
  )
    invalidErrandMedia();
  return value as ErrandMediaSlot;
}
export function errandMediaRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidErrandMedia();
  return value;
}
