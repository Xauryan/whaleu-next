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
  imports: [DatabaseModule, IdentityModule],
  controllers: [VerificationController],
  providers: [
    VerificationRepository,
    VerificationService,
    LocalStudentIdentitySource,
  ],
  exports: [LocalStudentIdentitySource],
})
export class VerificationModule {}
