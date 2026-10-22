import { sessionEpochFixture } from './support/session-epoch-fixture.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { registrationSchemaFixture } from './support/registration-schema-fixture.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { assertRegistrationAllowed } from '../src/identity/registration/guard.js';
import {
  ProviderIdentityDigests,
  REGISTRATION_GUARD_PROTOCOL,
} from '../src/identity/registration/digests.js';
const identity = {
  provider: 'wechat' as const,
  appId: 'wx0123456789abcdef',
  subject: 'synthetic-subject',
};
const ring = {
  version: 1 as const,
  activeEpoch: 'key-b',
  keys: [
    { epoch: 'key-a', keyHex: '12'.repeat(32) },
    { epoch: 'key-b', keyHex: '34'.repeat(32) },
  ],
};
const keys = new ProviderIdentityDigests(ring);
const config = {
  IDENTITY_REGISTRATION_GUARD: 'automatic' as const,
  IDENTITY_DELETION_DIGEST_KEYRING: JSON.stringify(ring),
};
const inactive = {
  slot: 1,
  protocol: REGISTRATION_GUARD_PROTOCOL,
  revision: 1,
  mode: 'inactive',
  completion_protocol: 'unavailable',
  active_epoch: null,
};
const enforced = {
  ...inactive,
  mode: 'enforced',
  completion_protocol: 'completed-account-deletion-v1',
  active_epoch: 'key-b',
};
const epochs = ring.keys.map((k) => ({
  epoch: { epoch: k.epoch, key_check: keys.keyCheck(k.epoch) },
}));
const hasCode = (code: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === code;
function fixture(
  input: {
    policy?: unknown;
    empty?: boolean;
    epochs?: unknown[];
    blocked?: unknown[];
    fail?: boolean;
  } = {},
) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (input.fail) throw new Error('synthetic-private-database-error');
      const schema = sessionEpochFixture(sql) ?? registrationSchemaFixture(sql);
      if (schema) return schema;
      if (sql.includes('registration_guard_policy'))
        return { rows: [{ policy: input.policy ?? inactive }] };
      if (sql.includes('AS empty'))
        return { rows: [{ empty: input.empty ?? true }] };
      if (sql.includes('registration_guard_key_epochs k'))
        return { rows: input.epochs ?? epochs };
      if (sql.includes('FROM whaleu_identity.registration_guards g'))
        return { rows: input.blocked ?? [] };
      assert.fail('Unexpected SQL: ' + sql);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, queries };
}

test('default deployment permits first registration only under persistent inactive, unavailable, empty proof', async () => {
  const f = fixture();
  await assertRegistrationAllowed(f.tx, identity);
  assert.match(
    f.queries.find((q) => q.sql.includes('to_jsonb(p) policy'))!.sql,
    /FOR SHARE/,
  );
  assert.match(
    f.queries.find((q) => q.sql.includes('AS empty'))!.sql,
    /registration_guards/,
  );
  assert.match(
    f.queries.find((q) => q.sql.includes('AS empty'))!.sql,
    /registration_guard_key_epochs/,
  );
});

test('explicit required mode does not pretend the absent completion lifecycle is usable', async () => {
  const f = fixture();
  await assert.rejects(
    assertRegistrationAllowed(f.tx, identity, {
      ...config,
      IDENTITY_REGISTRATION_GUARD: 'required',
    }),
    hasCode('AUTH_NOT_CONFIGURED'),
  );
});

for (const input of [
  { empty: false },
  { fail: true },
  { policy: { ...inactive, protocol: 'future-protocol' } },
  { policy: { ...inactive, mode: 'disabled' } },
  { policy: { ...inactive, extra_payload: 'unknown' } },
  {
    policy: {
      ...inactive,
      completion_protocol: 'completed-account-deletion-v1',
    },
  },
  { policy: { ...inactive, active_epoch: 'key-a' } },
])
  test('unknown, inconsistent, missing or nonempty inactive source is not a negative proof', async () => {
    const f = fixture(input);
    await assert.rejects(
      assertRegistrationAllowed(f.tx, identity, config),
      hasCode('AUTH_NOT_CONFIGURED'),
    );
  });

