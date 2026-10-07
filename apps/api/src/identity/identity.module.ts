import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseModule } from '../database/database.js';
import { SchemaValidationPipe } from '../http/validation.js';
import {
  IDENTITY_PROVIDER,
  loginRequestSchema,
  refreshRequestSchema,
} from './contracts.js';
import type {
  LoginRequest,
  RefreshRequest,
  SessionCredentials,
  SessionView,
} from './contracts.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { IdentityRateLimiter } from './rate-limit.js';
import { bearerToken } from './tokens.js';
import { WechatIdentityProvider } from './wechat-provider.js';

@Controller('v1/auth')
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(IdentityRateLimiter) private readonly risk: IdentityRateLimiter,
  ) {}
  @Post('wechat/login')
  @HttpCode(200)
  async login(
    @Body(new SchemaValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
  ): Promise<SessionCredentials> {
    await this.risk.consume('login', request.socket.remoteAddress ?? 'unknown');
    return this.identity.login(body.code);
  }
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new SchemaValidationPipe(refreshRequestSchema)) body: RefreshRequest,
    @Req() request: Request,
  ): Promise<SessionCredentials> {
    await this.risk.consume(
      'refresh',
      request.socket.remoteAddress ?? 'unknown',
    );
    return this.identity.refresh(body.refreshToken);
  }
  @Get('session')
  session(
    @Headers('authorization') authorization: unknown,
  ): Promise<SessionView> {
    return this.identity.session(bearerToken(authorization));
  }
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers('authorization') authorization: unknown,
    @Req() request: Request,
  ): Promise<void> {
    const token = bearerToken(authorization);
    await this.risk.consume(
      'logout',
      request.socket.remoteAddress ?? 'unknown',
    );
    await this.identity.logout(token);
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [IdentityController],
  providers: [
    IdentityRepository,
    IdentityService,
    IdentityRateLimiter,
    {
      provide: IDENTITY_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: RuntimeConfig) => new WechatIdentityProvider(config),
    },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
