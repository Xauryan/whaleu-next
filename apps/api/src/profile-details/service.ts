import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { PublicProfileFacade } from '../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { ProfileDetailsRepository } from './repository.js';
import {
  profileDetailsPatchSchema,
  publicProfileDetails,
} from './contracts.js';
import type { ProfileDetailsPatch, PublicProfileDetails } from './contracts.js';
@Injectable()
export class ProfileDetailsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly visibility: ProfileVisibilityFacade,
    @Inject(ProfileDetailsRepository)
    private readonly details: ProfileDetailsRepository,
  ) {}
  @AccountPolicy('private_self_service', 'entry')
  own(token: string) {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      await this.details.lock(session.accountId, tx);
      return this.details.read(session.accountId, tx);
    });
  }
  @AccountPolicy('private_self_service', 'entry')
  update(token: string, patch: ProfileDetailsPatch) {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      return this.details.update(
        session.accountId,
        profileDetailsPatchSchema.parse(patch),
        tx,
      );
    });
  }
  @AccountPolicy('browse', 'entry')
  public(
    token: string | null,
    profileId: string,
  ): Promise<PublicProfileDetails> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const viewer = token
          ? (await this.identity.session(token, tx)).accountId
          : null;
        const profile = await this.profiles.find(profileId, tx);
        if (
          !profile ||
          !(await this.identity.activeAccount(profile.accountId, tx)) ||
          (await this.visibility.read(viewer, profile.accountId, tx)).status !==
            'available'
        )
          return { status: 'unavailable', profileId };
        await this.details.lock(profile.accountId, tx);
        return publicProfileDetails(
          profileId,
          await this.details.read(profile.accountId, tx),
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
}
