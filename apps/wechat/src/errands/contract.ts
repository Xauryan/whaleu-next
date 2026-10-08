import { ClientError, isRecord } from '../api/errors';
import { boundedText, exact } from '../community/contract';
import { activityTimestamp } from '../activities/contract';
import { isUuid } from '../profile/contract';

export const errandId = (value: unknown): value is string => isUuid(value);
export const errandCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function invalidErrand(): never {
  throw new ClientError('protocol', 'Invalid errand data');
}
export function canonicalErrandText(
  value: unknown,
  maximum: number,
  required = true,
): string {
  if (typeof value !== 'string' || value.length > maximum * 2 + 100)
    invalidErrand();
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!boundedText(text, required ? 1 : 0, maximum)) invalidErrand();
  return text;
}
/** Decimal strings only: no binary float, exponent, rounding or assumed cent precision. */
export function exactErrandReward(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 101 ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ||
    value.replace('.', '').length > 100
  )
    invalidErrand();
  const [whole, fraction = ''] = value.split('.');
  if (
    whole === '0' ||
    whole!.length > 3 ||
    (whole!.length === 3 &&
      (whole! > '500' || (whole === '500' && /[1-9]/.test(fraction))))
  )
    invalidErrand();
  const trimmed = fraction.replace(/0+$/, '');
  return whole! + (trimmed ? `.${trimmed}` : '');
}
export interface ErrandContacts {
  readonly wechat: string;
  readonly phone: string;
}
export function decodeErrandContacts(
  value: unknown,
  mode: 'publisher' | 'accepter' | 'optional' = 'accepter',
): ErrandContacts {
  exact(value, ['wechat', 'phone']);
  const wechat = canonicalErrandText(value.wechat, 50, false);
  if (typeof value.phone !== 'string') invalidErrand();
  const phone = value.phone.trim();
  if (
    !/^[0-9]{0,11}$/.test(phone) ||
    (mode === 'publisher' && (!wechat || !phone)) ||
    (mode === 'accepter' && !wechat && !phone)
  )
    invalidErrand();
  return Object.freeze({ wechat, phone });
}
export interface PublishErrand {
  readonly clientRequestId: string;
  readonly targetRegionId: string;
  readonly title: string;
  readonly publicText: string;
  readonly privateText: string;
  readonly expectedTimeText: string;
  readonly reward: string;
  readonly publisherContacts: ErrandContacts;
  readonly publicAssetIds: readonly string[];
  readonly privateAssetIds: readonly string[];
}
export function decodePublishErrand(value: unknown): PublishErrand {
  exact(value, [
    'clientRequestId',
    'targetRegionId',
    'title',
    'publicText',
    'privateText',
    'expectedTimeText',
    'reward',
    'publisherContacts',
    'publicAssetIds',
    'privateAssetIds',
  ]);
  if (!errandId(value.clientRequestId) || !errandId(value.targetRegionId))
    invalidErrand();
  if (
    !Array.isArray(value.publicAssetIds) ||
    value.publicAssetIds.length ||
    !Array.isArray(value.privateAssetIds) ||
    value.privateAssetIds.length
  )
    throw new ClientError('configuration', 'Errand media is unavailable', {
      serverCode: 'MEDIA_UNAVAILABLE',
    });
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    targetRegionId: value.targetRegionId,
    title: canonicalErrandText(value.title, 50),
    publicText: canonicalErrandText(value.publicText, 500),
    privateText: canonicalErrandText(value.privateText, 200, false),
    expectedTimeText: canonicalErrandText(value.expectedTimeText, 50),
    reward: exactErrandReward(value.reward),
    publisherContacts: decodeErrandContacts(
      value.publisherContacts,
      'publisher',
    ),
    publicAssetIds: Object.freeze([]),
    privateAssetIds: Object.freeze([]),
  });
}
export interface ErrandCommand {
  readonly clientRequestId: string;
  readonly expectedRevision: string;
}
export interface AcceptErrand extends ErrandCommand {
  readonly contacts: ErrandContacts;
}
export type ErrandOperation =
  'publish' | 'accept' | 'cancel' | 'complete' | 'delete';
export type ErrandIntent =
  | { readonly operation: 'publish'; readonly payload: PublishErrand }
  | {
      readonly operation: 'accept';
      readonly orderId: string;
      readonly payload: AcceptErrand;
    }
  | {
      readonly operation: 'cancel' | 'complete' | 'delete';
      readonly orderId: string;
      readonly payload: ErrandCommand;
    };
