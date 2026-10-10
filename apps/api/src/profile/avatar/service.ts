import type { MediaIngressStorage } from '../../media/ingress-storage.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import type { ProfileRepository } from '../profile.repository.js';
import type { ProfileVisibilityFacade } from '../../safety/profile-visibility.facade.js';
import type { ProfileAvatarSafetyFacade } from '../../safety/profile-avatar.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { ApplicationError } from '../../http/application-error.js';
import { ProfileAvatarReviewFacade } from '../../community/content-review/profile-avatar-review.facade.js';
import { MediaProfilePrepareScopes } from '../../media/profile-prepare-scope.js';
import { ProfileMediaIntentRepository } from '../../media/intent-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { ProfileMediaRecoveryRepository } from '../../media/profile-recovery-repository.js';
import { ProfileMediaAssetRepository } from '../../media/profile-asset-repository.js';
import { ProfileMediaProofRegistry } from '../../media/profile-owner-proof.js';
import type {
  AuthorizedProfileMediaRead,
  ProfileMediaReadRequest,
} from '../../media/profile-owner-proof.js';
import type { MediaIngressPlanningPort } from '../../media/application-v2.js';
import type { ImmutableMediaStorage } from '../../media/storage-port.js';
import type { ProfileAvatarCatalog } from './catalog.js';
import {
  avatarCommandHash,
  avatarCommandSchema,
  avatarCommandCancelSchema,
  avatarPrepareSchema,
  avatarReviewDigest,
  PROFILE_MEDIA_PROTOCOL,
} from './contracts.js';
import type {
  AvatarCommandRecovery,
  AvatarReceipt,
  AvatarReviewEnvelope,
  AvatarSelectedSource,
} from './contracts.js';
import { avatarCatalogSchema } from './selection-contract.js';
import type { AvatarCurrent } from './selection-contract.js';
import { avatarAppearanceId, ProfileAvatarRepository } from './repository.js';
import type { AvatarDefinition } from './repository.js';
import { lockAvatarActor, requireAvatarCurrent } from './current-proof.js';

