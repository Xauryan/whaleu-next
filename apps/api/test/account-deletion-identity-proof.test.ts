import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { AccountDeletionService } from '../src/account-deletion/service.js';
import type { AccountDeletionRepository } from '../src/account-deletion/repository.js';
import { SYNTHETIC_APP } from '../src/account-deletion/synthetic-policy.js';

test('restricted reauthentication rechecks existing provider identity after the account-lock wait', async () => {
  let locked = false,
    reads = 0;
  const tx = {
    query: async (sql: string) => {
      assert.match(sql, /provider_identities/);
      reads++;
      if (reads === 1) {
        assert.equal(locked, false);
        return { rows: [{ account_id: 'old-account' }], rowCount: 1 };
      }
      assert.equal(locked, true);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const repository = {
    transaction: <T>(work: (client: PoolClient) => Promise<T>) => work(tx),
    lockAccount: async () => {
      locked = true;
      return {
        id: 'old-account',
        status: 'active',
        lifecycle: 'completed',
        lifecycle_generation: '1',
      };
    },
    context: async () => ({ now_at: new Date(1) }),
  } as unknown as AccountDeletionRepository;
  const service = new AccountDeletionService(repository, {
    verify: async () => ({
      provider: 'wechat',
      appId: SYNTHETIC_APP,
      subject: 'synthetic-existing',
      expiresAt: 100,
    }),
  });
  await assert.rejects(
    service.reauthenticate({}, 'request'),
    /EXISTING_ACCOUNT_REQUIRED/,
  );
  assert.equal(reads, 2);
});
