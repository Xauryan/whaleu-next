import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';

test(
  'ordinary AppModule exposes disabled official routes and inert operator shell',
  { timeout: 120000 },
  async () => {
    const f = await directoryRuntimeFixture();
    try {
      const actor = await createRuntimeActor(f.app),
        programId = randomUUID(),
        http = f.app.getHttpServer();
      const cap = await request(http)
        .get('/v1/me/official-account-operations/capabilities')
        .query({ programId })
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .expect(200);
      assert.equal(cap.body.mode, 'disabled');
      assert.equal(cap.body.canPublish, false);
      const config = await request(http)
        .get(`/v1/me/official-account-operations/programs/${programId}/config`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .expect(503);
      assert.equal(config.body.error.code, 'OFFICIAL_RUNTIME_DISABLED');
      await request(http)
        .post(`/v1/official-account-callbacks/${randomUUID()}`)
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(503);
      const shell = await request(http)
        .get('/operator/official-articles')
        .expect(200);
      assert.match(
        shell.headers['content-security-policy'] ?? '',
        /default-src 'none'/,
      );
      assert.match(shell.headers['cache-control'] ?? '', /no-store/);
      assert.doesNotMatch(
        shell.text,
        /type="password"|localStorage\.setItem\([^)]*bearer/,
      );
      const script = await request(http)
        .get('/operator/official-articles/app.js')
        .expect(200);
      assert.match(script.text, /mountOfficialOperator/);
    } finally {
      await f.close();
    }
  },
);
