import { InstitutionalSsoController } from './institutional/controller.js';
import { InstitutionalSsoService } from './institutional/service.js';
import {
  INSTITUTIONAL_PROVIDER,
  UnavailableInstitutionalProvider,
} from './institutional/provider.js';
import { SchoolUidModule } from '../school-uid/module.js';
import { SchoolIdentityVerificationFacade } from './school-identity.facade.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { ThrottlerModule } from '@nestjs/throttler';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { StudentVerificationNotices } from './student/notices.js';
import { CampusModule } from '../campus/campus.module.js';
import { SchoolConfigurationAccessModule } from '../school-configuration/access.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { StudentVerificationAccess } from './student/access.js';
import { StudentVerificationService } from './student/service.js';
import {
  OwnStudentVerificationController,
  StudentVerificationReviewController,
} from './student/controller.js';
import { VERIFICATION_EVIDENCE_ACCESS } from './evidence/access-port.js';
import {
  verificationEvidenceControllers,
  verificationEvidenceProviders,
} from './evidence/module.js';
import { APP_CONFIG, type RuntimeConfig } from '../config/config.js';
import { PhoneBindingController } from './phone-binding.controller.js';
import { PhoneBindingService } from './phone-binding.service.js';
import {
  WECHAT_PHONE_PROVIDER,
  WechatPhoneProvider,
} from './wechat-phone-provider.js';
import { DmVerificationFacade } from './dm-eligibility.facade.js';
import { RatingVerificationFacade } from './rating-eligibility.facade.js';
import { LocalErrandBaseEligibilitySource } from './errand-base.source.js';
import { LocalPublicationEligibilitySource } from './publication-eligibility.source.js';
import { LocalReportEligibilitySource } from './report-eligibility.source.js';
import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { bearerToken } from '../identity/tokens.js';
import { LocalSafetyPhoneSource } from './safety-phone.source.js';
import { LocalStudentIdentitySource } from './student-identity.source.js';
import { VerificationRepository } from './verification.repository.js';
import { VerificationService } from './verification.service.js';

@Controller('v1/me')
export class VerificationController {
  constructor(
    @Inject(VerificationService)
    private readonly verification: VerificationService,
  ) {}
  @Get('verification')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  own(@Headers('authorization') authorization: unknown) {
    return this.verification.ownSummary(bearerToken(authorization));
  }
}

@Module({
  imports: [
    DatabaseModule,
    SchoolUidModule,
    IdentityModule,
    AuthorizationModule,
    CampusModule,
    SchoolConfigurationAccessModule,
    SafetyPolicyModule,
    MediaDeliveryBudgetModule,
    PostgresRequestThrottlingModule,
    ThrottlerModule.forRootAsync({
      imports: [PostgresRequestThrottlingModule],
      inject: [PostgresThrottlerStorage],
      useFactory: (storage: PostgresThrottlerStorage) => ({
        storage,
        setHeaders: false,
        throttlers: [
          { name: 'default', ttl: 60000, limit: 120, blockDuration: 60000 },
        ],
      }),
    }),
  ],
  controllers: [
    VerificationController,
    InstitutionalSsoController,
    PhoneBindingController,
    OwnStudentVerificationController,
    StudentVerificationReviewController,
    ...verificationEvidenceControllers,
  ],
  providers: [
    SchoolIdentityVerificationFacade,
    InstitutionalSsoService,
    {
      provide: INSTITUTIONAL_PROVIDER,
      useClass: UnavailableInstitutionalProvider,
    },
    StudentVerificationNotices,
    StudentVerificationAccess,
    StudentVerificationService,
    {
      provide: VERIFICATION_EVIDENCE_ACCESS,
      useExisting: StudentVerificationAccess,
    },
    ...verificationEvidenceProviders,
    PhoneBindingService,
    {
      provide: WECHAT_PHONE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: RuntimeConfig) => new WechatPhoneProvider(config),
    },
    DmVerificationFacade,
    RatingVerificationFacade,
    LocalErrandBaseEligibilitySource,
    VerificationRepository,
    LocalReportEligibilitySource,
    LocalPublicationEligibilitySource,
    VerificationService,
    LocalStudentIdentitySource,
    LocalSafetyPhoneSource,
  ],
  exports: [
    SchoolIdentityVerificationFacade,
    DmVerificationFacade,
    RatingVerificationFacade,
    LocalErrandBaseEligibilitySource,
    LocalStudentIdentitySource,
    LocalSafetyPhoneSource,
    LocalReportEligibilitySource,
    LocalPublicationEligibilitySource,
  ],
})
export class VerificationModule {}
