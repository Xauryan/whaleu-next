import { isRecord } from '../api/errors';
import { sha256 } from 'js-sha256';
import { exact } from '../community/contract';
import { invalidRating } from './contract';
import { canonicalRatingScopedJson } from './scoped-contract';
import {
  discussionMediaId as id,
  discussionMediaDigest as digest,
  decodeRatingDiscussionMediaCommandContext,
  type RatingDiscussionMediaCommandContext,
} from './discussion-media-contract';
export const RATINGS_DISCUSSION_MEDIA_PROTOCOL =
  'ratings-discussion-media-v1' as const;
interface Target {
  readonly targetId: string;
  readonly expectedTargetRevision: string;
  readonly expectedDefinitionRevision: string;
  readonly expectedContentVersion: number;
}
export type RatingDiscussionBatchTarget = Target &
  (
    | { readonly kind: 'root' }
    | {
        readonly kind: 'reply';
        readonly rootId: string;
        readonly expectedRootRevision: string;
        readonly replyTo: {
          readonly replyId: string;
          readonly expectedRevision: string;
        } | null;
      }
  );
export interface RatingDiscussionBatchIdentity {
  readonly protocol: typeof RATINGS_DISCUSSION_MEDIA_PROTOCOL;
  readonly batchRequestId: string;
  readonly commandRequestId: string;
  readonly draftRevision: string;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly context: RatingDiscussionMediaCommandContext;
  readonly target: RatingDiscussionBatchTarget;
}
export function decodeRatingDiscussionBatchIdentity(
  raw: unknown,
): RatingDiscussionBatchIdentity {
  exact(raw, [
    'protocol',
    'batchRequestId',
    'commandRequestId',
    'draftRevision',
    'categoryId',
    'expectedCategoryRevision',
    'context',
    'target',
  ]);
  if (raw.protocol !== RATINGS_DISCUSSION_MEDIA_PROTOCOL) invalidRating();
  if (!isRecord(raw.target)) invalidRating();
  exact(raw.target, [
    'kind',
    'targetId',
    'expectedTargetRevision',
    'expectedDefinitionRevision',
    'expectedContentVersion',
    ...(raw.target?.kind === 'reply'
      ? ['rootId', 'expectedRootRevision', 'replyTo']
      : []),
  ]);
  const t = raw.target;
  if (
    (t.kind !== 'root' && t.kind !== 'reply') ||
    typeof t.expectedContentVersion !== 'number' ||
    !Number.isSafeInteger(t.expectedContentVersion) ||
    t.expectedContentVersion < 1 ||
    t.expectedContentVersion > 2147483647
  )
    invalidRating();
  const base = {
    targetId: id(t.targetId),
    expectedTargetRevision: id(t.expectedTargetRevision),
    expectedDefinitionRevision: id(t.expectedDefinitionRevision),
    expectedContentVersion: t.expectedContentVersion,
  };
  let target: RatingDiscussionBatchTarget;
  if (t.kind === 'root') target = Object.freeze({ ...base, kind: 'root' });
  else {
    const rootId = id(t.rootId);
    let replyTo: {
      readonly replyId: string;
      readonly expectedRevision: string;
    } | null = null;
    if (t.replyTo !== null) {
      exact(t.replyTo, ['replyId', 'expectedRevision']);
      const replyId = id(t.replyTo.replyId);
      if (replyId === rootId) invalidRating();
      replyTo = Object.freeze({
        replyId,
        expectedRevision: id(t.replyTo.expectedRevision),
      });
    }
    target = Object.freeze({
      ...base,
      kind: 'reply',
      rootId,
      expectedRootRevision: id(t.expectedRootRevision),
      replyTo,
    });
  }
  const batchRequestId = id(raw.batchRequestId),
    commandRequestId = id(raw.commandRequestId);
  if (batchRequestId === commandRequestId) invalidRating();
  return Object.freeze({
    protocol: RATINGS_DISCUSSION_MEDIA_PROTOCOL,
    batchRequestId,
    commandRequestId,
    draftRevision: id(raw.draftRevision),
    categoryId: id(raw.categoryId),
    expectedCategoryRevision: id(raw.expectedCategoryRevision),
    context: decodeRatingDiscussionMediaCommandContext(raw.context),
    target,
  });
}
export function ratingDiscussionBatchIdentityHash(
  actorAccountId: string,
  raw: RatingDiscussionBatchIdentity,
): string {
  return sha256(
    'whaleu:ratings-discussion-media-batch:v1\n' +
      canonicalRatingScopedJson({
        actorAccountId: id(actorAccountId),
        identity: decodeRatingDiscussionBatchIdentity(raw),
      }),
  );
}
export interface RatingDiscussionMember {
  readonly memberId: string;
  readonly clientRequestId: string;
  readonly sourceSlot: number;
  readonly requestHash: string;
  readonly declaration: {
    readonly mime: 'image/jpeg' | 'image/png';
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly state: 'pending' | 'unknown' | 'ready' | 'retiring' | 'retired';
  readonly assetId: string | null;
  readonly manifestDigest: string | null;
}
export function decodeRatingDiscussionMember(
  raw: unknown,
): RatingDiscussionMember {
  exact(raw, [
    'memberId',
    'clientRequestId',
    'sourceSlot',
    'requestHash',
    'declaration',
    'state',
    'assetId',
    'manifestDigest',
  ]);
  exact(raw.declaration, ['mime', 'bytes', 'sha256']);
  if (
    typeof raw.sourceSlot !== 'number' ||
    !Number.isSafeInteger(raw.sourceSlot) ||
    raw.sourceSlot < 0 ||
    raw.sourceSlot > 127 ||
    typeof raw.declaration.bytes !== 'number' ||
    !Number.isSafeInteger(raw.declaration.bytes) ||
    raw.declaration.bytes < 1 ||
    raw.declaration.bytes > 5 * 1024 * 1024 ||
    (raw.declaration.mime !== 'image/jpeg' &&
      raw.declaration.mime !== 'image/png') ||
    (raw.state !== 'pending' &&
      raw.state !== 'unknown' &&
      raw.state !== 'ready' &&
      raw.state !== 'retiring' &&
      raw.state !== 'retired')
  )
    invalidRating();
  const assetId = raw.assetId === null ? null : id(raw.assetId),
    manifestDigest =
      raw.manifestDigest === null ? null : digest(raw.manifestDigest);
  if (
    (assetId === null) !== (manifestDigest === null) ||
    (raw.state === 'ready' && assetId === null)
  )
    invalidRating();
  return Object.freeze({
    memberId: id(raw.memberId),
    clientRequestId: id(raw.clientRequestId),
    sourceSlot: raw.sourceSlot,
    requestHash: digest(raw.requestHash),
    declaration: Object.freeze({
      mime: raw.declaration.mime,
      bytes: raw.declaration.bytes,
      sha256: digest(raw.declaration.sha256),
    }),
    state: raw.state,
    assetId,
    manifestDigest,
  });
}
export function ratingDiscussionMemberRequestHash(
  actorAccountId: string,
  batchId: string,
  batchIdentityHash: string,
  member: Pick<
    RatingDiscussionMember,
    'memberId' | 'clientRequestId' | 'sourceSlot' | 'declaration'
  >,
): string {
  return sha256(
    'whaleu:ratings-discussion-media-member:v1\n' +
      canonicalRatingScopedJson({
        actorAccountId: id(actorAccountId),
        member: {
          protocol: RATINGS_DISCUSSION_MEDIA_PROTOCOL,
          clientRequestId: id(member.clientRequestId),
          batchId: id(batchId),
          batchIdentityHash: digest(batchIdentityHash),
          memberId: id(member.memberId),
          sourceSlot: member.sourceSlot,
          declaration: member.declaration,
        },
      }),
  );
}
export function ratingDiscussionSealedPlanHash(
  batchId: string,
  batchIdentityHash: string,
  orderedMemberIds: readonly string[],
  members: readonly RatingDiscussionMember[],
): string {
  if (
    orderedMemberIds.length < 1 ||
    orderedMemberIds.length > 9 ||
    new Set(orderedMemberIds).size !== orderedMemberIds.length
  )
    invalidRating();
  const orderedMembers = orderedMemberIds.map((memberId, ordinal) => {
    const matches = members.filter((member) => member.memberId === memberId);
    if (matches.length !== 1 || matches[0]!.state !== 'ready') invalidRating();
    const member = matches[0]!;
    return {
      ordinal,
      memberId: id(memberId),
      assetId: id(member.assetId),
      manifestDigest: digest(member.manifestDigest),
    };
  });
  if (
    new Set(orderedMembers.map((member) => member.assetId)).size !==
    orderedMembers.length
  )
    invalidRating();
  return sha256(
    'whaleu:ratings-discussion-media-plan:v1\n' +
      canonicalRatingScopedJson({
        batchId: id(batchId),
        batchIdentityHash: digest(batchIdentityHash),
        orderedMembers,
      }),
  );
}
