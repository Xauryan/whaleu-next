import { ClientError } from '../api/errors';
import { isUuid } from '../profile/contract';
export const announcementMediaSlots = [
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
export type AnnouncementMediaSlot = (typeof announcementMediaSlots)[number];
export function invalidAnnouncementMedia(): never {
  throw new ClientError('protocol', 'Invalid announcement image response');
}
export function announcementMediaUuid(value: unknown): string {
  if (!isUuid(value)) invalidAnnouncementMedia();
  return value;
}
export function announcementMediaSlot(value: unknown): AnnouncementMediaSlot {
  if (
    typeof value !== 'string' ||
    !(announcementMediaSlots as readonly string[]).includes(value)
  )
    invalidAnnouncementMedia();
  return value as AnnouncementMediaSlot;
}
export function announcementMediaRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidAnnouncementMedia();
  return value;
}
