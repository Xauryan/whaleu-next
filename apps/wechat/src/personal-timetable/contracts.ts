import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { monday } from './calendar';
export const base = '/v1/me/timetable';
export const colors = [
  'blue',
  'teal',
  'green',
  'orange',
  'red',
  'purple',
] as const;
export type Color = (typeof colors)[number];
export const operations = [
  'term.create',
  'term.update',
  'term.delete',
  'entry.create',
  'entry.update',
  'entry.delete',
] as const;
export type Operation = (typeof operations)[number];
export interface TermFields {
  name: string;
  weekOneMonday: string;
  weekCount: number;
  timeZone: 'Asia/Shanghai';
}
export interface Term extends TermFields {
  termId: string;
  revision: number;
}
export interface EntryFields {
  name: string;
  teacher: string;
  location: string;
  note: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  weeks: number[];
  color: Color;
}
export interface Entry extends EntryFields {
  entryId: string;
  termId: string;
}
export interface Detail {
  term: Term;
  entries: Entry[];
}
export interface Command {
  version: 1;
  requestId: string;
  operation: Operation;
  termId: string;
  expectedRevision: number;
  entryId?: string;
  payload: TermFields | EntryFields | Record<string, never>;
}
export interface Receipt {
  version: 1;
  requestId: string;
  intentHash: string;
  operation: Operation;
  termId: string;
  entryId: string | null;
  expectedRevision: number;
  resultingRevision: number | null;
  outcome: 'applied' | 'rejected' | 'cancelled';
  code: string | null;
}
export type Recovery =
  | { status: 'unknown'; requestId: string }
  | { status: 'settled'; receipt: Receipt };
