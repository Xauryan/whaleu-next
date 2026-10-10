import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating } from './contract';
import { canonicalRatingScopedJson } from './scoped-contract';
import {
  discussionMediaId as id,
  discussionMediaDigest as digest,
} from './discussion-media-contract';
import {
  RATINGS_DISCUSSION_MEDIA_PROTOCOL as protocol,
  decodeRatingDiscussionBatchIdentity,
  type RatingDiscussionBatchIdentity,
} from './discussion-media-batch-contract';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  uploadInteger,
  type UploadGrant,
  type UploadObserved,
  type UploadDeclaration,
} from '../media/upload-contracts';
export { protocol as RATING_DISCUSSION_WIRE_PROTOCOL };
const instant = (value: unknown): number => {
  if (!uploadInteger(value, 1, Number.MAX_SAFE_INTEGER)) invalidRating();
  return value;
};
export type DiscussionParent =
  | {
      readonly ownerKind: 'ratings';
      readonly resourceKind: 'rating_comment';
      readonly targetId: string;
      readonly resourceId: string;
      readonly contentVersion: 1;
    }
  | {
      readonly ownerKind: 'ratings';
      readonly resourceKind: 'rating_reply';
      readonly targetId: string;
      readonly rootId: string;
      readonly resourceId: string;
      readonly contentVersion: 1;
    };
