import { ClientError, isRecord } from '../api/errors';

export type Mode = 'named' | 'anonymous';
export type Coverage = 'local' | 'complete';
export type Entry =
  | { readonly kind: 'profile'; readonly profileId: string }
  | { readonly kind: 'post'; readonly postId: string }
  | {
      readonly kind: 'comment';
      readonly postId: string;
      readonly commentId: string;
    }
  | {
      readonly kind: 'reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly replyId: string;
    };
export type Operation =
  'open' | 'send' | 'read' | 'hide' | 'reopen' | 'recall' | 'block';
export type Intent =
  | {
      readonly operation: 'open';
      readonly clientRequestId: string;
      readonly entry: Entry;
      readonly initiationMode: Mode;
    }
  | {
      readonly operation: 'send';
      readonly clientRequestId: string;
      readonly conversationId: string;
      readonly text: string;
    }
  | {
      readonly operation: 'read';
      readonly clientRequestId: string;
      readonly conversationId: string;
      readonly observationId: string;
    }
  | {
      readonly operation: 'recall';
      readonly clientRequestId: string;
      readonly conversationId: string;
      readonly messageId: string;
    }
  | {
      readonly operation: 'hide' | 'reopen' | 'block';
      readonly clientRequestId: string;
      readonly conversationId: string;
    };
export type Receipt =
  | {
      readonly requestId: string;
      readonly operation: Operation;
      readonly outcome: 'applied' | 'noop';
      readonly conversationId: string;
      readonly messageId: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: Operation;
      readonly outcome: 'rejected';
      readonly code: string;
    };
export interface Display {
  readonly mode: Mode;
  readonly displayName: string;
  readonly profileId: string | null;
}
export interface Conversation {
  readonly id: string;
  readonly self: Display;
  readonly peer: Display;
  readonly source: {
    readonly kind: 'post';
    readonly postId: string;
    readonly available: boolean;
  } | null;
  readonly unreadCount: number;
  readonly hidden: boolean;
  readonly sendAvailability:
    'available' | 'unavailable' | 'blocked_by_you' | 'awaiting_reply';
  readonly blockScope: 'named' | 'conversation' | 'named_and_conversation';
  readonly blockedByYou: boolean;
}
export interface Message {
  readonly id: string;
  readonly sequence: string;
  readonly sender: 'self' | 'peer';
  readonly state: 'text' | 'recalled' | 'unavailable';
  readonly text: string | null;
  readonly createdAt: string;
  readonly canRecall: boolean;
}
export interface ListItem {
  readonly conversation: Conversation;
  readonly latest: Message | null;
  readonly updatedAt: string;
}
export interface ListPage {
  readonly items: readonly ListItem[];
  readonly nextCursor: string | null;
  readonly coverage: Coverage;
}
export interface History {
  readonly items: readonly Message[];
  readonly nextCursor: string | null;
  readonly observationId: string;
  readonly throughSequence: string;
  readonly eventCursor: string;
  readonly coverage: Coverage;
}
export interface Event {
  readonly sequence: string;
  readonly kind: 'sent' | 'recalled';
  readonly message: Message;
}
export interface Events {
  readonly items: readonly Event[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly observationId: string;
  readonly throughSequence: string;
}
export interface Unread {
  readonly count: number;
  readonly coverage: Coverage;
}
export function invalid(): never {
  throw new ClientError('protocol', 'Invalid private-message data');
}
export function exact(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !isRecord(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !(k in v))
  )
    invalid();
}
export const id = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
const requestId = (v: unknown): v is string => id(v) && v[14] === '4';
const mode = (v: unknown): v is Mode => v === 'named' || v === 'anonymous';
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT.*Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
export const cursor = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024;
export const sequence = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(v) &&
  (v.length < 19 || v <= '9223372036854775807');
export const compareSequence = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const coverage = (v: unknown): v is Coverage =>
  v === 'local' || v === 'complete';
