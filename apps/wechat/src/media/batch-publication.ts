import { sha256 } from 'js-sha256';
import { decodeCommentIntent } from '../community/contract';
import { decodeReplyIntent } from '../community/discussion-contract';
import type { PendingAttempt } from '../community/pending-attempt';
import type {
  BatchIdentity,
  DiscussionTarget,
  PublicationReference,
} from './batch-engine-contracts';
import { mediaPublicationReference } from './upload-runtime';
/** Original Community request hash, never the effective-author Review hash. */
export function batchPublicationReference(
  attempt: PendingAttempt,
): PublicationReference {
  if (attempt.operation === 'publish_post')
    return mediaPublicationReference(attempt);
  const body =
    attempt.operation === 'publish_comment'
      ? decodeCommentIntent(attempt.payload)
      : decodeReplyIntent(attempt.payload);
  const intent =
    attempt.operation === 'publish_comment'
      ? {
          postId: attempt.postId,
          text: body.text,
          imageAssetIds: body.imageAssetIds,
          authorMode: body.authorMode,
        }
      : {
          rootCommentId: attempt.rootCommentId.toLowerCase(),
          targetReplyId: decodeReplyIntent(attempt.payload).targetReplyId,
          text: body.text,
          imageAssetIds: body.imageAssetIds,
          authorMode: body.authorMode,
        };
  return Object.freeze({
    clientRequestId: body.clientRequestId,
    operation: attempt.operation,
    intentHash: sha256(
      JSON.stringify({ operation: attempt.operation, intent }),
    ),
  });
}
export function discussionTarget(
  attempt: PendingAttempt,
): DiscussionTarget | undefined {
  return attempt.operation === 'publish_post'
    ? undefined
    : attempt.operation === 'publish_comment'
      ? { kind: 'comment', postId: attempt.postId }
      : {
          kind: 'reply',
          rootCommentId: attempt.rootCommentId,
          targetReplyId: attempt.payload.targetReplyId,
        };
}
export function identityMatchesAttempt(
  identity: BatchIdentity,
  attempt: PendingAttempt,
  resolvedPostId?: string | null,
): boolean {
  if (identity.version === 1)
    return (
      attempt.operation === 'publish_post' &&
      identity.spaceId === attempt.payload.spaceId
    );
  if (
    attempt.operation === 'publish_post' ||
    !resolvedPostId ||
    attempt.postId !== resolvedPostId
  )
    return false;
  const target = identity.target;
  return target.kind === 'comment'
    ? attempt.operation === 'publish_comment' &&
        target.postId === attempt.postId
    : attempt.operation === 'publish_reply' &&
        target.rootCommentId === attempt.rootCommentId &&
        target.targetReplyId === attempt.payload.targetReplyId;
}
export function publicationKind(
  reference: PublicationReference,
): 'post' | 'comment' | 'reply' {
  return reference.operation === 'publish_post'
    ? 'post'
    : reference.operation === 'publish_comment'
      ? 'comment'
      : 'reply';
}