export function decodeDiscussionParent(raw: unknown): DiscussionParent {
  if (!isRecord(raw)) invalidRating();
  exact(raw, [
    'ownerKind',
    'resourceKind',
    'targetId',
    'resourceId',
    'contentVersion',
    ...(raw.resourceKind === 'rating_reply' ? ['rootId'] : []),
  ]);
  if (
    raw.ownerKind !== 'ratings' ||
    raw.contentVersion !== 1 ||
    !['rating_comment', 'rating_reply'].includes(String(raw.resourceKind))
  )
    invalidRating();
  const base = {
    ownerKind: 'ratings' as const,
    targetId: id(raw.targetId),
    resourceId: id(raw.resourceId),
    contentVersion: 1 as const,
  };
  if (raw.resourceKind === 'rating_comment')
    return Object.freeze({ ...base, resourceKind: 'rating_comment' });
  const rootId = id(raw.rootId);
  if (rootId === base.resourceId) invalidRating();
  return Object.freeze({ ...base, resourceKind: 'rating_reply', rootId });
}
export interface DiscussionDescriptor {
  readonly protocol: typeof protocol;
  readonly kind: 'ratings-discussion-media';
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId: string | null;
  readonly subjectRevision: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly bindingId: string;
  readonly ordinal: number;
  readonly attachmentSetDigest: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
export function decodeDiscussionDescriptor(raw: unknown): DiscussionDescriptor {
  exact(raw, [
    'protocol',
    'kind',
    'targetId',
    'rootId',
    'replyId',
    'subjectRevision',
    'contextId',
    'contextToken',
    'bindingId',
    'ordinal',
    'attachmentSetDigest',
    'width',
    'height',
    'variants',
  ]);
  if (
    raw.protocol !== protocol ||
    raw.kind !== 'ratings-discussion-media' ||
    typeof raw.contextToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw.contextToken) ||
    !uploadInteger(raw.ordinal, 0, raw.replyId === null ? 8 : 2) ||
    !uploadInteger(raw.width, 1, 2048) ||
    !uploadInteger(raw.height, 1, 2048) ||
    !Array.isArray(raw.variants) ||
    raw.variants.length !== 2 ||
    raw.variants[0] !== 'thumb-v1' ||
    raw.variants[1] !== 'display-v1'
  )
    invalidRating();
  const rootId = id(raw.rootId),
    replyId = raw.replyId === null ? null : id(raw.replyId);
  if (replyId === rootId) invalidRating();
  return Object.freeze({
    protocol,
    kind: 'ratings-discussion-media',
    targetId: id(raw.targetId),
    rootId,
    replyId,
    subjectRevision: id(raw.subjectRevision),
    contextId: id(raw.contextId),
    contextToken: raw.contextToken,
    bindingId: id(raw.bindingId),
    ordinal: raw.ordinal,
    attachmentSetDigest: digest(raw.attachmentSetDigest),
    width: raw.width,
    height: raw.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export interface DiscussionMemberPrepare {
  readonly protocol: typeof protocol;
  readonly clientRequestId: string;
  readonly batchId: string;
  readonly batchIdentityHash: string;
  readonly memberId: string;
  readonly sourceSlot: number;
  readonly declaration: UploadDeclaration;
}
interface MemberBase {
  readonly protocol: typeof protocol;
  readonly batchId: string;
  readonly memberId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type DiscussionMemberStatus = MemberBase &
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
        readonly parent: DiscussionParent;
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
        readonly retryable: true;
      }
  );
export function decodeDiscussionMemberStatus(
  raw: unknown,
): DiscussionMemberStatus {
  if (!isRecord(raw) || raw.protocol !== protocol) invalidRating();
  for (const key of ['batchId', 'memberId', 'intentId', 'requestId'])
    id(raw[key]);
  digest(raw.requestHash);
  instant(raw.serverNow);
  const common = [
    'protocol',
    'batchId',
    'memberId',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  switch (raw.status) {
    case 'prepared':
      exact(raw, [...common, 'operationDeadlineAt', 'upload']);
      instant(raw.operationDeadlineAt);
      if (
        !['none', 'in_flight', 'reconcile_needed'].includes(String(raw.upload))
      )
        invalidRating();
      break;
    case 'uploaded':
      exact(raw, [...common, 'operationDeadlineAt']);
      instant(raw.operationDeadlineAt);
      break;
    case 'processing':
      exact(raw, [...common, 'operationDeadlineAt', 'retryAfterMs']);
      instant(raw.operationDeadlineAt);
      if (!uploadInteger(raw.retryAfterMs, 250, 30000)) invalidRating();
      break;
    case 'ready_unbound':
      exact(raw, [
        ...common,
        'assetId',
        'manifestDigest',
        'bindBefore',
        'mediaProof',
      ]);
      id(raw.assetId);
      digest(raw.manifestDigest);
      instant(raw.bindBefore);
      if (raw.mediaProof !== 'current') invalidRating();
      break;
    case 'bound_history':
      exact(raw, [
        ...common,
        'assetId',
        'bindingId',
        'parent',
        'attachmentState',
      ]);
      id(raw.assetId);
      id(raw.bindingId);
      decodeDiscussionParent(raw.parent);
      if (!['active', 'detached'].includes(String(raw.attachmentState)))
        invalidRating();
      break;
    case 'terminal':
      exact(raw, [...common, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(raw.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(raw.cleanup))
      )
        invalidRating();
      break;
    case 'unavailable':
      exact(raw, [...common, 'reason', 'retryable']);
      if (raw.reason !== 'MEDIA_UNAVAILABLE' || raw.retryable !== true)
        invalidRating();
      break;
    default:
      invalidRating();
  }
  return Object.freeze({ ...raw }) as unknown as DiscussionMemberStatus;
}
export type DiscussionMemberRecovery = {
  readonly protocol: typeof protocol;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | { readonly state: 'cancelled_before_prepare'; readonly requestHash: string }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: DiscussionMemberStatus;
    }
);
export function decodeDiscussionMemberRecovery(
  raw: unknown,
): DiscussionMemberRecovery {
  if (!isRecord(raw) || raw.protocol !== protocol) invalidRating();
  id(raw.requestId);
  instant(raw.serverNow);
  const common = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (raw.state === 'not_recorded') {
    exact(raw, common);
    if (raw.requestHash !== null) invalidRating();
  } else if (raw.state === 'cancelled_before_prepare') {
    exact(raw, common);
    digest(raw.requestHash);
  } else if (raw.state === 'recorded') {
    exact(raw, [...common, 'status']);
    digest(raw.requestHash);
    const status = decodeDiscussionMemberStatus(raw.status);
    if (
      status.requestId !== raw.requestId ||
      status.requestHash !== raw.requestHash
    )
      invalidRating();
  } else invalidRating();
  return Object.freeze({ ...raw }) as unknown as DiscussionMemberRecovery;
}
export interface DiscussionSealedPlan {
  readonly batchId: string;
  readonly batchIdentityHash: string;
  readonly orderedMembers: readonly {
    readonly ordinal: number;
    readonly memberId: string;
    readonly assetId: string;
    readonly manifestDigest: string;
  }[];
}
export interface DiscussionBatchStatus {
  readonly protocol: typeof protocol;
  readonly batchId: string;
  readonly identity: RatingDiscussionBatchIdentity;
  readonly batchIdentityHash: string;
  readonly revision: string;
  readonly state: 'editing' | 'sealed' | 'consumed' | 'cancelled';
  readonly expiresAt: number;
  readonly serverNow: number;
  readonly members: readonly {
    readonly memberId: string;
    readonly requestId: string;
    readonly intentId: string;
    readonly sourceSlot: number;
    readonly state: 'live' | 'removed' | 'bound';
  }[];
  readonly sealedPlan: DiscussionSealedPlan | null;
  readonly sealedPlanDigest: string | null;
  readonly consumedParent: DiscussionParent | null;
}
export function decodeDiscussionBatchStatus(
  raw: unknown,
): DiscussionBatchStatus {
  exact(raw, [
    'protocol',
    'batchId',
    'identity',
    'batchIdentityHash',
    'revision',
    'state',
    'expiresAt',
    'serverNow',
    'members',
    'sealedPlan',
    'sealedPlanDigest',
    'consumedParent',
  ]);
  if (
    raw.protocol !== protocol ||
    !['editing', 'sealed', 'consumed', 'cancelled'].includes(
      String(raw.state),
    ) ||
    !Array.isArray(raw.members) ||
    raw.members.length > 128
  )
    invalidRating();
  const identity = decodeRatingDiscussionBatchIdentity(raw.identity),
    batchId = id(raw.batchId),
    batchIdentityHash = digest(raw.batchIdentityHash),
    maximum = identity.target.kind === 'root' ? 9 : 3;
  const members = raw.members.map((m: unknown) => {
    exact(m, ['memberId', 'requestId', 'intentId', 'sourceSlot', 'state']);
    if (
      !uploadInteger(m.sourceSlot, 0, 127) ||
      !['live', 'removed', 'bound'].includes(String(m.state))
    )
      invalidRating();
    return {
      memberId: id(m.memberId),
      requestId: id(m.requestId),
      intentId: id(m.intentId),
      sourceSlot: m.sourceSlot,
      state: m.state as 'live' | 'removed' | 'bound',
    };
  });
  for (const field of [
    'memberId',
    'requestId',
    'intentId',
    'sourceSlot',
  ] as const)
    if (new Set(members.map((m) => m[field])).size !== members.length)
      invalidRating();
  if (
    members.filter((m) => m.state !== 'removed').length > maximum ||
    members.some((m) => m.state === 'bound' && raw.state !== 'consumed')
  )
    invalidRating();
  let plan: DiscussionSealedPlan | null = null;
  if (raw.sealedPlan !== null) {
    exact(raw.sealedPlan, ['batchId', 'batchIdentityHash', 'orderedMembers']);
    const p = raw.sealedPlan;
    if (
      p.batchId !== batchId ||
      p.batchIdentityHash !== batchIdentityHash ||
      !Array.isArray(p.orderedMembers) ||
      p.orderedMembers.length < 1 ||
      p.orderedMembers.length > maximum
    )
      invalidRating();
    const orderedMembers = p.orderedMembers.map(
      (m: unknown, ordinal: number) => {
        exact(m, ['ordinal', 'memberId', 'assetId', 'manifestDigest']);
        if (m.ordinal !== ordinal) invalidRating();
        return {
          ordinal,
          memberId: id(m.memberId),
          assetId: id(m.assetId),
          manifestDigest: digest(m.manifestDigest),
        };
      },
    );
    if (
      new Set(orderedMembers.map((m) => m.memberId)).size !==
        orderedMembers.length ||
      new Set(orderedMembers.map((m) => m.assetId)).size !==
        orderedMembers.length ||
      orderedMembers.some(
        (m) =>
          !members.some(
            (entry) =>
              entry.memberId === m.memberId &&
              entry.state === (raw.state === 'consumed' ? 'bound' : 'live'),
          ),
      )
    )
      invalidRating();
    plan = { batchId, batchIdentityHash, orderedMembers };
    if (
      digest(raw.sealedPlanDigest) !==
      sha256(
        'whaleu:ratings-discussion-media-plan:v1\n' +
          canonicalRatingScopedJson(plan),
      )
    )
      invalidRating();
  }
  if (
    (plan === null) !== (raw.sealedPlanDigest === null) ||
    (['sealed', 'consumed'].includes(String(raw.state)) && plan === null)
  )
    invalidRating();
  const consumedParent =
    raw.consumedParent === null
      ? null
      : decodeDiscussionParent(raw.consumedParent);
  if (
    (raw.state === 'consumed') !== (consumedParent !== null) ||
    (consumedParent &&
      (consumedParent.targetId !== identity.target.targetId ||
        consumedParent.resourceKind !==
          (identity.target.kind === 'root'
            ? 'rating_comment'
            : 'rating_reply') ||
        (consumedParent.resourceKind === 'rating_reply' &&
          identity.target.kind === 'reply' &&
          consumedParent.rootId !== identity.target.rootId)))
  )
    invalidRating();
  return Object.freeze({
    protocol,
    batchId,
    identity,
    batchIdentityHash,
    revision: id(raw.revision),
    state: raw.state as DiscussionBatchStatus['state'],
    expiresAt: instant(raw.expiresAt),
    serverNow: instant(raw.serverNow),
    members,
    sealedPlan: plan,
    sealedPlanDigest: raw.sealedPlanDigest as string | null,
    consumedParent,
  });
}
export type DiscussionBatchRecovery = {
  readonly protocol: typeof protocol;
  readonly batchRequestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded' }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly identityHash: string;
    }
  | { readonly state: 'recorded'; readonly status: DiscussionBatchStatus }
);
export function decodeDiscussionBatchRecovery(
  raw: unknown,
): DiscussionBatchRecovery {
  if (!isRecord(raw)) invalidRating();
  exact(raw, [
    'protocol',
    'batchRequestId',
    'serverNow',
    'state',
    ...(raw.state === 'recorded'
      ? ['status']
      : raw.state === 'cancelled_before_prepare'
        ? ['identityHash']
        : []),
  ]);
  if (
    raw.protocol !== protocol ||
    (raw.state !== 'recorded' &&
      raw.state !== 'not_recorded' &&
      raw.state !== 'cancelled_before_prepare')
  )
    invalidRating();
  const base = {
    protocol,
    batchRequestId: id(raw.batchRequestId),
    serverNow: instant(raw.serverNow),
  };
  if (raw.state === 'not_recorded')
    return Object.freeze({ ...base, state: 'not_recorded' });
  if (raw.state === 'cancelled_before_prepare')
    return Object.freeze({
      ...base,
      state: 'cancelled_before_prepare',
      identityHash: digest(raw.identityHash),
    });
  const status = decodeDiscussionBatchStatus(raw.status);
  if (status.identity.batchRequestId !== base.batchRequestId) invalidRating();
  return Object.freeze({ ...base, state: 'recorded', status });
}
export type DiscussionGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof protocol;
  readonly batchId: string;
  readonly memberId: string;
};
export type DiscussionUploadObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof protocol;
  readonly batchId: string;
  readonly memberId: string;
};
export function decodeDiscussionGrant(raw: unknown): DiscussionGrant {
  if (!isRecord(raw) || raw.protocol !== protocol) invalidRating();
  const { protocol: p, batchId, memberId, ...rest } = raw;
  if ('version' in rest) invalidRating();
  const { version: _version, ...grant } = decodeUploadGrant({
    ...rest,
    version: 1,
  });
  void _version;
  return Object.freeze({
    protocol: p,
    batchId: id(batchId),
    memberId: id(memberId),
    ...grant,
  });
}
export function decodeDiscussionUploadObserved(
  raw: unknown,
): DiscussionUploadObserved {
  if (!isRecord(raw) || raw.protocol !== protocol) invalidRating();
  const { protocol: p, batchId, memberId, ...rest } = raw;
  if ('version' in rest) invalidRating();
  const { version: _version, ...observed } = decodeUploadObserved({
    ...rest,
    version: 2,
  });
  void _version;
  return Object.freeze({
    protocol: p,
    batchId: id(batchId),
    memberId: id(memberId),
    ...observed,
  });
}
