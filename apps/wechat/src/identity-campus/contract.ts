import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';

export interface IdentityCampusSummary {
  readonly id: string;
  readonly name: string;
  readonly operatingRegion: { readonly id: string; readonly name: string };
}
export const identityCampusReasons = [
  'current',
  'choice_required',
  'history_unknown',
  'inputs_changed',
  'choice_no_longer_valid',
  'affiliation_required',
  'affiliation_unavailable',
  'topology_unavailable',
] as const;
export type IdentityCampusReason = (typeof identityCampusReasons)[number];
export interface IdentityCampusState {
  readonly affiliation: 'verified' | 'unverified' | 'unavailable';
  readonly selection: 'valid' | 'selection_required' | 'unavailable';
  readonly reason: IdentityCampusReason;
  readonly selectedCampus: IdentityCampusSummary | null;
  readonly options: {
    readonly status: 'known' | 'unavailable';
    readonly items: readonly IdentityCampusSummary[];
  };
  readonly writeEligibility: {
    readonly phone: 'verified' | 'unverified' | 'unavailable';
    readonly safety: 'allowed' | 'restricted' | 'unavailable';
  };
  readonly canSelect: boolean;
  readonly expectedStateRevision: string | null;
  readonly guidance:
    'choose' | 'reselect' | 'refresh' | 'await_affiliation' | 'unavailable';
}
export interface IdentityCampusIntent {
  readonly requestId: string;
  readonly campusId: string;
  readonly expectedStateRevision: string;
}
export interface IdentityCampusReceipt {
  readonly requestId: string;
  readonly campusId: string;
  readonly outcome: 'applied' | 'unchanged';
  readonly selectionRevision: number;
}
export function invalidIdentityCampus(): never {
  throw new ClientError('protocol', 'Invalid identity campus response');
}
export function exactIdentityCampus(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalidIdentityCampus();
}
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^ic1:[a-f0-9]{64}$/.test(value);
const requestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const uuid = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
const label = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 500 &&
  value.trim().length > 0 &&
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
function campus(value: unknown): IdentityCampusSummary {
  exactIdentityCampus(value, ['id', 'name', 'operatingRegion']);
  exactIdentityCampus(value.operatingRegion, ['id', 'name']);
  if (
    !uuid(value.id) ||
    !label(value.name) ||
    !uuid(value.operatingRegion.id) ||
    !label(value.operatingRegion.name)
  )
    invalidIdentityCampus();
  return Object.freeze({
    id: value.id,
    name: value.name,
    operatingRegion: Object.freeze({
      id: value.operatingRegion.id,
      name: value.operatingRegion.name,
    }),
  });
}
/** Reject extra private fields and inconsistent authority, rather than projecting them away. */
export function decodeIdentityCampusState(value: unknown): IdentityCampusState {
  exactIdentityCampus(value, [
    'affiliation',
    'selection',
    'reason',
    'selectedCampus',
    'options',
    'writeEligibility',
    'canSelect',
    'expectedStateRevision',
    'guidance',
  ]);
  exactIdentityCampus(value.options, ['status', 'items']);
  exactIdentityCampus(value.writeEligibility, ['phone', 'safety']);
  if (
    !['verified', 'unverified', 'unavailable'].includes(
      value.affiliation as string,
    ) ||
    !['valid', 'selection_required', 'unavailable'].includes(
      value.selection as string,
    ) ||
    !(identityCampusReasons as readonly unknown[]).includes(value.reason) ||
    !['known', 'unavailable'].includes(value.options.status as string) ||
    !Array.isArray(value.options.items) ||
    value.options.items.length > 10000 ||
    !['verified', 'unverified', 'unavailable'].includes(
      value.writeEligibility.phone as string,
    ) ||
    !['allowed', 'restricted', 'unavailable'].includes(
      value.writeEligibility.safety as string,
    ) ||
    typeof value.canSelect !== 'boolean' ||
    ![
      'choose',
      'reselect',
      'refresh',
      'await_affiliation',
      'unavailable',
    ].includes(value.guidance as string)
  )
    invalidIdentityCampus();
  const items = value.options.items.map(campus);
  const selected =
    value.selectedCampus === null ? null : campus(value.selectedCampus);
  const possible =
    value.affiliation === 'verified' &&
    value.options.status === 'known' &&
    items.length > 0 &&
    value.writeEligibility.phone === 'verified' &&
    value.writeEligibility.safety === 'allowed';
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    (value.options.status === 'unavailable' && items.length !== 0) ||
    (value.affiliation !== 'verified' &&
      (value.options.status !== 'unavailable' ||
        selected !== null ||
        value.selection !== 'unavailable')) ||
    (value.selection === 'valid') !== (selected !== null) ||
    (value.selection === 'valid') !== (value.reason === 'current') ||
    (value.selection === 'selection_required') !==
      (value.reason === 'choice_required') ||
    (value.canSelect && !possible) ||
    (value.canSelect
      ? !revision(value.expectedStateRevision)
      : value.expectedStateRevision !== null) ||
    (value.affiliation === 'unverified' &&
      value.reason !== 'affiliation_required') ||
    (value.affiliation === 'unavailable' &&
      value.reason !== 'affiliation_unavailable') ||
    (value.affiliation === 'verified' &&
      ['affiliation_required', 'affiliation_unavailable'].includes(
        value.reason as string,
      ))
  )
    invalidIdentityCampus();
  if (
    selected &&
    value.options.status === 'known' &&
    !items.some((item) => JSON.stringify(item) === JSON.stringify(selected))
  )
    invalidIdentityCampus();
  if (
    value.canSelect
      ? !['choose', 'reselect'].includes(value.guidance as string)
      : ['choose', 'reselect'].includes(value.guidance as string)
  )
    invalidIdentityCampus();
  if (
    value.guidance === 'await_affiliation' &&
    value.affiliation !== 'unverified'
  )
    invalidIdentityCampus();
  return Object.freeze({
    ...value,
    selectedCampus: selected,
    options: Object.freeze({
      status: value.options.status,
      items: Object.freeze(items),
    }),
    writeEligibility: Object.freeze({ ...value.writeEligibility }),
  }) as unknown as IdentityCampusState;
}
export function decodeIdentityCampusIntent(
  value: unknown,
): IdentityCampusIntent {
  exactIdentityCampus(value, [
    'requestId',
    'campusId',
    'expectedStateRevision',
  ]);
  if (
    !requestId(value.requestId) ||
    !uuid(value.campusId) ||
    !revision(value.expectedStateRevision)
  )
    invalidIdentityCampus();
  return Object.freeze({
    requestId: value.requestId,
    campusId: value.campusId,
    expectedStateRevision: value.expectedStateRevision,
  });
}
export function decodeIdentityCampusReceipt(
  value: unknown,
): IdentityCampusReceipt {
  exactIdentityCampus(value, [
    'requestId',
    'campusId',
    'outcome',
    'selectionRevision',
  ]);
  if (
    !requestId(value.requestId) ||
    !uuid(value.campusId) ||
    !['applied', 'unchanged'].includes(value.outcome as string) ||
    !Number.isSafeInteger(value.selectionRevision) ||
    (value.selectionRevision as number) < 1 ||
    (value.selectionRevision as number) > 2147483647
  )
    invalidIdentityCampus();
  return Object.freeze({ ...value }) as unknown as IdentityCampusReceipt;
}
export function matchIdentityCampusReceipt(
  intent: Pick<IdentityCampusIntent, 'requestId' | 'campusId'>,
  receipt: IdentityCampusReceipt,
): void {
  if (
    intent.requestId !== receipt.requestId ||
    intent.campusId !== receipt.campusId
  )
    invalidIdentityCampus();
}
