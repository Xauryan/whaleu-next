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
import { ApplicationError } from '../http/application-error.js';
import { bearerToken } from '../identity/tokens.js';
const optionalToolsBearer = (auth: unknown) =>
  auth === undefined ? null : bearerToken(auth);
/** Shared family quota across endpoints/sessions. Guest tracking uses the
 * framework's request IP; no forwarded-header parsing or fake guest account. */
@Injectable()
export class CampusToolsRequestGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {
    super(options, storage, reflector);
  }
  protected async throttle(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse<Response>();
    response.vary('Authorization');
    response.setHeader('Cache-Control', 'no-store');
    return super.canActivate(context);
  }
  override async canActivate(context: ExecutionContext) {
    try {
      const allowed = await this.throttle(context);
      const request = context.switchToHttp().getRequest<Request>();
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
      throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
    }
  }
  protected override async getTracker(req: Record<string, unknown>) {
    const headers = req['headers'] as Record<string, unknown> | undefined;
    const token = optionalToolsBearer(headers?.['authorization']);
    return token === null
      ? `guest:${await super.getTracker(req)}`
      : `account:${(await this.identity.session(token)).accountId}`;
  }
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ) {
    return createHash('sha256')
      .update(JSON.stringify(['campus-tools-request-v1', name, tracker]))
      .digest('hex');
  }
  protected override async throwThrottlingException(): Promise<never> {
    throw new ApplicationError('RATE_LIMITED');
  }
}
