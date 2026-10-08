import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import {
  directoryCategorySchema,
  directorySummarySchema,
  directoryDetailSchema,
} from './contracts.js';
import type {
  DirectoryKind,
  DirectoryCategory,
  DirectorySummary,
  DirectoryDetail,
} from './contracts.js';

const rawSlot = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('absent'), reference: z.null() }),
  z.strictObject({ status: z.literal('unknown'), reference: z.null() }),
  z.strictObject({
    status: z.literal('referenced'),
    reference: z.string().min(1).max(4096),
  }),
]);
export const directoryStoredMediaSchema = z.strictObject({
  avatar: rawSlot,
  mainQr: rawSlot,
  managerWechatImage: rawSlot,
  linkedOfficialAccountQr: rawSlot,
  introImages: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('known'),
      references: z.array(z.string().min(1).max(4096)).max(100),
    }),
    z.strictObject({ status: z.literal('unknown'), references: z.null() }),
  ]),
});
export interface StoredDirectoryCategory {
  id: string;
  kind: DirectoryKind;
  name: string;
  description: string;
  accent: string;
  display_ordinal: string;
}
export interface StoredDirectoryEntry {
  id: string;
  category_id: string;
  kind: DirectoryKind;
  platform: string;
  name: string;
  intro_text: string;
  badge_state: string;
  badge: string | null;
  media: unknown;
  qq_state: string;
  qq_number: string | null;
  source_created_at: Date | null;
  source_updated_at: Date | null;
  display_ordinal: string;
  search_ordinal: string;
}
function fail(): never {
  throw new ApplicationError('DIRECTORY_UNAVAILABLE');
}
function media(row: StoredDirectoryEntry) {
  const parsed = directoryStoredMediaSchema.safeParse(row.media);
  if (!parsed.success) return fail();
  return parsed.data;
}
function slot(value: z.infer<typeof rawSlot>) {
  return {
    status: value.status === 'absent' ? 'absent' : 'unavailable',
    value: null,
  } as const;
}
function badge(row: StoredDirectoryEntry) {
  if (row.badge_state === 'known') return { status: 'known', value: row.badge };
  if (row.badge_state === 'unknown' && row.badge === null)
    return { status: 'unavailable', value: null };
  return fail();
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail();
  return result.data;
}
export function directoryCategory(
  row: StoredDirectoryCategory,
): DirectoryCategory {
  return checked(directoryCategorySchema, {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    accent: row.accent,
  });
}
export function directorySummary(row: StoredDirectoryEntry): DirectorySummary {
  const source = media(row);
  return checked(directorySummarySchema, {
    id: row.id,
    categoryId: row.category_id,
    kind: row.kind,
    platform: row.platform,
    name: row.name,
    introPreview: Array.from(row.intro_text).slice(0, 160).join(''),
    badge: badge(row),
    avatar: slot(source.avatar),
  });
}
function date(value: Date | null) {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return fail();
  return value.toISOString();
}
export function directoryDetail(row: StoredDirectoryEntry): DirectoryDetail {
  const source = media(row);
  const inapplicable = { status: 'not_applicable', value: null } as const;
  if (
    row.platform !== 'qq' &&
    (row.qq_state !== 'not_applicable' || row.qq_number !== null)
  )
    return fail();
  if (
    row.platform !== 'wechat' &&
    source.managerWechatImage.status === 'referenced'
  )
    return fail();
  if (
    row.platform === 'official' &&
    source.linkedOfficialAccountQr.status === 'referenced'
  )
    return fail();
  const number =
    row.platform !== 'qq'
      ? inapplicable
      : row.qq_state === 'known'
        ? { status: 'known', value: row.qq_number }
        : row.qq_state === 'unknown' && row.qq_number === null
          ? { status: 'unavailable', value: null }
          : fail();
  return checked(directoryDetailSchema, {
    ...directorySummary(row),
    introText: row.intro_text,
    introImages:
      source.introImages.status === 'known' &&
      source.introImages.references.length === 0
        ? { status: 'known', items: [] }
        : { status: 'unavailable', items: null },
    mainQr: slot(source.mainQr),
    managerWechatImage:
      row.platform === 'wechat'
        ? slot(source.managerWechatImage)
        : inapplicable,
    linkedOfficialAccountQr:
      row.platform === 'official'
        ? inapplicable
        : slot(source.linkedOfficialAccountQr),
    qqGroupNumber: number,
    createdAt: date(row.source_created_at),
    updatedAt: date(row.source_updated_at),
    visits: { status: 'unavailable', value: null },
    managers: { status: 'unavailable', items: null },
    management: { status: 'unavailable' },
  });
}
