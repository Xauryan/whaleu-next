import type { PoolClient } from 'pg';
import type {
  CurrentMediaDeliveryAuthorizer,
  InternalMediaDeliveryPlan,
} from '../../media/delivery.js';
import type { MediaVariantName } from '../../media/contracts.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type { MediaAssetRepository } from '../../media/asset-repository.js';
import type { MediaOwnerProofRegistry } from '../../media/owner-proof.js';

export class CommunityMediaDeliveryAuthorizer implements CurrentMediaDeliveryAuthorizer {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly assets: MediaAssetRepository,
    private readonly owners: MediaOwnerProofRegistry,
  ) {}
  async authorize(
    token: string,
    bindingId: string,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<InternalMediaDeliveryPlan> {
    const actor = await this.access.actor(token, tx);
    const reference = await this.assets.bindingReference(bindingId, tx);
    const request = {
      viewerAccountId: actor,
      parent: reference.parent,
      audience: 'content-gated' as const,
      purpose: 'download' as const,
    };
    const proof = await this.owners.authorize(request, tx);
    return this.assets.deliveryPlan(
      proof,
      request,
      bindingId,
      this.owners.contentMedia(proof, tx, request),
      variant,
      tx,
    );
  }
}
