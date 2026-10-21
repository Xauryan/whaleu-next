import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  profileDetailsPatchSchema,
  emptyProfileDetails,
  publicProfileDetails,
} from '../src/profile-details/contracts.js';
import type { ProfileDetails } from '../src/profile-details/contracts.js';
import { ProfileDetailsRepository } from '../src/profile-details/repository.js';
import { ProfileDetailsService } from '../src/profile-details/service.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { PublicProfileFacade } from '../src/profile/public-profile.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const fields = {
  region: null,
  gender: null,
  age: null,
  showRegion: false,
  showGender: false,
  showAge: false,
};
test('strict optional details reject birthdays, inferred identifiers, malformed ages and partial consent', () => {
  assert.deepEqual(
    profileDetailsPatchSchema.parse({
      expectedRevision: 0,
      ...fields,
      region: '  北京  ',
    }),
    { expectedRevision: 0, ...fields, region: '北京' },
  );
  for (const patch of [
    { birthDate: '2000-01-01' },
    { accountId: randomUUID() },
    { age: -1 },
    { age: 121 },
    { age: 1.5 },
    { gender: 'unknown' },
    { gender: 'other' },
    { region: 'x'.repeat(81) },
    { region: 'x\ny' },
    { showAge: 'true' },
    { expectedRevision: 2147483647 },
  ])
    assert.equal(
      profileDetailsPatchSchema.safeParse({
        expectedRevision: 0,
        ...fields,
        ...patch,
      }).success,
      false,
    );
  assert.equal(
    profileDetailsPatchSchema.safeParse({ expectedRevision: 0 }).success,
    false,
  );
});
test('public projection minimizes data and requires each field opt-in independently', () => {
  const own = {
    ...emptyProfileDetails(randomUUID()),
    region: '北京',
    gender: 'male' as const,
    age: 23,
  };
  const profileId = randomUUID();
  assert.deepEqual(publicProfileDetails(profileId, own), {
    status: 'available',
    profileId,
    region: null,
    gender: null,
    age: null,
  });
  assert.deepEqual(
    publicProfileDetails(profileId, {
      ...own,
      showRegion: true,
      showAge: true,
    }),
    { status: 'available', profileId, region: '北京', gender: null, age: 23 },
  );
  assert.ok(
    !JSON.stringify(publicProfileDetails(profileId, own)).includes(
      own.accountId,
    ),
  );
});
test('repository absent row defaults are private; CAS rejects stale edits without writing', async () => {
  const id = randomUUID();
  let row: ProfileDetails | undefined;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string, p: unknown[]) => {
      calls.push(sql);
      if (sql.startsWith('SELECT account_id'))
        return { rows: row ? [row] : [] };
      if (sql.startsWith('INSERT'))
        row = {
          accountId: id,
          revision: p[1] as number,
          region: p[2] as string | null,
          gender: p[3] as ProfileDetails['gender'],
          age: p[4] as number | null,
          showRegion: p[5] as boolean,
          showGender: p[6] as boolean,
          showAge: p[7] as boolean,
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new ProfileDetailsRepository();
  assert.deepEqual(await repository.read(id, tx), emptyProfileDetails(id));
  assert.equal(
    (
      await repository.update(
        id,
        { expectedRevision: 0, ...fields, age: 25 },
        tx,
      )
    ).revision,
    1,
  );
  await assert.rejects(
    repository.update(
      id,
      { expectedRevision: 0, ...fields, showAge: true },
      tx,
    ),
    (error) =>
      (error as { code?: string }).code === 'PROFILE_DETAILS_REVISION_CONFLICT',
  );
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT')).length, 1);
  assert.equal(row!.showAge, false);
  assert.ok(calls.some((sql) => sql.includes('pg_advisory_xact_lock(')));
});
test('public service honors current profile access and never falls back to guest for invalid credentials', async () => {
  const id = randomUUID(),
    profileId = randomUUID();
  let active = true,
    visible = true,
    exists = true,
    invalidToken = false;
  let reads = 0;
  const tx = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
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
      if (invalidToken) throw new Error('expired');
      return { accountId: randomUUID() };
    },
    activeAccount: async () => active,
  } as unknown as IdentityService;
  const profiles = {
    find: async () => (exists ? { accountId: id } : null),
  } as unknown as PublicProfileFacade;
  const visibility = {
    read: async () => ({ status: visible ? 'available' : 'unavailable' }),
  } as unknown as ProfileVisibilityFacade;
  const details = {
    lock: async () => undefined,
    read: async () => {
      reads++;
      return { ...emptyProfileDetails(id), age: 23, showAge: true };
    },
  } as unknown as ProfileDetailsRepository;
  const service = new ProfileDetailsService(
    database,
    identity,
    profiles,
    visibility,
    details,
  );
  assert.deepEqual(await service.public(null, profileId), {
    status: 'available',
    profileId,
    region: null,
    gender: null,
    age: 23,
  });
  visible = false;
  assert.deepEqual(await service.public('token', profileId), {
    status: 'unavailable',
    profileId,
  });
  visible = true;
  active = false;
  assert.equal(
    (await service.public('token', profileId)).status,
    'unavailable',
  );
  active = true;
  exists = false;
  assert.equal(
    (await service.public('token', profileId)).status,
    'unavailable',
  );
  assert.equal(reads, 1);
  exists = true;
  invalidToken = true;
  await assert.rejects(service.public('bad', profileId));
  assert.equal(reads, 1);
});

