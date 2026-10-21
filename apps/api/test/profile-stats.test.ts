import { setTimeout as sleep } from 'node:timers/promises';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  ProfileStatsService,
  PROFILE_STATS_CANDIDATE_LIMIT,
} from '../src/profile-details/stats.service.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { PublicProfileFacade } from '../src/profile/public-profile.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function fixture() {
  const actor = randomUUID(),
    valid = randomUUID(),
    blocked = randomUUID(),
    inactive = randomUUID(),
    missing = randomUUID();
  let following: string[] = [valid, blocked, inactive, missing];
  let followers: string[] = [valid, blocked];
  let lockFailure: string | null = null,
    coverageFailure = false,
    expiredOnFallback = false,
    eligibilityDelay = 0;
  let transactions = 0,
    authCalls = 0;
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('LOCK TABLE') && lockFailure)
        throw Object.assign(new Error('database lock'), { code: lockFailure });
      if (sql.startsWith('SELECT followed_id'))
        return { rows: following.map((target) => ({ target })) };
      if (sql.startsWith('SELECT follower_id'))
        return { rows: followers.map((target) => ({ target })) };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
      transactions++;
      startTransactionDeadlines(tx);
      try {
        return await fn(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const identity = {
    session: async () => {
      authCalls++;
      if (expiredOnFallback && authCalls > 1)
        throw new ApplicationError('AUTHENTICATION_REQUIRED');
      return { accountId: actor };
    },
    activeAccount: async (id: string) => {
      if (eligibilityDelay) await sleep(eligibilityDelay);
      return id !== inactive;
    },
  } as unknown as IdentityService;
  const profiles = {
    ownReference: async (id: string) => (id === missing ? null : id),
    find: async () => ({}),
  } as unknown as PublicProfileFacade;
  const visibility = {
    read: async (_actor: string, id: string) => {
      if (coverageFailure) throw new ApplicationError('SAFETY_UNAVAILABLE');
      return { status: id === blocked ? 'unavailable' : 'available' };
    },
  } as unknown as ProfileVisibilityFacade;
  return {
    actor,
    valid,
    service: new ProfileStatsService(database, identity, profiles, visibility),
    queries,
    state: () => ({ transactions, authCalls }),
    set: (patch: {
      following?: string[];
      followers?: string[];
      lockFailure?: string | null;
      coverageFailure?: boolean;
      expiredOnFallback?: boolean;
      eligibilityDelay?: number;
    }) => {
      eligibilityDelay = patch.eligibilityDelay ?? eligibilityDelay;
      following = patch.following ?? following;
      followers = patch.followers ?? followers;
      if ('lockFailure' in patch) lockFailure = patch.lockFailure!;
      coverageFailure = patch.coverageFailure ?? coverageFailure;
      expiredOnFallback = patch.expiredOnFallback ?? expiredOnFallback;
    },
  };
}
test('own stats count only active visible recorded relationships, never received-interaction guesses', async () => {
  const f = fixture(),
    result = await f.service.own('token');
  assert.deepEqual(result, {
    accountId: f.actor,
    following: { status: 'known', value: 1 },
    followers: { status: 'known', value: 1 },
    receivedInteractions: { status: 'unavailable', value: null },
  });
  assert.ok(
    f.queries.includes(
      'LOCK TABLE whaleu_community.user_follows IN SHARE MODE NOWAIT',
    ),
  );
  assert.ok(!JSON.stringify(result).includes(f.valid));
});
test('empty source is known zero; exceeding a direction bound is unavailable not a truncated count', async () => {
  const f = fixture();
  f.set({ following: [], followers: [] });
  const empty = await f.service.own('token');
  assert.deepEqual(empty.following, { status: 'known', value: 0 });
  f.set({
    following: Array.from({ length: PROFILE_STATS_CANDIDATE_LIMIT + 1 }, () =>
      randomUUID(),
    ),
  });
  const large = await f.service.own('token');
  assert.deepEqual(large.following, { status: 'unavailable', value: null });
  assert.deepEqual(large.followers, { status: 'known', value: 0 });
});
test('lock contention and timeout roll back optional reads and reauthenticate before unavailable fallback', async () => {
  for (const code of ['55P03', '57014']) {
    const f = fixture();
    f.set({ lockFailure: code });
    const result = await f.service.own('token');
    assert.equal(result.following.status, 'unavailable');
    assert.equal(result.followers.status, 'unavailable');
    assert.deepEqual(f.state(), { transactions: 2, authCalls: 2 });
  }
  const revoked = fixture();
  revoked.set({ lockFailure: '55P03', expiredOnFallback: true });
  await assert.rejects(
    revoked.service.own('token'),
    (error) => (error as ApplicationError).code === 'AUTHENTICATION_REQUIRED',
  );
});
test('missing relationship coverage is unavailable, while unrelated database errors are never hidden', async () => {
  const f = fixture();
  f.set({ coverageFailure: true });
  assert.equal((await f.service.own('token')).following.status, 'unavailable');
  const broken = fixture();
  broken.set({ lockFailure: '42P01' });
  await assert.rejects(broken.service.own('token'));
  assert.equal(broken.state().transactions, 1);
});

test('wall-clock budget exhaustion never returns a partial known count', async () => {
  const f = fixture();
  f.set({ following: [f.valid], followers: [], eligibilityDelay: 1050 });
  const result = await f.service.own('token');
  assert.equal(result.following.status, 'unavailable');
  assert.equal(result.followers.status, 'unavailable');
  assert.deepEqual(f.state(), { transactions: 2, authCalls: 2 });
});