export function invalid(): never {
  throw new ClientError('protocol', '课表数据未能安全验证');
}
export function object(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    return invalid();
  return value;
}
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    return invalid();
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalid();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    return invalid();
  return value as T;
}
function text(
  value: unknown,
  max: number,
  required = false,
  note = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && value.length === 0) ||
    (!note && value.trim() !== value) ||
    /[\p{Cc}\p{Cf}]/u.test(note ? value.replace(/[\n\t]/g, '') : value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return invalid();
  return value;
}
const termKeys = ['name', 'weekOneMonday', 'weekCount', 'timeZone'];
const entryKeys = [
  'name',
  'teacher',
  'location',
  'note',
  'dayOfWeek',
  'startMinute',
  'endMinute',
  'weeks',
  'color',
];
export function decodeTermFields(input: unknown): TermFields {
  const value = object(input, termKeys);
  const date = text(value.weekOneMonday, 10, true);
  try {
    monday(date);
  } catch {
    return invalid();
  }
  return {
    name: text(value.name, 120, true),
    weekOneMonday: date,
    weekCount: integer(value.weekCount, 1, 30),
    timeZone: choice(value.timeZone, ['Asia/Shanghai']),
  };
}
export function decodeEntryFields(input: unknown, count = 30): EntryFields {
  const value = object(input, entryKeys);
  if (
    !Array.isArray(value.weeks) ||
    value.weeks.length < 1 ||
    value.weeks.length > count
  )
    return invalid();
  const weeks = value.weeks.map((week) => integer(week, 1, count));
  if (weeks.some((week, index) => index > 0 && week <= weeks[index - 1]!))
    return invalid();
  const startMinute = integer(value.startMinute, 0, 1439),
    endMinute = integer(value.endMinute, 1, 1440);
  if (endMinute <= startMinute) return invalid();
  return {
    name: text(value.name, 120, true),
    teacher: text(value.teacher, 100),
    location: text(value.location, 100),
    note: text(value.note, 500, false, true),
    dayOfWeek: integer(value.dayOfWeek, 1, 7),
    startMinute,
    endMinute,
    weeks,
    color: choice(value.color, colors),
  };
}
export function decodeTerm(input: unknown): Term {
  const value = object(input, ['termId', ...termKeys, 'revision']);
  return {
    termId: uuid(value.termId),
    ...decodeTermFields(
      Object.fromEntries(termKeys.map((key) => [key, value[key]])),
    ),
    revision: integer(value.revision, 1, 2147483647),
  };
}
export function decodeEntry(input: unknown, count = 30): Entry {
  const value = object(input, ['entryId', 'termId', ...entryKeys]);
  return {
    entryId: uuid(value.entryId),
    termId: uuid(value.termId),
    ...decodeEntryFields(
      Object.fromEntries(entryKeys.map((key) => [key, value[key]])),
      count,
    ),
  };
}
export function decodeTerms(input: unknown): { terms: Term[] } {
  const value = object(input, ['terms']);
  if (!Array.isArray(value.terms) || value.terms.length > 32) return invalid();
  const terms = value.terms.map(decodeTerm);
  if (new Set(terms.map((term) => term.termId)).size !== terms.length)
    return invalid();
  return { terms };
}
export function decodeDetail(input: unknown): Detail {
  const value = object(input, ['term', 'entries']),
    term = decodeTerm(value.term);
  if (!Array.isArray(value.entries) || value.entries.length > 200)
    return invalid();
  const entries = value.entries.map((entry) =>
    decodeEntry(entry, term.weekCount),
  );
  if (
    entries.some((entry) => entry.termId !== term.termId) ||
    new Set(entries.map((entry) => entry.entryId)).size !== entries.length
  )
    return invalid();
  return { term, entries };
}
export function decodeCommand(input: unknown): Command {
  const operation = choice(
      (input as Record<string, unknown> | null)?.operation,
      operations,
    ),
    isEntry = operation.startsWith('entry.');
  const value = object(input, [
    'version',
    'requestId',
    'operation',
    'termId',
    'expectedRevision',
    ...(isEntry ? ['entryId'] : []),
    'payload',
  ]);
  if (value.version !== 1) return invalid();
  const expectedRevision = integer(
    value.expectedRevision,
    operation === 'term.create' ? 0 : 1,
    operation === 'term.create' ? 0 : 2147483647,
  );
  const payload = operation.endsWith('.delete')
    ? (object(value.payload, []) as Record<string, never>)
    : isEntry
      ? decodeEntryFields(value.payload)
      : decodeTermFields(value.payload);
  // Canonical insertion order is shared with the server. Never hash caller object order.
  return {
    version: 1,
    requestId: uuid(value.requestId),
    operation,
    termId: uuid(value.termId),
    expectedRevision,
    ...(isEntry ? { entryId: uuid(value.entryId) } : {}),
    payload,
  };
}
export function commandHash(command: Command): string {
  return sha256(JSON.stringify(decodeCommand(command)));
}
const codes = [
  'TIMETABLE_NOT_FOUND',
  'TIMETABLE_REVISION_CONFLICT',
  'TIMETABLE_ID_REUSED',
  'TIMETABLE_TERM_LIMIT',
  'TIMETABLE_ENTRY_LIMIT',
  'TIMETABLE_WEEKS_OUT_OF_RANGE',
  'SAFETY_ACCESS_SUSPENDED',
  'SAFETY_ACTION_RESTRICTED',
];
export function decodeReceipt(input: unknown): Receipt {
  const value = object(input, [
    'version',
    'requestId',
    'intentHash',
    'operation',
    'termId',
    'entryId',
    'expectedRevision',
    'resultingRevision',
    'outcome',
    'code',
  ]);
  if (
    value.version !== 1 ||
    typeof value.intentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.intentHash)
  )
    return invalid();
  const operation = choice(value.operation, operations),
    outcome = choice(value.outcome, ['applied', 'rejected', 'cancelled']);
  const entryId = value.entryId === null ? null : uuid(value.entryId);
  if ((entryId !== null) !== operation.startsWith('entry.')) return invalid();
  if (outcome !== 'rejected' && value.code !== null) return invalid();
  if (outcome === 'cancelled' && value.resultingRevision !== null)
    return invalid();
  if (
    outcome === 'applied' &&
    value.resultingRevision !== Number(value.expectedRevision) + 1
  )
    return invalid();
  return {
    version: 1,
    requestId: uuid(value.requestId),
    intentHash: value.intentHash,
    operation,
    termId: uuid(value.termId),
    entryId,
    expectedRevision: integer(
      value.expectedRevision,
      operation === 'term.create' ? 0 : 1,
      operation === 'term.create' ? 0 : 2147483647,
    ),
    resultingRevision:
      value.resultingRevision === null
        ? null
        : integer(value.resultingRevision, 1, 2147483647),
    outcome,
    code: outcome === 'rejected' ? choice(value.code, codes) : null,
  };
}
export function decodeRecovery(input: unknown): Recovery {
  if ((input as Record<string, unknown> | null)?.status === 'unknown') {
    const value = object(input, ['status', 'requestId']);
    return { status: 'unknown', requestId: uuid(value.requestId) };
  }
  const value = object(input, ['status', 'receipt']);
  if (value.status !== 'settled') return invalid();
  return { status: 'settled', receipt: decodeReceipt(value.receipt) };
}
export function matchReceipt(command: Command, receipt: Receipt): void {
  receipt = decodeReceipt(receipt);
  if (
    receipt.requestId !== command.requestId ||
    receipt.intentHash !== commandHash(command) ||
    receipt.operation !== command.operation ||
    receipt.termId !== command.termId ||
    receipt.entryId !== (command.entryId ?? null) ||
    receipt.expectedRevision !== command.expectedRevision
  )
    invalid();
  if (
    receipt.outcome === 'applied' &&
    receipt.resultingRevision !== command.expectedRevision + 1
  )
    invalid();
}
