import type {
  PrepareMediaV4Input,
  MediaBatchIdentity as DiscussionMediaBatchIdentity,
} from '../../media/contracts-v4.js';
import { authorizeDiscussionPublication } from '../discussion/publication-target.js';
import type { DiscussionPublicationTarget } from '../discussion/publication-target.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PrepareMediaV3Input } from '../../media/contracts-v3.js';
import type { PrepareMediaV2Input } from '../../media/contracts-v2.js';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { requireAction } from '../community-policy.js';
import { contentScopeSchema } from '../content-review/contracts.js';
import type { PublicationScope } from '../content-review/contracts.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type { CommunityRepository } from '../community.repository.js';
import type {
  AuthorizedMediaDraft,
  MediaDraftOwnerPort,
  PrepareMediaInput,
} from '../../media/prepare-scope.js';
import type {
  MediaOwnerReadPort,
  OwnerReadRequest,
} from '../../media/owner-proof.js';

interface DraftRow {
  id: string;
  actor_id: string;
  client_draft_id: string;
  space_id: string;
  scope_revision: string;
  expires_at: Date;
  protocol_version: 1 | 2;
  discussion_target: DiscussionPublicationTarget | null;
  ancestor_post_id: string | null;
}
interface DraftFact {
  id: string;
  actor: string;
  space: string;
  revision: string;
  expires: number;
}
/** Community implementation, deliberately not registered in normal AppModule.
 * Tests must inject this real owner alongside test-only storage/issuer wiring. */
