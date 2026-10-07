import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { CampusService } from '../src/campus/campus.service.js';
import { campusQuerySchema } from '../src/campus/contracts.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { configureHttp } from '../src/http/http.js';
import { IdentityService } from '../src/identity/identity.service.js';
import {
  campusSelectionSchema,
  preferenceDefaults,
  preferencesPatchSchema,
  profilePatchSchema,
} from '../src/profile/contracts.js';
import { ProfileService } from '../src/profile/profile.service.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const campusId = '22222222-2222-4222-8222-222222222222';
const token = `wu_a_${'A'.repeat(43)}`;

test('campus query accepts only bounded, non-coerced query strings with explicit defaults', () => {
  assert.deepEqual(campusQuerySchema.parse({}), { page: 1, pageSize: 20 });
  assert.deepEqual(
    campusQuerySchema.parse({
      q: ' 示例 ',
      district: ' 甲 ',
      page: '2',
      pageSize: '100',
    }),
    { q: '示例', district: '甲', page: 2, pageSize: 100 },
  );
  for (const key of ['q', 'district']) {
    assert.equal(
      campusQuerySchema.safeParse({ [key]: '🐳'.repeat(100) }).success,
      true,
    );
    assert.equal(
      campusQuerySchema.safeParse({ [key]: '🐳'.repeat(101) }).success,
      false,
    );
  }
  for (const value of [
    { page: '0' },
    { page: '-1' },
    { page: '10001' },
    { page: '1.0' },
    { page: '1e1' },
    { page: 1 },
    { pageSize: '101' },
    { pageSize: ['1', '2'] },
    { pageSize: '01' },
    { q: 'x'.repeat(101) },
    { q: 'bad\u0000search' },
    { q: '\ud800' },
    { district: 'bad\u007ftext' },
    { district: '' },
    { q: { injected: true } },
    { includeSecrets: '1' },
  ])
    assert.equal(
      campusQuerySchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
});

test('profile patch preserves supported nickname and bio bounds with Unicode-safe biography length', () => {
  assert.deepEqual(
    profilePatchSchema.parse({
      expectedRevision: 0,
      nickname: ' 泡泡_#&@.+-123 ',
    }),
    { expectedRevision: 0, nickname: '泡泡_#&@.+-123' },
  );
  assert.equal(
    profilePatchSchema.safeParse({
      expectedRevision: 0,
      nickname: 'x'.repeat(20),
    }).success,
    true,
  );
  assert.equal(
    profilePatchSchema.safeParse({ expectedRevision: 0, bio: '🐳'.repeat(100) })
      .success,
    true,
  );
  assert.deepEqual(
    profilePatchSchema.parse({ expectedRevision: 0, bio: ' 甲\r\n乙 ' }),
    { expectedRevision: 0, bio: '甲\n乙' },
  );
  for (const value of [
    { expectedRevision: 0 },
    { expectedRevision: '0', nickname: 'valid' },
    { expectedRevision: -1, nickname: 'valid' },
    { expectedRevision: 2147483647, nickname: 'valid' },
    { expectedRevision: 1.5, nickname: 'valid' },
    { expectedRevision: 0, nickname: '' },
    { expectedRevision: 0, nickname: null },
    { expectedRevision: 0, nickname: 'x'.repeat(21) },
    { expectedRevision: 0, nickname: 'has space' },
    { expectedRevision: 0, nickname: '🐳' },
    { expectedRevision: 0, bio: '🐳'.repeat(101) },
    { expectedRevision: 0, bio: 'a\n'.repeat(6) + 'z' },
    { expectedRevision: 0, bio: 'bad\u0000value' },
    { expectedRevision: 0, bio: '\ud800' },
    { expectedRevision: 0, nickname: 'valid', accountId: 'victim' },
    { expectedRevision: 0, nickname: 'valid', verifiedInstitutionId: campusId },
    { expectedRevision: 0, nickname: 'valid', adminScope: campusId },
    {
      expectedRevision: 0,
      nickname: 'valid',
      avatarUrl: 'https://example.test/image',
    },
  ])
    assert.equal(
      profilePatchSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
});

test('preferences are typed known booleans, empty patches and conflicting comment modes reject', () => {
  assert.equal(preferenceDefaults.showOfficialAccountTip, true);
  assert.equal(preferenceDefaults.activitySubscribed, true);
  assert.equal(preferenceDefaults.hideProfilePosts, false);
  assert.equal(preferenceDefaults.defaultAnonymousEnabled, false);
  for (const key of Object.keys(preferenceDefaults)) {
    assert.equal(
      preferencesPatchSchema.safeParse({
        expectedRevision: 0,
        preferences: { [key]: true },
      }).success,
      true,
    );
    assert.equal(
      preferencesPatchSchema.safeParse({
        expectedRevision: 0,
        preferences: { [key]: '1' },
      }).success,
      false,
    );
  }
  for (const preferences of [
    {},
    { unknown: true },
    { hideProfilePosts: 1 },
    { hideProfilePosts: null },
    {
      defaultCommentAnonymousEnabled: true,
      defaultCommentNonAnonymousEnabled: true,
    },
  ])
    assert.equal(
      preferencesPatchSchema.safeParse({ expectedRevision: 0, preferences })
        .success,
      false,
    );
  assert.equal(
    campusSelectionSchema.safeParse({ expectedRevision: 0, campusId }).success,
    true,
  );
  for (const value of [
    { expectedRevision: 0, campusId: null },
    { expectedRevision: 0, campusId: '1' },
    { expectedRevision: 0, campusId, accountId },
    { expectedRevision: 0, campusId, verified: true },
  ])
    assert.equal(campusSelectionSchema.safeParse(value).success, false);
});

let app: INestApplication;
let calls: unknown[][] = [];
let authFailure: string | undefined;
const profile = {
  accountId,
  nickname: null,
  bio: '',
  selectedCampus: null,
  revision: 0,
  preferences: { ...preferenceDefaults },
};

before(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .overrideProvider(IdentityService)
    .useValue({
      session: async (provided: string) => {
        assert.equal(provided, token);
        if (authFailure) throw new ApplicationError('SESSION_REVOKED');
        return { accountId };
      },
    })
    .overrideProvider(CampusService)
    .useValue({
      list: async (query: unknown) => {
        calls.push(['list', query]);
        return { items: [], page: 1, pageSize: 20, total: 0 };
      },
    })
    .overrideProvider(ProfileService)
    .useValue(
      Object.fromEntries(
        ['get', 'update', 'updatePreferences', 'selectCampus'].map(
          (operation) => [
            operation,
            async (...args: unknown[]) => {
              calls.push([operation, ...args]);
              return profile;
            },
          ],
        ),
      ),
    )
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
});
after(async () => {
  await app?.close();
});

test('directory is public while own routes require identity facade authentication', async () => {
  await request(app.getHttpServer()).get('/v1/campuses').expect(200);
  for (const operation of [
    () => request(app.getHttpServer()).get('/v1/me/profile'),
    () =>
      request(app.getHttpServer())
        .patch('/v1/me/profile')
        .send({ expectedRevision: 0, bio: '' }),
    () =>
      request(app.getHttpServer())
        .patch('/v1/me/preferences')
        .send({ expectedRevision: 0, preferences: { hideProfilePosts: true } }),
    () =>
      request(app.getHttpServer())
        .put('/v1/me/campus')
        .send({ expectedRevision: 0, campusId }),
  ]) {
    const response = await operation().expect(401);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'AUTHENTICATION_REQUIRED',
    );
  }
  calls = [];
  authFailure = 'revoked';
  try {
    await request(app.getHttpServer())
      .get('/v1/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    assert.deepEqual(calls, []);
  } finally {
    authFailure = undefined;
  }
});

test('strict HTTP own writes take account only from the authenticated facade', async () => {
  calls = [];
  const auth = `Bearer ${token}`;
  await request(app.getHttpServer())
    .get('/v1/me/profile')
    .set('Authorization', auth)
    .expect(200);
  await request(app.getHttpServer())
    .patch('/v1/me/profile')
    .set('Authorization', auth)
    .send({ expectedRevision: 0, nickname: '泡泡' })
    .expect(200);
  await request(app.getHttpServer())
    .patch('/v1/me/preferences')
    .set('Authorization', auth)
    .send({ expectedRevision: 0, preferences: { hideProfilePosts: true } })
    .expect(200);
  await request(app.getHttpServer())
    .put('/v1/me/campus')
    .set('Authorization', auth)
    .send({ expectedRevision: 0, campusId })
    .expect(200);
  assert.deepEqual(calls, [
    ['get', accountId],
    ['update', accountId, { expectedRevision: 0, nickname: '泡泡' }],
    [
      'updatePreferences',
      accountId,
      { expectedRevision: 0, preferences: { hideProfilePosts: true } },
    ],
    ['selectCampus', accountId, { expectedRevision: 0, campusId }],
  ]);
});

test('HTTP rejects authority escalation, missing revisions, coercion and query pollution before service', async () => {
  calls = [];
  for (const body of [
    { nickname: 'valid' },
    { expectedRevision: 0, nickname: 'valid', accountId },
    { expectedRevision: 0, nickname: 'valid', verifiedInstitutionId: campusId },
    { expectedRevision: 0, nickname: 'valid', fixedAdminScope: campusId },
  ]) {
    const result = await request(app.getHttpServer())
      .patch('/v1/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(400);
    assert.equal(
      (result.body as { error: { code: string } }).error.code,
      'BAD_REQUEST',
    );
  }
  for (const query of [
    'page=1&page=2',
    'pageSize=0',
    'q=x&q=y',
    'accountId=victim',
    'district=',
    'q=%00',
  ])
    await request(app.getHttpServer()).get(`/v1/campuses?${query}`).expect(400);
  assert.deepEqual(calls, []);
});
