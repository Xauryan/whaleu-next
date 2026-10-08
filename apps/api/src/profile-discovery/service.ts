import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { bindDiscoveryCount } from '../community/discovery-counts.js';
import { IdentityService } from '../identity/identity.service.js';
import type { SessionView } from '../identity/contracts.js';
import { PublicProfileFacade } from '../profile/public-profile.facade.js';
import type { PublicProfileRecord } from '../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import { CommunityProfileDiscoveryFacade } from '../community/profile-discovery.facade.js';
import type { PublicContentKind } from '../community/profile-discovery.facade.js';
import type {
  ProfileContentQuery,
  PublicProfile,
  PublicProfilePage,
  UnavailableProfile,
} from './contracts.js';
import { profileCursorScope } from './cursor.js';

type AvailableTarget = {
  status: 'available';
  record: PublicProfileRecord;
  isOwn: boolean;
  hidden: boolean;
};

/** Application composition only. Domain repositories and SQL stay with owners. */
@Injectable()
export class ProfileDiscoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly safety: ProfileVisibilityFacade,
    @Inject(CommunityProfileDiscoveryFacade)
    private readonly community: CommunityProfileDiscoveryFacade,
  ) {}

  private async target(
    profileId: string,
    session: SessionView | null,
    tx: PoolClient,
  ): Promise<AvailableTarget | UnavailableProfile> {
    const record = await this.profiles.find(profileId, tx);
    if (!record || !(await this.identity.activeAccount(record.accountId, tx)))
      return { status: 'unavailable', profileId };
    const relationship = await this.safety.read(
      session?.accountId ?? null,
      record.accountId,
      tx,
    );
    if (relationship.status !== 'available')
      return { ...relationship, profileId };
    const isOwn = session?.accountId === record.accountId;
    return {
      status: 'available',
      record,
      isOwn,
      hidden: !isOwn && record.hideProfilePosts,
    };
  }

  ownReference(token: string): Promise<{ profileId: string | null }> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      const profileId = await this.profiles.ownReference(session.accountId, tx);
      await this.identity.session(token, tx);
      return { profileId };
    });
  }

  profile(token: string | null, profileId: string): Promise<PublicProfile> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const session = token ? await this.identity.session(token, tx) : null;
        const target = await this.target(profileId, session, tx);
        if (target.status !== 'available') return target;
        const postCount = target.hidden
          ? { value: 0, status: 'known' as const, optionalUntil: null }
          : await this.community.count(
              target.record.accountId,
              session?.accountId ?? null,
              'posts',
              tx,
            );
        const tradeCount = target.hidden
          ? { value: 0, status: 'known' as const, optionalUntil: null }
          : await this.community.count(
              target.record.accountId,
              session?.accountId ?? null,
              'trading',
              tx,
            );
        if (token) await this.identity.session(token, tx);
        const result: Extract<PublicProfile, { status: 'available' }> = {
          status: 'available',
          profileId: target.record.profileId,
          isOwn: target.isOwn,
          displayName: target.record.displayName,
          bio: target.record.bio,
          avatar: null,
          affiliation: null,
          publicUid: null,
          title: null,
          level: null,
          totalInteractions: null,
          displayAvailability: 'unavailable',
          postsHidden: target.hidden,
          postCount: postCount.value,
          postCountStatus: postCount.status,
          tradeCount: tradeCount.value,
          tradeCountStatus: tradeCount.status,
        };
        bindDiscoveryCount(tx, postCount, () => {
          result.postCount = null;
          result.postCountStatus = 'unavailable';
        });
        bindDiscoveryCount(tx, tradeCount, () => {
          result.tradeCount = null;
          result.tradeCountStatus = 'unavailable';
        });
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }

  list(
    token: string | null,
    profileId: string,
    kind: PublicContentKind,
    query: ProfileContentQuery,
  ): Promise<PublicProfilePage> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const session = token ? await this.identity.session(token, tx) : null;
        const scope = profileCursorScope(profileId, kind, query, session);
        await this.community.validateCursor(query.cursor, scope, tx);
        const target = await this.target(profileId, session, tx);
        if (target.status !== 'available') return target;
        if (target.hidden)
          return {
            status: 'hidden',
            profileId,
            items: [],
            total: 0,
            totalStatus: 'known',
            continuation: 'end',
            nextCursor: null,
          };
        const count = await this.community.count(
          target.record.accountId,
          session?.accountId ?? null,
          kind,
          tx,
          query.tradingSubtype,
        );
        const page = await this.community.page(
          target.record.accountId,
          session?.accountId ?? null,
          kind,
          query,
          scope,
          tx,
          async () => {
            if (token) await this.identity.session(token, tx);
          },
        );
        const result: Extract<
          PublicProfilePage,
          { status: 'available' | 'hidden' }
        > = {
          status: 'available',
          profileId,
          ...page,
          total: count.value,
          totalStatus: count.status,
        };
        bindDiscoveryCount(tx, count, () => {
          result.total = null;
          result.totalStatus = 'unavailable';
        });
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
