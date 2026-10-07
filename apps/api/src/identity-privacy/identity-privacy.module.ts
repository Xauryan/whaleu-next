import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CommunityModule } from '../community/community.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { LocalStudentIdentitySource } from '../verification/student-identity.source.js';
import { DatabaseModule } from '../database/database.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { ProfileModule } from '../profile/profile.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { bearerToken } from '../identity/tokens.js';
import { identityBatchSchema, STUDENT_IDENTITY_SOURCE } from './contracts.js';
import type { IdentityBatch } from './contracts.js';
import { IdentityAuditRepository } from './identity-audit.repository.js';
import { IdentityPrivacyService } from './identity-privacy.service.js';
import { PrivateIdentityRepository } from './private-identity.repository.js';

@Controller('v1/identity-privacy')
export class IdentityPrivacyController {
  constructor(
    @Inject(IdentityPrivacyService)
    private readonly privacy: IdentityPrivacyService,
  ) {}
  @Post('content-identities')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  view(
    @Headers('authorization') authorization: unknown,
    @Body(new SchemaValidationPipe(identityBatchSchema)) body: IdentityBatch,
    @Res({ passthrough: true }) response: Response,
  ) {
    // configureHttp generates this header; never accept a request-supplied audit request ID.
    const header = response.getHeader('x-request-id');
    const requestId =
      typeof header === 'string' && /^[0-9a-f-]{36}$/i.test(header)
        ? header
        : randomUUID();
    return this.privacy.view(bearerToken(authorization), body, requestId);
  }
}

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    AuthorizationModule,
    CommunityModule,
    ProfileModule,
    VerificationModule,
  ],
  controllers: [IdentityPrivacyController],
  providers: [
    IdentityPrivacyService,
    PrivateIdentityRepository,
    IdentityAuditRepository,
    {
      provide: STUDENT_IDENTITY_SOURCE,
      useExisting: LocalStudentIdentitySource,
    },
  ],
})
export class IdentityPrivacyModule {}
