import request from 'supertest';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPromotionFixture } from './support/rating-group-promotion.js';
import { nativeLocator } from '../../src/ratings/group-promotion/contracts.js';
for (const regionalCatalog of [false, true])
  test(
    `accepted ${regionalCatalog ? 'regional canteen' : 'global course'} locator opens actual emitted catalog through current native HTTP ownership`,
    { timeout: 240000 },
    async (t) => {
      const f = await createPromotionFixture({
        regionalCatalog,
        type: regionalCatalog ? 'canteen' : 'course',
      });
      t.after(() => f.close());
      const preview = await request(f.app.getHttpServer())
        .post(`/v1/rating-group-promotion/programs/${f.programId}/previews`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({
          type: f.binding.systemKey,
          mode: 'normal',
          expectedProgramRevision: f.programRevision,
        });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.locator, nativeLocator(f.binding));
      const child = fork(
        fileURLToPath(
          new URL('../support/rating-group-native-worker.mjs', import.meta.url),
        ),
        [],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: ['--import', 'tsx'],
        },
      );
      let logs = '';
      child.stdout?.on('data', (v) => (logs += String(v)));
      child.stderr?.on('data', (v) => (logs += String(v)));
      t.after(() => {
        if (!child.killed) child.kill();
      });
      const done = new Promise<void>((resolve, reject) => {
        let finished = false;
        child.on('message', (raw: unknown) => {
          const m = raw as {
            event: string;
            message?: string;
            categoryId?: string;
            requests?: number;
          };
          if (m.event === 'failure') {
            finished = true;
            reject(Error(m.message + '\n' + logs));
          } else if (m.event === 'done') {
            try {
              assert.equal(m.categoryId, f.binding.categoryId);
              assert.ok((m.requests ?? 0) > 0);
              finished = true;
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        });
        child.on('exit', (code) => {
          if (!finished || code)
            reject(Error(`Native child exit ${code}: ${logs}`));
        });
      });
      const a = f.creator;
      child.send({
        port: f.port,
        locator: preview.body.locator,
        categoryId: f.binding.categoryId,
        actor: {
          accountId: a.accountId,
          sessionId: a.sessionId,
          accessToken: a.accessToken,
          refreshToken: a.refreshToken,
          expiresAt: a.expiresAt,
          refreshExpiresAt: a.refreshExpiresAt,
        },
      });
      await done;
    },
  );
