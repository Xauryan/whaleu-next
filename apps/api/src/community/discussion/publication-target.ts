import { discussionAncestorAuthorization } from '../../media/discussion-ancestor-proof.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type {
  CommunityRepository,
  StoredComment,
} from '../community.repository.js';
import {
  requireCommentControl,
  requirePublication,
} from '../community-policy.js';
import type { AuthorMode } from '../contracts.js';

export type DiscussionPublicationTarget =
  | { kind: 'comment'; postId: string }
  | { kind: 'reply'; rootCommentId: string; targetReplyId: string | null };
/** Shared original publication authority. Routing reads do not lock children;
 * actual locks are post -> root -> target before any Media batch/intent. */
export async function authorizeDiscussionPublication(
  access: CommunityAccessService,
  repository: CommunityRepository,
  actor: string,
  target: DiscussionPublicationTarget,
  tx: PoolClient,
  authorMode: AuthorMode = 'named',
) {
  const immutableTarget = Object.freeze({ ...target });
  return discussionAncestorAuthorization(
    tx,
    { actor, target: immutableTarget, authorMode },
    () =>
      authorizeDiscussionPublicationCurrent(
        access,
        repository,
        actor,
        immutableTarget,
        tx,
        authorMode,
      ),
    (value) =>
      JSON.stringify({
        postId: value.post.id,
        spaceId: value.space.id,
        rootId: value.root?.id ?? null,
        scope: value.authority.publicationScope,
        mode: value.mode,
        targetAccount: value.targetAccount,
      }),
  );
}
async function authorizeDiscussionPublicationCurrent(
  access: CommunityAccessService,
  repository: CommunityRepository,
  actor: string,
  target: DiscussionPublicationTarget,
  tx: PoolClient,
  authorMode: AuthorMode,
) {
  const parent =
    target.kind === 'comment'
      ? await access.accessiblePost(target.postId, actor, tx, true)
      : await access.accessibleComment(target.rootCommentId, actor, tx, true);
  const { post, space } = parent;
  const root: StoredComment | null =
    target.kind === 'reply'
      ? (
          parent as Awaited<
            ReturnType<CommunityAccessService['accessibleComment']>
          >
        ).comment
      : null;
  await access.interaction(actor, post, tx);
  if (root) await access.interaction(actor, root, tx);
  const authority = await access.authority(actor, space, tx, {
    publication: true,
    targetPostId: post.id,
    managementRequired:
      post.comments_policy === 'restricted' && post.account_id !== actor,
  });
  const mode =
    post.author_mode === 'anonymous' && post.account_id === actor
      ? 'anonymous'
      : authorMode;
  requirePublication(
    authority,
    space,
    post.category,
    mode,
    'publish_comment',
    post.author_mode,
  );
  requireCommentControl(
    authority,
    post.account_id === actor,
    post.comments_policy === 'restricted',
  );
  let targetAccount = root?.account_id ?? post.account_id;
  if (target.kind === 'reply' && target.targetReplyId) {
    const reply = await repository.reply(target.targetReplyId, tx, true);
    if (
      !root ||
      reply.post_id !== post.id ||
      reply.root_comment_id !== root.id ||
      !(await access.visible(actor, reply, tx, 'list_projection'))
    )
      throw new ApplicationError('REPLY_NOT_FOUND');
    await access.interaction(actor, reply, tx);
    targetAccount = reply.account_id;
  }
  return { post, space, root, authority, mode, targetAccount };
}
