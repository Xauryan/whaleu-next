import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import type { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { ApplicationError } from '../../http/application-error.js';
import { ExactMediaDeliveryService } from '../../media/delivery.js';
import type { ExactMediaDeliveryPlan } from '../../media/delivery.js';
import type { ProfileCoverMediaPrincipal } from '../../media/profile-cover-owner-proof.js';
import type { MediaVariantName } from '../../media/contracts.js';
import type { ProfileCoverService } from './service.js';
interface Plan extends ExactMediaDeliveryPlan {
  readonly principal: ProfileCoverMediaPrincipal;
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
export class ProfileCoverDelivery {
  private readonly exact: ExactMediaDeliveryService | null;
  constructor(
    private readonly owner: ProfileCoverService,
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
  @AccountPolicy('browse', 'entry')
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
        const { actor } = await this.owner.target(token, profileId, tx);
        const definition = await this.owner.repository.current(actor, tx);
        if (
          !definition ||
          definition.authority !== 'self_selection' ||
          definition.id !== appearanceId ||
          definition.source.kind === 'clear'
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        return this.owner.assets.profileCoverDeliveryPlan(
          await this.owner.registry.authorize(token, request, tx),
          request,
          variant,
          tx,
        );
      },
      (plan) =>
        plan.principal.kind === 'session'
          ? `account:${plan.principal.accountId}`
          : `guest-connection:${connection}`,
      range,
    );
  }
}
