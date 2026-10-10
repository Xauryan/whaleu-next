import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { RatingsAccessService } from '../src/ratings/access.js';
import { RatingVerificationFacade } from '../src/verification/rating-eligibility.facade.js';
import {
  RatingAuthorizationFacade,
  ratingGrantScope,
} from '../src/authorization/rating-grants.facade.js';
import { RatingSafetyFacade } from '../src/safety/rating.facade.js';
import { SafetyRepository } from '../src/safety/repository.js';
import { CampusRatingScopeFacade } from '../src/campus/rating-scope.facade.js';
import { IdentityService } from '../src/identity/identity.service.js';
import { ProfileRepository } from '../src/profile/profile.repository.js';
import {
  boundedOwnerProof,
  requiredOwnerEpoch,
} from '../src/database/required-owner-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-09T00:00:00.000Z');
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function sqlFixture(
  source: (
    sql: string,
    values: unknown[],
    final: boolean,
  ) => unknown[] = () => [],
) {
  const commands: { sql: string; values: unknown[] }[] = [];
  const state = {
    final: false,
    epoch: '0',
    capacity: 118,
    fence: true,
    lockFailure: false,
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        state.final = true;
        return { rows: [] };
      }
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: state.capacity,
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.lockFailure)
          throw Object.assign(new Error('synthetic NOWAIT conflict'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now }] };
      if (sql.includes('discovery_count_epochs'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.epoch,
          })),
        };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return {
          rows: Array.from({ length: 128 }, () => ({ locked: state.fence })),
        };
      if (sql.includes('pg_try_advisory_xact_lock('))
        return { rows: [{ locked: state.fence }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      return { rows: source(sql, values, state.final) };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, commands };
}
function accessFixture() {
  const calls: string[] = [];
  const state = {
    phone: 'verified',
    affiliation: 'unverified',
    temporary: 'unverified',
    grant: { kind: 'ordinary', fingerprint: 'g' } as {
      kind: string;
      regionId?: string;
      fingerprint: string;
    },
  };
  const identity = {
    activeAccount: async () => true,
    session: async () => {
      calls.push('session');
      return {
        accountId: id(1),
        sessionId: id(2),
        expiresAt: now.getTime() + 10000,
        refreshExpiresAt: now.getTime() + 20000,
      };
    },
  } as unknown as IdentityService;
  const verification = {
    phone: async () => {
      calls.push('phone');
      return { status: state.phone };
    },
    affiliation: async () => {
      calls.push('affiliation');
      return {
        status: state.affiliation,
        assertionId: id(3),
        snapshotId: id(4),
        institutionId: id(5),
        originRegionId: id(6),
        validUntil: null,
        fingerprint: 'a',
      };
    },
    temporary: async () => {
      calls.push('temporary');
      return { status: state.temporary };
    },
  } as unknown as RatingVerificationFacade;
  const authorization = {
    scope: async () => {
      calls.push('grant');
      return state.grant;
    },
  } as unknown as RatingAuthorizationFacade;
  const campus = {
    requireManaged: async () => {
      calls.push('managed');
      return 'm';
    },
    managed: async () => {
      calls.push('context-managed');
      return {
        homeRegion: null,
        regions: [
          { id: id(6), label: 'Synthetic region', relation: 'managed' },
        ],
      };
    },
    ordinary: async () => {
      calls.push('ordinary');
      return {
        homeRegion: { id: id(6), label: 'Synthetic region' },
        regions: [{ id: id(6), label: 'Synthetic region', relation: 'home' }],
        fingerprint: 'c',
      };
    },
  } as unknown as CampusRatingScopeFacade;
  const safety = {
    requireAllowed: async () => {
      calls.push('safety');
    },
    requireDeletionAllowed: async () => {
      calls.push('safety');
    },
    navigation: async () => {
      calls.push('safety-epoch');
      return 's';
    },
  } as unknown as RatingSafetyFacade;
  return {
    access: new RatingsAccessService(
      identity,
      verification,
      authorization,
      campus,
      safety,
    ),
    calls,
    state,
    tx: sqlFixture().tx,
  };
}
test('global target authority requires phone and safety but no affiliation or privileged/temporary base', async () => {
  const f = accessFixture();
  const result = await f.access.resolve('synthetic-token', null, f.tx, {
    phone: true,
  });
  assert.equal(result.regionId, null);
  assert.deepEqual(f.calls, ['session', 'phone', 'safety', 'safety-epoch']);
});
test('global categories omit only phone; receipt authentication omits safety and all domain authority', async () => {
  const f = accessFixture();
  await f.access.resolve('synthetic-token', null, f.tx, { phone: false });
  assert.deepEqual(f.calls, ['session', 'safety', 'safety-epoch']);
  f.calls.length = 0;
  await f.access.authenticate('synthetic-token', f.tx);
  assert.deepEqual(f.calls, ['session']);
});
test('known unverified phone rejects target access before scope lookup', async () => {
  const f = accessFixture();
  f.state.phone = 'unverified';
  await assert.rejects(
    f.access.resolve('x', null, f.tx, { phone: true }),
    errorIs('PHONE_VERIFICATION_REQUIRED'),
  );
  assert.deepEqual(f.calls, ['session', 'phone']);
});
test('ordinary regional access uses current affiliation and canonical Campus group', async () => {
  const f = accessFixture();
  f.state.affiliation = 'verified';
  await f.access.resolve('x', id(6), f.tx, { phone: false });
  assert.deepEqual(f.calls, [
    'session',
    'safety',
    'safety-epoch',
    'grant',
    'affiliation',
    'ordinary',
  ]);
});
test('fixed school administrators cannot select another region', async () => {
  const f = accessFixture();
  f.state.grant = { kind: 'fixed', regionId: id(6), fingerprint: 'fixed' };
  await assert.rejects(
    f.access.resolve('x', id(7), f.tx, { phone: false }),
    errorIs('RATING_SCOPE_UNAVAILABLE'),
  );
  assert.ok(!f.calls.includes('affiliation'));
});
test('context needs no phone; unknown affiliation is not an invented empty region set', async () => {
  const f = accessFixture();
  assert.deepEqual(await f.access.context('x', f.tx), {
    homeRegion: null,
    regions: [],
  });
  assert.ok(!f.calls.includes('phone'));
  f.state.affiliation = 'unavailable';
  await assert.rejects(
    f.access.context('x', f.tx),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
});
test('anonymous author mode separately accepts only affiliation, real grant or rating temporary fact', async () => {
  const f = accessFixture();
  assert.deepEqual(await f.access.authorModes(id(1), f.tx), ['named']);
  await assert.rejects(
    f.access.requireAnonymous(id(1), f.tx),
    errorIs('AFFILIATION_VERIFICATION_REQUIRED'),
  );
  f.state.temporary = 'verified';
  assert.deepEqual(await f.access.authorModes(id(1), f.tx), [
    'named',
    'anonymous',
  ]);
  f.state.temporary = 'unverified';
  f.state.affiliation = 'verified';
  f.calls.length = 0;
  await f.access.requireAnonymous(id(1), f.tx);
  assert.deepEqual(f.calls, ['affiliation']);
});
test('unknown anonymous base stays unavailable instead of granting anonymous or rejecting terminally', async () => {
  const f = accessFixture();
  f.state.temporary = 'unavailable';
  assert.deepEqual(await f.access.authorModes(id(1), f.tx), ['named']);
  await assert.rejects(
    f.access.requireAnonymous(id(1), f.tx),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
});
test('duplicate school grants fail closed even when identical; global grants remain truly global', () => {
  const school = {
    id: id(1),
    role: 'school_admin' as const,
    operatingRegionId: id(2),
    validUntil: null,
  };
  assert.throws(
    () => ratingGrantScope([school, { ...school, id: id(3) }], 'x'),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  assert.equal(
    ratingGrantScope(
      [{ ...school, role: 'developer', operatingRegionId: null }],
      'x',
    ).kind,
    'global',
  );
});
test('grant candidate lock is bounded and final proof catches future activation/expiry', async () => {
  let active = true;
  const f = sqlFixture((sql) => {
    if (sql.includes('role_grants'))
      return active
        ? [
            {
              id: id(1),
              role: 'developer',
              operatingRegionId: null,
              expiresAt: null,
              isFuture: false,
              validFrom: null,
              preciseFrom: null,
            },
          ]
        : [];
    return [];
  });
  await new RatingAuthorizationFacade().scope(id(2), f.tx);
  assert.match(
    f.commands.find((c) => c.sql.includes('FOR SHARE'))!.sql,
    /LIMIT 4 FOR SHARE/,
  );
  active = false;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
});
test('named list uses outgoing direction while direct uses bilateral; both retain negative epochs', async () => {
  const purposes: string[] = [];
  const records = {
    directions: async (_v: string, _a: string, p: string) => {
      purposes.push(p);
      return { outgoing: false, incoming: true };
    },
  } as unknown as SafetyRepository;
  const facade = new RatingSafetyFacade(records);
  const f = sqlFixture();
  assert.equal(
    (await facade.named(id(1), id(2), 'rating_list', f.tx)).kind,
    'allow',
  );
  assert.equal(
    (await facade.named(id(1), id(2), 'rating_direct', f.tx)).kind,
    'deny',
  );
  assert.deepEqual(purposes, ['rating_list', 'rating_direct']);
  f.state.epoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_UNAVAILABLE'),
  );
});
test('missing named coverage still registers a mandatory negative epoch', async () => {
  const facade = new RatingSafetyFacade({
    directions: async () => null,
  } as unknown as SafetyRepository);
  const f = sqlFixture();
  assert.equal(
    (await facade.named(id(1), id(2), 'rating_list', f.tx)).kind,
    'unavailable',
  );
  f.state.lockFailure = true;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_UNAVAILABLE'),
  );
});
test('Safety 128-slot protocol cannot silently expand or run outside a managed transaction', async () => {
  const facade = new RatingSafetyFacade({} as SafetyRepository);
  const f = sqlFixture();
  f.state.capacity = 128;
  await assert.rejects(facade.navigation(f.tx), errorIs('SAFETY_UNAVAILABLE'));
  await assert.rejects(
    facade.navigation({
      query: async () => ({ rows: [] }),
    } as unknown as PoolClient),
    errorIs('SAFETY_UNAVAILABLE'),
  );
});
test('owner epochs are independently required, and unchanged proof succeeds only after deferred flush', async () => {
  const owner = {
    order: 1,
    capture: async () =>
      Array.from({ length: 128 }, (_, slot) => ({
        slot,
        version: 1,
        epoch: '0',
      })),
    fence: async () => true,
  };
  const capture = requiredOwnerEpoch(owner, 'SAFETY_UNAVAILABLE'),
    f = sqlFixture();
  await capture(f.tx);
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.commands[1]?.sql, 'SET CONSTRAINTS ALL IMMEDIATE');
});
test('NOWAIT conflict is an owner error, never optional downgrade or retry/blocking fence', async () => {
  const f = sqlFixture();
  f.state.lockFailure = true;
  await assert.rejects(
    boundedOwnerProof(f.tx, 'VERIFICATION_UNAVAILABLE', async (read) => {
      await read.query('LOCK TABLE synthetic IN SHARE MODE NOWAIT');
    }),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
  assert.equal(
    f.commands.filter((c) => c.sql.startsWith('LOCK TABLE')).length,
    1,
  );
  assert.ok(
    f.commands.some(
      (c) => c.sql.includes('set_config') && c.values[1] === '1ms',
    ),
  );
});
function verificationRow() {
  return {
    id: id(3),
    snapshot_id: id(4),
    account_id: id(1),
    fact_kind: 'phone',
    assertion_state: 'verified',
    coverage_state: 'complete',
    provenance_state: 'accepted',
    method: 'phone_provider',
    source_reference: 'synthetic-source',
    policy_reference: 'synthetic-policy',
    source_account_id: id(1),
    issuer_institution_id: null,
    source_issuer_institution_id: null,
    origin_region_id: null,
    phone_binding_reference: 'synthetic-not-a-phone',
    verified_at: new Date(now.getTime() - 1000),
    expiry_kind: 'policy_exempt',
    expires_at: null,
    now,
    exact_time: true,
  };
}
test('Verification exact SQL fact rejects future verified_at flattened into the same JS millisecond', async () => {
  const row = { ...verificationRow(), verified_at: now, exact_time: false };
  const f = sqlFixture((sql) =>
    sql.includes('JOIN whaleu_verification.assertions') ? [row] : [],
  );
  assert.equal(
    (await new RatingVerificationFacade().phone(id(1), f.tx)).status,
    'unavailable',
  );
  assert.ok(
    f.commands.some((c) => c.sql.includes('a.verified_at<=instant.now')),
  );
  row.exact_time = true;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
});
test('Verification positive/negative facts use source fences and current SQL final time', async () => {
  const row = verificationRow();
  const f = sqlFixture((sql) =>
    sql.includes('JOIN whaleu_verification.assertions') ? [row] : [],
  );
  assert.equal(
    (await new RatingVerificationFacade().phone(id(1), f.tx)).status,
    'verified',
  );
  await checkTransactionDeadlines(f.tx);
  assert.ok(
    f.commands.some(
      (c) =>
        c.sql.startsWith('LOCK TABLE whaleu_verification.account_heads') &&
        c.sql.endsWith('NOWAIT'),
    ),
  );
});
test('rating temporary base never reads errand base, and its absent-to-present transition fails final proof', async () => {
  let present = false;
  const f = sqlFixture((sql) =>
    sql.includes('JOIN whaleu_verification.rating_base_assertions') && present
      ? [
          {
            id: id(8),
            status: 'verified',
            valid_until: new Date(now.getTime() + 10000),
          },
        ]
      : [],
  );
  const facade = new RatingVerificationFacade();
  assert.equal((await facade.temporary(id(1), f.tx)).status, 'unavailable');
  present = true;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
  assert.ok(f.commands.every((c) => !c.sql.includes('errand_base')));
});
test('Profile rating projection is row-locked before reread, contains no experience or implicit creation', async () => {
  const f = sqlFixture((sql) =>
    sql.includes('coalesce(nickname')
      ? [{ profileId: id(5), displayName: 'Synthetic display' }]
      : [],
  );
  const repository = Object.create(
    ProfileRepository.prototype,
  ) as ProfileRepository;
  assert.deepEqual(await repository.ratingAuthorDisplay(id(1), f.tx), {
    profileId: id(5),
    displayName: 'Synthetic display',
  });
  assert.match(f.commands[0]!.sql, /FOR SHARE$/);
  assert.ok(
    f.commands.every(
      (c) => !/INSERT|experience|student|phone|campus/i.test(c.sql),
    ),
  );
});

test('Campus exact SQL rejects future-effective scope even when legacy Date validation says valid', async () => {
  const policy = {
    resolve: async () => ({
      status: 'valid',
      selectionId: id(11),
      topologySnapshotId: id(12),
      identityRegionId: id(6),
      relation: 'home',
    }),
  } as unknown as ConstructorParameters<typeof CampusRatingScopeFacade>[0];
  const f = sqlFixture((sql) =>
    sql.includes('FROM whaleu_campus.community_identity_heads h')
      ? [{ valid: false }]
      : [],
  );
  await assert.rejects(
    new CampusRatingScopeFacade(policy).ordinary(
      id(1),
      {
        assertionId: id(3),
        snapshotId: id(4),
        institutionId: id(5),
        originRegionId: id(6),
        validUntil: null,
      },
      id(6),
      f.tx,
    ),
    errorIs('IDENTITY_CAMPUS_UNAVAILABLE'),
  );
  assert.ok(
    f.commands.some(
      (c) =>
        c.sql.includes('s.effective_at<=instant.now') &&
        c.sql.includes('t.effective_at<=instant.now'),
    ),
  );
});
test('Campus positive selection/topology must remain current after all deferred waits', async () => {
  let current = true;
  const policy = {
    resolve: async () => ({
      status: 'valid',
      selectionId: id(11),
      topologySnapshotId: id(12),
      identityRegionId: id(6),
      relation: 'home',
    }),
  } as unknown as ConstructorParameters<typeof CampusRatingScopeFacade>[0];
  const topology = {
    version: 1,
    groups: [{ groupId: id(13), coverage: 'complete', isActive: true }],
    regions: [
      {
        regionId: id(6),
        institutionId: id(5),
        groupId: id(13),
        coverage: 'complete',
        isActive: true,
      },
    ],
    assignments: [],
  };
  const f = sqlFixture((sql) => {
    if (sql.includes('FROM whaleu_campus.community_identity_heads h'))
      return [{ valid: current }];
    if (sql.includes('SELECT snapshot_id,revision'))
      return [{ snapshot_id: id(12), revision: 1 }];
    if (
      sql.includes('SELECT * FROM whaleu_campus.community_topology_snapshots')
    )
      return [{ id: id(12), revision: 1, topology }];
    if (sql.includes('SELECT id,name label'))
      return [{ id: id(6), label: 'Synthetic region', active: true }];
    return [];
  });
  const result = await new CampusRatingScopeFacade(policy).ordinary(
    id(1),
    {
      assertionId: id(3),
      snapshotId: id(4),
      institutionId: id(5),
      originRegionId: id(6),
      validUntil: null,
    },
    id(6),
    f.tx,
  );
  assert.deepEqual(result.homeRegion, { id: id(6), label: 'Synthetic region' });
  current = false;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('IDENTITY_CAMPUS_UNAVAILABLE'),
  );
});
test('managed region projection never acquires affiliation or selection, and caps returned directory', async () => {
  const campus = new CampusRatingScopeFacade({
    resolve: async () =>
      assert.fail('managed scope must not require a personal campus'),
  } as unknown as ConstructorParameters<typeof CampusRatingScopeFacade>[0]);
  const f = sqlFixture((sql) =>
    sql.includes('SELECT id,name label')
      ? [{ id: id(6), label: 'Synthetic region', active: true }]
      : [],
  );
  assert.deepEqual((await campus.managed(id(6), f.tx)).regions, [
    { id: id(6), label: 'Synthetic region', relation: 'managed' },
  ]);
  assert.ok(f.commands.every((c) => !c.sql.includes('community_identity')));
  await checkTransactionDeadlines(f.tx);
  const over = sqlFixture((sql) =>
    sql.includes('SELECT id,name label')
      ? Array.from({ length: 201 }, (_, i) => ({
          id: id(i),
          label: 'Synthetic region',
          active: true,
        }))
      : [],
  );
  await assert.rejects(
    campus.managed(null, over.tx),
    errorIs('IDENTITY_CAMPUS_UNAVAILABLE'),
  );
});

