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
import type { StoredProfile } from './profile.repository.js';

@Injectable()
export class ProfileService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  async get(accountId: string): Promise<OwnProfile> {
    return this.view(await this.repository.get(accountId));
  }
  async update(accountId: string, patch: ProfilePatch): Promise<OwnProfile> {
    const profile = await this.repository.update(
      accountId,
      patch.expectedRevision,
      async () => ({
        ...(patch.nickname === undefined ? {} : { nickname: patch.nickname }),
        ...(patch.bio === undefined ? {} : { bio: patch.bio }),
      }),
    );
    return this.view(profile);
  }
  async updatePreferences(
    accountId: string,
    patch: PreferencesPatch,
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
    );
    return this.view(profile);
  }
  async selectCampus(
    accountId: string,
    selection: CampusSelection,
  ): Promise<OwnProfile> {
    const profile = await this.repository.update(
      accountId,
      selection.expectedRevision,
      async (_current, transaction) => {
        await this.campuses.requireSelectable(selection.campusId, transaction);
        return { selectedCampusId: selection.campusId };
      },
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
