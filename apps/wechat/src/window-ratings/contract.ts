import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { isUuid } from '../profile/contract';

export const windowScoreChoices = Object.freeze(
  Array.from({ length: 21 }, (_, index) => index - 10),
);
export const windowId = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
export const windowScore = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= -10 &&
  value <= 10;
export const windowCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000;
export function invalidWindow(): never {
  throw new ClientError('protocol', 'Invalid window rating data');
}
const label = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
export type WindowSummary =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'known';
      readonly ratingCount: number;
      readonly mean: number | null;
    };
export type WindowOwnScore =
  | { readonly kind: 'not_submitted' | 'unavailable' }
  | {
      readonly kind: 'recorded';
      readonly score: number;
      readonly revision: string;
      readonly recordedAt: string;
    };
export interface WindowFloor {
  readonly id: string;
  readonly sourceFloorKey: string;
  readonly label: string;
}
export interface WindowCanteen {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly sourceCanteenKey: string;
  readonly campusId: string;
  readonly campusLabel: string;
  readonly sourceCampusKey: string;
  readonly floors: readonly WindowFloor[];
}
export interface WindowCatalog {
  readonly catalogRevision: string;
  readonly canteens: readonly WindowCanteen[];
}
export interface RatingWindow {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly canteenId: string;
  readonly canteenName: string;
  readonly floor: WindowFloor;
  readonly summary: WindowSummary;
}
export interface WindowPage {
  readonly catalogRevision: string;
  readonly scoreRevision: string;
  readonly items: readonly RatingWindow[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface WindowDetail {
  readonly catalogRevision: string;
  readonly window: RatingWindow;
  readonly myScore: WindowOwnScore;
}
export interface WindowQuery {
  readonly canteenIds?: readonly string[];
  readonly floorId?: string;
  readonly minRating?: number;
}
export interface WindowSetScore {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedWindowRevision: string;
  readonly expectedOwnScoreRevision: string | null;
  readonly score: number;
}
export type WindowReceipt = {
  readonly requestId: string;
  readonly operation: 'window.score.set.v1';
  readonly windowId: string;
} & (
  | {
      readonly outcome: 'applied' | 'noop';
      readonly score: number;
      readonly scoreRevision: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        | 'WINDOW_REVISION_CONFLICT'
        | 'WINDOW_SCORE_REVISION_CONFLICT'
        | 'WINDOW_SCORE_CANCELLED';
    }
);
export function decodeWindowSummary(value: unknown): WindowSummary {
  if (!isRecord(value)) invalidWindow();
  if (value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'unavailable' });
  }
  exact(value, ['kind', 'ratingCount', 'mean']);
  if (
    value.kind !== 'known' ||
    typeof value.ratingCount !== 'number' ||
    !Number.isSafeInteger(value.ratingCount) ||
    value.ratingCount < 0 ||
    (value.ratingCount === 0
      ? value.mean !== null
      : typeof value.mean !== 'number' ||
        !Number.isFinite(value.mean) ||
        !Number.isInteger(value.mean * 10) ||
        value.mean < -10 ||
        value.mean > 10)
  )
    invalidWindow();
  return Object.freeze({
    kind: 'known',
    ratingCount: value.ratingCount,
    mean: value.mean as number | null,
  });
}
export function decodeWindowOwnScore(value: unknown): WindowOwnScore {
  if (!isRecord(value)) invalidWindow();
  if (value.kind === 'not_submitted' || value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: value.kind });
  }
  exact(value, ['kind', 'score', 'revision', 'recordedAt']);
  if (
    value.kind !== 'recorded' ||
    !windowScore(value.score) ||
    !windowId(value.revision) ||
    !timestamp(value.recordedAt)
  )
    invalidWindow();
  return Object.freeze({
    kind: 'recorded',
    score: value.score,
    revision: value.revision,
    recordedAt: value.recordedAt,
  });
}
export function decodeWindowFloor(value: unknown): WindowFloor {
  exact(value, ['id', 'sourceFloorKey', 'label']);
  if (
    !windowId(value.id) ||
    !label(value.sourceFloorKey) ||
    !label(value.label)
  )
    invalidWindow();
  return Object.freeze({
    id: value.id,
    sourceFloorKey: value.sourceFloorKey,
    label: value.label,
  });
}
export function decodeWindowCanteen(value: unknown): WindowCanteen {
  exact(value, [
    'id',
    'revision',
    'name',
    'sourceCanteenKey',
    'campusId',
    'campusLabel',
    'sourceCampusKey',
    'floors',
  ]);
  if (
    !windowId(value.id) ||
    !windowId(value.revision) ||
    !windowId(value.campusId) ||
    !label(value.name) ||
    !label(value.sourceCanteenKey) ||
    !label(value.campusLabel) ||
    !label(value.sourceCampusKey) ||
    !Array.isArray(value.floors) ||
    value.floors.length > 100
  )
    invalidWindow();
  const floors = value.floors.map(decodeWindowFloor);
  if (new Set(floors.map((floor) => floor.id)).size !== floors.length)
    invalidWindow();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    name: value.name,
    sourceCanteenKey: value.sourceCanteenKey,
    campusId: value.campusId,
    campusLabel: value.campusLabel,
    sourceCampusKey: value.sourceCampusKey,
    floors: Object.freeze(floors),
  });
}
export function decodeWindowCatalog(value: unknown): WindowCatalog {
  exact(value, ['catalogRevision', 'canteens']);
  if (
    !windowId(value.catalogRevision) ||
    !Array.isArray(value.canteens) ||
    value.canteens.length > 100
  )
    invalidWindow();
  const canteens = value.canteens.map(decodeWindowCanteen);
  if (new Set(canteens.map((item) => item.id)).size !== canteens.length)
    invalidWindow();
  const floorIds = canteens.flatMap((canteen) =>
    canteen.floors.map((floor) => floor.id),
  );
  if (new Set(floorIds).size !== floorIds.length) invalidWindow();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    canteens: Object.freeze(canteens),
  });
}
export function decodeWindow(value: unknown): RatingWindow {
  exact(value, [
    'id',
    'revision',
    'name',
    'canteenId',
    'canteenName',
    'floor',
    'summary',
  ]);
  if (
    !windowId(value.id) ||
    !windowId(value.revision) ||
    !windowId(value.canteenId) ||
    !label(value.name) ||
    !label(value.canteenName)
  )
    invalidWindow();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    name: value.name,
    canteenId: value.canteenId,
    canteenName: value.canteenName,
    floor: decodeWindowFloor(value.floor),
    summary: decodeWindowSummary(value.summary),
  });
}
export function decodeWindowPage(value: unknown): WindowPage {
  exact(value, [
    'catalogRevision',
    'scoreRevision',
    'items',
    'nextCursor',
    'continuation',
  ]);
  if (
    !windowId(value.catalogRevision) ||
    typeof value.scoreRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.scoreRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || windowCursor(value.nextCursor)) ||
    !['more', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end') ||
    (value.continuation === 'more' && !value.items.length)
  )
    invalidWindow();
  const items = value.items.map(decodeWindow);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidWindow();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    scoreRevision: value.scoreRevision,
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as 'more' | 'end',
  });
}
export function decodeWindowDetail(value: unknown): WindowDetail {
  exact(value, ['catalogRevision', 'window', 'myScore']);
  if (!windowId(value.catalogRevision)) invalidWindow();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    window: decodeWindow(value.window),
    myScore: decodeWindowOwnScore(value.myScore),
  });
}
export function decodeWindowQuery(value: unknown): WindowQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['canteenIds', 'floorId', 'minRating'].includes(key),
    )
  )
    invalidWindow();
  if (
    value.canteenIds !== undefined &&
    (!Array.isArray(value.canteenIds) ||
      value.canteenIds.length < 1 ||
      value.canteenIds.length > 20 ||
      !value.canteenIds.every(windowId))
  )
    invalidWindow();
  if (value.floorId !== undefined && !windowId(value.floorId)) invalidWindow();
  if (
    value.minRating !== undefined &&
    (typeof value.minRating !== 'number' ||
      !Number.isFinite(value.minRating) ||
      value.minRating < -10 ||
      value.minRating > 10 ||
      !/^-?(?:\d|10)(?:\.\d{1,4})?$/.test(String(value.minRating)))
  )
    invalidWindow();
  return Object.freeze({
    ...(value.canteenIds === undefined
      ? {}
      : {
          canteenIds: Object.freeze(
            [...new Set(value.canteenIds as string[])].sort(),
          ),
        }),
    ...(value.floorId === undefined
      ? {}
      : { floorId: value.floorId as string }),
    ...(value.minRating === undefined
      ? {}
      : { minRating: value.minRating as number }),
  });
}
export function decodeWindowSetScore(value: unknown): WindowSetScore {
  exact(value, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedWindowRevision',
    'expectedOwnScoreRevision',
    'score',
  ]);
  if (
    !windowId(value.clientRequestId) ||
    !windowId(value.expectedCatalogRevision) ||
    !windowId(value.expectedWindowRevision) ||
    !(
      value.expectedOwnScoreRevision === null ||
      windowId(value.expectedOwnScoreRevision)
    ) ||
    !windowScore(value.score)
  )
    invalidWindow();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedWindowRevision: value.expectedWindowRevision,
    expectedOwnScoreRevision: value.expectedOwnScoreRevision,
    score: value.score,
  });
}
export function decodeWindowReceipt(value: unknown): WindowReceipt {
  if (!isRecord(value)) invalidWindow();
  exact(
    value,
    value.outcome === 'rejected'
      ? ['requestId', 'operation', 'windowId', 'outcome', 'code']
      : [
          'requestId',
          'operation',
          'windowId',
          'outcome',
          'score',
          'scoreRevision',
          'recordedAt',
        ],
  );
  if (
    !windowId(value.requestId) ||
    value.operation !== 'window.score.set.v1' ||
    !windowId(value.windowId)
  )
    invalidWindow();
  const base = {
    requestId: value.requestId,
    operation: value.operation,
    windowId: value.windowId,
  } as const;
  if (value.outcome === 'rejected') {
    if (
      value.code !== 'WINDOW_REVISION_CONFLICT' &&
      value.code !== 'WINDOW_SCORE_REVISION_CONFLICT' &&
      value.code !== 'WINDOW_SCORE_CANCELLED'
    )
      invalidWindow();
    return Object.freeze({ ...base, outcome: 'rejected', code: value.code });
  }
  if (
    (value.outcome !== 'applied' && value.outcome !== 'noop') ||
    !windowScore(value.score) ||
    !windowId(value.scoreRevision) ||
    !timestamp(value.recordedAt)
  )
    invalidWindow();
  return Object.freeze({
    ...base,
    outcome: value.outcome,
    score: value.score,
    scoreRevision: value.scoreRevision,
    recordedAt: value.recordedAt,
  });
}
export function matchWindowReceipt(
  id: string,
  command: WindowSetScore,
  receipt: WindowReceipt,
): void {
  if (
    receipt.windowId !== id ||
    receipt.requestId !== command.clientRequestId ||
    (receipt.outcome !== 'rejected' && receipt.score !== command.score) ||
    (receipt.outcome === 'noop' &&
      (command.expectedOwnScoreRevision === null ||
        receipt.scoreRevision !== command.expectedOwnScoreRevision)) ||
    (receipt.outcome === 'applied' &&
      receipt.scoreRevision === command.expectedOwnScoreRevision)
  )
    invalidWindow();
}
