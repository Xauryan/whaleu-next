import { createHash } from 'node:crypto';
import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  Throttle,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { IdentityService } from '../identity/identity.service.js';
import { bearerToken } from '../identity/tokens.js';
import { ApplicationError } from '../http/application-error.js';

const VIEW_OPERATION = 'whaleu:view-request-operation';
export const VIEW_REQUEST_LIMITS = { epoch: 20, report: 120 } as const;

/** Explicit opt-in: this guard never silently rate-limits unrelated endpoints. */
export function ViewRequestLimit(operation: keyof typeof VIEW_REQUEST_LIMITS) {
  return applyDecorators(
    SetMetadata(VIEW_OPERATION, operation),
    Throttle({
      default: {
        limit: VIEW_REQUEST_LIMITS[operation],
        ttl: 60000,
        blockDuration: 60000,
      },
    }),
    UseGuards(ViewReportingRequestGuard),
  );
}

@Injectable()
export class ViewReportingRequestGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {
    super(options, storage, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    }
  }

  protected override async getTracker(req: Record<string, unknown>) {
    const headers = req['headers'] as Record<string, unknown> | undefined;
    const session = await this.identity.session(
      bearerToken(headers?.['authorization']),
    );
    return session.accountId;
  }

  protected override generateKey(
    context: ExecutionContext,
    accountId: string,
    name: string,
  ): string {
    const operation = this.reflector.getAllAndOverride<
      keyof typeof VIEW_REQUEST_LIMITS
    >(VIEW_OPERATION, [context.getHandler(), context.getClass()]);
    if (!operation || !(operation in VIEW_REQUEST_LIMITS))
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    return createHash('sha256')
      .update(JSON.stringify(['view-request-v1', operation, name, accountId]))
      .digest('hex');
  }

  protected override async throwThrottlingException(): Promise<never> {
    throw new ApplicationError('RATE_LIMITED');
  }
}
