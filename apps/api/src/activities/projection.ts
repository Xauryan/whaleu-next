import { activitySummarySchema, activityDetailSchema } from './contracts.js';
export interface StoredActivity {
  id: string;
  revision: string;
  region_id: string;
  display_ordinal: string;
  title: string;
  body_text: string;
  organizer_label: string;
  activity_time: string | null;
  activity_location: string | null;
  reward: boolean | null;
  online: boolean | null;
  source_created_at: string | null;
  cover_state: 'absent' | 'unavailable';
  avatar_state: 'absent' | 'unavailable';
  qr_state: 'absent' | 'unavailable';
  gallery_state: 'known_empty' | 'unavailable';
}
export function activitySummary(row: StoredActivity) {
  return activitySummarySchema.parse({
    id: row.id,
    revision: row.revision,
    title: row.title,
    organizerLabel: row.organizer_label,
    reward:
      row.reward === null
        ? { status: 'unavailable', value: null }
        : { status: 'known', value: row.reward },
    online:
      row.online === null
        ? { status: 'unavailable', value: null }
        : { status: 'known', value: row.online ? 'online' : 'offline' },
    createdAt:
      row.source_created_at === null
        ? { status: 'unavailable', value: null }
        : { status: 'known', value: row.source_created_at },
    cover: { status: row.cover_state },
    organizerAvatar: { status: row.avatar_state },
  });
}
export function activityDetail(row: StoredActivity) {
  return activityDetailSchema.parse({
    ...activitySummary(row),
    regionId: row.region_id,
    bodyText: row.body_text,
    activityTime: row.activity_time,
    activityLocation: row.activity_location,
    organizerQr: { status: row.qr_state },
    gallery:
      row.gallery_state === 'known_empty'
        ? { status: 'known_empty', items: [] }
        : { status: row.gallery_state, items: null },
  });
}
