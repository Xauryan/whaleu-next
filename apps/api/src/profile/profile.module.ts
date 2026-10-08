import { AccountIdentityProfileService } from './account-identity-profile.service.js';
import { PublicProfileFacade } from './public-profile.facade.js';
import { AuthorDisplayService } from './author-display.service.js';
import { ProfileAdminParticipantFacade } from './admin-participant.facade.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Patch,
  Put,
} from '@nestjs/common';
import { CampusModule } from '../campus/campus.module.js';
import { DatabaseModule } from '../database/database.js';
import { ExperiencePublicDisplayModule } from '../experience/public-display.module.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { bearerToken } from '../identity/tokens.js';
import {
  campusSelectionSchema,
  preferencesPatchSchema,
  profilePatchSchema,
} from './contracts.js';
import type {
  CampusSelection,
  OwnProfile,
  PreferencesPatch,
  ProfilePatch,
} from './contracts.js';
import { ProfileRepository } from './profile.repository.js';
import { ProfileService } from './profile.service.js';

@Controller('v1/me')
export class ProfileController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ProfileService) private readonly profiles: ProfileService,
  ) {}
  @Get('profile')
  async get(
    @Headers('authorization') authorization: unknown,
  ): Promise<OwnProfile> {
    const session = await this.identity.session(bearerToken(authorization));
    return this.profiles.get(session.accountId);
  }
  @Patch('profile')
  async update(
    @Headers('authorization') authorization: unknown,
    @Body(new SchemaValidationPipe(profilePatchSchema)) patch: ProfilePatch,
  ): Promise<OwnProfile> {
    const session = await this.identity.session(bearerToken(authorization));
    return this.profiles.update(session.accountId, patch);
  }
  @Patch('preferences')
  async updatePreferences(
    @Headers('authorization') authorization: unknown,
    @Body(new SchemaValidationPipe(preferencesPatchSchema))
    patch: PreferencesPatch,
  ): Promise<OwnProfile> {
    const session = await this.identity.session(bearerToken(authorization));
    return this.profiles.updatePreferences(session.accountId, patch);
  }
  @Put('campus')
  async selectCampus(
    @Headers('authorization') authorization: unknown,
    @Body(new SchemaValidationPipe(campusSelectionSchema))
    selection: CampusSelection,
  ): Promise<OwnProfile> {
    const session = await this.identity.session(bearerToken(authorization));
    return this.profiles.selectCampus(session.accountId, selection);
  }
}

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    ExperiencePublicDisplayModule,
  ],
  controllers: [ProfileController],
  providers: [
    ProfileRepository,
    ProfileService,
    AuthorDisplayService,
    AccountIdentityProfileService,
    PublicProfileFacade,
    ProfileAdminParticipantFacade,
  ],
  exports: [
    AuthorDisplayService,
    AccountIdentityProfileService,
    PublicProfileFacade,
    ProfileAdminParticipantFacade,
  ],
})
export class ProfileModule {}
