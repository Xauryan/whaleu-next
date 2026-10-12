import { ClientError, isRecord } from '../api/errors';
import { exact, isCategory, timestamp, uuid4 } from '../community/contract';
import type { Category } from '../community/contract';
import { isUuid } from '../profile/contract';

/** Membership describes the wire vocabulary, never accepted policy or authority. */
export const reclassificationCategories = [
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
] as const;
export type ReclassificationCategory =
  (typeof reclassificationCategories)[number];
export const reclassificationLabels: Readonly<Record<Category, string>> = {
  discussion: '校园讨论',
  confession: '表白',
  companions: '找搭子',
  pets: '萌宠',
  internships: '实习',
  scenery: '校园风景',
  dorms: '宿舍',
  research: '科研',
  deep_sea: '深海',
  feedback: '意见反馈',
  trading: '闲置交易',
};
export const isReclassificationCategory = (
  value: unknown,
): value is ReclassificationCategory =>
  typeof value === 'string' &&
  reclassificationCategories.includes(value as ReclassificationCategory);

export interface CategoryManagement {
  readonly postId: string;
  readonly currentCategory: Category;
  readonly revision: number;
  readonly canChange: boolean;
  readonly targets: readonly ReclassificationCategory[];
}
export interface ReclassificationCommand {
  readonly clientRequestId: string;
  readonly postId: string;
  readonly expectedRevision: number;
  readonly targetCategory: ReclassificationCategory;
}
export type ReclassificationReceipt = {
  readonly requestId: string;
  readonly postId: string;
  readonly expectedRevision: number;
  readonly targetCategory: ReclassificationCategory;
} & (
  | {
      readonly outcome: 'applied';
      readonly revision: number;
      readonly eventId: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'unchanged';
      readonly revision: number;
      readonly eventId: string | null;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        | 'POST_CATEGORY_STALE'
        | 'POST_CATEGORY_CANCELLED'
        | 'POST_CATEGORY_UNAVAILABLE';
    }
);
export type ReclassificationRecovery =
  | { readonly state: 'recorded'; readonly receipt: ReclassificationReceipt }
  | { readonly state: 'not_recorded' | 'unavailable' };
export function invalidReclassification(): never {
  throw new ClientError(
    'protocol',
    'Invalid category reclassification response',
  );
}
const revision = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
export function decodeCategoryManagement(raw: unknown): CategoryManagement {
  exact(raw, ['postId', 'currentCategory', 'revision', 'canChange', 'targets']);
  if (
    !isUuid(raw.postId) ||
    !isCategory(raw.currentCategory) ||
    !revision(raw.revision) ||
    typeof raw.canChange !== 'boolean' ||
    !Array.isArray(raw.targets) ||
    raw.targets.length > reclassificationCategories.length ||
    !raw.targets.every(isReclassificationCategory) ||
    new Set(raw.targets).size !== raw.targets.length ||
    (!raw.canChange && raw.targets.length !== 0) ||
    (raw.canChange &&
      (!isReclassificationCategory(raw.currentCategory) ||
        raw.revision === 2147483647 ||
        raw.targets.length === 0))
  )
    invalidReclassification();
  return Object.freeze({
    postId: raw.postId,
    currentCategory: raw.currentCategory,
    revision: raw.revision,
    canChange: raw.canChange,
    targets: Object.freeze([...raw.targets]),
  });
}
export function decodeReclassificationCommand(
  raw: unknown,
): ReclassificationCommand {
  exact(raw, [
    'clientRequestId',
    'postId',
    'expectedRevision',
    'targetCategory',
  ]);
  if (
    !uuid4(raw.clientRequestId) ||
    !isUuid(raw.postId) ||
    !revision(raw.expectedRevision, 2147483646) ||
    !isReclassificationCategory(raw.targetCategory)
  )
    invalidReclassification();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    postId: raw.postId,
    expectedRevision: raw.expectedRevision,
    targetCategory: raw.targetCategory,
  });
}
export function decodeReclassificationReceipt(
  raw: unknown,
): ReclassificationReceipt {
  if (!isRecord(raw)) invalidReclassification();
  exact(raw, [
    'requestId',
    'postId',
    'expectedRevision',
    'targetCategory',
    'outcome',
    ...(raw.outcome === 'applied' || raw.outcome === 'unchanged'
      ? ['revision', 'eventId', 'recordedAt']
      : ['code']),
  ]);
  if (
    !isUuid(raw.requestId) ||
    !isUuid(raw.postId) ||
    !revision(raw.expectedRevision, 2147483646) ||
    !isReclassificationCategory(raw.targetCategory)
  )
    invalidReclassification();
  if (raw.outcome === 'applied' || raw.outcome === 'unchanged') {
    if (!revision(raw.revision) || !timestamp(raw.recordedAt))
      invalidReclassification();
    if (raw.outcome === 'applied') {
      if (raw.revision !== raw.expectedRevision + 1 || !isUuid(raw.eventId))
        invalidReclassification();
    } else if (
      raw.revision !== raw.expectedRevision ||
      (raw.revision === 0 ? raw.eventId !== null : !isUuid(raw.eventId))
    )
      invalidReclassification();
  } else if (
    raw.outcome !== 'rejected' ||
    ![
      'POST_CATEGORY_STALE',
      'POST_CATEGORY_CANCELLED',
      'POST_CATEGORY_UNAVAILABLE',
    ].includes(String(raw.code))
  )
    invalidReclassification();
  return Object.freeze({ ...raw }) as ReclassificationReceipt;
}
export function matchReclassificationReceipt(
  command: ReclassificationCommand,
  receipt: ReclassificationReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    command.postId !== receipt.postId ||
    command.expectedRevision !== receipt.expectedRevision ||
    command.targetCategory !== receipt.targetCategory
  )
    invalidReclassification();
}
export function decodeReclassificationRecovery(
  raw: unknown,
): ReclassificationRecovery {
  if (!isRecord(raw)) invalidReclassification();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeReclassificationReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded' && raw.state !== 'unavailable')
    invalidReclassification();
  return Object.freeze({ state: raw.state });
}
