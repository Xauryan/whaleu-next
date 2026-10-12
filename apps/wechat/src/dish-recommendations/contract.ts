import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { windowCursor, windowId } from '../window-ratings/contract';
export type DishOperation =
  'window.dish.recommend.v1' | 'window.dish.retract.v1';
export const dishOperation = (value: unknown): value is DishOperation =>
  value === 'window.dish.recommend.v1' || value === 'window.dish.retract.v1';
export function invalidDish(): never {
  throw new ClientError('protocol', 'Invalid dish recommendation data');
}
/** Unicode code points, exact accepted bytes. No trim, normalization or truncation. */
export const dishName = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const points = Array.from(value);
  return (
    points.length >= 1 &&
    points.length <= 10 &&
    points.every((point) => {
      const code = point.codePointAt(0)!;
      return (
        code > 0x1f &&
        (code < 0x7f || code > 0x9f) &&
        (code < 0xd800 || code > 0xdfff)
      );
    })
  );
};
/** Native-safe UTF-8 identity; never uses Node Buffer or TextEncoder. */
export function dishIdentity(name: string): string {
  if (!dishName(name)) invalidDish();
  return Array.from(name)
    .flatMap((point) => {
      const code = point.codePointAt(0)!;
      return code < 0x80
        ? [code]
        : code < 0x800
          ? [0xc0 | (code >> 6), 0x80 | (code & 63)]
          : code < 0x10000
            ? [
                0xe0 | (code >> 12),
                0x80 | ((code >> 6) & 63),
                0x80 | (code & 63),
              ]
            : [
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 63),
                0x80 | ((code >> 6) & 63),
                0x80 | (code & 63),
              ];
    })
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{2}){1,40}$/.test(value);
export type DishOwn =
  | { readonly kind: 'not_recommended' | 'unavailable' }
  | {
      readonly kind: 'recorded';
      readonly catalogRevision: string;
      readonly windowRevision: string;
      readonly active: boolean;
      readonly revision: string;
      readonly recordedAt: string;
    };