export function normalizeText(raw: string): string {
  const value = raw.replace(/\r\n/g, '\n');
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (!(
      code === 9 ||
      code === 10 ||
      (code >= 32 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0xd800 && code <= 0xdfff))
    ))
      throw new ClientError('business', '文字含不支持的控制字符');
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (!value.trim() || [...value].length > 500 || bytes > 2000)
    throw new ClientError('business', '请输入 1–500 个字符，最多 2000 字节');
  return value;
}
export function decodeEntry(v: unknown): Entry {
  if (!isRecord(v)) invalid();
  switch (v.kind) {
    case 'profile':
      exact(v, ['kind', 'profileId']);
      if (!id(v.profileId)) invalid();
      return Object.freeze({ kind: 'profile', profileId: v.profileId });
    case 'post':
      exact(v, ['kind', 'postId']);
      if (!id(v.postId)) invalid();
      return Object.freeze({ kind: 'post', postId: v.postId });
    case 'comment':
      exact(v, ['kind', 'postId', 'commentId']);
      if (!id(v.postId) || !id(v.commentId)) invalid();
      return Object.freeze({
        kind: 'comment',
        postId: v.postId,
        commentId: v.commentId,
      });
    case 'reply':
      exact(v, ['kind', 'postId', 'rootCommentId', 'replyId']);
      if (!id(v.postId) || !id(v.rootCommentId) || !id(v.replyId)) invalid();
      return Object.freeze({
        kind: 'reply',
        postId: v.postId,
        rootCommentId: v.rootCommentId,
        replyId: v.replyId,
      });
    default:
      return invalid();
  }
}
export function decodeIntent(v: unknown): Intent {
  if (!isRecord(v) || !requestId(v.clientRequestId)) invalid();
  const clientRequestId = v.clientRequestId;
  if (v.operation === 'open') {
    exact(v, ['operation', 'clientRequestId', 'entry', 'initiationMode']);
    if (!mode(v.initiationMode)) invalid();
    return Object.freeze({
      operation: 'open',
      clientRequestId,
      entry: decodeEntry(v.entry),
      initiationMode: v.initiationMode,
    });
  }
  if (!id(v.conversationId)) invalid();
  const conversationId = v.conversationId;
  switch (v.operation) {
    case 'send':
      exact(v, ['operation', 'clientRequestId', 'conversationId', 'text']);
      if (typeof v.text !== 'string') invalid();
      return Object.freeze({
        operation: 'send',
        clientRequestId,
        conversationId,
        text: normalizeText(v.text),
      });
    case 'read':
      exact(v, [
        'operation',
        'clientRequestId',
        'conversationId',
        'observationId',
      ]);
      if (!id(v.observationId)) invalid();
      return Object.freeze({
        operation: 'read',
        clientRequestId,
        conversationId,
        observationId: v.observationId,
      });
    case 'recall':
      exact(v, ['operation', 'clientRequestId', 'conversationId', 'messageId']);
      if (!id(v.messageId)) invalid();
      return Object.freeze({
        operation: 'recall',
        clientRequestId,
        conversationId,
        messageId: v.messageId,
      });
    case 'hide':
    case 'reopen':
    case 'block':
      exact(v, ['operation', 'clientRequestId', 'conversationId']);
      return Object.freeze({
        operation: v.operation,
        clientRequestId,
        conversationId,
      });
    default:
      return invalid();
  }
}
const rejectionCodes = [
  'DM_COMMAND_CANCELLED',
  'DM_NOT_FOUND',
  'DM_ENTRY_UNAVAILABLE',
  'DM_SEND_UNAVAILABLE',
  'DM_FIRST_CONTACT_LIMIT',
  'DM_RECALL_EXPIRED',
  'DM_OBSERVATION_UNAVAILABLE',
  'CONTENT_REJECTED',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
];
export function decodeReceipt(v: unknown): Receipt {
  if (
    !isRecord(v) ||
    !id(v.requestId) ||
    !['open', 'send', 'read', 'hide', 'reopen', 'recall', 'block'].includes(
      String(v.operation),
    )
  )
    invalid();
  const operation = v.operation as Operation;
  if (v.outcome === 'rejected') {
    exact(v, ['requestId', 'operation', 'outcome', 'code']);
    if (typeof v.code !== 'string' || !rejectionCodes.includes(v.code))
      invalid();
    return Object.freeze({
      requestId: v.requestId,
      operation,
      outcome: 'rejected',
      code: v.code,
    });
  }
  exact(v, [
    'requestId',
    'operation',
    'outcome',
    'conversationId',
    'messageId',
    'occurredAt',
  ]);
  if (
    (v.outcome !== 'applied' && v.outcome !== 'noop') ||
    !id(v.conversationId) ||
    !(v.messageId === null || id(v.messageId)) ||
    !date(v.occurredAt)
  )
    invalid();
  return Object.freeze({
    requestId: v.requestId,
    operation,
    outcome: v.outcome,
    conversationId: v.conversationId,
    messageId: v.messageId,
    occurredAt: v.occurredAt,
  });
}
export function matchReceipt(intent: Intent, receipt: Receipt): void {
  if (
    intent.clientRequestId !== receipt.requestId ||
    intent.operation !== receipt.operation
  )
    invalid();
  if (
    receipt.outcome !== 'rejected' &&
    ((intent.operation !== 'open' &&
      intent.conversationId !== receipt.conversationId) ||
      (intent.operation === 'recall' &&
        intent.messageId !== receipt.messageId) ||
      (intent.operation === 'send' && !receipt.messageId))
  )
    invalid();
}
function display(v: unknown): Display {
  exact(v, ['mode', 'displayName', 'profileId']);
  if (
    !mode(v.mode) ||
    typeof v.displayName !== 'string' ||
    v.displayName.length > 200 ||
    !(v.profileId === null || id(v.profileId)) ||
    (v.mode === 'anonymous' && v.profileId !== null)
  )
    invalid();
  return Object.freeze({
    mode: v.mode,
    displayName: v.displayName,
    profileId: v.profileId,
  });
}
export function decodeConversation(v: unknown): Conversation {
  exact(v, [
    'id',
    'self',
    'peer',
    'source',
    'unreadCount',
    'hidden',
    'sendAvailability',
    'blockScope',
    'blockedByYou',
  ]);
  if (
    !id(v.id) ||
    !count(v.unreadCount) ||
    typeof v.hidden !== 'boolean' ||
    typeof v.blockedByYou !== 'boolean' ||
    !['available', 'unavailable', 'blocked_by_you', 'awaiting_reply'].includes(
      String(v.sendAvailability),
    ) ||
    !['named', 'conversation', 'named_and_conversation'].includes(
      String(v.blockScope),
    )
  )
    invalid();
  let source: Conversation['source'] = null;
  if (v.source !== null) {
    exact(v.source, ['kind', 'postId', 'available']);
    if (
      v.source.kind !== 'post' ||
      !id(v.source.postId) ||
      typeof v.source.available !== 'boolean'
    )
      invalid();
    source = Object.freeze({
      kind: 'post',
      postId: v.source.postId,
      available: v.source.available,
    });
  }
  const self = display(v.self),
    peer = display(v.peer);
  if (
    (v.blockScope === 'named' &&
      (self.mode !== 'named' || peer.mode !== 'named')) ||
    (v.blockScope === 'named_and_conversation' &&
      (self.mode !== 'anonymous' || peer.mode !== 'named'))
  )
    invalid();
  return Object.freeze({
    id: v.id,
    self,
    peer,
    source,
    unreadCount: v.unreadCount,
    hidden: v.hidden,
    sendAvailability: v.sendAvailability as Conversation['sendAvailability'],
    blockScope: v.blockScope as Conversation['blockScope'],
    blockedByYou: v.blockedByYou,
  });
}
export function decodeMessage(v: unknown): Message {
  exact(v, [
    'id',
    'sequence',
    'sender',
    'state',
    'text',
    'createdAt',
    'canRecall',
  ]);
  if (
    !id(v.id) ||
    !sequence(v.sequence) ||
    (v.sender !== 'self' && v.sender !== 'peer') ||
    !['text', 'recalled', 'unavailable'].includes(String(v.state)) ||
    !date(v.createdAt) ||
    typeof v.canRecall !== 'boolean' ||
    (v.state === 'text' ? typeof v.text !== 'string' : v.text !== null) ||
    (v.canRecall && (v.sender !== 'self' || v.state === 'recalled'))
  )
    invalid();
  return Object.freeze({
    id: v.id,
    sequence: v.sequence,
    sender: v.sender,
    state: v.state as Message['state'],
    text: v.text as string | null,
    createdAt: v.createdAt,
    canRecall: v.canRecall,
  });
}
function messages(v: unknown): readonly Message[] {
  if (!Array.isArray(v) || v.length > 50) invalid();
  const items = v.map(decodeMessage);
  if (
    new Set(items.map((m) => m.id)).size !== items.length ||
    items.some(
      (m, i) =>
        i > 0 && compareSequence(items[i - 1]!.sequence, m.sequence) >= 0,
    )
  )
    invalid();
  return Object.freeze(items);
}
export function decodeList(v: unknown): ListPage {
  exact(v, ['items', 'nextCursor', 'coverage']);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !(v.nextCursor === null || cursor(v.nextCursor)) ||
    !coverage(v.coverage)
  )
    invalid();
  const items = v.items.map((raw) => {
    exact(raw, ['conversation', 'latest', 'updatedAt']);
    if (!date(raw.updatedAt)) invalid();
    return Object.freeze({
      conversation: decodeConversation(raw.conversation),
      latest: raw.latest === null ? null : decodeMessage(raw.latest),
      updatedAt: raw.updatedAt,
    });
  });
  if (new Set(items.map((i) => i.conversation.id)).size !== items.length)
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: v.nextCursor,
    coverage: v.coverage,
  });
}
export function decodeHistory(v: unknown): History {
  exact(v, [
    'items',
    'nextCursor',
    'observationId',
    'throughSequence',
    'eventCursor',
    'coverage',
  ]);
  if (
    !(v.nextCursor === null || cursor(v.nextCursor)) ||
    !id(v.observationId) ||
    !sequence(v.throughSequence) ||
    !cursor(v.eventCursor) ||
    !coverage(v.coverage)
  )
    invalid();
  const items = messages(v.items);
  if (
    items.some(
      (m) => compareSequence(m.sequence, v.throughSequence as string) > 0,
    )
  )
    invalid();
  return Object.freeze({
    items,
    nextCursor: v.nextCursor,
    observationId: v.observationId,
    throughSequence: v.throughSequence,
    eventCursor: v.eventCursor,
    coverage: v.coverage,
  });
}
export function decodeEvents(v: unknown): Events {
  exact(v, [
    'items',
    'nextCursor',
    'hasMore',
    'observationId',
    'throughSequence',
  ]);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !cursor(v.nextCursor) ||
    typeof v.hasMore !== 'boolean' ||
    !id(v.observationId) ||
    !sequence(v.throughSequence)
  )
    invalid();
  const items = v.items.map((raw) => {
    exact(raw, ['sequence', 'kind', 'message']);
    if (
      !sequence(raw.sequence) ||
      (raw.kind !== 'sent' && raw.kind !== 'recalled')
    )
      invalid();
    const message = decodeMessage(raw.message);
    if (
      raw.kind === 'recalled' &&
      message.state !== 'recalled' &&
      message.state !== 'unavailable'
    )
      invalid();
    return Object.freeze({ sequence: raw.sequence, kind: raw.kind, message });
  });
  if (
    items.some(
      (m, i) =>
        i > 0 && compareSequence(items[i - 1]!.sequence, m.sequence) >= 0,
    ) ||
    (v.hasMore && !items.length)
  )
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: v.nextCursor,
    hasMore: v.hasMore,
    observationId: v.observationId,
    throughSequence: v.throughSequence,
  });
}
export function decodeUnread(v: unknown): Unread {
  exact(v, ['count', 'coverage']);
  if (!count(v.count) || !coverage(v.coverage)) invalid();
  return Object.freeze({ count: v.count, coverage: v.coverage });
}
export interface CancellationResult {
  readonly outcome: 'cancelled' | 'already_terminal';
  readonly receipt: Receipt;
}
export function decodeCancellationResult(value: unknown): CancellationResult {
  exact(value, ['outcome', 'receipt']);
  if (value.outcome !== 'cancelled' && value.outcome !== 'already_terminal')
    invalid();
  const receipt = decodeReceipt(value.receipt);
  const cancelled =
    receipt.outcome === 'rejected' && receipt.code === 'DM_COMMAND_CANCELLED';
  if ((value.outcome === 'cancelled') !== cancelled) invalid();
  return Object.freeze({ outcome: value.outcome, receipt });
}
