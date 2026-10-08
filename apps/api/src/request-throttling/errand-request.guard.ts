import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { IdentityService } from '../identity/identity.service.js';
import { bearerToken } from '../identity/tokens.js';
import { ApplicationError } from '../http/application-error.js';
/** Reuses the shared bounded PostgreSQL request-attempt storage. The account's
 * 120/minute budget is shared by every errand endpoint and session. */
@Injectable()
export class ErrandRequestGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {
    super(options, storage, reflector);
  }
  override async canActivate(context: ExecutionContext) {
    context.switchToHttp().getResponse<Response>().vary('Authorization');
    try {
      const allowed = await super.canActivate(context);
      const request = context.switchToHttp().getRequest<Request>();
      // An unsupported media type must not hide an unparsed GET body from the
      // strict empty-body pipe. Parsed JSON/form bodies are validated there.
      if (
        request.body === undefined &&
        ((request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
          request.headers['transfer-encoding'] !== undefined)
      )
        throw new BadRequestException('Invalid request');
      return allowed;
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    }
  }
  protected override async getTracker(req: Record<string, unknown>) {
    const headers = req['headers'] as Record<string, unknown> | undefined;
    return (
      await this.identity.session(bearerToken(headers?.['authorization']))
    ).accountId;
  }
  protected override generateKey(
    _context: ExecutionContext,
    accountId: string,
    name: string,
  ) {
    return createHash('sha256')
      .update(JSON.stringify(['errand-read-request-v1', name, accountId]))
      .digest('hex');
  }
  protected override async throwThrottlingException(): Promise<never> {
    throw new ApplicationError('RATE_LIMITED');
  }
}
