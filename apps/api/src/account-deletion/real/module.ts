import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type RuntimeConfig } from '../../config/config.js';
import { DatabaseModule } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { IdentityRateLimiter } from '../../identity/rate-limit.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  prepareDeletionSchema,
  deletionStatusSchema,
  acceptDeletionSchema,
  cancelDeletionSchema,
  type PrepareDeletion,
  type DeletionStatusCommand,
  type AcceptDeletion,
  type CancelDeletion,
} from './contracts.js';
import { RealDeletionService } from './service.js';

@Controller('v1/account-deletion')
export class RealDeletionController {
  constructor(
    @Inject(RealDeletionService) private readonly service: RealDeletionService,
    @Inject(IdentityRateLimiter) private readonly risk: IdentityRateLimiter,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  private async limit(
    operation:
      | 'deletion-prepare'
      | 'deletion-status'
      | 'deletion-accept'
      | 'deletion-cancel',
    request: Request,
  ) {
    if (this.config.REAL_ACCOUNT_DELETION_ENTRY !== 'prepare_only')
      throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
    await this.risk.consume(
      operation,
      request.socket.remoteAddress ?? 'unknown',
    );
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async prepare(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(prepareDeletionSchema))
    body: PrepareDeletion,
    @Req() request: Request,
  ) {
    await this.limit('deletion-prepare', request);
    return this.service.prepare(bearerToken(auth), body);
  }
  @Post('status')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async status(
    @Body(new SchemaValidationPipe(deletionStatusSchema))
    body: DeletionStatusCommand,
    @Req() request: Request,
  ) {
    await this.limit('deletion-status', request);
    return this.service.status(body);
  }
  @Post('accept')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async accept(
    @Body(new SchemaValidationPipe(acceptDeletionSchema)) body: AcceptDeletion,
    @Req() request: Request,
  ) {
    await this.limit('deletion-accept', request);
    return this.service.accept(body);
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async cancel(
    @Body(new SchemaValidationPipe(cancelDeletionSchema)) body: CancelDeletion,
    @Req() request: Request,
  ) {
    await this.limit('deletion-cancel', request);
    return this.service.cancel(body);
  }
}
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [RealDeletionController],
  providers: [RealDeletionService],
})
export class RealDeletionModule {}
