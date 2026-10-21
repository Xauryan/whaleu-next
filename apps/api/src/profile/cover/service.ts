import { AccountPolicy } from '../../safety/account-policy/decorator.js';
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
import { ProfileCoverReviewFacade } from '../../community/content-review/profile-cover-review.facade.js';
import { MediaProfileCoverPrepareScopes } from '../../media/profile-cover-prepare-scope.js';
import { ProfileCoverMediaIntentRepository } from '../../media/intent-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { ProfileCoverMediaRecoveryRepository } from '../../media/profile-cover-recovery-repository.js';
import { ProfileCoverMediaAssetRepository } from '../../media/profile-cover-asset-repository.js';
import { ProfileCoverMediaProofRegistry } from '../../media/profile-cover-owner-proof.js';
import type {
  AuthorizedProfileCoverMediaRead,
  ProfileCoverMediaReadRequest,
} from '../../media/profile-cover-owner-proof.js';
import type { MediaIngressPlanningPort } from '../../media/application-v2.js';
import type { ImmutableMediaStorage } from '../../media/storage-port.js';
import {
  coverCommandHash,
  coverCommandSchema,
  coverCommandCancelSchema,
  coverPrepareSchema,
  coverReviewDigest,
  PROFILE_COVER_PROTOCOL,
} from './contracts.js';
import type {
  CoverCommandRecovery,
  CoverReceipt,
  CoverReviewEnvelope,
  CoverSelectedSource,
} from './contracts.js';
import type { CoverCurrent } from './selection-contract.js';
import { coverAppearanceId, ProfileCoverRepository } from './repository.js';
import type { CoverDefinition } from './repository.js';
import { lockCoverActor, requireCoverCurrent } from './current-proof.js';

