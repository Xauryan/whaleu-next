import { MetadataScanner } from '@nestjs/core';
import { Injectable, Inject } from '@nestjs/common';
import type {
  Type,
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { sessionPolicyContext } from '../../http/session-policy-context.js';
import { IdentityService } from '../../identity/identity.service.js';
import { bearerToken } from '../../identity/tokens.js';
import { enforceAccountPunishment } from '../account-moderation/policy.js';
import { accountPolicyAction } from './context.js';
import { accountRoutePolicies } from './routes.js';

const policies = new Map(
  accountRoutePolicies.map((row) => [row[0] as string, row]),
);
const handlerKeys = new WeakMap<object, Map<object, string>>();
export function accountPolicyHandlerKey(
  controller: Type<unknown>,
  handler: object,
): string {
  let methods = handlerKeys.get(controller);
  if (!methods) {
    methods = new Map();
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of new MetadataScanner().getAllMethodNames(prototype)) {
      const method = prototype[name];
      if (typeof method !== 'function') continue;
      if (methods.has(method)) throw new ApplicationError('SAFETY_UNAVAILABLE');
      methods.set(method, `${controller.name}.${name}`);
    }
    handlerKeys.set(controller, methods);
  }
  const key = methods.get(handler);
  if (!key) throw new ApplicationError('SAFETY_UNAVAILABLE');
  return key;
}
/** Entry checks close optional-auth/public routes, but are NOT the commit proof.
 * Every authenticated session in the handler's data transaction is observed too.
 * Fresh commands defer to the owner after receipt/cancel handling; no replay may
 * be denied by today's role, source, phone or punishment state. */
@Injectable()
export class AccountPolicyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const id = accountPolicyHandlerKey(
      context.getClass(),
      context.getHandler(),
    );
    const policy = policies.get(id);
    if (!policy) throw new ApplicationError('SAFETY_UNAVAILABLE');
    const [, , , action, phase] = policy;
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const entry = async () => {
      if (phase !== 'entry' || header === undefined) return;
      // A supplied authenticated context is never silently downgraded to guest.
      const token = bearerToken(header);
      await this.database.transaction(
        async (tx) => {
          const session = await this.identity.session(token, tx);
          await enforceAccountPunishment(session.accountId, action, tx);
        },
        { isolationLevel: 'read committed' },
      );
    };
    return new Observable((subscriber) => {
      let subscription: { unsubscribe(): void } | undefined;
      let cancelled = false;
      void entry().then(
        () => {
          if (cancelled) return;
          accountPolicyAction.run(action, () =>
            sessionPolicyContext.run(
              {
                observe: async (session, tx) => {
                  if (phase === 'entry')
                    await enforceAccountPunishment(
                      session.accountId,
                      action,
                      tx,
                    );
                },
              },
              () => {
                subscription = next.handle().subscribe(subscriber);
              },
            ),
          );
        },
        (error: unknown) => subscriber.error(error),
      );
      return () => {
        cancelled = true;
        subscription?.unsubscribe();
      };
    });
  }
}
