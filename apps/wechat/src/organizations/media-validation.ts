import { ClientError } from '../api/errors';
import { isUuid } from '../profile/contract';
export const organizationMediaSlots = [
  'avatar',
  'mainQr',
  'managerContact',
  'linkedOfficialQr',
  'introImage0',
  'introImage1',
  'introImage2',
  'introImage3',
  'introImage4',
  'introImage5',
  'introImage6',
  'introImage7',
  'introImage8',
] as const;
export type OrganizationMediaSlot = (typeof organizationMediaSlots)[number];
export function invalidOrganizationMedia(): never {
  throw new ClientError('protocol', 'Invalid organization image response');
}
export function organizationMediaUuid(value: unknown): string {
  if (!isUuid(value)) invalidOrganizationMedia();
  return value;
}
export function organizationMediaSlot(value: unknown): OrganizationMediaSlot {
  if (
    typeof value !== 'string' ||
    !(organizationMediaSlots as readonly string[]).includes(value)
  )
    invalidOrganizationMedia();
  return value as OrganizationMediaSlot;
}
export function organizationMediaRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidOrganizationMedia();
  return value;
}