export const PROFILE_AVATAR_APPLICATION = Symbol('PROFILE_AVATAR_APPLICATION');
export const PROFILE_AVATAR_RUNTIME = Symbol('PROFILE_AVATAR_RUNTIME');
/** Test DI only. AppModule supplies null: no environment/provider activation. */
export interface ProfileAvatarRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
  readonly catalog: ProfileAvatarCatalog | null;
}
export class ProfileAvatarService {
  readonly repository = new ProfileAvatarRepository();
  readonly scopes: MediaProfilePrepareScopes;
  readonly intents: ProfileMediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: ProfileMediaAssetRepository;
  readonly registry: ProfileMediaProofRegistry;
  readonly recovery: ProfileMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly profiles: ProfileRepository,
    readonly safety: ProfileVisibilityFacade,
    readonly actorSafety: ProfileAvatarSafetyFacade,
    readonly runtime: ProfileAvatarRuntime | null,
    readonly reviews: ProfileAvatarReviewFacade,
  ) {
    this.scopes = new MediaProfilePrepareScopes({
      authorizePrepare: async (actor, raw, tx) => {
        await this.actorSafety.requireAllowed(actor, tx);
        const edit = await this.repository.prepare(
          actor,
          avatarPrepareSchema.parse(raw),
          tx,
        );
        return {
          actorAccountId: actor,
          serverScopeId: edit.id,
          scopeRevision: edit.scope_revision,
          expiresAt: edit.expires_at.getTime(),
          ownerKind: 'profile',
          resourceKind: 'avatar',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'profile-public',
          purpose: 'profile-avatar-image',
          slot: 'avatar',
          ordinal: 0,
        };
      },
    });
    this.intents = new ProfileMediaIntentRepository(this.scopes);
    this.registry = new ProfileMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.assets = new ProfileMediaAssetRepository(this.registry);
    this.recovery = new ProfileMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 5)
      : null;
  }
  authorized<T>(
    token: string,
    run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        return run(
          await authenticateMediaSession(this.identity, token, tx),
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  async command(token: string, raw: unknown): Promise<AvatarReceipt> {
    const command = avatarCommandSchema.parse(raw);
    return this.authorized(token, async (session, tx) => {
      const actor = session.accountId;
      await lockAvatarActor(actor, tx);
      const previous = await this.repository.receipt(
        actor,
        command.clientRequestId,
        tx,
      );
      if (previous) {
        if (previous.requestHash !== avatarCommandHash(actor, command))
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        return previous;
      }
      const cancellation = await this.repository.cancellation(
        actor,
        command.clientRequestId,
        tx,
      );
      if (cancellation) {
        if (cancellation !== avatarCommandHash(actor, command))
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
      }
      if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await this.repository.reserveCommand(actor, tx);
      await this.actorSafety.requireAllowed(actor, tx);
      const appearanceId = avatarAppearanceId(actor, command.clientRequestId);
      const updated = await this.profiles.updateInTransaction(
        actor,
        command.expectedRevision,
        async () => {
          const old = await this.repository.current(actor, tx);
          const oldParent =
            old?.source.kind === 'custom'
              ? {
                  ownerKind: 'profile' as const,
                  resourceKind: 'avatar' as const,
                  resourceId: old.id,
                  contentVersion: 1 as const,
                }
              : null;
          const locks = await this.assets.prepareProfileReplacement(
            actor,
            oldParent,
            command.source.kind === 'custom' ? command.source.assetId : null,
            tx,
          );
          let source: AvatarSelectedSource,
            bindingId: string | null = null;
          let accepted: Awaited<
            ReturnType<ProfileMediaAssetRepository['acceptProfileOwned']>
          > | null = null;
          if (command.source.kind === 'custom') {
            const edit = await this.repository.edit(
              actor,
              command.source.editId,
              tx,
            );
            if (edit.expected_revision !== command.expectedRevision)
              throw new ApplicationError('PROFILE_REVISION_CONFLICT');
            accepted = await this.assets.acceptProfileOwned(
              { actor, scopeId: edit.id, scopeRevision: edit.scope_revision },
              command.source.assetId,
              locks,
              tx,
            );
            source = {
              ...command.source,
              manifestDigest: accepted.manifestDigest,
            };
          } else if (command.source.kind === 'catalog') {
            const item = await this.runtime!.catalog?.require(
              command.source.catalogVersion,
              command.source.itemId,
              tx,
            );
            if (!item) throw new ApplicationError('MEDIA_UNAVAILABLE');
            source = { ...command.source, contentHash: item.content_hash };
          } else source = { kind: 'clear' };
          const envelope: AvatarReviewEnvelope = {
            version: 1,
            purpose: 'select_profile_avatar',
            accountId: actor,
            clientRequestId: command.clientRequestId,
            expectedRevision: command.expectedRevision,
            appearanceId,
            previousAppearanceId: old?.id ?? null,
            slot: 'avatar',
            source,
          };
          const review = await this.reviews.accepted(envelope, tx);
          if (accepted)
            bindingId = await this.assets.bindProfile(
              accepted,
              {
                ownerKind: 'profile',
                resourceKind: 'avatar',
                resourceId: appearanceId,
                contentVersion: 1,
              },
              locks,
              tx,
            );
          await this.reviews.bind(review, tx);
          await this.repository.replace(
            {
              id: appearanceId,
              actor_id: actor,
              source,
              envelope,
              digest: avatarReviewDigest(envelope),
              binding_id: bindingId,
            },
            tx,
          );
          await this.assets.finishProfileReplacement(locks, tx);
          return {};
        },
        tx,
      );
      const receipt = await this.repository.commitReceipt(
        actor,
        command,
        appearanceId,
        updated.revision,
        tx,
      );
      await requireAvatarCurrent(actor, tx);
      return receipt;
    });
  }
  recoverCommand(
    token: string,
    requestId: string,
  ): Promise<AvatarCommandRecovery> {
    return this.authorized(
      token,
      async (session, tx) => {
        const receipt = await this.repository.receipt(
          session.accountId,
          requestId,
          tx,
        );
        if (receipt)
          return {
            protocol: PROFILE_MEDIA_PROTOCOL,
            clientRequestId: requestId,
            state: 'committed',
            receipt,
          };
        const cancelled = await this.repository.cancellation(
          session.accountId,
          requestId,
          tx,
        );
        return cancelled
          ? {
              protocol: PROFILE_MEDIA_PROTOCOL,
              clientRequestId: requestId,
              state: 'cancelled',
              requestHash: cancelled,
            }
          : {
              protocol: PROFILE_MEDIA_PROTOCOL,
              clientRequestId: requestId,
              state: 'not_recorded',
            };
      },
      false,
    );
  }
  cancelCommand(
    token: string,
    requestId: string,
    raw: unknown,
  ): Promise<AvatarCommandRecovery> {
    const { requestHash } = avatarCommandCancelSchema.parse(raw);
    return this.authorized(token, async (session, tx) => {
      const actor = session.accountId;
      await lockAvatarActor(actor, tx);
      const receipt = await this.repository.receipt(actor, requestId, tx);
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        return {
          protocol: PROFILE_MEDIA_PROTOCOL,
          clientRequestId: requestId,
          state: 'committed',
          receipt,
        };
      }
      const cancelled = await this.repository.cancellation(
        actor,
        requestId,
        tx,
      );
      if (cancelled && cancelled !== requestHash)
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      if (!cancelled) {
        await this.repository.reserveCommand(actor, tx);
        await this.repository.cancelCommand(actor, requestId, requestHash, tx);
      }
      return {
        protocol: PROFILE_MEDIA_PROTOCOL,
        clientRequestId: requestId,
        state: 'cancelled',
        requestHash,
      };
    });
  }
  async target(token: string | null, profileId: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    enableSafetyRelationshipProof(tx);
    const session =
      token === null ? null : await this.identity.session(token, tx);
    const profile = await this.profiles.avatarPublicTarget(profileId, tx);
    if (
      !profile ||
      !(await this.identity.activeAccount(profile.accountId, tx)) ||
      (
        await this.safety.read(
          session?.accountId ?? null,
          profile.accountId,
          tx,
        )
      ).status !== 'available'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const currentRevision = await requireAvatarCurrent(
      profile.accountId,
      tx,
      null,
      profileId,
    );
    return { actor: profile.accountId, session, currentRevision };
  }
  async authorizeCurrent(
    token: string | null,
    request: ProfileMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedProfileMediaRead> {
    const { actor, session, currentRevision } = await this.target(
      token,
      request.profileId,
      tx,
    );
    const definition = await this.repository.current(actor, tx);
    if (
      !definition ||
      definition.id !== request.appearanceId ||
      definition.source.kind !== 'custom' ||
      !definition.binding_id
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const reviewRevision = await this.reviews.current(definition.envelope, tx);
    return {
      principal: session
        ? {
            kind: 'session',
            accountId: session.accountId,
            sessionId: session.sessionId,
          }
        : { kind: 'guest', requestId: request.requestId },
      actorAccountId: actor,
      profileId: request.profileId,
      parent: {
        ownerKind: 'profile',
        resourceKind: 'avatar',
        resourceId: definition.id,
        contentVersion: 1,
      },
      assetId: definition.source.assetId,
      manifestDigest: definition.source.manifestDigest,
      bindingId: definition.binding_id,
      ownerRevision: currentRevision,
      reviewRevision,
    };
  }
  private async selection(
    token: string | null,
    actor: string,
    definition: AvatarDefinition | null,
    tx: PoolClient,
  ): Promise<AvatarCurrent> {
    const current = await this.repository.revision(actor, tx);
    await requireAvatarCurrent(actor, tx);
    const base = {
      protocol: PROFILE_MEDIA_PROTOCOL,
      profileId: current.profileId,
      revision: current.revision,
    };
    if (!definition) return { ...base, avatar: { state: 'none' } };
    if (!this.runtime) return { ...base, avatar: { state: 'unavailable' } };
    // Missing/held avatar does not make an already-visible named profile fail.
    // We do not discard any proof facts: final proof uncertainty still fails.
    try {
      await this.reviews.current(definition.envelope, tx);
      if (definition.source.kind === 'clear')
        return { ...base, avatar: { state: 'none' } };
      if (!current.profileId) throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (definition.source.kind === 'catalog') {
        const item = await this.runtime.catalog?.require(
          definition.source.catalogVersion,
          definition.source.itemId,
          tx,
        );
        if (!item || item.content_hash !== definition.source.contentHash)
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const display = item.manifest.variants[1];
        return {
          ...base,
          avatar: {
            state: 'available',
            appearanceId: definition.id,
            source: {
              kind: 'catalog',
              catalogVersion: item.catalog_version,
              itemId: item.item_id,
            },
            variants: ['thumb-v1', 'display-v1'],
            width: display.width,
            height: display.height,
          },
        };
      }
      const request: ProfileMediaReadRequest = {
        profileId: current.profileId,
        appearanceId: definition.id,
        purpose: 'direct-content',
        requestId: randomUUID(),
      };
      const descriptor = await this.assets.profileDescriptor(
        await this.registry.authorize(token, request, tx),
        request,
        tx,
      );
      return {
        ...base,
        avatar: {
          state: 'available',
          appearanceId: descriptor.appearanceId,
          source: { kind: 'custom', bindingId: descriptor.bindingId },
          variants: descriptor.variants,
          width: descriptor.width,
          height: descriptor.height,
        },
      };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'MEDIA_UNAVAILABLE',
          'MEDIA_NOT_READY',
          'CONTENT_REVIEW_UNAVAILABLE',
          'CONTENT_REJECTED',
        ].includes(error.code)
      )
        return { ...base, avatar: { state: 'unavailable' } };
      throw error;
    }
  }
  ownCurrent(token: string): Promise<AvatarCurrent> {
    return this.authorized(
      token,
      async (session, tx) =>
        this.selection(
          token,
          session.accountId,
          await this.repository.current(session.accountId, tx),
          tx,
        ),
      false,
    );
  }
  publicCurrent(
    token: string | null,
    profileId: string,
  ): Promise<AvatarCurrent> {
    return this.database.transaction(
      async (tx) => {
        const target = await this.target(token, profileId, tx);
        return this.selection(
          token,
          target.actor,
          await this.repository.current(target.actor, tx),
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  catalog() {
    return this.database.transaction(
      async (tx) =>
        avatarCatalogSchema.parse(
          this.runtime?.catalog
            ? await this.runtime.catalog.list(tx)
            : {
                protocol: PROFILE_MEDIA_PROTOCOL,
                availability: 'unavailable',
                catalogVersion: null,
                items: [],
              },
        ),
      { isolationLevel: 'read committed' },
    );
  }
}
