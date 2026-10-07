import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Module,
} from '@nestjs/common';
import { CampusModule } from '../campus/campus.module.js';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { bearerToken } from '../identity/tokens.js';
import { AuthorizationRepository } from './authorization.repository.js';
import { AuthorizationService } from './authorization.service.js';

@Controller('v1/me')
export class AuthorizationController {
  constructor(
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
  ) {}
  @Get('authorization')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  capabilities(@Headers('authorization') authorization: unknown) {
    return this.authorization.capabilities(bearerToken(authorization));
  }
}

@Module({
  imports: [DatabaseModule, IdentityModule, CampusModule],
  controllers: [AuthorizationController],
  providers: [AuthorizationRepository, AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
