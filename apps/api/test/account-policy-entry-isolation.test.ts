import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { firstValueFrom, of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  DatabaseService,
  TransactionOptions,
} from '../src/database/database.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { AccountPolicyInterceptor } from '../src/safety/account-policy/interceptor.js';
import { mintToken } from '../src/identity/tokens.js';
import { unpunishedAccountPolicyObservation } from './support/unpunished-account-policy-observation.js';

class SearchController {
  search() {}
}
test('authenticated entry policy explicitly requests read committed before handing off to the owner', async () => {
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      const answer = unpunishedAccountPolicyObservation(sql, values);
      assert.ok(answer, `Unexpected entry query: ${sql}`);
      return answer;
    },
  } as unknown as PoolClient;
  let observed = false;
  const database = {
    transaction: async <T>(
      operation: (client: PoolClient) => Promise<T>,
      options?: TransactionOptions,
    ) => {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      startTransactionDeadlines(tx);
      try {
        const result = await operation(tx);
        observed = true;
        return result;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const identity = {
    session: async () => ({ accountId: 'synthetic-viewer' }),
  } as unknown as IdentityService;
  const context = {
    getClass: () => SearchController,
    getHandler: () => SearchController.prototype.search,
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization: `Bearer ${mintToken('access')}` },
      }),
    }),
  } as unknown as ExecutionContext;
  const response = await firstValueFrom(
    new AccountPolicyInterceptor(database, identity).intercept(context, {
      handle: () => {
        assert.equal(observed, true);
        return of('owner-result');
      },
    }),
  );
  assert.equal(response, 'owner-result');
});
