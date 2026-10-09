import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { APP_CONFIG } from '../../../config/config.js';
import type { RuntimeConfig } from '../../../config/config.js';
import { IdentityService } from '../../../identity/identity.service.js';
import { IdentityModule } from '../../../identity/identity.module.js';
import { bearerToken } from '../../../identity/tokens.js';
import { ApplicationError } from '../../../http/application-error.js';
import { PostgresRequestThrottlingModule } from '../../../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../../../request-throttling/postgres-storage.js';

@Injectable()
export class SemanticSearchRequestGuard extends ThrottlerGuard {
  constructor(
    @Inject(PostgresThrottlerStorage) storage: PostgresThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
  ) {
    // Per-guard options: never register another global ThrottlerModule token.
    // Existing activity/directory/errand limits must remain unaffected.
    super(
      {
        setHeaders: false,
        throttlers: [
          { name: 'semantic', ttl: 60000, limit: 10, blockDuration: 60000 },
        ],
      },
      storage,
      reflector,
    );
  }
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    context.switchToHttp().getResponse<Response>().vary('Authorization');
    const request = context.switchToHttp().getRequest<Request>();
    if (
      request.body === undefined &&
      ((request.headers['content-length'] !== undefined &&
        request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined)
    )
      throw new BadRequestException('Invalid request');
    // Disabled is a meaningful capability response and needs neither database
    // request counters nor secret lookup nor a provider request.
    if (this.config.COMMUNITY_SEMANTIC_SEARCH === 'disabled') return true;
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  }
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const headers = req['headers'] as Record<string, unknown> | undefined;
    if (headers?.['authorization'] !== undefined)
      return `account:${(await this.identity.session(bearerToken(headers['authorization']))).accountId}`;
    const ip = req['ip'];
    if (typeof ip !== 'string' || !ip || ip.length > 128)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return `guest:${ip}`;
  }
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify(['community-semantic-request-v1', name, tracker]))
      .digest('hex');
  }
  protected override async throwThrottlingException(): Promise<never> {
    throw new ApplicationError('RATE_LIMITED');
  }
}
@Module({
  imports: [IdentityModule, PostgresRequestThrottlingModule],
  providers: [SemanticSearchRequestGuard],
  exports: [SemanticSearchRequestGuard, PostgresRequestThrottlingModule],
})
export class SemanticSearchRequestModule {}
