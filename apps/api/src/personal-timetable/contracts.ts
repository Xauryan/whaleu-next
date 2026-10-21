import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TIMETABLE_TERM_LIMIT = 32;
export const TIMETABLE_ENTRY_LIMIT = 200;
export const TIMETABLE_REVISION_MAX = 2147483647;
export const timetableIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const timetableEmptySchema = z.strictObject({});
const revision = z.number().int().min(0).max(TIMETABLE_REVISION_MAX);
const text = (max: number, required = false) =>
  z
    .string()
    .max(max)
    .refine(
      (v) =>
        v === v.trim() &&
        (!required || v.length > 0) &&
        !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v),
    );
export function isTimetableMonday(value: string): boolean {
  if (!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCDay() === 1
  );
}
export const timetableTermPayloadSchema = z.strictObject({
  name: text(120, true),
  weekOneMonday: z.string().refine(isTimetableMonday),
  weekCount: z.number().int().min(1).max(30),
  timeZone: z.literal('Asia/Shanghai'),
});
export const timetableEntryPayloadSchema = z
  .strictObject({
    name: text(120, true),
    teacher: text(100),
    location: text(100),
    note: z
      .string()
      .max(500)
      .refine((v) => !/[\p{Cf}\p{Cc}\p{Cs}]/u.test(v.replace(/[\n\t]/g, ''))),
    dayOfWeek: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    weeks: z
      .array(z.number().int().min(1).max(30))
      .min(1)
      .max(30)
      .refine((v) => v.every((n, i) => i === 0 || n > v[i - 1]!)),
    color: z.enum(['blue', 'teal', 'green', 'orange', 'red', 'purple']),
  })
  .refine((v) => v.endMinute > v.startMinute);
const base = {
  version: z.literal(1),
  requestId: timetableIdSchema,
  termId: timetableIdSchema,
};
export const timetableCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...base,
    operation: z.literal('term.create'),
    expectedRevision: z.literal(0),
    payload: timetableTermPayloadSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('term.update'),
    expectedRevision: revision.min(1),
    payload: timetableTermPayloadSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('term.delete'),
    expectedRevision: revision.min(1),
    payload: timetableEmptySchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('entry.create'),
    expectedRevision: revision.min(1),
    entryId: timetableIdSchema,
    payload: timetableEntryPayloadSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('entry.update'),
    expectedRevision: revision.min(1),
    entryId: timetableIdSchema,
    payload: timetableEntryPayloadSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('entry.delete'),
    expectedRevision: revision.min(1),
    entryId: timetableIdSchema,
    payload: timetableEmptySchema,
  }),
]);
export type TimetableCommand = z.infer<typeof timetableCommandSchema>;
export type TimetableTermPayload = z.infer<typeof timetableTermPayloadSchema>;
export type TimetableEntryPayload = z.infer<typeof timetableEntryPayloadSchema>;
export const timetableTermSchema = timetableTermPayloadSchema.extend({
  termId: timetableIdSchema,
  revision: revision.min(1),
});
export const timetableEntrySchema = timetableEntryPayloadSchema.safeExtend({
  entryId: timetableIdSchema,
  termId: timetableIdSchema,
});
export type TimetableTerm = z.infer<typeof timetableTermSchema>;
export type TimetableEntry = z.infer<typeof timetableEntrySchema>;
export const timetableTermsSchema = z.strictObject({
  terms: z.array(timetableTermSchema).max(TIMETABLE_TERM_LIMIT),
});
export const timetableDetailSchema = z
  .strictObject({
    term: timetableTermSchema,
    entries: z.array(timetableEntrySchema).max(TIMETABLE_ENTRY_LIMIT),
  })
  .refine((v) =>
    v.entries.every(
      (e) =>
        e.termId === v.term.termId &&
        e.weeks.every((w) => w <= v.term.weekCount),
    ),
  );
export const timetableRejectionCodeSchema = z.enum([
  'TIMETABLE_NOT_FOUND',
  'TIMETABLE_REVISION_CONFLICT',
  'TIMETABLE_ID_REUSED',
  'TIMETABLE_TERM_LIMIT',
  'TIMETABLE_ENTRY_LIMIT',
  'TIMETABLE_WEEKS_OUT_OF_RANGE',
  'SAFETY_ACCESS_SUSPENDED',
  'SAFETY_ACTION_RESTRICTED',
]);
export type TimetableRejectionCode = z.infer<
  typeof timetableRejectionCodeSchema
>;
export const timetableReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: timetableIdSchema,
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.enum([
      'term.create',
      'term.update',
      'term.delete',
      'entry.create',
      'entry.update',
      'entry.delete',
    ]),
    termId: timetableIdSchema,
    entryId: timetableIdSchema.nullable(),
    expectedRevision: revision,
    resultingRevision: revision.min(1).nullable(),
    outcome: z.enum(['applied', 'rejected', 'cancelled']),
    code: timetableRejectionCodeSchema.nullable(),
  })
  .refine(
    (v) =>
      (v.outcome === 'rejected') === (v.code !== null) &&
      v.operation.startsWith('entry.') === (v.entryId !== null) &&
      (v.operation === 'term.create'
        ? v.expectedRevision === 0
        : v.expectedRevision > 0) &&
      (v.outcome !== 'applied' ||
        v.resultingRevision === v.expectedRevision + 1) &&
      (v.outcome !== 'cancelled' || v.resultingRevision === null),
  );
export type TimetableReceipt = z.infer<typeof timetableReceiptSchema>;
export const timetableRecoverySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('unknown'),
    requestId: timetableIdSchema,
  }),
  z.strictObject({
    status: z.literal('settled'),
    receipt: timetableReceiptSchema,
  }),
]);
export type TimetableRecovery = z.infer<typeof timetableRecoverySchema>;
/** This field order is shared with native. Parsing never trims or normalizes text. */
export function canonicalTimetableCommand(raw: TimetableCommand): string {
  const c = timetableCommandSchema.parse(raw);
  return JSON.stringify({
    version: c.version,
    requestId: c.requestId,
    operation: c.operation,
    termId: c.termId,
    expectedRevision: c.expectedRevision,
    ...('entryId' in c ? { entryId: c.entryId } : {}),
    payload: c.payload,
  });
}
export const timetableIntentHash = (command: TimetableCommand): string =>
  createHash('sha256')
    .update(canonicalTimetableCommand(command), 'utf8')
    .digest('hex');
export function timetableReceipt(
  command: TimetableCommand,
  outcome: TimetableReceipt['outcome'],
  resultingRevision: number | null,
  code: TimetableRejectionCode | null = null,
): TimetableReceipt {
  return timetableReceiptSchema.parse({
    version: 1,
    requestId: command.requestId,
    intentHash: timetableIntentHash(command),
    operation: command.operation,
    termId: command.termId,
    entryId: 'entryId' in command ? command.entryId : null,
    expectedRevision: command.expectedRevision,
    resultingRevision,
    outcome,
    code,
  });
}