test('persistent enforcement cannot be turned off by absent configuration', async () => {
  const f = fixture({ policy: enforced });
  await assert.rejects(
    assertRegistrationAllowed(f.tx, identity),
    hasCode('AUTH_NOT_CONFIGURED'),
  );
});

test('enforced lookup includes every retained epoch and sends only keyed digests to guard storage', async () => {
  const f = fixture({ policy: enforced });
  await assertRegistrationAllowed(f.tx, identity, config);
  const lookup = f.queries.find((q) =>
    q.sql.includes('FROM whaleu_identity.registration_guards g'),
  )!;
  assert.deepEqual(lookup.values, [
    ['key-a', 'key-b'],
    ['key-a', 'key-b'].map((e) => keys.digest(identity, e).digest),
  ]);
  assert.equal(JSON.stringify(lookup).includes(identity.subject), false);
  assert.equal(JSON.stringify(lookup).includes(identity.appId), false);
  assert.match(lookup.sql, /clock_timestamp/);
});

for (const changed of [
  { ...ring, activeEpoch: 'key-a' },
  { ...ring, keys: [ring.keys[1]!] },
  {
    ...ring,
    keys: [{ ...ring.keys[0]!, keyHex: '56'.repeat(32) }, ring.keys[1]!],
  },
])
  test('active epoch mismatch, omitted old epoch and secret replacement cannot bypass a guard', async () => {
    const f = fixture({ policy: enforced });
    await assert.rejects(
      assertRegistrationAllowed(f.tx, identity, {
        ...config,
        IDENTITY_DELETION_DIGEST_KEYRING: JSON.stringify(changed),
      }),
      hasCode('AUTH_NOT_CONFIGURED'),
    );
    assert.equal(
      f.queries.some((q) => q.sql.includes('registration_guards g')),
      false,
    );
  });

test('PostgreSQL microsecond guard observation is not reinterpreted through millisecond Date', async () => {
  // Model SQL's exact integer-microsecond comparison; actual PG coverage is a
  // separate integration gate. Both values truncate to the SAME JS millisecond.
  const completedMicros = 1835395199999123n;
  const expiresMicros = completedMicros + 2592000000000n;
  const nowMicros = expiresMicros - 1n;
  assert.equal(
    new Date(Number(expiresMicros / 1000n)).getTime(),
    new Date(Number(nowMicros / 1000n)).getTime(),
  );
  const f = fixture({
    policy: enforced,
    blocked: expiresMicros > nowMicros ? [{ valid: true }] : [],
  });
  await assert.rejects(
    assertRegistrationAllowed(f.tx, identity, config),
    hasCode('LOGIN_REJECTED'),
  );
  assert.match(
    f.queries.find((q) =>
      q.sql.includes('FROM whaleu_identity.registration_guards g'),
    )!.sql,
    /reregister_after>clock_timestamp\(\)/,
  );
  assert.match(
    f.queries.find((q) =>
      q.sql.includes('FROM whaleu_identity.registration_guards g'),
    )!.sql,
    /completed_at\+interval '2592000 seconds'/,
  );
});

test('exact PostgreSQL equality returns no live guard; expiry after selection is conservative denial', async () => {
  const expiry = 1837987199999123n;
  const equality = fixture({
    policy: enforced,
    blocked: expiry > expiry ? [{ valid: true }] : [],
  });
  await assertRegistrationAllowed(equality.tx, identity, config);
  const selectedBeforeExpiry = fixture({
    policy: enforced,
    blocked: [{ valid: true }],
  });
  await assert.rejects(
    assertRegistrationAllowed(selectedBeforeExpiry.tx, identity, config),
    hasCode('LOGIN_REJECTED'),
  );
});

