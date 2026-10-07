import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { cursor, exact, invalid, timestamp, uuid4 } from './contract';
export interface BlockSource {
  readonly kind: 'post' | 'comment' | 'reply' | 'profile';
  readonly id: string;
}
export type BlockIntent = { readonly clientRequestId: string } & (
  | {
      readonly operation: 'block_named';
      readonly source: BlockSource;
      readonly blocked: true;
    }
  | {
      readonly operation: 'unblock_named';
      readonly relationshipId: string;
      readonly expectedRevision: string;
      readonly blocked: false;
    }
);
export interface BlockState {
  readonly relationshipId: string;
  readonly blocked: boolean;
  readonly revision: string;
}
export type BlockReceipt = {
  readonly requestId: string;
  readonly operation: 'block_named' | 'unblock_named';
} & (
  | ({ readonly outcome: 'applied' } & BlockState)
  | { readonly outcome: 'rejected'; readonly code: string }
);
export type BlockResult =
  | {
      readonly receipt: Extract<BlockReceipt, { outcome: 'applied' }>;
      readonly current: BlockState;
    }
  | {
      readonly receipt: Extract<BlockReceipt, { outcome: 'rejected' }>;
      readonly current: null;
    };
export interface BlockEntry {
  readonly relationshipId: string;
  readonly revision: string;
  readonly blocked: true;
  readonly blockedAt: string;
  readonly display: {
    readonly kind: 'current' | 'snapshot' | 'unavailable';
    readonly displayName: string | null;
  };
  readonly canUnblock: true;
}
export interface BlocksList {
  readonly items: readonly BlockEntry[];
  readonly nextCursor: string | null;
}
export const blockRejectionCodes = [
  'BLOCK_TARGET_NOT_ALLOWED',
  'BLOCK_NOT_FOUND',
  'BLOCK_REVISION_CONFLICT',
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
] as const;
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
export function decodeBlockSource(value: unknown): BlockSource {
  exact(value, ['kind', 'id']);
  if (
    !['post', 'comment', 'reply', 'profile'].includes(value.kind as string) ||
    !isUuid(value.id)
  )
    invalid();
  return Object.freeze({
    kind: value.kind as BlockSource['kind'],
    id: value.id,
  });
}
export function decodeBlockIntent(value: unknown): BlockIntent {
  if (!isRecord(value)) invalid();
  if (value.operation === 'block_named') {
    exact(value, ['clientRequestId', 'operation', 'source', 'blocked']);
    if (!uuid4(value.clientRequestId) || value.blocked !== true) invalid();
    return Object.freeze({
      clientRequestId: value.clientRequestId,
      operation: 'block_named',
      source: decodeBlockSource(value.source),
      blocked: true,
    });
  }
  exact(value, [
    'clientRequestId',
    'operation',
    'relationshipId',
    'expectedRevision',
    'blocked',
  ]);
  if (
    !uuid4(value.clientRequestId) ||
    value.operation !== 'unblock_named' ||
    !isUuid(value.relationshipId) ||
    !revision(value.expectedRevision) ||
    value.blocked !== false
  )
    invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    operation: 'unblock_named',
    relationshipId: value.relationshipId,
    expectedRevision: value.expectedRevision,
    blocked: false,
  });
}
export function decodeBlockState(value: unknown): BlockState {
  exact(value, ['relationshipId', 'blocked', 'revision']);
  if (
    !isUuid(value.relationshipId) ||
    typeof value.blocked !== 'boolean' ||
    !revision(value.revision)
  )
    invalid();
  return Object.freeze({
    relationshipId: value.relationshipId,
    blocked: value.blocked,
    revision: value.revision,
  });
}
export function decodeBlockReceipt(value: unknown): BlockReceipt {
  if (
    !isRecord(value) ||
    !uuid4(value.requestId) ||
    !['block_named', 'unblock_named'].includes(value.operation as string)
  )
    invalid();
  const operation = value.operation as BlockReceipt['operation'];
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (!(blockRejectionCodes as readonly unknown[]).includes(value.code))
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as string,
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'relationshipId',
    'blocked',
    'revision',
  ]);
  if (
    value.outcome !== 'applied' ||
    value.blocked !== (operation === 'block_named')
  )
    invalid();
  const state = decodeBlockState({
    relationshipId: value.relationshipId,
    blocked: value.blocked,
    revision: value.revision,
  });
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: 'applied',
    ...state,
  });
}
export function decodeBlockResult(value: unknown): BlockResult {
  exact(value, ['receipt', 'current']);
  const receipt = decodeBlockReceipt(value.receipt);
  if (receipt.outcome === 'rejected') {
    if (value.current !== null) invalid();
    return Object.freeze({ receipt, current: null });
  }
  const current = decodeBlockState(value.current);
  if (
    current.relationshipId !== receipt.relationshipId ||
    BigInt(current.revision) < BigInt(receipt.revision) ||
    (current.revision === receipt.revision &&
      current.blocked !== receipt.blocked)
  )
    invalid();
  return Object.freeze({ receipt, current });
}
export function matchBlockResult(
  intent: BlockIntent,
  result: BlockResult,
): void {
  const receipt = result.receipt;
  if (
    receipt.requestId !== intent.clientRequestId ||
    receipt.operation !== intent.operation
  )
    invalid();
  if (
    receipt.outcome === 'applied' &&
    (receipt.blocked !== intent.blocked ||
      (intent.operation === 'unblock_named' &&
        (receipt.relationshipId !== intent.relationshipId ||
          BigInt(receipt.revision) < BigInt(intent.expectedRevision))))
  )
    invalid();
}
export function decodeBlocksList(value: unknown): BlocksList {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor) ||
    (!value.items.length && value.nextCursor !== null)
  )
    invalid();
  const items = value.items.map((raw): BlockEntry => {
    exact(raw, [
      'relationshipId',
      'revision',
      'blocked',
      'blockedAt',
      'display',
      'canUnblock',
    ]);
    const state = decodeBlockState({
      relationshipId: raw.relationshipId,
      blocked: raw.blocked,
      revision: raw.revision,
    });
    exact(raw.display, ['kind', 'displayName']);
    if (
      state.blocked !== true ||
      !timestamp(raw.blockedAt) ||
      raw.canUnblock !== true ||
      !['current', 'snapshot', 'unavailable'].includes(
        raw.display.kind as string,
      ) ||
      (raw.display.kind === 'unavailable'
        ? raw.display.displayName !== null
        : typeof raw.display.displayName !== 'string' ||
          !raw.display.displayName ||
          raw.display.displayName.length > 1024)
    )
      invalid();
    return Object.freeze({
      ...state,
      blocked: true,
      blockedAt: raw.blockedAt,
      display: Object.freeze({
        kind: raw.display.kind as BlockEntry['display']['kind'],
        displayName: raw.display.displayName as string | null,
      }),
      canUnblock: true,
    });
  });
  if (new Set(items.map((item) => item.relationshipId)).size !== items.length)
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
  });
}
