import type { CommunitySocialSourceCapture } from '../src/community/social-source/capture.js';
import { unpunishedAccountPolicyObservation } from './support/unpunished-account-policy-observation.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  FollowingService,
  followingRevision,
} from '../src/community/following/service.js';
import { followRequestSchema } from '../src/community/following/contracts.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { PublicProfileFacade } from '../src/profile/public-profile.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import {
  distributionCursorScope,
  decodeCursor,
  encodeCursor,
} from '../src/community/cursor.js';
function fixture() {
  const actor = randomUUID(),
    target = randomUUID(),
    profileId = randomUUID();
  let edge = false,
    revision = 0,
    active = true,
    available = true,
    hidden = false,
    exists = true,
    restricted = false,
    sessionAvailable = true,
    accountExists = true,
    lifecycle = 'active',
    lifecycleBusy = false,
    locatedAccount = target;
  const requests = new Map<
    string,
    { profile_id: string; following: boolean; outcome: unknown; code: unknown }
  >();
  const queries: string[] = [];
  const socialEpochs: string[] = [];
  const tx = {
    query: async (sql: string, p: unknown[] = []) => {
      queries.push(sql);
      const observation = unpunishedAccountPolicyObservation(sql, p);
      if (observation) return observation;
      if (sql.startsWith('SELECT pg_advisory'))
        return { rows: [], rowCount: 1 };
      if (
        sql ===
        'SELECT account_id FROM whaleu_profile.profiles WHERE public_id=$1'
      ) {
        assert.equal(p.length, 1);
        assert.ok(p[0] === profileId || p[0] === actor);
        locatedAccount = p[0] === actor ? actor : target;
        return {
          rows: exists ? [{ account_id: p[0] === actor ? actor : target }] : [],
          rowCount: exists ? 1 : 0,
        };
      }
      if (
        sql ===
        'SELECT followed_id AS account_id FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_profile_id=$2'
      ) {
        assert.deepEqual(p, [actor, profileId]);
        locatedAccount = target;
        return {
          rows: edge ? [{ account_id: target }] : [],
          rowCount: edge ? 1 : 0,
        };
      }
      if (
        sql ===
        'SELECT status,lifecycle FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT'
      ) {
        assert.deepEqual(p, [locatedAccount]);
        if (lifecycleBusy)
          throw Object.assign(new Error('lifecycle row busy'), {
            code: '55P03',
          });
        return {
          rows: accountExists
            ? [
                {
                  status: 'active',
                  lifecycle: active ? lifecycle : 'completed',
                },
              ]
            : [],
          rowCount: accountExists ? 1 : 0,
        };
      }
      if (sql.startsWith('SELECT profile_id,following'))
        return {
          rows: requests.has(String(p[1])) ? [requests.get(String(p[1]))] : [],
          rowCount: 0,
        };
      if (sql.startsWith('INSERT INTO whaleu_community.follow_requests')) {
        requests.set(String(p[1]), {
          profile_id: String(p[2]),
          following: p[3] as boolean,
          outcome: p[4],
          code: p[5],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO whaleu_community.user_follows')) {
        const changed = !edge;
        edge = true;
        return { rows: [], rowCount: changed ? 1 : 0 };
      }
      if (sql.startsWith('DELETE FROM whaleu_community.user_follows')) {
        const changed = edge;
        edge = false;
        return { rows: [], rowCount: changed ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO whaleu_community.follow_heads')) {
        revision++;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT revision::text'))
        return {
          rows: revision ? [{ revision: String(revision) }] : [],
          rowCount: revision ? 1 : 0,
        };
      if (sql.startsWith('SELECT 1 FROM whaleu_community.user_follows'))
        return { rows: edge ? [{}] : [], rowCount: edge ? 1 : 0 };
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(f: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await f(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const identity = {
    session: async (token: string, client: PoolClient) => {
      assert.equal(token, 'token');
      assert.equal(client, tx);
      queries.push('current-session-authentication');
      if (!sessionAvailable) throw new Error('session unavailable');
      return { accountId: actor };
    },
    activeAccount: async () => active,
  } as unknown as IdentityService;
  const profiles = {
    find: async (id: string) => {
      queries.push('profile-projection');
      return exists
        ? {
            profileId: id,
            accountId: id === actor ? actor : target,
            hideProfilePosts: hidden,
          }
        : null;
    },
    ownReference: async () => (exists ? profileId : null),
  } as unknown as PublicProfileFacade;
  const visibility = {
    read: async () => ({ status: available ? 'available' : 'unavailable' }),
  } as unknown as ProfileVisibilityFacade;
  const safety = {
    restriction: async () => {
      if (restricted) throw new Error('restricted');
    },
  } as unknown as SafetyRepository;
  return {
    service: new FollowingService(
      database,
      identity,
      profiles,
      visibility,
      safety,
      {
        follow: async (
          _actor: string,
          _recipient: string,
          _profile: string,
          requestId: string,
        ) => {
          assert.equal(requests.get(requestId)?.outcome, 'applied');
          socialEpochs.push(requestId);
        },
      } as unknown as CommunitySocialSourceCapture,
    ),
    actor,
    target,
    profileId,
    tx,
    queries,
    socialEpochs,
    state: () => ({ edge, revision }),
    receiptCount: () => requests.size,
    change: (value: {
      active?: boolean;
      available?: boolean;
      hidden?: boolean;
      exists?: boolean;
      restricted?: boolean;
      sessionAvailable?: boolean;
      accountExists?: boolean;
      lifecycle?: 'active' | 'cooling' | 'erasing' | 'completed';
      lifecycleBusy?: boolean;
    }) => {
      active = value.active ?? active;
      available = value.available ?? available;
      hidden = value.hidden ?? hidden;
      exists = value.exists ?? exists;
      restricted = value.restricted ?? restricted;
      sessionAvailable = value.sessionAvailable ?? sessionAvailable;
      accountExists = value.accountExists ?? accountExists;
      lifecycle = value.lifecycle ?? lifecycle;
      lifecycleBusy = value.lifecycleBusy ?? lifecycleBusy;
    },
  };
}
test('follow intent schema is strict and requires a UUID receipt identity', () => {
  assert.deepEqual(
    followRequestSchema.parse({ requestId: randomUUID() }).requestId.length,
    36,
  );
  for (const value of [
    {},
    { requestId: 'bad' },
    { requestId: randomUUID(), accountId: randomUUID() },
  ])
    assert.equal(followRequestSchema.safeParse(value).success, false);
});
test('edge changes are idempotent; replay cannot reapply older intent after unfollow', async () => {
  const f = fixture(),
    first = randomUUID();
  await f.service.set('token', f.profileId, true, first);
  await f.service.set('token', f.profileId, true, randomUUID());
  assert.deepEqual(f.state(), { edge: true, revision: 1 });
  assert.deepEqual(f.socialEpochs, [first]);
  await f.service.set('token', f.profileId, false, randomUUID());
  await f.service.set('token', f.profileId, true, first);
  assert.deepEqual(f.state(), { edge: false, revision: 2 });
  assert.deepEqual(
    f.socialEpochs,
    [first],
    'Replays, duplicate true and unfollow never enroll another positive source',
  );
  await assert.rejects(f.service.set('token', f.profileId, false, first));
  assert.ok(f.queries.some((sql) => sql.includes('pg_advisory_xact_lock(')));
});
test('self, inaccessible and inactive targets cannot be followed; withdrawal is protective', async () => {
  const f = fixture();
  assert.equal(
    (await f.service.set('token', f.actor, true, randomUUID())).outcome,
    'rejected',
  );
  f.change({ available: false });
  assert.equal(
    (await f.service.set('token', f.profileId, true, randomUUID())).outcome,
    'rejected',
  );
  f.change({ available: true, active: false });
  assert.equal(
    (await f.service.set('token', f.profileId, true, randomUUID())).outcome,
    'rejected',
  );
  f.change({ active: true });
  await f.service.set('token', f.profileId, true, randomUUID());
  f.change({ available: false, active: false, restricted: true });
  await f.service.set('token', f.profileId, false, randomUUID());
  assert.equal(f.state().edge, false);
});
test('feed target guard excludes private profiles, blocks, inactive and missing accounts', async () => {
  const f = fixture();
  assert.equal(
    await f.service.eligibleFeedAuthor(f.actor, f.target, f.tx),
    true,
  );
  for (const value of [
    { hidden: true },
    { hidden: false, available: false },
    { available: true, active: false },
    { active: true, exists: false },
  ]) {
    f.change(value);
    assert.equal(
      await f.service.eligibleFeedAuthor(f.actor, f.target, f.tx),
      false,
    );
  }
});
test('following cursor binds session, scope and edge-set revision', async () => {
  const f = fixture();
  const revision = await followingRevision(f.actor, f.tx);
  const scope = distributionCursorScope(
    `feed:school:following:${revision}`,
    undefined,
    'session-a',
  );
  const cursor = encodeCursor(
    { at: '2026-10-20T00:00:00.000Z', id: randomUUID() },
    scope,
    10,
  );
  assert.ok(decodeCursor(cursor, scope, 10));
  for (const changed of [
    distributionCursorScope('feed:school:following:1', undefined, 'session-a'),
    distributionCursorScope('feed:other:following:0', undefined, 'session-a'),
    distributionCursorScope('feed:school:following:0', undefined, 'session-b'),
  ])
    assert.throws(() => decodeCursor(cursor, changed, 10));
});

test('unfollow removes the owned edge even if the target profile has been erased', async () => {
  const f = fixture();
  await f.service.set('token', f.profileId, true, randomUUID());
  f.change({ exists: false, active: false });
  await f.service.set('token', f.profileId, false, randomUUID());
  assert.deepEqual(f.state(), { edge: false, revision: 2 });
  assert.ok(
    f.queries.some((sql) =>
      sql.includes(
        'DELETE FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_profile_id=$2',
      ),
    ),
  );
});

test('terminal rejection is persisted and never reapplied after eligibility changes; unknown errors remain unsettled', async () => {
  const f = fixture(),
    requestId = randomUUID();
  f.change({ available: false });
  const rejected = await f.service.set('token', f.profileId, true, requestId);
  assert.deepEqual(rejected, {
    requestId,
    profileId: f.profileId,
    following: true,
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  f.change({ available: true });
  assert.deepEqual(
    await f.service.set('token', f.profileId, true, requestId),
    rejected,
  );
  assert.equal(f.state().edge, false);
  f.change({ restricted: true });
  const unknown = randomUUID();
  await assert.rejects(f.service.set('token', f.profileId, true, unknown));
  f.change({ restricted: false });
  assert.equal(
    (await f.service.set('token', f.profileId, true, unknown)).outcome,
    'applied',
  );
});

test('fresh follow locks the ID-only target lifecycle before edge gate and profile projection', async () => {
  const f = fixture();
  await f.service.set('token', f.profileId, true, randomUUID());
  const locator = f.queries.findIndex((sql) =>
    sql.startsWith('SELECT account_id FROM whaleu_profile.profiles'),
  );
  const lifecycle = f.queries.findIndex((sql) =>
    sql.includes('FROM whaleu_identity.accounts'),
  );
  const edge = f.queries.findIndex((sql) =>
    sql.includes('pg_advisory_xact_lock(hashtextextended($1,0))'),
  );
  assert.ok(locator >= 0 && locator < lifecycle && lifecycle < edge);
  assert.ok(edge < f.queries.indexOf('profile-projection'));
  assert.match(f.queries[lifecycle]!, /FOR SHARE NOWAIT$/);
});

test('historical follow recovery never consults target lifecycle or profile after deletion', async () => {
  const f = fixture(),
    requestId = randomUUID();
  const receipt = await f.service.set('token', f.profileId, true, requestId);
  await f.service.set('token', f.profileId, false, randomUUID());
  f.change({ exists: false, active: false });
  f.queries.length = 0;
  assert.deepEqual(
    await f.service.set('token', f.profileId, true, requestId),
    receipt,
  );
  assert.equal(f.state().edge, false);
  assert.equal(
    f.queries.filter((sql) => sql.startsWith('SELECT profile_id,following'))
      .length,
    2,
  );
  assert.ok(
    !f.queries.some(
      (sql) =>
        sql.includes('whaleu_profile') ||
        sql.includes('whaleu_identity.accounts') ||
        sql === 'profile-projection',
    ),
  );
});

test('fresh positive against a nonactive target rejects without resolving its profile', async () => {
  const f = fixture();
  f.change({ active: false });
  const result = await f.service.set('token', f.profileId, true, randomUUID());
  assert.equal(result.outcome, 'rejected');
  assert.ok(!f.queries.includes('profile-projection'));
  assert.equal(f.socialEpochs.length, 0);
});

test('current target lifecycle and missing account deny fresh positive follow before profile projection', async () => {
  for (const change of [
    { lifecycle: 'cooling' as const },
    { lifecycle: 'erasing' as const },
    { lifecycle: 'completed' as const },
    { accountExists: false },
  ]) {
    const f = fixture(),
      requestId = randomUUID();
    f.change(change);
    const receipt = await f.service.set('token', f.profileId, true, requestId);
    assert.deepEqual(receipt, {
      requestId,
      profileId: f.profileId,
      following: true,
      outcome: 'rejected',
      code: 'POST_NOT_FOUND',
    });
    assert.equal(f.receiptCount(), 1);
    assert.deepEqual(f.state(), { edge: false, revision: 0 });
    assert.equal(f.socialEpochs.length, 0);
    assert.ok(!f.queries.includes('profile-projection'));
  }
});

test('busy target lifecycle is retryable and cannot settle a terminal receipt', async () => {
  const f = fixture(),
    requestId = randomUUID();
  f.change({ lifecycleBusy: true });
  await assert.rejects(f.service.set('token', f.profileId, true, requestId), {
    code: '55P03',
  });
  assert.equal(f.receiptCount(), 0);
  assert.deepEqual(f.state(), { edge: false, revision: 0 });
  assert.equal(f.socialEpochs.length, 0);
  assert.ok(!f.queries.includes('profile-projection'));
  f.change({ lifecycleBusy: false });
  assert.equal(
    (await f.service.set('token', f.profileId, true, requestId)).outcome,
    'applied',
  );
  assert.equal(f.receiptCount(), 1);
  assert.deepEqual(f.socialEpochs, [requestId]);
});

test('historical receipt recovery still requires current session authentication before receipt lookup', async () => {
  const f = fixture(),
    requestId = randomUUID();
  const receipt = await f.service.set('token', f.profileId, true, requestId);
  f.queries.length = 0;
  f.change({ sessionAvailable: false });
  await assert.rejects(
    f.service.set('token', f.profileId, true, requestId),
    /session unavailable/,
  );
  assert.ok(f.queries.includes('current-session-authentication'));
  assert.ok(
    !f.queries.some(
      (sql) =>
        sql.includes('follow_requests') ||
        sql.includes('whaleu_profile') ||
        sql.includes('whaleu_identity.accounts'),
    ),
  );
  assert.equal(f.receiptCount(), 1);
  assert.deepEqual(f.state(), { edge: true, revision: 1 });
  assert.deepEqual(f.socialEpochs, [requestId]);
  f.change({ sessionAvailable: true, exists: false, active: false });
  assert.deepEqual(
    await f.service.set('token', f.profileId, true, requestId),
    receipt,
  );
});