export interface DishItem {
  readonly dishName: string;
  readonly dishIdentity: string;
  readonly recommendationCount: number;
  readonly isRecommended: boolean;
  readonly myMembershipRevision: string | null;
}
export interface DishPage {
  readonly windowId: string;
  readonly catalogRevision: string;
  readonly windowRevision: string;
  readonly membershipRevision: string;
  readonly items: readonly DishItem[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface DishCommand {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedWindowRevision: string;
  readonly expectedMembershipRevision: string | null;
  readonly dishName: string;
}
export type DishReceipt = {
  readonly requestId: string;
  readonly operation: DishOperation;
  readonly windowId: string;
  readonly dishIdentity: string;
} & (
  | {
      readonly outcome: 'applied';
      readonly active: boolean;
      readonly membershipRevision: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        | 'WINDOW_REVISION_CONFLICT'
        | 'DISH_MEMBERSHIP_REVISION_CONFLICT'
        | 'DISH_ALREADY_RECOMMENDED'
        | 'DISH_NOT_RECOMMENDED'
        | 'DISH_CANCELLED'
        | 'CONTENT_REJECTED';
    }
);
export function decodeDishOwn(value: unknown): DishOwn {
  if (!isRecord(value)) invalidDish();
  if (value.kind === 'not_recommended' || value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: value.kind });
  }
  exact(value, [
    'kind',
    'active',
    'revision',
    'recordedAt',
    'catalogRevision',
    'windowRevision',
  ]);
  if (
    value.kind !== 'recorded' ||
    !windowId(value.catalogRevision) ||
    !windowId(value.windowRevision) ||
    typeof value.active !== 'boolean' ||
    !windowId(value.revision) ||
    !timestamp(value.recordedAt)
  )
    invalidDish();
  return Object.freeze({
    kind: 'recorded',
    catalogRevision: value.catalogRevision,
    windowRevision: value.windowRevision,
    active: value.active,
    revision: value.revision,
    recordedAt: value.recordedAt,
  });
}
export function decodeDishItem(value: unknown): DishItem {
  exact(value, [
    'dishName',
    'dishIdentity',
    'recommendationCount',
    'isRecommended',
    'myMembershipRevision',
  ]);
  if (
    !dishName(value.dishName) ||
    value.dishIdentity !== dishIdentity(value.dishName) ||
    typeof value.recommendationCount !== 'number' ||
    !Number.isInteger(value.recommendationCount) ||
    value.recommendationCount < 1 ||
    value.recommendationCount > 1000 ||
    typeof value.isRecommended !== 'boolean' ||
    !(
      value.myMembershipRevision === null ||
      windowId(value.myMembershipRevision)
    ) ||
    (value.isRecommended && value.myMembershipRevision === null)
  )
    invalidDish();
  return Object.freeze({
    dishName: value.dishName,
    dishIdentity: value.dishIdentity as string,
    recommendationCount: value.recommendationCount,
    isRecommended: value.isRecommended,
    myMembershipRevision: value.myMembershipRevision,
  });
}
export function decodeDishPage(value: unknown): DishPage {
  exact(value, [
    'windowId',
    'catalogRevision',
    'windowRevision',
    'membershipRevision',
    'items',
    'nextCursor',
    'continuation',
  ]);
  if (
    !windowId(value.windowId) ||
    !windowId(value.catalogRevision) ||
    !windowId(value.windowRevision) ||
    typeof value.membershipRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.membershipRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || windowCursor(value.nextCursor)) ||
    !['more', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end') ||
    (value.continuation === 'more' && !value.items.length)
  )
    invalidDish();
  const items = value.items.map(decodeDishItem);
  if (
    new Set(items.map((item) => item.dishIdentity)).size !== items.length ||
    items.some(
      (item, index) =>
        index > 0 &&
        (items[index - 1]!.recommendationCount < item.recommendationCount ||
          (items[index - 1]!.recommendationCount === item.recommendationCount &&
            items[index - 1]!.dishIdentity >= item.dishIdentity)),
    )
  )
    invalidDish();
  return Object.freeze({
    windowId: value.windowId,
    catalogRevision: value.catalogRevision,
    windowRevision: value.windowRevision,
    membershipRevision: value.membershipRevision,
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as 'more' | 'end',
  });
}
export function decodeDishCommand(value: unknown): DishCommand {
  exact(value, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedWindowRevision',
    'expectedMembershipRevision',
    'dishName',
  ]);
  if (
    !windowId(value.clientRequestId) ||
    !windowId(value.expectedCatalogRevision) ||
    !windowId(value.expectedWindowRevision) ||
    !(
      value.expectedMembershipRevision === null ||
      windowId(value.expectedMembershipRevision)
    ) ||
    !dishName(value.dishName)
  )
    invalidDish();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedWindowRevision: value.expectedWindowRevision,
    expectedMembershipRevision: value.expectedMembershipRevision,
    dishName: value.dishName,
  });
}
export function decodeDishReceipt(value: unknown): DishReceipt {
  if (!isRecord(value)) invalidDish();
  exact(
    value,
    value.outcome === 'rejected'
      ? [
          'requestId',
          'operation',
          'windowId',
          'dishIdentity',
          'outcome',
          'code',
        ]
      : [
          'requestId',
          'operation',
          'windowId',
          'dishIdentity',
          'outcome',
          'active',
          'membershipRevision',
          'recordedAt',
        ],
  );
  if (
    !windowId(value.requestId) ||
    !dishOperation(value.operation) ||
    !windowId(value.windowId) ||
    !identity(value.dishIdentity)
  )
    invalidDish();
  const base = {
    requestId: value.requestId,
    operation: value.operation,
    windowId: value.windowId,
    dishIdentity: value.dishIdentity,
  };
  if (value.outcome === 'rejected') {
    if (
      ![
        'WINDOW_REVISION_CONFLICT',
        'DISH_MEMBERSHIP_REVISION_CONFLICT',
        'DISH_ALREADY_RECOMMENDED',
        'DISH_NOT_RECOMMENDED',
        'DISH_CANCELLED',
        'CONTENT_REJECTED',
      ].includes(String(value.code))
    )
      invalidDish();
    return Object.freeze({
      ...base,
      outcome: 'rejected',
      code: value.code,
    }) as DishReceipt;
  }
  if (
    value.outcome !== 'applied' ||
    typeof value.active !== 'boolean' ||
    !windowId(value.membershipRevision) ||
    !timestamp(value.recordedAt) ||
    value.active !== (value.operation === 'window.dish.recommend.v1')
  )
    invalidDish();
  return Object.freeze({
    ...base,
    outcome: 'applied',
    active: value.active,
    membershipRevision: value.membershipRevision,
    recordedAt: value.recordedAt,
  });
}
export function matchDishReceipt(
  id: string,
  operation: DishOperation,
  command: DishCommand,
  receipt: DishReceipt,
): void {
  if (
    receipt.windowId !== id ||
    receipt.operation !== operation ||
    receipt.requestId !== command.clientRequestId ||
    receipt.dishIdentity !== dishIdentity(command.dishName) ||
    (receipt.outcome === 'applied' &&
      (receipt.active !== (operation === 'window.dish.recommend.v1') ||
        receipt.membershipRevision === command.expectedMembershipRevision))
  )
    invalidDish();
}
