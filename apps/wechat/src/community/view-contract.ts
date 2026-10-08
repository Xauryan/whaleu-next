import { sha256 } from 'js-sha256';
import { exact, invalid } from './contract';
const uuid4 = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
import { isUuid } from '../profile/contract';

export type ViewKind = 'list_exposure' | 'detail_visit';
export interface ViewEpoch {
  readonly version: 1;
  readonly epochId: string;
  readonly issuedAt: string;
  readonly collectionUntil: string;
  readonly expiresAt: string;
  readonly serverNow: string;
}
export interface ViewIntent {
  readonly version: 1;
  readonly epochId: string;
  readonly batchId: string;
  readonly kind: ViewKind;
  readonly postIds: readonly string[];
}
export interface ViewReceipt {
  readonly version: 1;
  readonly epochId: string;
  readonly batchId: string;
  readonly kind: ViewKind;
  readonly payloadFingerprint: string;
  readonly acceptedCount: number;
}
export const VIEW_COLLECTION_MS = 3_600_000;
export const VIEW_RETENTION_MS = 86_400_000;
export const VIEW_RETRY_MS = 300_000;
export function viewKind(value: unknown): value is ViewKind {
  return value === 'list_exposure' || value === 'detail_visit';
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function decodeViewEpoch(value: unknown): ViewEpoch {
  exact(value, [
    'version',
    'epochId',
    'issuedAt',
    'collectionUntil',
    'expiresAt',
    'serverNow',
  ]);
  if (
    value.version !== 1 ||
    !uuid4(value.epochId) ||
    value.epochId !== value.epochId.toLowerCase() ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.collectionUntil) ||
    !timestamp(value.expiresAt) ||
    !timestamp(value.serverNow) ||
    Date.parse(value.collectionUntil) - Date.parse(value.issuedAt) !==
      VIEW_COLLECTION_MS ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !==
      VIEW_RETENTION_MS ||
    Date.parse(value.serverNow) < Date.parse(value.issuedAt) ||
    Date.parse(value.serverNow) >= Date.parse(value.collectionUntil)
  )
    invalid();
  return Object.freeze({
    version: 1,
    epochId: value.epochId,
    issuedAt: value.issuedAt,
    collectionUntil: value.collectionUntil,
    expiresAt: value.expiresAt,
    serverNow: value.serverNow,
  });
}
export function decodeViewIntent(value: unknown): ViewIntent {
  exact(value, ['version', 'epochId', 'batchId', 'kind', 'postIds']);
  if (
    value.version !== 1 ||
    !uuid4(value.epochId) ||
    !uuid4(value.batchId) ||
    !viewKind(value.kind) ||
    !Array.isArray(value.postIds) ||
    value.postIds.length < 1 ||
    value.postIds.length > (value.kind === 'detail_visit' ? 1 : 50) ||
    !value.postIds.every(
      (id: unknown) => typeof id === 'string' && isUuid(id.toLowerCase()),
    )
  )
    invalid();
  return Object.freeze({
    version: 1,
    epochId: value.epochId.toLowerCase(),
    batchId: value.batchId.toLowerCase(),
    kind: value.kind,
    postIds: Object.freeze(value.postIds.map((id: string) => id.toLowerCase())),
  });
}
export function viewFingerprint(
  intent: Pick<ViewIntent, 'kind' | 'postIds'>,
): string {
  const counts = new Map<string, number>();
  for (const id of intent.postIds)
    counts.set(id.toLowerCase(), (counts.get(id.toLowerCase()) ?? 0) + 1);
  const pairs = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify([1, intent.kind, pairs]));
}
export function decodeViewReceipt(value: unknown): ViewReceipt {
  exact(value, [
    'version',
    'epochId',
    'batchId',
    'kind',
    'payloadFingerprint',
    'acceptedCount',
  ]);
  if (
    value.version !== 1 ||
    !uuid4(value.epochId) ||
    !uuid4(value.batchId) ||
    !viewKind(value.kind) ||
    value.epochId !== value.epochId.toLowerCase() ||
    value.batchId !== value.batchId.toLowerCase() ||
    typeof value.payloadFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.payloadFingerprint) ||
    !Number.isSafeInteger(value.acceptedCount) ||
    (value.acceptedCount as number) < 0 ||
    (value.acceptedCount as number) > (value.kind === 'detail_visit' ? 1 : 50)
  )
    invalid();
  return Object.freeze({
    version: 1,
    epochId: value.epochId,
    batchId: value.batchId,
    kind: value.kind,
    payloadFingerprint: value.payloadFingerprint,
    acceptedCount: value.acceptedCount as number,
  });
}
export function matchViewReceipt(
  intent: ViewIntent,
  value: unknown,
): ViewReceipt {
  const receipt = decodeViewReceipt(value);
  if (
    receipt.epochId !== intent.epochId ||
    receipt.batchId !== intent.batchId ||
    receipt.kind !== intent.kind ||
    receipt.payloadFingerprint !== viewFingerprint(intent) ||
    receipt.acceptedCount > intent.postIds.length
  )
    invalid();
  return receipt;
}
