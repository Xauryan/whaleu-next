import { ApplicationError } from '../http/application-error.js';
import {
  announcementDetailSchema,
  announcementPopupSchema,
  announcementSummarySchema,
} from './contracts.js';
export interface StoredAnnouncement {
  id: string;
  revision: string;
  source_ordinal: string;
  version_label: string;
  title: string;
  body_text: string;
  announcement_date: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  highlight: boolean;
  popup_enabled: boolean;
  popup_title_state: string;
  popup_title: string | null;
  popup_body_state: string;
  popup_body_text: string | null;
  media_state: string;
}
export function announcementMedia(state: string) {
  if (state === 'known_empty')
    return { status: 'known_empty', items: [] } as const;
  if (state === 'unavailable')
    return { status: 'unavailable', items: null } as const;
  throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
}
export function announcementSummary(
  row: StoredAnnouncement,
  latestId: string | null,
) {
  return announcementSummarySchema.parse({
    id: row.id,
    revision: row.revision,
    versionLabel: row.version_label,
    title: row.title,
    announcementDate: row.announcement_date,
    createdAt: row.source_created_at,
    highlight: row.highlight,
    isLatest: row.id === latestId,
    popupEnabled: row.popup_enabled,
  });
}
export function announcementDetail(
  row: StoredAnnouncement,
  latestId: string | null,
) {
  return announcementDetailSchema.parse({
    ...announcementSummary(row, latestId),
    bodyText: row.body_text,
    updatedAt: row.source_updated_at,
    media: announcementMedia(row.media_state),
  });
}
export function announcementPopup(row: StoredAnnouncement) {
  function override(state: string, value: string | null, fallback: string) {
    if (state === 'absent' && value === null) return fallback;
    if (state === 'value' && typeof value === 'string') return value;
    throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
  }
  return announcementPopupSchema.parse({
    id: row.id,
    revision: row.revision,
    versionLabel: row.version_label,
    title: override(row.popup_title_state, row.popup_title, row.title),
    announcementDate: row.announcement_date,
    bodyText: override(
      row.popup_body_state,
      row.popup_body_text,
      row.body_text,
    ),
    media: announcementMedia(row.media_state),
  });
}