export const PROFILE_COVER_APPLICATION = Symbol('PROFILE_COVER_APPLICATION');
export const PROFILE_COVER_RUNTIME = Symbol('PROFILE_COVER_RUNTIME');
/** Test DI only. AppModule supplies null: no environment/provider activation. */
export interface ProfileCoverRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class ProfileCoverService {
  readonly repository = new ProfileCoverRepository();
  readonly scopes: MediaProfileCoverPrepareScopes;
  readonly intents: ProfileCoverMediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: ProfileCoverMediaAssetRepository;
  readonly registry: ProfileCoverMediaProofRegistry;
  readonly recovery: ProfileCoverMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly profiles: ProfileRepository,
    readonly safety: ProfileVisibilityFacade,
    readonly actorSafety: ProfileAvatarSafetyFacade,
    readonly runtime: ProfileCoverRuntime | null,
    readonly reviews: ProfileCoverReviewFacade,
  ) {
    this.scopes = new MediaProfileCoverPrepareScopes({
      authorizePrepare: async (actor, raw, tx) => {
        await this.actorSafety.requireAllowed(actor, tx);
        const edit = await this.repository.prepare(
          actor,
          coverPrepareSchema.parse(raw),
          tx,
        );
        return {
          actorAccountId: actor,
          serverScopeId: edit.id,
          scopeRevision: edit.scope_revision,
          expiresAt: edit.expires_at.getTime(),
          ownerKind: 'profile',
          resourceKind: 'cover',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'profile-public',
          purpose: 'profile-cover-image',
          slot: 'cover',
          ordinal: 0,
        };
      },
    });
    this.intents = new ProfileCoverMediaIntentRepository(this.scopes);
    this.registry = new ProfileCoverMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.assets = new ProfileCoverMediaAssetRepository(this.registry);
    this.recovery = new ProfileCoverMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 18)
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
  @AccountPolicy('private_self_service', 'owner_after_recovery')
  async command(token: string, raw: unknown): Promise<CoverReceipt> {
    const command = coverCommandSchema.parse(raw);
    return this.authorized(token, async (session, tx) => {
      const actor = session.accountId;
      await lockCoverActor(actor, tx);
      const previous = await this.repository.receipt(
        actor,
        command.clientRequestId,
        tx,
      );
      if (previous) {
        if (previous.requestHash !== coverCommandHash(actor, command))
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        return previous;
      }
      const cancellation = await this.repository.cancellation(
        actor,
        command.clientRequestId,
        tx,
      );
      if (cancellation) {
        if (cancellation !== coverCommandHash(actor, command))
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
      }
      if (!this.runtime && command.source.kind !== 'clear')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      await this.repository.reserveCommand(actor, tx);
      await this.actorSafety.requireAllowed(actor, tx);
      const appearanceId = coverAppearanceId(actor, command.clientRequestId);
      const updated = await this.repository.updateInTransaction(
        actor,
        command.expectedRevision,
        async () => {
          const old = await this.repository.current(actor, tx);
          const oldParent =
            old?.source.kind === 'custom'
              ? {
                  ownerKind: 'profile' as const,
                  resourceKind: 'cover' as const,
                  resourceId: old.id,
                  contentVersion: 1 as const,
                }
              : null;
          const locks = await this.assets.prepareProfileCoverReplacement(
            actor,
            oldParent,
            command.source.kind === 'custom' ? command.source.assetId : null,
            tx,
          );
          let source: CoverSelectedSource,
            bindingId: string | null = null;
          let accepted: Awaited<
            ReturnType<
              ProfileCoverMediaAssetRepository['acceptProfileCoverOwned']
            >
          > | null = null;
          if (command.source.kind === 'custom') {
            const edit = await this.repository.edit(
              actor,
              command.source.editId,
              tx,
            );
            if (edit.expected_revision !== command.expectedRevision)
              throw new ApplicationError('PROFILE_REVISION_CONFLICT');
            accepted = await this.assets.acceptProfileCoverOwned(
              { actor, scopeId: edit.id, scopeRevision: edit.scope_revision },
              command.source.assetId,
              locks,
              tx,
            );
            source = {
              ...command.source,
              manifestDigest: accepted.manifestDigest,
            };
          } else source = { kind: 'clear' };
          const envelope: CoverReviewEnvelope = {
            version: 1,
            purpose: 'select_profile_cover',
            accountId: actor,
            clientRequestId: command.clientRequestId,
            expectedRevision: command.expectedRevision,
            appearanceId,
            previousAppearanceId: old?.id ?? null,
            slot: 'cover',
            source,
          };
          const review = await this.reviews.accepted(envelope, tx);
          if (accepted)
            bindingId = await this.assets.bindProfileCover(
              accepted,
              {
                ownerKind: 'profile',
                resourceKind: 'cover',
                resourceId: appearanceId,
                contentVersion: 1,
              },
              locks,
              tx,
            );
          await this.reviews.bind(review, tx);
          await this.repository.replace(
            {
              authority: 'self_selection',
              id: appearanceId,
              actor_id: actor,
              source,
              envelope,
              digest: coverReviewDigest(envelope),
              binding_id: bindingId,
            },
            tx,
          );
          await this.assets.finishProfileCoverReplacement(locks, tx);
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
      await requireCoverCurrent(actor, tx);
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recoverCommand(
    token: string,
    requestId: string,
  ): Promise<CoverCommandRecovery> {
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
            protocol: PROFILE_COVER_PROTOCOL,
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
              protocol: PROFILE_COVER_PROTOCOL,
              clientRequestId: requestId,
              state: 'cancelled',
              requestHash: cancelled,
            }
          : {
              protocol: PROFILE_COVER_PROTOCOL,
              clientRequestId: requestId,
              state: 'not_recorded',
            };
      },
      false,
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelCommand(
    token: string,
    requestId: string,
    raw: unknown,
  ): Promise<CoverCommandRecovery> {
    const { requestHash } = coverCommandCancelSchema.parse(raw);
    return this.authorized(token, async (session, tx) => {
      const actor = session.accountId;
      await lockCoverActor(actor, tx);
      const receipt = await this.repository.receipt(actor, requestId, tx);
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        return {
          protocol: PROFILE_COVER_PROTOCOL,
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
        protocol: PROFILE_COVER_PROTOCOL,
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
    const currentRevision = await requireCoverCurrent(
      profile.accountId,
      tx,
      null,
      profileId,
    );
    return { actor: profile.accountId, session, currentRevision };
  }
  async authorizeCurrent(
    token: string | null,
    request: ProfileCoverMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedProfileCoverMediaRead> {
    const { actor, session, currentRevision } = await this.target(
      token,
      request.profileId,
      tx,
    );
    const definition = await this.repository.current(actor, tx);
    if (
      !definition ||
      definition.authority !== 'self_selection' ||
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
        resourceKind: 'cover',
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
    definition: CoverDefinition | null,
    tx: PoolClient,
  ): Promise<CoverCurrent> {
    const current = await this.repository.revision(actor, tx);
    await requireCoverCurrent(actor, tx);
    const base = {
      protocol: PROFILE_COVER_PROTOCOL,
      profileId: current.profileId,
      revision: current.revision,
    };
    if (!definition) return { ...base, cover: { state: 'none' } };
    if (definition.source.kind === 'clear')
      return { ...base, cover: { state: 'none' } };
    if (!this.runtime) return { ...base, cover: { state: 'unavailable' } };
    // Missing/held cover does not make an already-visible named profile fail.
    // We do not discard any proof facts: final proof uncertainty still fails.
    try {
      await this.reviews.current(definition.envelope, tx);
      if (!current.profileId) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const request: ProfileCoverMediaReadRequest = {
        profileId: current.profileId,
        appearanceId: definition.id,
        purpose: 'direct-content',
        requestId: randomUUID(),
      };
      const descriptor = await this.assets.profileCoverDescriptor(
        await this.registry.authorize(token, request, tx),
        request,
        tx,
      );
      return {
        ...base,
        cover: {
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
        return { ...base, cover: { state: 'unavailable' } };
      throw error;
    }
  }
  @AccountPolicy('private_self_service', 'entry')
  capabilities(token: string) {
    return this.authorized(
      token,
      async (session, tx) => {
        await this.actorSafety.requireAllowed(session.accountId, tx);
        return {
          protocol: PROFILE_COVER_PROTOCOL,
          upload: this.runtime
            ? ('available' as const)
            : ('unavailable' as const),
        };
      },
      false,
    );
  }
  @AccountPolicy('private_self_service', 'entry')
  ownCurrent(token: string): Promise<CoverCurrent> {
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
  @AccountPolicy('browse', 'entry')
  publicCurrent(
    token: string | null,
    profileId: string,
  ): Promise<CoverCurrent> {
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
}
