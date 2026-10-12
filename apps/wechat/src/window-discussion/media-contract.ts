import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { windowId } from '../window-ratings/contract';
import { invalidDiscussion } from './contract';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  uploadInteger,
  uploadDigest,
} from '../media/upload-contracts';
import type {
  UploadGrant,
  UploadObserved,
  UploadDeclaration,
} from '../media/upload-contracts';
export const WINDOW_DISCUSSION_MEDIA_PROTOCOL =
  'window-discussion-media-v1' as const;
export const WINDOW_DISCUSSION_MEDIA_PATH = '/v3/media/window-discussions';
export function mediaId(value: unknown): string {
  if (!windowId(value)) invalidDiscussion();
  return value;
}
export interface WindowDiscussionMediaPrepare {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly publicationRequestId: string;
  readonly windowId: string;
  readonly catalogRevision: string;
  readonly windowRevision: string;
  readonly rootId: string | null;
  readonly replyToReplyId: string | null;
  readonly ordinal: number;
  readonly declaration: UploadDeclaration;
}
export interface WindowDiscussionImageReference {
  readonly windowId: string;
  readonly commentId: string;
  readonly bindingId: string;
  readonly ordinal: number;
}
export interface WindowDiscussionMediaDescriptor extends WindowDiscussionImageReference {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
  readonly kind: 'window-discussion-media';
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
export function decodeWindowDiscussionImageReference(
  v: unknown,
): WindowDiscussionImageReference {
  exact(v, ['windowId', 'commentId', 'bindingId', 'ordinal']);
  if (!uploadInteger(v.ordinal, 0, 2)) invalidDiscussion();
  return Object.freeze({
    windowId: mediaId(v.windowId),
    commentId: mediaId(v.commentId),
    bindingId: mediaId(v.bindingId),
    ordinal: v.ordinal,
  });
}
export function decodeWindowDiscussionMediaPrepare(
  v: unknown,
): WindowDiscussionMediaPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'publicationRequestId',
    'windowId',
    'catalogRevision',
    'windowRevision',
    'rootId',
    'replyToReplyId',
    'ordinal',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    !uploadInteger(v.ordinal, 0, 2) ||
    !(v.rootId === null || windowId(v.rootId)) ||
    !(v.replyToReplyId === null || windowId(v.replyToReplyId)) ||
    (v.rootId === null && v.replyToReplyId !== null) ||
    !['image/jpeg', 'image/png'].includes(String(v.declaration.mime)) ||
    !uploadInteger(v.declaration.bytes, 1, 5242880) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidDiscussion();
  return Object.freeze({
    protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
    clientRequestId: mediaId(v.clientRequestId),
    publicationRequestId: mediaId(v.publicationRequestId),
    windowId: mediaId(v.windowId),
    catalogRevision: mediaId(v.catalogRevision),
    windowRevision: mediaId(v.windowRevision),
    rootId: v.rootId,
    replyToReplyId: v.replyToReplyId,
    ordinal: v.ordinal,
    declaration: Object.freeze({
      mime: v.declaration.mime as 'image/jpeg' | 'image/png',
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function windowDiscussionMediaPrepareHash(
  actor: string,
  raw: unknown,
): string {
  const i = decodeWindowDiscussionMediaPrepare(raw);
  return sha256(
    'whaleu-window-discussion-media-prepare:v1\n' +
      JSON.stringify({
        protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
        actorAccountId: mediaId(actor),
        clientRequestId: i.clientRequestId,
        publicationRequestId: i.publicationRequestId,
        windowId: i.windowId,
        catalogRevision: i.catalogRevision,
        windowRevision: i.windowRevision,
        rootId: i.rootId,
        replyToReplyId: i.replyToReplyId,
        ordinal: i.ordinal,
        declaration: {
          mime: i.declaration.mime,
          bytes: i.declaration.bytes,
          sha256: i.declaration.sha256,
        },
      }),
  );
}
export function decodeWindowDiscussionMediaDescriptor(
  v: unknown,
): WindowDiscussionMediaDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'windowId',
    'commentId',
    'bindingId',
    'ordinal',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    v.kind !== 'window-discussion-media' ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidDiscussion();
  return Object.freeze({
    ...decodeWindowDiscussionImageReference({
      windowId: v.windowId,
      commentId: v.commentId,
      bindingId: v.bindingId,
      ordinal: v.ordinal,
    }),
    protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
    kind: 'window-discussion-media',
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
interface Base {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type WindowDiscussionMediaStatus = Base &
  (
    | {
        readonly status: 'prepared';
        readonly operationDeadlineAt: number;
        readonly upload: 'none' | 'in_flight' | 'reconcile_needed';
      }
    | { readonly status: 'uploaded'; readonly operationDeadlineAt: number }
    | {
        readonly status: 'processing';
        readonly operationDeadlineAt: number;
        readonly retryAfterMs: number;
      }
    | {
        readonly status: 'ready_unbound';
        readonly assetId: string;
        readonly manifestDigest: string;
        readonly bindBefore: number;
        readonly mediaProof: 'current';
      }
    | {
        readonly status: 'bound_history';
        readonly assetId: string;
        readonly bindingId: string;
        readonly attachmentState: 'active' | 'detached';
      }
    | {
        readonly status: 'terminal';
        readonly reason: 'cancelled' | 'expired' | 'rejected' | 'deleted';
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type WindowDiscussionMediaRecovery = {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: WindowDiscussionMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type WindowDiscussionMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
};
export type WindowDiscussionMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof WINDOW_DISCUSSION_MEDIA_PROTOCOL;
};
export function decodeWindowDiscussionMediaStatus(
  v: unknown,
): WindowDiscussionMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidDiscussion();
  mediaId(v.intentId);
  mediaId(v.requestId);
  const base = [
    'protocol',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  switch (v.status) {
    case 'prepared':
      exact(v, [...base, 'operationDeadlineAt', 'upload']);
      if (!['none', 'in_flight', 'reconcile_needed'].includes(String(v.upload)))
        invalidDiscussion();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidDiscussion();
      break;
    case 'ready_unbound':
      exact(v, [
        ...base,
        'assetId',
        'manifestDigest',
        'bindBefore',
        'mediaProof',
      ]);
      mediaId(v.assetId);
      if (
        !uploadDigest(v.manifestDigest) ||
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidDiscussion();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      mediaId(v.assetId);
      mediaId(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidDiscussion();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidDiscussion();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidDiscussion();
      break;
    default:
      invalidDiscussion();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidDiscussion();
  return Object.freeze({ ...v }) as unknown as WindowDiscussionMediaStatus;
}
export function decodeWindowDiscussionMediaRecovery(
  v: unknown,
): WindowDiscussionMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidDiscussion();
  mediaId(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidDiscussion();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidDiscussion();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeWindowDiscussionMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidDiscussion();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as WindowDiscussionMediaRecovery;
  } else invalidDiscussion();
  return Object.freeze({ ...v }) as unknown as WindowDiscussionMediaRecovery;
}
export function decodeWindowDiscussionMediaGrant(
  v: unknown,
): WindowDiscussionMediaGrant {
  if (
    !isRecord(v) ||
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidDiscussion();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({
    ...value,
    protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
  });
}
export function decodeWindowDiscussionMediaObserved(
  v: unknown,
): WindowDiscussionMediaObserved {
  if (
    !isRecord(v) ||
    v.protocol !== WINDOW_DISCUSSION_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidDiscussion();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({
    ...value,
    protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
  });
}
