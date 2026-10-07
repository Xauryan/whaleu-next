import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import type { SessionView } from '../identity/contracts.js';
import { PublicProfileFacade } from '../profile/public-profile.facade.js';
import type { PublicProfileRecord } from '../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { CommunityProfileDiscoveryFacade } from '../community/profile-discovery.facade.js';
import type { PublicContentKind } from '../community/profile-discovery.facade.js';
import type {
  ProfileContentQuery,
  PublicProfile,
  PublicProfilePage,
  UnavailableProfile,
} from './contracts.js';
import {
  decodeProfileCursor,
  encodeProfileCursor,
  profileCursorScope,
} from './cursor.js';

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
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = token ? await this.identity.session(token, tx) : null;
      const target = await this.target(profileId, session, tx);
      if (target.status !== 'available') return target;
      let postCount = 0,
        tradeCount = 0;
      if (!target.hidden) {
        postCount = (
          await this.community.eligible(
            target.record.accountId,
            session?.accountId ?? null,
            'posts',
            undefined,
            tx,
          )
        ).length;
        tradeCount = (
          await this.community.eligible(
            target.record.accountId,
            session?.accountId ?? null,
            'trading',
            undefined,
            tx,
          )
        ).length;
      }
      if (token) await this.identity.session(token, tx);
      return {
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
        postCount,
        tradeCount,
      };
    });
  }

  list(
    token: string | null,
    profileId: string,
    kind: PublicContentKind,
    query: ProfileContentQuery,
  ): Promise<PublicProfilePage> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = token ? await this.identity.session(token, tx) : null;
      const scope = profileCursorScope(profileId, kind, query, session);
      const seek = decodeProfileCursor(query.cursor, scope);
      const target = await this.target(profileId, session, tx);
      if (target.status !== 'available') return target;
      if (target.hidden)
        return {
          status: 'hidden',
          profileId,
          items: [],
          total: 0,
          nextCursor: null,
        };
      const eligible = await this.community.eligible(
        target.record.accountId,
        session?.accountId ?? null,
        kind,
        query.tradingSubtype,
        tx,
      );
      const anchor = seek
        ? eligible.findIndex(
            (item) =>
              item.post.id === seek.id &&
              item.post.published_at.toISOString() === seek.at,
          )
        : -1;
      if (seek && anchor < 0)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      const remaining = eligible.slice(anchor + 1);
      const page = remaining.slice(0, query.limit);
      const items = await this.community.project(
        page,
        session?.accountId ?? null,
        tx,
      );
      const last = page.at(-1);
      if (token) await this.identity.session(token, tx);
      return {
        status: 'available',
        profileId,
        items,
        total: eligible.length,
        nextCursor:
          remaining.length > query.limit && last
            ? encodeProfileCursor(
                last.post.published_at.toISOString(),
                last.post.id,
                scope,
              )
            : null,
      };
    });
  }
}
