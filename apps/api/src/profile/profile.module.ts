import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { ProfileAvatarReviewFacade } from '../community/content-review/profile-avatar-review.facade.js';
import {
  ProfileAvatarService,
  PROFILE_AVATAR_RUNTIME,
} from './avatar/service.js';
import type { ProfileAvatarRuntime } from './avatar/service.js';
import { ProfileAvatarUploadApplication } from './avatar/upload-application.js';
import { ProfileAvatarDelivery } from './avatar/delivery.js';
import {
  ProfileAvatarOwnedController,
  ProfileAvatarPublicController,
  ProfileAvatarMultipartInterceptor,
} from './avatar/controller.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { ProfileAvatarSafetyFacade } from '../safety/profile-avatar.facade.js';
import { DatabaseService } from '../database/database.js';
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
    MediaDeliveryBudgetModule,
    SafetyPolicyModule,
    ContentReviewModule,
    IdentityModule,
    CampusModule,
    ExperiencePublicDisplayModule,
  ],
  controllers: [
    ProfileController,
    ProfileAvatarOwnedController,
    ProfileAvatarPublicController,
  ],
  providers: [
    { provide: PROFILE_AVATAR_RUNTIME, useValue: null },
    {
      provide: ProfileAvatarService,
      inject: [
        DatabaseService,
        IdentityService,
        ProfileRepository,
        ProfileVisibilityFacade,
        ProfileAvatarSafetyFacade,
        PROFILE_AVATAR_RUNTIME,
        ProfileAvatarReviewFacade,
      ],
      useFactory: (
        database: DatabaseService,
        identity: IdentityService,
        profiles: ProfileRepository,
        safety: ProfileVisibilityFacade,
        actorSafety: ProfileAvatarSafetyFacade,
        runtime: ProfileAvatarRuntime | null,
        reviews: ProfileAvatarReviewFacade,
      ) =>
        new ProfileAvatarService(
          database,
          identity,
          profiles,
          safety,
          actorSafety,
          runtime,
          reviews,
        ),
    },
    {
      provide: ProfileAvatarUploadApplication,
      inject: [ProfileAvatarService],
      useFactory: (owner: ProfileAvatarService) =>
        new ProfileAvatarUploadApplication(owner),
    },
    {
      provide: ProfileAvatarDelivery,
      inject: [ProfileAvatarService, MediaDeliveryBudgetPool],
      useFactory: (
        owner: ProfileAvatarService,
        budget: MediaDeliveryBudgetPool,
      ) => new ProfileAvatarDelivery(owner, budget),
    },
    ProfileAvatarMultipartInterceptor,
    ProfileRepository,
    ProfileService,
    AuthorDisplayService,
    AccountIdentityProfileService,
    PublicProfileFacade,
    ProfileAdminParticipantFacade,
  ],
  exports: [
    ProfileAvatarService,
    ProfileAvatarUploadApplication,
    PROFILE_AVATAR_RUNTIME,
    AuthorDisplayService,
    AccountIdentityProfileService,
    PublicProfileFacade,
    ProfileAdminParticipantFacade,
  ],
})
export class ProfileModule {}