export class CommunityMediaOwner
  implements MediaDraftOwnerPort, MediaOwnerReadPort
{
  readonly ownerKind = 'community' as const;
  private readonly proof: RequiredTransactionProof<DraftFact> = {
    maximumFacts: 64,
    failureCode: 'MEDIA_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
        await read.query(
          'LOCK TABLE whaleu_community.media_drafts IN SHARE MODE NOWAIT',
        );
        const rows = (
          await read.query<DraftRow>(
            'SELECT * FROM whaleu_community.media_drafts WHERE id=ANY($1::uuid[])',
            [facts.map((f) => f.id)],
          )
        ).rows;
        const current = new Map(rows.map((r) => [r.id, r]));
        for (const fact of facts) {
          const row = current.get(fact.id);
          if (
            !row ||
            row.actor_id !== fact.actor ||
            row.space_id !== fact.space ||
            row.scope_revision !== fact.revision ||
            row.expires_at.getTime() !== fact.expires
          )
            throw new ApplicationError('MEDIA_UNAVAILABLE');
        }
      }),
  };
  constructor(
    private readonly access: CommunityAccessService,
    private readonly community: CommunityRepository,
  ) {}
  static scopeRevision(spaceId: string, scope: PublicationScope): string {
    return createHash('sha256')
      .update('whaleu-community-media-draft:v1\n')
      .update(
        JSON.stringify({ spaceId, scope: contentScopeSchema.parse(scope) }),
      )
      .digest('hex');
  }
  static discussionScopeRevision(
    spaceId: string,
    scope: PublicationScope,
    postId: string,
    target: DiscussionPublicationTarget,
  ): string {
    return createHash('sha256')
      .update('whaleu-community-media-draft:v2\n')
      .update(
        JSON.stringify({
          spaceId,
          scope: contentScopeSchema.parse(scope),
          postId,
          target,
        }),
      )
      .digest('hex');
  }
  async authorizePrepare(
    actor: string,
    input:
      | PrepareMediaInput
      | PrepareMediaV2Input
      | PrepareMediaV3Input
      | PrepareMediaV4Input,
    tx: PoolClient,
  ): Promise<AuthorizedMediaDraft> {
    const discussion =
      'protocolVersion' in input && input.protocolVersion === 4
        ? await authorizeDiscussionPublication(
            this.access,
            this.community,
            actor,
            input.batchIdentity.target,
            tx,
          )
        : null;
    const space =
      discussion?.space ?? (await this.community.space(input.spaceId, tx));
    if (space.id !== input.spaceId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const authority =
      discussion?.authority ??
      (await this.access.authority(actor, space, tx, { publication: true }));
    if (!discussion) requireAction(authority, 'publish_post');
    if (!authority.publicationScope)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const target =
      'protocolVersion' in input && input.protocolVersion === 4
        ? input.batchIdentity.target
        : null;
    const revision =
      discussion && target
        ? CommunityMediaOwner.discussionScopeRevision(
            space.id,
            authority.publicationScope,
            discussion.post.id,
            target,
          )
        : CommunityMediaOwner.scopeRevision(
            space.id,
            authority.publicationScope,
          );
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:community-media-draft:v1:${actor}:${input.draftId}`,
    ]);
    let draft = (
      await tx.query<DraftRow>(
        'SELECT * FROM whaleu_community.media_drafts WHERE actor_id=$1 AND client_draft_id=$2 FOR SHARE',
        [actor, input.draftId],
      )
    ).rows[0];
    if (!draft) {
      draft = target
        ? (
            await tx.query<DraftRow>(
              `INSERT INTO whaleu_community.media_drafts(id,actor_id,client_draft_id,space_id,scope_revision,expires_at,protocol_version,discussion_target,ancestor_post_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '24 hours',$6,$7::jsonb,$8) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.draftId,
                space.id,
                revision,
                2,
                JSON.stringify(target),
                discussion!.post.id,
              ],
            )
          ).rows[0]
        : (
            await tx.query<DraftRow>(
              `INSERT INTO whaleu_community.media_drafts(id,actor_id,client_draft_id,space_id,scope_revision,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '24 hours') RETURNING *`,
              [randomUUID(), actor, input.draftId, space.id, revision],
            )
          ).rows[0];
    }
    if (
      !draft ||
      draft.space_id !== space.id ||
      draft.scope_revision !== revision ||
      draft.protocol_version !== (target ? 2 : 1) ||
      (target
        ? !draft.discussion_target ||
          draft.discussion_target.kind !== target.kind ||
          (target.kind === 'comment'
            ? draft.discussion_target.kind !== 'comment' ||
              draft.discussion_target.postId !== target.postId
            : draft.discussion_target.kind !== 'reply' ||
              draft.discussion_target.rootCommentId !== target.rootCommentId ||
              draft.discussion_target.targetReplyId !== target.targetReplyId)
        : draft.discussion_target !== null) ||
      draft.ancestor_post_id !== (discussion?.post.id ?? null)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.requireDraft(draft.id, actor, space.id, revision, tx);
    return {
      actorAccountId: actor,
      serverScopeId: draft.id,
      scopeRevision: revision,
      ownerKind: 'community',
      resourceKind: target?.kind ?? 'post',
      targetKind: 'draft',
      contentVersion: 1,
      audience: 'content-gated',
      purpose: target
        ? target.kind === 'comment'
          ? 'community-comment-image'
          : 'community-reply-image'
        : 'community-post-image',
      slot: 'images',
      ordinal: input.ordinal,
    };
  }
  async resolvedDiscussionPostId(
    actor: string,
    scopeId: string,
    revision: string,
    identity: DiscussionMediaBatchIdentity,
    tx: PoolClient,
  ): Promise<string> {
    // The draft definition is immutable. This historical lookup deliberately
    // does not test current ancestor visibility or renew its publication expiry.
    const row = (
      await tx.query<DraftRow>(
        'SELECT * FROM whaleu_community.media_drafts WHERE id=$1 AND actor_id=$2',
        [scopeId, actor],
      )
    ).rows[0];
    const target = identity.target;
    if (
      !row ||
      row.protocol_version !== 2 ||
      row.client_draft_id !== identity.draftId ||
      row.space_id !== identity.spaceId ||
      row.scope_revision !== revision ||
      !row.ancestor_post_id ||
      !row.discussion_target ||
      row.discussion_target.kind !== target.kind ||
      (target.kind === 'comment'
        ? row.discussion_target.kind !== 'comment' ||
          row.discussion_target.postId !== target.postId ||
          row.ancestor_post_id !== target.postId
        : row.discussion_target.kind !== 'reply' ||
          row.discussion_target.rootCommentId !== target.rootCommentId ||
          row.discussion_target.targetReplyId !== target.targetReplyId)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return row.ancestor_post_id;
  }
  async requireDraft(
    id: string,
    actor: string,
    space: string,
    revision: string,
    tx: PoolClient,
  ): Promise<void> {
    enableRequiredTransactionProof(tx, this.proof);
    const row = (
      await tx.query<DraftRow>(
        'SELECT * FROM whaleu_community.media_drafts WHERE id=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    if (
      !row ||
      row.actor_id !== actor ||
      row.space_id !== space ||
      row.scope_revision !== revision ||
      now === undefined ||
      row.expires_at.getTime() <= now
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const fact = Object.freeze({
      id,
      actor,
      space,
      revision,
      expires: row.expires_at.getTime(),
    });
    registerRequiredTransactionFact(tx, this.proof, JSON.stringify(fact), fact);
    registerTransactionDeadline(tx, fact.expires, 'MEDIA_UNAVAILABLE');
  }
  async resolveAuthorizedContentMedia(
    request: OwnerReadRequest,
    tx: PoolClient,
  ): Promise<readonly { assetId: string; digest: string }[]> {
    // authorizeCurrent has already validated the full approved definition and
    // enrolled its final proof. Re-read the owner-owned list under the same
    // transaction; its positions, not whatever bindings remain, are authority.
    const kind = request.parent.resourceKind;
    if (
      request.parent.ownerKind !== 'community' ||
      !['post', 'comment', 'reply'].includes(kind)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const limit = kind === 'post' ? 9 : 3;
    const rows = (
      await tx.query<{ assetId: string; digest: string; position: number }>(
        `SELECT asset_id AS "assetId",digest,position FROM whaleu_community.${kind}_images WHERE ${kind}_id=$1 ORDER BY position LIMIT $2 FOR SHARE`,
        [request.parent.resourceId, limit + 1],
      )
    ).rows;
    if (
      rows.length > limit ||
      rows.some((image, index) => image.position !== index)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return rows.map(({ assetId, digest }) => ({ assetId, digest }));
  }
  async authorizeCurrent(
    request: OwnerReadRequest,
    tx: PoolClient,
  ): Promise<void> {
    const { resourceKind: kind, resourceId: id } = request.parent;
    if (
      request.parent.ownerKind !== 'community' ||
      !['post', 'comment', 'reply'].includes(kind) ||
      request.parent.contentVersion !== 1 ||
      request.audience !== 'content-gated'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (kind === 'post' && request.purpose !== 'list-projection') {
      await this.access.accessiblePost(id, request.viewerAccountId, tx);
      return;
    }
    // Resolve routing hints without child locks, then acquire only canonical
    // ancestors. A reply's target is a degradable reference, never its ancestor.
    const replyHint =
      kind === 'reply' ? await this.community.reply(id, tx) : null;
    const rootHint =
      kind === 'comment'
        ? await this.community.comment(id, tx)
        : replyHint
          ? await this.community.comment(replyHint.root_comment_id, tx)
          : null;
    const post = await this.community.post(rootHint?.post_id ?? id, tx);
    await this.community.space(post.space_id, tx);
    if (
      !(await this.access.visible(
        request.viewerAccountId,
        post,
        tx,
        'list_projection',
      ))
    )
      throw new ApplicationError('POST_NOT_FOUND');
    if (rootHint) {
      const root = await this.community.comment(rootHint.id, tx, true);
      if (
        root.post_id !== post.id ||
        !(await this.access.visible(
          request.viewerAccountId,
          root,
          tx,
          'list_projection',
        ))
      )
        throw new ApplicationError('COMMENT_NOT_FOUND');
      if (replyHint) {
        const reply = await this.community.reply(replyHint.id, tx, true);
        if (
          reply.post_id !== post.id ||
          reply.root_comment_id !== root.id ||
          !(await this.access.visible(
            request.viewerAccountId,
            reply,
            tx,
            'list_projection',
          ))
        )
          throw new ApplicationError('REPLY_NOT_FOUND');
      }
    }
  }
}
