/** Private Community-owned evidence. Never serialize this record to a client. */
export interface SocialSource {
  id: string;
  kind: 'like' | 'save' | 'follow';
  actorAccountId: string;
  recipientAccountId: string;
  resourceKind: 'post' | 'comment' | 'reply' | 'profile';
  resourceId: string;
  postId: string | null;
  rootCommentId: string | null;
  replyId: string | null;
  targetReplyId: string | null;
  occurredAt: string;
  sourceEpochId: string;
}
export type SocialProjection =
  | {
      kind: 'like' | 'save';
      target: {
        type: 'community';
        postId: string;
        commentId: string | null;
        replyId: string | null;
      };
    }
  | {
      kind: 'follow';
      target: { type: 'profile'; profileId: string };
      actor: { profileId: string; displayName: string };
    };
