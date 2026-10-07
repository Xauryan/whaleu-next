import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunitySerializer } from './community-serialization.js';
import { SavedRepository } from './saved/repository.js';
import type { AuthorView, MediaView } from './contracts.js';
export interface CommunityUpdateTarget {
  postId: string;
  commentId: string;
  replyId: string | null;
}
export interface CommunityUpdateRecipient {
  accountId: string;
  reason: 'direct' | 'saved';
  saveEpochId: string | null;
}
export interface CommunityUpdateEvent {
  id: string;
  kind: 'root' | 'reply';
  actorAccountId: string;
  occurredAt: string;
  sequence: string;
  target: CommunityUpdateTarget;
  recipients: CommunityUpdateRecipient[];
}
export type UpdateEligibility =
  | {
      outcome: 'eligible';
      preview: { text: string; images: MediaView[]; author: AuthorView };
      externalEnabled: boolean;
    }
  | { outcome: 'suppressed' | 'unavailable'; code: string };
/** This is the only notifications-to-community boundary. It owns source-event
 * interpretation, membership epochs, current parent/child access and personas.
 * Notifications must never query community/private identity tables itself. */
@Injectable()
export class CommunityUpdatesFacade {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(SavedRepository) private readonly saved: SavedRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  /** The source service enrolls automatic eligibility only for newly committed
   * publications from an explicitly automatic-configured application. */
  async enrolledAfter(after: string, limit: number, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('community-update-enrollment',0))",
    );
    return (
      await tx.query<{ event_id: string; enrollment_order: string }>(
        'SELECT event_id,enrollment_order FROM whaleu_community.local_update_events WHERE enrollment_order>$1 AND automatic_eligible ORDER BY enrollment_order LIMIT $2',
        [after, limit],
      )
    ).rows;
  }
  async event(
    id: string,
    tx: PoolClient,
  ): Promise<
    | { status: 'ready'; event: CommunityUpdateEvent }
    | { status: 'missing' | 'ignored' | 'unavailable'; code: string }
  > {
    const row = (
      await tx.query<{
        event_type: string;
        event_key: string;
        resource_id: string;
        context: Record<string, unknown>;
      }>(
        'SELECT event_type,event_key,resource_id,context FROM whaleu_community.outbox WHERE id=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
    if (!row) return { status: 'missing', code: 'event_missing' };
    if (!['comment_created', 'reply_created'].includes(row.event_type))
      return { status: 'ignored', code: 'unsupported_obligation' };
    if (
      !(
        await tx.query(
          "SELECT 1 FROM whaleu_community.local_update_events WHERE event_id=$1 AND origin='local_publication'",
          [id],
        )
      ).rowCount
    )
      return { status: 'unavailable', code: 'local_provenance_unavailable' };
    try {
      const kind = row.event_type === 'comment_created' ? 'root' : 'reply';
      // Resolve ancestry without child locks, then use the common parent-first guard.
      const reference =
        kind === 'root'
          ? await this.repository.comment(row.resource_id, tx)
          : await this.repository.reply(row.resource_id, tx);
      const post = await this.repository.post(reference.post_id, tx);
      const content =
        kind === 'root'
          ? await this.repository.comment(row.resource_id, tx, true)
          : await this.repository.reply(row.resource_id, tx, true);
      const root =
        kind === 'root'
          ? content
          : await this.repository.comment(
              (content as import('./community.repository.js').StoredReply)
                .root_comment_id,
              tx,
              true,
            );
      const reply =
        kind === 'reply'
          ? (content as import('./community.repository.js').StoredReply)
          : null;
      const obligations = row.context['obligations'];
      const required =
        kind === 'root'
          ? [
              'post_author_notification',
              'eligible_saved_subscriber_notification',
            ]
          : ['reply_recipient_notification'];
      if (
        row.event_key !==
          `${kind === 'root' ? 'comment' : 'reply'}:${content.id}:created` ||
        row.context['actorAccountId'] !== content.account_id ||
        row.context['postId'] !== post.id ||
        !Array.isArray(obligations) ||
        required.some((x) => !obligations.includes(x)) ||
        (reply &&
          (row.context['rootCommentId'] !== root.id ||
            row.context['targetReplyId'] !== reply.target_reply_id))
      )
        return { status: 'unavailable', code: 'event_provenance_unavailable' };
      const sequence =
        reply?.sequence ??
        (
          await tx.query<{ interaction_sequence: string }>(
            'SELECT interaction_sequence FROM whaleu_community.root_comments WHERE id=$1',
            [root.id],
          )
        ).rows[0]!.interaction_sequence;
      const direct = new Set<string>();
      if (!reply) direct.add(post.account_id);
      else {
        direct.add(root.account_id);
        if (reply.target_reply_id)
          direct.add(
            (await this.repository.reply(reply.target_reply_id, tx, true))
              .account_id,
          );
      }
      direct.delete(content.account_id);
      const expected = [...direct].sort();
      const supplied = row.context['recipientAccountIds'];
      if (
        !Array.isArray(supplied) ||
        supplied.some((x) => typeof x !== 'string') ||
        JSON.stringify([...supplied].sort()) !== JSON.stringify(expected)
      )
        return { status: 'unavailable', code: 'event_provenance_unavailable' };
      const recipients: CommunityUpdateRecipient[] = expected.map(
        (accountId) => ({ accountId, reason: 'direct', saveEpochId: null }),
      );
      if (!reply) {
        const epochs = await this.saved.epochsAt(post.id, sequence, tx);
        if (epochs.length > 1024)
          return {
            status: 'unavailable',
            code: 'recipient_capacity_unavailable',
          };
        for (const epoch of epochs) {
          if (
            epoch.account_id === content.account_id ||
            epoch.account_id === post.account_id
          )
            continue;
          recipients.push({
            accountId: epoch.account_id,
            reason: 'saved',
            saveEpochId: epoch.id,
          });
        }
      }
      return {
        status: 'ready',
        event: {
          id,
          kind,
          actorAccountId: content.account_id,
          occurredAt: content.created_at.toISOString(),
          sequence,
          target: {
            postId: post.id,
            commentId: root.id,
            replyId: reply?.id ?? null,
          },
          recipients: recipients.sort((a, b) =>
            a.accountId.localeCompare(b.accountId),
          ),
        },
      };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        ['POST_NOT_FOUND', 'COMMENT_NOT_FOUND', 'REPLY_NOT_FOUND'].includes(
          error.code,
        )
      )
        return { status: 'unavailable', code: 'event_target_unavailable' };
      throw error;
    }
  }
  /** materialization checks the same historical epoch; reads retain notices after
   * unsave but always recheck current preference/access, never a frozen preview. */
  async eligible(
    target: CommunityUpdateTarget,
    recipient: CommunityUpdateRecipient,
    tx: PoolClient,
    eventSequence?: string,
  ): Promise<UpdateEligibility> {
    try {
      if (!(await this.identity.activeAccount(recipient.accountId, tx)))
        return { outcome: 'suppressed', code: 'recipient_inactive' };
      const { post, space } = await this.access.accessiblePost(
        target.postId,
        recipient.accountId,
        tx,
      );
      // Require the current read authority to be available; do not impose a phone,
      // student, publication-category, identity-campus or comments-open write gate.
      const authority = await this.access.authorization.resolve(
        recipient.accountId,
        space,
        tx,
      );
      if (authority.kind === 'deny')
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      if (authority.kind === 'unavailable')
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      const root = await this.repository.comment(target.commentId, tx, true);
      if (
        root.post_id !== post.id ||
        !(await this.access.visible(recipient.accountId, root, tx))
      )
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      const content = target.replyId
        ? await this.repository.reply(target.replyId, tx, true)
        : root;
      if (
        content.post_id !== post.id ||
        (target.replyId &&
          (content as import('./community.repository.js').StoredReply)
            .root_comment_id !== root.id) ||
        !(await this.access.visible(recipient.accountId, content, tx))
      )
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      for (const accountId of [
        ...new Set([post.account_id, root.account_id, content.account_id]),
      ].sort())
        if (!(await this.identity.activeAccount(accountId, tx)))
          return { outcome: 'suppressed', code: 'target_inaccessible' };
      const preferences = await this.saved.preferences(
        recipient.accountId,
        post.id,
        tx,
      );
      if (recipient.reason === 'saved') {
        if (
          eventSequence !== undefined &&
          (!recipient.saveEpochId ||
            (await this.saved.own(recipient.accountId, post.id, tx))
              ?.epoch_id !== recipient.saveEpochId)
        )
          return { outcome: 'suppressed', code: 'saved_epoch_ended' };
        if (
          eventSequence !== undefined &&
          !(await this.saved.updatesAllowedSince(
            recipient.accountId,
            post.id,
            eventSequence,
            tx,
          ))
        )
          return {
            outcome: 'suppressed',
            code: 'saved_updates_muted_since_event',
          };
        if (preferences?.saved_updates_enabled === false)
          return { outcome: 'suppressed', code: 'saved_updates_disabled' };
      }
      return {
        outcome: 'eligible',
        externalEnabled: preferences?.external_updates_enabled ?? true,
        preview: {
          text: content.text,
          images: await this.serializer.images(
            target.replyId ? 'reply' : 'comment',
            content.id,
            tx,
          ),
          author: await this.serializer.author(content, post, tx),
        },
      };
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      if (
        [
          'POST_NOT_FOUND',
          'COMMENT_NOT_FOUND',
          'REPLY_NOT_FOUND',
          'COMMUNITY_SCOPE_UNAVAILABLE',
          'COMMUNITY_ACTION_RESTRICTED',
        ].includes(error.code)
      )
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      if (error.code === 'COMMUNITY_UNAVAILABLE')
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      if (error.code === 'MEDIA_UNAVAILABLE')
        return { outcome: 'unavailable', code: 'media_unavailable' };
      throw error;
    }
  }
}
