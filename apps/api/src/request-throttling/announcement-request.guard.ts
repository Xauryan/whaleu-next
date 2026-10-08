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
import { optionalAnnouncementBearer } from '../announcements/access.js';
/** Shared family quota across endpoints/sessions. Guest tracking uses the
 * framework's request IP; no forwarded-header parsing or fake guest account. */
@Injectable()
export class AnnouncementRequestGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {
    super(options, storage, reflector);
  }
  override async canActivate(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse<Response>();
    response.vary('Authorization');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const allowed = await super.canActivate(context);
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
      throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    }
  }
  protected override async getTracker(req: Record<string, unknown>) {
    const headers = req['headers'] as Record<string, unknown> | undefined;
    const token = optionalAnnouncementBearer(headers?.['authorization']);
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
      .update(JSON.stringify(['announcements-request-v1', name, tracker]))
      .digest('hex');
  }
  protected override async throwThrottlingException(): Promise<never> {
    throw new ApplicationError('RATE_LIMITED');
  }
}
