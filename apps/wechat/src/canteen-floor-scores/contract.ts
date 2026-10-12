import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import {
  windowId,
  decodeWindowCatalog,
  type WindowCatalog,
} from '../window-ratings/contract';
export const floorId = windowId;
export const decodeFloorCatalog = decodeWindowCatalog;
export type FloorCatalog = WindowCatalog;
export const floorScore = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5;
export function invalidFloor(): never {
  throw new ClientError('protocol', 'Invalid canteen-floor score data');
}
export type FloorSummary =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'known';
      readonly ratingCount: number;
      readonly mean: number | null;
    };
export type FloorOwn =
  | { readonly kind: 'not_submitted' | 'unavailable' }
  | {
      readonly kind: 'recorded';
      readonly score: number;
      readonly revision: string;
      readonly recordedAt: string;
    };
export interface FloorDetail {
  readonly catalogRevision: string;
  readonly floor: {
    readonly id: string;
    readonly canteenRevision: string;
    readonly canteenId: string;
    readonly canteenName: string;
    readonly sourceFloorKey: string;
    readonly label: string;
    readonly summary: FloorSummary;
  };
  readonly myScore: FloorOwn;
}
export interface FloorSetScore {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedCanteenRevision: string;
  readonly score: number;
}
export type FloorReceipt = {
  readonly requestId: string;
  readonly operation: 'floor.score.first.v1';
  readonly floorId: string;
} & (
  | {
      readonly outcome: 'applied';
      readonly score: number;
      readonly scoreRevision: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        | 'FLOOR_ALREADY_RATED'
        | 'FLOOR_REVISION_CONFLICT'
        | 'FLOOR_SCORE_CANCELLED';
    }
);
export function decodeFloorSummary(v: unknown): FloorSummary {
  if (!isRecord(v)) invalidFloor();
  if (v.kind === 'unavailable') {
    exact(v, ['kind']);
    return Object.freeze({ kind: 'unavailable' });
  }
  exact(v, ['kind', 'ratingCount', 'mean']);
  if (
    v.kind !== 'known' ||
    typeof v.ratingCount !== 'number' ||
    !Number.isSafeInteger(v.ratingCount) ||
    v.ratingCount < 0 ||
    (v.ratingCount === 0
      ? v.mean !== null
      : !floorScore(v.mean) || !Number.isInteger(v.mean * 10))
  )
    invalidFloor();
  return Object.freeze({
    kind: 'known',
    ratingCount: v.ratingCount,
    mean: v.mean as number | null,
  });
}
export function decodeFloorOwn(v: unknown): FloorOwn {
  if (!isRecord(v)) invalidFloor();
  if (v.kind === 'not_submitted' || v.kind === 'unavailable') {
    exact(v, ['kind']);
    return Object.freeze({ kind: v.kind });
  }
  exact(v, ['kind', 'score', 'revision', 'recordedAt']);
  if (
    v.kind !== 'recorded' ||
    !floorScore(v.score) ||
    !floorId(v.revision) ||
    !timestamp(v.recordedAt)
  )
    invalidFloor();
  return Object.freeze({
    kind: 'recorded',
    score: v.score,
    revision: v.revision,
    recordedAt: v.recordedAt,
  });
}
export function decodeFloorDetail(v: unknown): FloorDetail {
  exact(v, ['catalogRevision', 'floor', 'myScore']);
  exact(v.floor, [
    'id',
    'canteenRevision',
    'canteenId',
    'canteenName',
    'sourceFloorKey',
    'label',
    'summary',
  ]);
  const f = v.floor;
  if (
    !floorId(v.catalogRevision) ||
    !floorId(f.id) ||
    !floorId(f.canteenRevision) ||
    !floorId(f.canteenId) ||
    ![f.canteenName, f.sourceFloorKey, f.label].every(
      (x) => typeof x === 'string' && x.length > 0 && x.length <= 200,
    )
  )
    invalidFloor();
  return Object.freeze({
    catalogRevision: v.catalogRevision,
    floor: Object.freeze({
      id: f.id,
      canteenRevision: f.canteenRevision,
      canteenId: f.canteenId,
      canteenName: f.canteenName as string,
      sourceFloorKey: f.sourceFloorKey as string,
      label: f.label as string,
      summary: decodeFloorSummary(f.summary),
    }),
    myScore: decodeFloorOwn(v.myScore),
  });
}
export function decodeFloorSetScore(v: unknown): FloorSetScore {
  exact(v, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedCanteenRevision',
    'score',
  ]);
  if (
    !floorId(v.clientRequestId) ||
    !floorId(v.expectedCatalogRevision) ||
    !floorId(v.expectedCanteenRevision) ||
    !floorScore(v.score)
  )
    invalidFloor();
  return Object.freeze({
    clientRequestId: v.clientRequestId,
    expectedCatalogRevision: v.expectedCatalogRevision,
    expectedCanteenRevision: v.expectedCanteenRevision,
    score: v.score,
  });
}
export function decodeFloorReceipt(v: unknown): FloorReceipt {
  if (!isRecord(v)) invalidFloor();
  exact(
    v,
    v.outcome === 'rejected'
      ? ['requestId', 'operation', 'floorId', 'outcome', 'code']
      : [
          'requestId',
          'operation',
          'floorId',
          'outcome',
          'score',
          'scoreRevision',
          'recordedAt',
        ],
  );
  if (
    !floorId(v.requestId) ||
    !floorId(v.floorId) ||
    v.operation !== 'floor.score.first.v1'
  )
    invalidFloor();
  const base = {
    requestId: v.requestId,
    floorId: v.floorId,
    operation: v.operation,
  } as const;
  if (v.outcome === 'rejected') {
    if (
      v.code !== 'FLOOR_ALREADY_RATED' &&
      v.code !== 'FLOOR_REVISION_CONFLICT' &&
      v.code !== 'FLOOR_SCORE_CANCELLED'
    )
      invalidFloor();
    return Object.freeze({ ...base, outcome: 'rejected', code: v.code });
  }
  if (
    v.outcome !== 'applied' ||
    !floorScore(v.score) ||
    !floorId(v.scoreRevision) ||
    !timestamp(v.recordedAt)
  )
    invalidFloor();
  return Object.freeze({
    ...base,
    outcome: 'applied',
    score: v.score,
    scoreRevision: v.scoreRevision,
    recordedAt: v.recordedAt,
  });
}
export function matchFloorReceipt(
  id: string,
  c: FloorSetScore,
  r: FloorReceipt,
): void {
  if (
    r.floorId !== id ||
    r.requestId !== c.clientRequestId ||
    (r.outcome === 'applied' && r.score !== c.score)
  )
    invalidFloor();
}
