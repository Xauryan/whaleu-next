import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type {
  ApprovedAsset,
  Decision,
  MediaAttachmentPort,
  MediaDisplayContext,
} from '../community-policy.js';
import type { PublicationOperation, MediaView } from '../contracts.js';
import type { EffectiveContentEnvelopeDraft } from '../content-review/contracts.js';
import { MediaAssetRepository } from '../../media/asset-repository.js';
import type { AcceptedMediaAssets } from '../../media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../../media/owner-proof.js';
import { CommunityMediaOwner } from './owner.js';

/** Opt-in dependency wiring only. No storage/review is invented here and ordinary
 * AppModule continues to use UnavailableMedia until separately activated. */
export class CommunityMediaAttachmentAdapter implements MediaAttachmentPort {
  private readonly accepted = new WeakMap<
    PoolClient,
    Map<string, AcceptedMediaAssets>
  >();
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly owner: CommunityMediaOwner,
    private readonly proofs: MediaOwnerProofRegistry,
  ) {}
  async resolveOwned(
    actor: string,
    purpose: PublicationOperation,
    ids: string[],
    tx: PoolClient,
    envelope: EffectiveContentEnvelopeDraft,
  ): Promise<Decision<ApprovedAsset[]>> {
    if (
      purpose !== 'publish_post' ||
      envelope.purpose !== purpose ||
      envelope.accountId !== actor ||
      ids.length !== 1
    )
      return { kind: 'unavailable' };
    const scope = await this.assets.peekOwnedScope(actor, ids, tx);
    const revision = CommunityMediaOwner.scopeRevision(
      envelope.spaceId,
      envelope.scope,
    );
    if (revision !== scope.scopeRevision)
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.owner.requireDraft(
      scope.scopeId,
      actor,
      envelope.spaceId,
      revision,
      tx,
    );
    const accepted = await this.assets.acceptOwned(
      {
        actor,
        scopeId: scope.scopeId,
        scopeRevision: revision,
        purpose: 'community-post-image',
        audience: 'content-gated',
        ownerKind: 'community',
        resourceKind: 'post',
        contentVersion: 1,
      },
      ids,
      tx,
    );
    let entries = this.accepted.get(tx);
    if (!entries) {
      entries = new Map();
      this.accepted.set(tx, entries);
    }
    entries.set(JSON.stringify(accepted.images), accepted);
    return {
      kind: 'allow',
      value: accepted.images.map((image) => ({ ...image })),
    };
  }
  async bind(
    images: ApprovedAsset[],
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    if (!images.length) return;
    const accepted = this.accepted.get(tx)?.get(JSON.stringify(images));
    if (!accepted || kind !== 'post')
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.assets.bind(
      accepted,
      {
        ownerKind: 'community',
        resourceKind: 'post',
        resourceId: id,
        contentVersion: 1,
      },
      tx,
    );
  }
  async detach(
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    if (kind !== 'post') throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.assets.detach(
      {
        ownerKind: 'community',
        resourceKind: kind,
        resourceId: id,
        contentVersion: 1,
      },
      tx,
    );
  }
  async display(
    images: ApprovedAsset[],
    tx: PoolClient,
    context: MediaDisplayContext,
  ): Promise<Decision<MediaView[]>> {
    if (!context.viewerAccountId) return { kind: 'unavailable' };
    const request = {
      viewerAccountId: context.viewerAccountId,
      parent: context.parent,
      audience: 'content-gated' as const,
      purpose: context.purpose,
    };
    const proof = await this.proofs.authorize(request, tx);
    return {
      kind: 'allow',
      value: await this.assets.descriptors(proof, request, images, tx),
    };
  }
}
