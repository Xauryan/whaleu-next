import type { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { ApplicationError } from '../../http/application-error.js';
import { ExactMediaDeliveryService } from '../../media/delivery.js';
import type { ExactMediaDeliveryPlan } from '../../media/delivery.js';
import type { ProfileMediaPrincipal } from '../../media/profile-owner-proof.js';
import type { MediaVariantName } from '../../media/contracts.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import type { ProfileAvatarService } from './service.js';
interface Plan extends ExactMediaDeliveryPlan {
  readonly principal: ProfileMediaPrincipal;
}
/** Socket identity is issued server-side and retained across requests on that
 * connection. Unauthenticated clients cannot choose budget keys. */
const connections = new WeakMap<Socket, string>();
function connectionKey(socket: Socket): string {
  let key = connections.get(socket);
  if (!key) {
    key = randomUUID();
    connections.set(socket, key);
  }
  return key;
}
export class ProfileAvatarDelivery {
  private readonly exact: ExactMediaDeliveryService | null;
  constructor(
    private readonly owner: ProfileAvatarService,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.exact = owner.runtime
      ? new ExactMediaDeliveryService(
          owner.database,
          owner.runtime.storage,
          budget,
        )
      : null;
  }
  async open(
    token: string | null,
    profileId: string,
    appearanceId: string,
    variant: MediaVariantName,
    socket: Socket,
    range?: string,
  ) {
    const request = {
      profileId,
      appearanceId,
      purpose: 'download' as const,
      requestId: randomUUID(),
    };
    if (!this.exact) {
      await this.owner.database.transaction(
        async (tx) => {
          await this.owner.target(token, profileId, tx);
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
        { isolationLevel: 'read committed' },
      );
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    const connection = connectionKey(socket);
    return this.exact.open<Plan>(
      async (tx) => {
        const { actor, session, currentRevision } = await this.owner.target(
          token,
          profileId,
          tx,
        );
        const definition = await this.owner.repository.current(actor, tx);
        if (
          !definition ||
          definition.id !== appearanceId ||
          definition.source.kind === 'clear'
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        if (definition.source.kind === 'custom')
          return this.owner.assets.profileDeliveryPlan(
            await this.owner.registry.authorize(token, request, tx),
            request,
            variant,
            tx,
          );
        const reviewRevision = await this.owner.reviews.current(
          definition.envelope,
          tx,
        );
        const item = await this.owner.runtime?.catalog?.require(
          definition.source.catalogVersion,
          definition.source.itemId,
          tx,
        );
        if (!item || item.content_hash !== definition.source.contentHash)
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const image = item.manifest.variants.find(
          (value) => value.name === variant,
        );
        if (!image) throw new ApplicationError('MEDIA_UNAVAILABLE');
        const revision = await this.owner.repository.revision(actor, tx);
        return {
          principal: session
            ? {
                kind: 'session' as const,
                accountId: session.accountId,
                sessionId: session.sessionId,
              }
            : { kind: 'guest' as const, requestId: request.requestId },
          profileId,
          appearanceId,
          ownerRevision: currentRevision,
          reviewRevision,
          catalogRevision: ownerFingerprint(item),
          source: definition.source,
          variant,
          object: image.object,
          sha256: image.sha256,
          bytes: image.bytes,
          mime: image.mime,
          attachmentSetRevision: ownerFingerprint({
            definition,
            contentHash: item.content_hash,
            revision: revision.revision,
          }),
        };
      },
      (plan) =>
        plan.principal.kind === 'session'
          ? `account:${plan.principal.accountId}`
          : `guest-connection:${connection}`,
      range,
    );
  }
}
