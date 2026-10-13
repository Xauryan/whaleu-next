import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CampusService } from '../campus/campus.service.js';
import { preferencesSchema, validCommentDefaults } from './contracts.js';
import type {
  CampusSelection,
  OwnProfile,
  PreferencesPatch,
  ProfilePatch,
} from './contracts.js';
import { ProfileRepository } from './profile.repository.js';
import type {
  ProfileSelfEditIdentity,
  StoredProfile,
} from './profile.repository.js';

@Injectable()
export class ProfileService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  @AccountPolicy('private_self_service', 'entry')
  async get(accountId: string): Promise<OwnProfile> {
    return this.view(await this.repository.get(accountId));
  }
  @AccountPolicy('private_self_service', 'entry')
  async update(
    accountId: string,
    patch: ProfilePatch,
    identity: ProfileSelfEditIdentity,
  ): Promise<OwnProfile> {
    const profile = await this.repository.update(
      accountId,
      patch.expectedRevision,
      async () => ({
        ...(patch.nickname === undefined ? {} : { nickname: patch.nickname }),
        ...(patch.bio === undefined ? {} : { bio: patch.bio }),
      }),
      identity,
    );
    return this.view(profile);
  }
  @AccountPolicy('private_self_service', 'entry')
  async updatePreferences(
    accountId: string,
    patch: PreferencesPatch,
    identity: ProfileSelfEditIdentity,
  ): Promise<OwnProfile> {
    const profile = await this.repository.update(
      accountId,
      patch.expectedRevision,
      async (current) => {
        const preferences = preferencesSchema.parse({
          ...current.preferences,
          ...patch.preferences,
        });
        if (!validCommentDefaults(preferences))
          throw new BadRequestException('Invalid request');
        return { preferences };
      },
      identity,
    );
    return this.view(profile);
  }
  @AccountPolicy('private_self_service', 'entry')
  async selectCampus(
    accountId: string,
    selection: CampusSelection,
    identity: ProfileSelfEditIdentity,
  ): Promise<OwnProfile> {
    const profile = await this.repository.update(
      accountId,
      selection.expectedRevision,
      async (_current, transaction) => {
        await this.campuses.requireSelectable(selection.campusId, transaction);
        return { selectedCampusId: selection.campusId };
      },
      identity,
    );
    return this.view(profile);
  }
  private async view(profile: StoredProfile): Promise<OwnProfile> {
    const { selectedCampusId, ...own } = profile;
    return {
      ...own,
      selectedCampus: selectedCampusId
        ? await this.campuses.find(selectedCampusId)
        : null,
    };
  }
}