test('future school grant activation is a deadline even when the last grant proof still observes it as future', async () => {
  const starts = new Date(now.getTime() - 1);
  const f = sqlFixture((sql) =>
    sql.includes('valid_from>instant.now')
      ? [
          {
            id: id(50),
            validFrom: starts,
            preciseFrom: '2026-10-08 23:59:59.999999+00',
            role: null,
            operatingRegionId: null,
            expiresAt: null,
            isFuture: true,
          },
        ]
      : [],
  );
  const result = await new RatingAuthorizationFacade().scope(id(1), f.tx);
  assert.equal(result.kind, 'ordinary');
  // Both owner snapshots agree, but the later final database clock crosses the
  // registered activation. This is the tiny post-owner-proof boundary case.
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  assert.ok(
    f.commands
      .filter((c) => c.sql.includes('valid_from>instant.now'))
      .every((c) => c.sql.includes('LIMIT 1')),
  );
});

test('grant current and upcoming horizon use one snapshot so cross-clock activation cannot vanish', async () => {
  for (const future of [true, false]) {
    const f = sqlFixture((sql, _values, final) => {
      if (!sql.includes('active AS MATERIALIZED') || !final) return [];
      return [
        {
          id: id(70),
          role: future ? null : 'school_admin',
          operatingRegionId: future ? null : id(71),
          expiresAt: null,
          validFrom: future ? new Date(now.getTime() + 1000) : null,
          preciseFrom: future ? '2026-10-09 00:00:01.000001+00' : null,
          isFuture: future,
        },
      ];
    });
    assert.equal(
      (await new RatingAuthorizationFacade().scope(id(1), f.tx)).kind,
      'ordinary',
    );
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
    const reads = f.commands.filter((c) =>
      c.sql.includes('active AS MATERIALIZED'),
    );
    assert.equal(reads.length, 2);
    for (const { sql } of reads) {
      assert.equal((sql.match(/clock_timestamp\(\)/g) ?? []).length, 1);
      assert.match(sql, /valid_from<=instant.now/);
      assert.match(sql, /valid_from>instant.now/);
      assert.match(sql, /LIMIT 4/);
      assert.match(sql, /LIMIT 1/);
    }
  }
});

