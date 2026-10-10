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
  async authorizePrepare(
    actor: string,
    input: PrepareMediaInput | PrepareMediaV2Input | PrepareMediaV3Input,
    tx: PoolClient,
  ): Promise<AuthorizedMediaDraft> {
    const space = await this.community.space(input.spaceId, tx);
    const authority = await this.access.authority(actor, space, tx, {
      publication: true,
    });
    requireAction(authority, 'publish_post');
    if (!authority.publicationScope)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const revision = CommunityMediaOwner.scopeRevision(
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
      draft = (
        await tx.query<DraftRow>(
          `INSERT INTO whaleu_community.media_drafts(id,actor_id,client_draft_id,space_id,scope_revision,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '24 hours') RETURNING *`,
          [randomUUID(), actor, input.draftId, space.id, revision],
        )
      ).rows[0];
    }
    if (
      !draft ||
      draft.space_id !== space.id ||
      draft.scope_revision !== revision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.requireDraft(draft.id, actor, space.id, revision, tx);
    return {
      actorAccountId: actor,
      serverScopeId: draft.id,
      scopeRevision: revision,
      ownerKind: 'community',
      resourceKind: 'post',
      targetKind: 'draft',
      contentVersion: 1,
      audience: 'content-gated',
      purpose: 'community-post-image',
      slot: 'images',
      ordinal: input.ordinal,
    };
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
    const rows = (
      await tx.query<{ assetId: string; digest: string; position: number }>(
        'SELECT asset_id AS "assetId",digest,position FROM whaleu_community.post_images WHERE post_id=$1 ORDER BY position LIMIT 10 FOR SHARE',
        [request.parent.resourceId],
      )
    ).rows;
    if (
      request.parent.ownerKind !== 'community' ||
      request.parent.resourceKind !== 'post' ||
      rows.length > 9 ||
      rows.some((image, index) => image.position !== index)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return rows.map(({ assetId, digest }) => ({ assetId, digest }));
  }
  async authorizeCurrent(
    request: OwnerReadRequest,
    tx: PoolClient,
  ): Promise<void> {
    if (
      request.parent.ownerKind !== 'community' ||
      request.parent.resourceKind !== 'post' ||
      request.parent.contentVersion !== 1 ||
      request.audience !== 'content-gated'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (request.purpose === 'list-projection') {
      const post = await this.community.post(request.parent.resourceId, tx);
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
    } else {
      await this.access.accessiblePost(
        request.parent.resourceId,
        request.viewerAccountId,
        tx,
      );
    }
  }
}
