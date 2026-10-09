import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import type { DatabaseService } from '../src/database/database.js';
import { PublicProfileFacade } from '../src/profile/public-profile.facade.js';
import type { ProfileRepository } from '../src/profile/profile.repository.js';
import type { ExperiencePublicDisplayFacade } from '../src/experience/public-display.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const errorIs = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'DM_UNAVAILABLE';
function fixture() {
  const state = {
    account: null as { status: string; state_version: string } | null,
    profile: null as {
      account_id: string;
      public_id: string;
      revision: number;
      state_version: string;
    } | null,
  };
  const tx = {
    query: async (sql: string) => {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql.startsWith('SELECT status,xmin::text'))
        return { rows: state.account ? [state.account] : [] };
      if (sql.startsWith('SELECT account_id,public_id,revision,xmin::text'))
        return { rows: state.profile ? [state.profile] : [] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const identity = new IdentityRepository({} as DatabaseService);
  const profiles = new PublicProfileFacade(
    { publicProfile: async () => null } as unknown as ProfileRepository,
    {} as ExperiencePublicDisplayFacade,
  );
  return { tx, state, identity, profiles };
}
test('DM Identity absence is retained after savepoint rollback and detects later activation/insertion', async () => {
  const f = fixture();
  assert.equal(await f.identity.dmActiveAccount(id(1), f.tx), false);
  await f.tx.query('ROLLBACK TO SAVEPOINT dm_command');
  f.state.account = { status: 'active', state_version: '2' };
  await assert.rejects(() => checkTransactionDeadlines(f.tx), errorIs);
});
test('DM Identity active and blocked observations both receive final version proof', async () => {
  for (const status of ['active', 'blocked']) {
    const f = fixture();
    f.state.account = { status, state_version: '1' };
    assert.equal(
      await f.identity.dmActiveAccount(id(1), f.tx),
      status === 'active',
    );
    f.state.account = {
      status: status === 'active' ? 'blocked' : 'active',
      state_version: '2',
    };
    await assert.rejects(() => checkTransactionDeadlines(f.tx), errorIs);
  }
});
test('DM Profile absence survives command rollback and cannot become a stale durable rejection', async () => {
  const f = fixture();
  assert.equal(await f.profiles.dmFind(id(2), f.tx), null);
  await f.tx.query('ROLLBACK TO SAVEPOINT dm_command');
  f.state.profile = {
    account_id: id(1),
    public_id: id(2),
    revision: 1,
    state_version: '1',
  };
  await assert.rejects(() => checkTransactionDeadlines(f.tx), errorIs);
});
test('Unchanged absent DM owner facts are valid negative evidence', async () => {
  const f = fixture();
  assert.equal(await f.identity.dmActiveAccount(id(1), f.tx), false);
  assert.equal(await f.profiles.dmFind(id(2), f.tx), null);
  await checkTransactionDeadlines(f.tx);
});