test('owner cleanup retains global phone and safety gates without school or anonymous authority', async () => {
  const f = accessFixture();
  f.state.affiliation = 'unavailable';
  f.state.grant = { kind: 'fixed', regionId: id(90), fingerprint: 'foreign' };
  const result = await f.access.requireDeletionActor(id(1), f.tx);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls, ['phone', 'safety', 'safety-epoch']);
});

test('owner cleanup fails closed on missing phone and keeps unverified distinct', async () => {
  for (const [status, code] of [
    ['unavailable', 'VERIFICATION_UNAVAILABLE'],
    ['unverified', 'PHONE_VERIFICATION_REQUIRED'],
  ]) {
    const f = accessFixture();
    f.state.phone = status!;
    await assert.rejects(
      f.access.requireDeletionActor(id(1), f.tx),
      errorIs(code!),
    );
    assert.deepEqual(f.calls, ['phone']);
  }
});

test('cleanup restriction rejection preserves finite Safety coverage through final constraint waits', async () => {
  const f = sqlFixture();
  const facade = new RatingSafetyFacade({
    restriction: async () => {
      throw new ApplicationError('SAFETY_ACTION_RESTRICTED');
    },
    head: async () => ({ valid_until: new Date(now.getTime() - 1) }),
  } as unknown as SafetyRepository);
  await assert.rejects(
    facade.requireDeletionAllowed(id(1), f.tx),
    errorIs('SAFETY_ACTION_RESTRICTED'),
  );
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_UNAVAILABLE'),
  );
});
