import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { AccountIdentityProfileService } from '../src/profile/account-identity-profile.service.js';
import type { CampusService } from '../src/campus/campus.service.js';
import { AuthorizationRepository } from '../src/authorization/authorization.repository.js';
import {
  capabilitiesFromGrants,
  canManageRegion,
} from '../src/authorization/contracts.js';
import type { ActiveGrant } from '../src/authorization/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  identityBatchSchema,
  UnavailableStudentIdentitySource,
} from '../src/identity-privacy/contracts.js';
import type { StudentIdentitySource } from '../src/identity-privacy/contracts.js';
import { PrivateIdentityRepository } from '../src/identity-privacy/private-identity.repository.js';

const region = randomUUID();
const school: ActiveGrant = {
  id: randomUUID(),
  role: 'school_admin',
  operatingRegionId: region,
  validUntil: null,
};
const superAdmin: ActiveGrant = {
  id: randomUUID(),
  role: 'super_admin',
  operatingRegionId: null,
  validUntil: null,
};
const developer: ActiveGrant = {
  id: randomUUID(),
  role: 'developer',
  operatingRegionId: null,
  validUntil: null,
};
test('hierarchy grants global management only to top roles and identity views only to developer', () => {
  for (const [grants, role, global, privateIdentity] of [
    [[], 'member', false, false],
    [[school], 'school_admin', false, false],
    [[school, superAdmin], 'super_admin', true, false],
    [[school, superAdmin, developer], 'developer', true, true],
  ] as const) {
    const capabilities = capabilitiesFromGrants(grants);
    assert.equal(capabilities.role, role);
    assert.equal(capabilities.management.global, global);
    assert.equal(capabilities.identityView.allowed, privateIdentity);
    assert.equal(capabilities.identityView.maxBatchSize, 20);
  }
  assert.equal(canManageRegion([school], region), true);
  assert.equal(canManageRegion([school], randomUUID()), false);
  assert.equal(canManageRegion([school], null), false);
  assert.equal(canManageRegion([], region), false);
  assert.equal(canManageRegion([superAdmin], null), true);
  assert.equal(canManageRegion([developer], randomUUID()), true);
});

test('active grant query uses database expiry/revocation conditions and locks scope; malformed rows fail closed', async () => {
  const statements: string[] = [];
  let active = true;
  const now = new Date('2026-01-01T00:00:00Z');
  let expiresAt: Date | null = null;
  let grants: ActiveGrant[] = [school, superAdmin];
  const transaction = {
    query: async (sql: string) => {
      statements.push(sql);
      return {
        rows: sql.includes('FROM whaleu_authorization')
          ? grants.map((grant) => ({
              ...grant,
              validFrom: new Date(0),
              expiresAt,
            }))
          : [{ now }],
      };
    },
  } as unknown as PoolClient;
  const campus = {
    requireActiveRegion: async () => {
      if (!active) throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
      return { id: region, name: 'synthetic', isActive: true };
    },
  } as unknown as CampusService;
  const repository = new AuthorizationRepository(campus);
  assert.deepEqual(
    await repository.activeGrants(randomUUID(), transaction),
    grants,
  );
  assert.match(statements[0]!, /revoked_at IS NULL/);
  assert.match(statements[0]!, /expires_at > clock_timestamp\(\)/);
  assert.match(statements[0]!, /valid_from <= clock_timestamp\(\)/);
  assert.match(statements[0]!, /FOR SHARE/);
  assert.equal(statements[1], 'SELECT clock_timestamp() AS now');
  expiresAt = new Date(now);
  assert.deepEqual(
    await repository.activeGrants(randomUUID(), transaction),
    [],
  );
  expiresAt = null;
  active = false;
  assert.deepEqual(await repository.activeGrants(randomUUID(), transaction), [
    superAdmin,
  ]);
  grants = [{ ...developer, operatingRegionId: region }];
  await assert.rejects(
    repository.activeGrants(randomUUID(), transaction),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'AUTHORIZATION_UNAVAILABLE',
  );
});

test('identity batch rejects owner/scope/client role input, duplicates and overflow', () => {
  const target = { kind: 'post', id: randomUUID() };
  assert.equal(
    identityBatchSchema.safeParse({ targets: [target] }).success,
    true,
  );
  for (const body of [
    { targets: [] },
    { targets: [target, target] },
    {
      targets: Array.from({ length: 21 }, () => ({
        kind: 'post',
        id: randomUUID(),
      })),
    },
    { targets: [target], role: 'developer' },
    { targets: [{ ...target, accountId: randomUUID() }] },
    { targets: [{ ...target, operatingRegionId: region }] },
    { targets: [{ kind: 'account', id: randomUUID() }] },
    { targets: [target, { ...target, id: target.id.toUpperCase() }] },
  ])
    assert.equal(identityBatchSchema.safeParse(body).success, false);
});

test('default student source reports unavailable and never derives student numbers from account UUID', async () => {
  const accountId = randomUUID();
  const transaction = {} as PoolClient;
  const profiles = {
    find: async () => null,
  } as unknown as AccountIdentityProfileService;
  const source = new PrivateIdentityRepository(
    new UnavailableStudentIdentitySource(),
    profiles,
  );
  assert.deepEqual(await source.resolve(accountId, transaction), {
    accountId,
    nickname: null,
    avatar: null,
    studentNumber: null,
    studentNumberStatus: 'unavailable',
  });
  const verified = new PrivateIdentityRepository(
    {
      resolve: async () => ({
        status: 'verified',
        studentNumber: '00001234',
        validUntil: null,
      }),
    },
    profiles,
  );
  assert.equal(
    (await verified.resolve(accountId, transaction))?.studentNumber,
    '00001234',
  );
  const unverified = new PrivateIdentityRepository(
    {
      resolve: async () => ({
        status: 'unverified',
        studentNumber: 'not-for-display',
      }),
    },
    profiles,
  );
  assert.equal(
    (await unverified.resolve(accountId, transaction))?.studentNumber,
    null,
  );
  for (const number of ['', ' ', 'bad\nvalue', 'x'.repeat(101)]) {
    const malformed = new PrivateIdentityRepository(
      {
        resolve: async () => ({
          status: 'verified',
          studentNumber: number,
          validUntil: null,
        }),
      },
      profiles,
    );
    await assert.rejects(
      malformed.resolve(accountId, transaction),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'IDENTITY_VIEW_UNAVAILABLE',
    );
  }
});

test('verified sources must supply a finite bound or explicit non-expiring policy; metadata never joins identity DTO', async () => {
  const profiles = {
    find: async () => null,
  } as unknown as AccountIdentityProfileService;
  for (const bound of [undefined, NaN, Infinity, '9999999999999']) {
    const source = {
      resolve: async () => ({
        status: 'verified',
        studentNumber: '00001234',
        validUntil: bound,
      }),
    } as unknown as StudentIdentitySource;
    await assert.rejects(
      new PrivateIdentityRepository(source, profiles).snapshot(
        randomUUID(),
        {} as PoolClient,
      ),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'IDENTITY_VIEW_UNAVAILABLE',
    );
  }
  const source: StudentIdentitySource = {
    resolve: async () => ({
      status: 'verified',
      studentNumber: '00001234',
      validUntil: 1000,
    }),
  };
  const snapshot = await new PrivateIdentityRepository(
    source,
    profiles,
  ).snapshot(randomUUID(), {} as PoolClient);
  assert.equal(snapshot.validUntil, 1000);
  assert.equal('validUntil' in snapshot.identity, false);
});