for (const blocked of [{ valid: false }, { valid: null }, {}])
  test('invalid or missing database completion-validity proof cannot become real lifecycle evidence', async () => {
    const f = fixture({ policy: enforced, blocked: [blocked] });
    await assert.rejects(
      assertRegistrationAllowed(f.tx, identity, config),
      hasCode('AUTH_NOT_CONFIGURED'),
    );
  });

function repositoryFixture(existing: boolean, allow = true) {
  const queries: string[] = [];
  let committed = false;
  let rolledBack = false;
  const now = new Date('2026-10-22T00:00:00Z');
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      const schema = sessionEpochFixture(sql) ?? registrationSchemaFixture(sql);
      if (schema) return schema;
      if (sql.includes('registration_guard_policy'))
        return { rows: [{ policy: inactive }] };
      if (sql.includes('AS empty')) return { rows: [{ empty: allow }] };
      if (
        sql.startsWith(
          'SELECT account_id FROM whaleu_identity.provider_identities',
        )
      )
        return { rows: existing ? [{ account_id: 'account' }] : [] };
      if (sql.startsWith('SELECT status,lifecycle'))
        return {
          rows: [
            {
              status: 'active',
              lifecycle: 'active',
              session_revocation_epoch: '0',
            },
          ],
        };
      if (sql.includes('clock_timestamp() AS now')) return { rows: [{ now }] };
      if (sql.includes('INSERT INTO whaleu_identity.sessions'))
        return {
          rows: [
            {
              id: 'session',
              account_id: 'account',
              access_expires_at: new Date(now.getTime() + 1000),
              refresh_expires_at: new Date(now.getTime() + 2000),
            },
          ],
        };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(
      run: (client: PoolClient) => Promise<T>,
      options: { isolationLevel: string },
    ) => {
      assert.equal(options.isolationLevel, 'read committed');
      try {
        startTransactionDeadlines(tx);
        const value = await run(tx);
        await checkTransactionDeadlines(tx);
        committed = true;
        return value;
      } catch (e) {
        rolledBack = true;
        throw e;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as unknown as DatabaseService;
  return {
    repository: new IdentityRepository(database),
    queries,
    committed: () => committed,
    rolledBack: () => rolledBack,
  };
}

test('real repository first registration holds provider lock before guard and writes identity only after admission', async () => {
  const f = repositoryFixture(false);
  await f.repository.createSession(identity, {
    access: 'a'.repeat(64),
    refresh: 'b'.repeat(64),
  });
  const lock = f.queries.findIndex((s) => s.includes('pg_advisory_xact_lock'));
  const gate = f.queries.findIndex((s) => s.includes('to_jsonb(p) policy'));
  const insert = f.queries.findIndex((s) =>
    s.includes('INSERT INTO whaleu_identity.accounts'),
  );
  assert.ok(lock >= 0 && lock < gate && gate < insert);
  assert.equal(f.committed(), true);
});

test('denied first registration rolls back before profile, baseline, provider mapping or session writes', async () => {
  const f = repositoryFixture(false, false);
  await assert.rejects(
    f.repository.createSession(identity, {
      access: 'a'.repeat(64),
      refresh: 'b'.repeat(64),
    }),
    hasCode('AUTH_NOT_CONFIGURED'),
  );
  assert.equal(
    f.queries.some((s) => /INSERT|UPDATE|DELETE/.test(s)),
    false,
  );
  assert.equal(f.committed(), false);
  assert.equal(f.rolledBack(), true);
});

test('existing identity login retains current account lifecycle and session rules, never enters registration gate', async () => {
  const f = repositoryFixture(true, false);
  await f.repository.createSession(identity, {
    access: 'a'.repeat(64),
    refresh: 'b'.repeat(64),
  });
  assert.equal(
    f.queries.some((s) => s.includes('registration_guard')),
    false,
  );
  assert.equal(
    f.queries.some((s) => s.includes('SELECT status,lifecycle')),
    true,
  );
  assert.equal(f.committed(), true);
});
