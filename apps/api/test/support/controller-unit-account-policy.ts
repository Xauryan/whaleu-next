import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';

/**
 * TEST ONLY: isolate controller DTO/auth/error contracts from account policy.
 * These harnesses already stub persistence or the domain owner; synthetic
 * identities and test-only routes cannot prove production account policy.
 * Only explicitly opted-in TestingModules replace the named interceptor.
 * Controller bearer validation, guards, auth errors and DTO parsing stay real.
 * Do not use in policy/inventory tests or PostgreSQL integration fixtures:
 * account-policy-route-inventory.test.ts checks the real HTTP boundary;
 * integration/account-punishment-causal.test.ts covers policy with PostgreSQL.
 */
export const controllerUnitAccountPolicy: NestInterceptor = {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle();
  },
};