export function decodeErrandIntent(value: unknown): ErrandIntent {
  if (!isRecord(value)) invalidErrand();
  if (value.operation === 'publish') {
    exact(value, ['operation', 'payload']);
    return Object.freeze({
      operation: 'publish',
      payload: decodePublishErrand(value.payload),
    });
  }
  exact(value, ['operation', 'orderId', 'payload']);
  if (
    !errandId(value.orderId) ||
    !['accept', 'cancel', 'complete', 'delete'].includes(
      String(value.operation),
    )
  )
    invalidErrand();
  exact(
    value.payload,
    value.operation === 'accept'
      ? ['clientRequestId', 'expectedRevision', 'contacts']
      : ['clientRequestId', 'expectedRevision'],
  );
  if (
    !errandId(value.payload.clientRequestId) ||
    !errandId(value.payload.expectedRevision)
  )
    invalidErrand();
  const payload = {
    clientRequestId: value.payload.clientRequestId,
    expectedRevision: value.payload.expectedRevision,
  };
  return value.operation === 'accept'
    ? Object.freeze({
        operation: 'accept',
        orderId: value.orderId,
        payload: Object.freeze({
          ...payload,
          contacts: decodeErrandContacts(value.payload.contacts),
        }),
      })
    : Object.freeze({
        operation: value.operation as 'cancel' | 'complete' | 'delete',
        orderId: value.orderId,
        payload: Object.freeze(payload),
      });
}
export const errandRejections = [
  'ERRAND_NOT_FOUND',
  'ERRAND_REVISION_CONFLICT',
  'ERRAND_STATE_CONFLICT',
  'ERRAND_ACTION_RESTRICTED',
  'ERRAND_SELF_ACCEPT',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'CONTENT_REJECTED',
] as const;
export type ErrandReceipt =
  | {
      readonly requestId: string;
      readonly operation: ErrandOperation;
      readonly outcome: 'applied';
      readonly orderId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: ErrandOperation;
      readonly outcome: 'rejected';
      readonly code: string;
    };
