import type { PoolClient } from 'pg';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  discussionAncestorAuthorization,
  withDiscussionMediaMutation,
} from '../../media/discussion-ancestor-proof.js';
import { verifyDiscussionDeletionMedia } from '../../media/discussion-deletion-proof.js';
import type { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import type {
  ApprovedAsset,
  Authority,
  MediaAttachmentPort,
} from '../community-policy.js';
import type { CommunitySpace } from '../contracts.js';
import type {
  CommunityRepository,
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';

interface DeletionInput {
  repository: CommunityRepository;
  access: CommunityAccessService;
  media: MediaAttachmentPort | undefined;
  tx: PoolClient;
  actor: string;
  id: string;
  images: readonly ApprovedAsset[];
  target:
    | { kind: 'comment'; reference: StoredComment }
    | { kind: 'reply'; reference: StoredReply };
}

function unchangedContent(row: StoredComment | StoredReply) {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'deleted_at' && key !== 'local_deletion_transaction',
    ),
  );
}

interface DeletionParent {
  post: StoredPost;
  space: CommunitySpace;
  comment: StoredComment | null;
  authority: Authority;
}

/** The original delete qualifications are evaluated before mutation and again
 * for its unchanged ancestors. Only the same owner's own tombstone replaces
 * self visibility in the final phase; no target-reply visibility is added. */
export async function deleteDiscussionImages(
  input: DeletionInput,
): Promise<void> {
  const { repository, access, media, tx, actor, id, target } = input;
  const images = input.images.map((image) => Object.freeze({ ...image }));
  const reference = Object.freeze({ ...target.reference });
  if (!images.length || images.length > 3 || reference.account_id !== actor)
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  let transitioned = false;
  return withDiscussionMediaMutation(
    tx,
    { operation: 'delete', actor, kind: target.kind, id: reference.id, images },
    async () => {
      const current = await discussionAncestorAuthorization(
        tx,
        { operation: 'delete', actor, kind: target.kind, id: reference.id },
        async () => {
          let parent: DeletionParent;
          if (target.kind === 'comment') {
            const original = await access.accessiblePost(
              reference.post_id,
              actor,
              tx,
              true,
            );
            parent = {
              ...original,
              comment: null,
              authority: await access.authority(actor, original.space, tx),
            };
          } else {
            const original = await access.accessibleComment(
              target.reference.root_comment_id,
              actor,
              tx,
              true,
            );
            parent = { ...original, authority: original.authority! };
          }
          const { authority } = parent;
          // Preserve the original root-delete authority-before-row ordering.
          if (target.kind === 'comment') requireAction(authority, 'delete');
          const row =
            target.kind === 'comment'
              ? (
                  await tx.query<StoredComment>(
                    'SELECT * FROM whaleu_community.root_comments WHERE id=$1 FOR UPDATE',
                    [id],
                  )
                ).rows[0]
              : await repository.reply(id, tx, true);
          if (
            !row ||
            row.account_id !== actor ||
            row.post_id !== parent.post.id ||
            ownerFingerprint(unchangedContent(row)) !==
              ownerFingerprint(unchangedContent(reference)) ||
            (target.kind === 'reply' &&
              (!parent.comment ||
                (row as StoredReply).root_comment_id !== parent.comment.id))
          )
            throw new ApplicationError('MEDIA_UNAVAILABLE');
          const alreadyDeleted = !!row.deleted_at && !transitioned;
          if (!alreadyDeleted) {
            if (target.kind === 'reply') requireAction(authority, 'delete');
            if (transitioned) {
              if (!row.deleted_at)
                throw new ApplicationError('MEDIA_UNAVAILABLE');
              await requirePendingCleanup(tx, target.kind, row);
            } else if (
              !(await access.visible(actor, row, tx, 'list_projection'))
            )
              throw new ApplicationError(
                target.kind === 'comment'
                  ? 'COMMENT_NOT_FOUND'
                  : 'REPLY_NOT_FOUND',
              );
            const storedImages = await repository.images(
              target.kind,
              row.id,
              tx,
            );
            if (ownerFingerprint(storedImages) !== ownerFingerprint(images))
              throw new ApplicationError('MEDIA_UNAVAILABLE');
            await verifyDiscussionDeletionMedia(
              tx,
              target.kind,
              row.id,
              storedImages,
              transitioned,
            );
          }
          return { parent, authority, row, alreadyDeleted };
        },
        (value) =>
          ownerFingerprint({
            parent: value.parent,
            authority: value.authority,
            content: unchangedContent(value.row),
            alreadyDeleted: value.alreadyDeleted,
          }),
      );
      // A concurrent committed owner deletion retains the existing no-op result.
      if (current.alreadyDeleted) return;
      if (target.kind === 'comment')
        await tx.query(
          'DELETE FROM whaleu_community.comment_pins WHERE comment_id=$1',
          [id],
        );
      const table = target.kind === 'comment' ? 'root_comments' : 'replies';
      await tx.query(
        `UPDATE whaleu_community.${table} SET deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1`,
        [id],
      );
      if (!media) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await media.detach(target.kind, id, tx);
      await repository.event(
        `${target.kind}:${id}:deleted`,
        `${target.kind}_deleted`,
        id,
        tx,
        {
          experienceSourceVersion: 1,
          actorAccountId: actor,
          actorAuthorMode: current.row.author_mode,
          resourceAuthorMode: current.row.author_mode,
          postId: current.parent.post.id,
          rootCommentId:
            target.kind === 'comment'
              ? id
              : (current.row as StoredReply).root_comment_id,
          obligations: [
            'own_delete_deduction',
            'bounded_daily_refund',
            'discussion_ranking',
            'media_cleanup',
          ],
        },
      );
      transitioned = true;
    },
  );
}

/** 0078 creates this pending obligation in the same tombstone statement. The
 * synchronous delete must not impersonate bounded descendant enumeration. */
async function requirePendingCleanup(
  tx: PoolClient,
  kind: 'comment' | 'reply',
  row: StoredComment | StoredReply,
): Promise<void> {
  const rootId =
    kind === 'comment' ? row.id : (row as StoredReply).root_comment_id;
  const table = kind === 'comment' ? 'root_comments' : 'replies';
  const jobs = await tx.query(
    `SELECT j.id FROM whaleu_community.media_cleanup_jobs j
     JOIN whaleu_community.${table} c ON c.id=j.resource_id
     WHERE j.resource_kind=$1 AND j.resource_id=$2 AND j.post_id=$3
       AND j.root_comment_id=$4 AND j.source_deleted_at=$5
       AND j.source_deleted_at=c.deleted_at
       AND c.local_deletion_transaction=pg_current_xact_id()
       AND j.phase='self' AND j.cursor_id IS NULL AND j.detached_targets=0
       AND j.enumeration_completed_at IS NULL FOR SHARE OF j`,
    [kind, row.id, row.post_id, rootId, row.deleted_at],
  );
  if (jobs.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
}