test('OpenAPI owns only the details and own stats routes and public schema cannot expose account or consent controls', async () => {
  const { createProfileDetailsOpenApiDocument } =
    await import('../scripts/profile-details-openapi-document.js');
  const doc = createProfileDetailsOpenApiDocument();
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    '/v1/me/profile-details',
    '/v1/me/profile-stats',
    '/v1/profiles/{profileId}/details',
  ]);
  assert.ok(doc.paths['/v1/me/profile-details']?.get);
  assert.ok(doc.paths['/v1/me/profile-details']?.patch);
  const publicSchema = JSON.stringify(
    doc.components!.schemas!['PublicProfileDetails'],
  );
  for (const key of [
    'accountId',
    'showRegion',
    'showGender',
    'showAge',
    'birthDate',
  ])
    assert.ok(!publicSchema.includes(key));
});

test('age zero remains a deliberate value while null and individual privacy toggles remain independent', () => {
  const profileId = randomUUID(),
    own = { ...emptyProfileDetails(randomUUID()), age: 0, showAge: true };
  assert.equal(
    profileDetailsPatchSchema.parse({ expectedRevision: 0, ...fields, age: 0 })
      .age,
    0,
  );
  assert.deepEqual(publicProfileDetails(profileId, own), {
    status: 'available',
    profileId,
    region: null,
    gender: null,
    age: 0,
  });
  assert.deepEqual(publicProfileDetails(profileId, { ...own, age: null }), {
    status: 'available',
    profileId,
    region: null,
    gender: null,
    age: null,
  });
});

test('legacy unsupported gender reads redact only that field and revoke its visibility', async () => {
  const accountId = randomUUID();
  const legacy = {
    ...emptyProfileDetails(accountId),
    revision: 7,
    region: '北京',
    age: 25,
    gender: 'other',
    showGender: true,
    showRegion: true,
    showAge: false,
  };
  const tx = {
    query: async () => ({ rows: [legacy] }),
  } as unknown as PoolClient;
  const actual = await new ProfileDetailsRepository().read(accountId, tx);
  assert.deepEqual(actual, { ...legacy, gender: null, showGender: false });
  const publicView = publicProfileDetails(randomUUID(), actual);
  assert.equal(publicView.status, 'available');
  assert.ok(publicView.status === 'available');
  assert.equal(publicView.gender, null);
});