export function decodeErrandReceipt(value: unknown): ErrandReceipt {
  if (!isRecord(value)) invalidErrand();
  exact(
    value,
    value.outcome === 'applied'
      ? [
          'requestId',
          'operation',
          'outcome',
          'orderId',
          'revision',
          'occurredAt',
        ]
      : ['requestId', 'operation', 'outcome', 'code'],
  );
  if (
    !errandId(value.requestId) ||
    !['publish', 'accept', 'cancel', 'complete', 'delete'].includes(
      String(value.operation),
    )
  )
    invalidErrand();
  const base = {
    requestId: value.requestId,
    operation: value.operation as ErrandOperation,
  };
  if (value.outcome === 'applied') {
    if (
      !errandId(value.orderId) ||
      !errandId(value.revision) ||
      !activityTimestamp(value.occurredAt)
    )
      invalidErrand();
    return Object.freeze({
      ...base,
      outcome: 'applied',
      orderId: value.orderId,
      revision: value.revision,
      occurredAt: value.occurredAt,
    });
  }
  if (
    value.outcome !== 'rejected' ||
    !errandRejections.includes(value.code as never)
  )
    invalidErrand();
  return Object.freeze({
    ...base,
    outcome: 'rejected',
    code: value.code as string,
  });
}
export function matchErrandReceipt(
  intent: ErrandIntent,
  receipt: ErrandReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    (receipt.outcome === 'applied' &&
      intent.operation !== 'publish' &&
      receipt.orderId !== intent.orderId)
  )
    invalidErrand();
}
export type ErrandState = 'pending' | 'accepted' | 'completed' | 'cancelled';
export interface ErrandRegion {
  readonly id: string;
  readonly label: string;
}
export interface ErrandSummary {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly publicText: string;
  readonly expectedTimeText: string;
  readonly reward: string;
  readonly state: ErrandState;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly targetRegion: ErrandRegion;
  readonly sourceRegion: ErrandRegion;
  readonly scope: 'home' | 'related' | 'foreign';
}
export interface ErrandDetail extends ErrandSummary {
  readonly relation: 'publisher' | 'accepter' | 'none';
  readonly privateText?: string;
  readonly oppositeContact?: {
    readonly display:
      | { readonly status: 'available'; readonly displayName: string }
      | { readonly status: 'unavailable' };
    readonly contacts: ErrandContacts;
  };
  readonly capabilities: {
    readonly accept: boolean;
    readonly cancel: boolean;
    readonly complete: boolean;
    readonly delete: boolean;
  };
}
const summaryKeys = [
  'id',
  'revision',
  'title',
  'publicText',
  'expectedTimeText',
  'reward',
  'state',
  'createdAt',
  'acceptedAt',
  'completedAt',
  'cancelledAt',
  'targetRegion',
  'sourceRegion',
  'scope',
] as const;
function responseText(value: unknown, max: number, required = true): string {
  const text = canonicalErrandText(value, max, required);
  if (text !== value) invalidErrand();
  return text;
}
function region(value: unknown): ErrandRegion {
  exact(value, ['id', 'label']);
  if (
    !errandId(value.id) ||
    typeof value.label !== 'string' ||
    !value.label ||
    value.label.length > 200
  )
    invalidErrand();
  return Object.freeze({ id: value.id, label: value.label });
}
function summary(value: Record<string, unknown>): ErrandSummary {
  if (
    !errandId(value.id) ||
    !errandId(value.revision) ||
    !['pending', 'accepted', 'completed', 'cancelled'].includes(
      String(value.state),
    ) ||
    !['home', 'related', 'foreign'].includes(String(value.scope)) ||
    !activityTimestamp(value.createdAt)
  )
    invalidErrand();
  for (const key of ['acceptedAt', 'completedAt', 'cancelledAt'])
    if (value[key] !== null && !activityTimestamp(value[key])) invalidErrand();
  if (
    (value.state === 'pending' && value.acceptedAt !== null) ||
    (['accepted', 'completed'].includes(String(value.state)) &&
      value.acceptedAt === null) ||
    (value.state === 'completed') !== (value.completedAt !== null) ||
    (value.state === 'cancelled') !== (value.cancelledAt !== null)
  )
    invalidErrand();
  const reward = exactErrandReward(value.reward);
  if (reward !== value.reward) invalidErrand();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    title: responseText(value.title, 50),
    publicText: responseText(value.publicText, 500),
    expectedTimeText: responseText(value.expectedTimeText, 50),
    reward,
    state: value.state as ErrandState,
    createdAt: value.createdAt,
    acceptedAt: value.acceptedAt as string | null,
    completedAt: value.completedAt as string | null,
    cancelledAt: value.cancelledAt as string | null,
    targetRegion: region(value.targetRegion),
    sourceRegion: region(value.sourceRegion),
    scope: value.scope as ErrandSummary['scope'],
  });
}
export function decodeErrandSummary(value: unknown): ErrandSummary {
  exact(value, summaryKeys);
  return summary(value);
}
export function decodeErrandDetail(value: unknown): ErrandDetail {
  if (!isRecord(value)) invalidErrand();
  exact(value, [
    ...summaryKeys,
    'relation',
    'capabilities',
    ...('privateText' in value ? ['privateText'] : []),
    ...('oppositeContact' in value ? ['oppositeContact'] : []),
  ]);
  const core = summary(value);
  if (
    !['publisher', 'accepter', 'none'].includes(String(value.relation)) ||
    (value.relation === 'none') !== !('privateText' in value) ||
    (value.relation === 'accepter' && value.acceptedAt === null)
  )
    invalidErrand();
  exact(value.capabilities, ['accept', 'cancel', 'complete', 'delete']);
  const caps = value.capabilities;
  if (
    Object.values(caps).some((v) => typeof v !== 'boolean') ||
    (caps.accept && (value.relation !== 'none' || core.state !== 'pending')) ||
    (caps.cancel &&
      (value.relation !== 'publisher' ||
        !['pending', 'accepted'].includes(core.state))) ||
    (caps.complete &&
      (value.relation !== 'publisher' || core.state !== 'accepted')) ||
    (caps.delete && value.relation !== 'publisher')
  )
    invalidErrand();
  let oppositeContact: ErrandDetail['oppositeContact'];
  if ('oppositeContact' in value) {
    if (value.relation === 'none' || core.state !== 'accepted') invalidErrand();
    exact(value.oppositeContact, ['display', 'contacts']);
    const display = value.oppositeContact.display;
    if (!isRecord(display)) invalidErrand();
    exact(
      display,
      display.status === 'available' ? ['status', 'displayName'] : ['status'],
    );
    if (display.status !== 'available' && display.status !== 'unavailable')
      invalidErrand();
    if (
      display.status === 'available' &&
      (typeof display.displayName !== 'string' ||
        !display.displayName ||
        display.displayName.length > 200)
    )
      invalidErrand();
    const contacts = decodeErrandContacts(value.oppositeContact.contacts);
    if (
      !isRecord(value.oppositeContact.contacts) ||
      contacts.wechat !== value.oppositeContact.contacts.wechat ||
      contacts.phone !== value.oppositeContact.contacts.phone
    )
      invalidErrand();
    oppositeContact = Object.freeze({
      display: Object.freeze(
        display.status === 'available'
          ? { status: 'available', displayName: display.displayName as string }
          : { status: 'unavailable' },
      ),
      contacts,
    });
  }
  return Object.freeze({
    ...core,
    relation: value.relation as ErrandDetail['relation'],
    ...('privateText' in value
      ? { privateText: responseText(value.privateText, 200, false) }
      : {}),
    ...(oppositeContact ? { oppositeContact } : {}),
    capabilities: Object.freeze({
      accept: caps.accept as boolean,
      cancel: caps.cancel as boolean,
      complete: caps.complete as boolean,
      delete: caps.delete as boolean,
    }),
  });
}
export interface ErrandListQuery {
  readonly regionId: string;
  readonly filter: 'all' | 'pending';
  readonly sort: 'created' | 'reward';
  readonly direction: 'asc' | 'desc';
}
export type ErrandRelation = 'published' | 'accepted';
export interface ErrandPage {
  readonly context:
    | {
        readonly kind: 'discovery';
        readonly regionId: string;
        readonly discoveryMode: 'home' | 'own_only';
      }
    | { readonly kind: 'own'; readonly relation: ErrandRelation };
  readonly items: readonly ErrandSummary[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
}
export function decodeErrandPage(value: unknown): ErrandPage {
  exact(value, ['context', 'items', 'continuation', 'nextCursor']);
  if (!isRecord(value.context)) invalidErrand();
  let context: ErrandPage['context'];
  if (value.context.kind === 'discovery') {
    exact(value.context, ['kind', 'regionId', 'discoveryMode']);
    if (
      !errandId(value.context.regionId) ||
      !['home', 'own_only'].includes(String(value.context.discoveryMode))
    )
      invalidErrand();
    context = {
      kind: 'discovery',
      regionId: value.context.regionId,
      discoveryMode: value.context.discoveryMode as 'home' | 'own_only',
    };
  } else {
    exact(value.context, ['kind', 'relation']);
    if (
      value.context.kind !== 'own' ||
      !['published', 'accepted'].includes(String(value.context.relation))
    )
      invalidErrand();
    context = {
      kind: 'own',
      relation: value.context.relation as ErrandRelation,
    };
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !['more', 'end'].includes(String(value.continuation)) ||
    !(value.nextCursor === null || errandCursor(value.nextCursor)) ||
    (value.continuation === 'end') !== (value.nextCursor === null)
  )
    invalidErrand();
  const items = value.items.map(decodeErrandSummary);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidErrand();
  return Object.freeze({
    context: Object.freeze(context),
    items: Object.freeze(items),
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor,
  });
}
export type ErrandContactHistory =
  | { readonly status: 'empty' }
  | { readonly status: 'available'; readonly contacts: ErrandContacts };
export function decodeErrandContactHistory(
  value: unknown,
): ErrandContactHistory {
  if (!isRecord(value)) invalidErrand();
  exact(
    value,
    value.status === 'available' ? ['status', 'contacts'] : ['status'],
  );
  if (value.status === 'empty') return Object.freeze({ status: 'empty' });
  if (value.status !== 'available') invalidErrand();
  const contacts = decodeErrandContacts(value.contacts);
  if (
    !isRecord(value.contacts) ||
    contacts.wechat !== value.contacts.wechat ||
    contacts.phone !== value.contacts.phone
  )
    invalidErrand();
  return Object.freeze({ status: 'available', contacts });
}
export function decodeOperatingRegions(
  value: unknown,
): readonly ErrandRegion[] {
  exact(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length > 1) invalidErrand();
  return Object.freeze(
    value.items.map((item: unknown) => {
      exact(item, ['id', 'name', 'isActive']);
      if (
        !errandId(item.id) ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.isActive !== 'boolean'
      )
        invalidErrand();
      if (!item.isActive)
        throw new ClientError('forbidden', 'Inactive region', {
          serverCode: 'ERRAND_SCOPE_UNAVAILABLE',
        });
      return Object.freeze({ id: item.id, label: item.name });
    }),
  );
}
export const errandStateLabels = Object.freeze({
  pending: '待接单',
  accepted: '进行中',
  completed: '已完成',
  cancelled: '已取消',
});
