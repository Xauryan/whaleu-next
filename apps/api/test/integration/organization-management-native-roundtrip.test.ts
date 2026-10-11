import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import {
  organizationMediaFixture,
  grantOrganizationSchoolReviewer,
  organizationOk,
} from '../support/media/organization-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';

test(
  'emitted App/Page/WXML organization apply, real image review, school rejection/resubmission/approval, management and directory to disposable PostgreSQL',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 40, height: 40, channels: 3, background: '#407b86' },
      })
        .png()
        .toBuffer(),
      f = await organizationMediaFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actors = {
      owner: await f.actor(),
      reviewer: await f.actor(),
      one: await f.actor(),
      two: await f.actor(),
      outsider: await f.actor(),
    };
    await grantOrganizationSchoolReviewer(f, actors.reviewer);
    const profileIds: Record<string, string> = {};
    for (const [key, actor] of Object.entries(actors)) {
      organizationOk(
        await request(f.app.getHttpServer())
          .patch('/v1/me/profile')
          .send({ expectedRevision: 0, nickname: '组织成员' })
          .set('Authorization', `Bearer ${actor.accessToken}`),
      );
      profileIds[key] = (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0]!.id;
    }
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/organization-management-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (v) => {
      logs += String(v);
    });
    child.stderr?.on('data', (v) => {
      logs += String(v);
    });
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          if (!raw || typeof raw !== 'object' || !('event' in raw))
            throw Error('Invalid native IPC');
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            if (m['name'] === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (m['name'] === 'verify-final') {
              const id = String(m['organizationId']);
              const owners = (
                await f.pool.query(
                  `SELECT account_id FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND role='organization_owner' AND revoked_at IS NULL`,
                  [id],
                )
              ).rows;
              assert.deepEqual(owners, [{ account_id: actors.two.accountId }]);
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT count(*)::integer n FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL`,
                    [id, actors.reviewer.accountId],
                  )
                ).rows[0].n,
                0,
              );
              const events = (
                await f.pool.query<{ action: string }>(
                  `SELECT action FROM whaleu_organizations.organization_events WHERE organization_id=$1 ORDER BY created_at,id`,
                  [id],
                )
              ).rows.map((r) => r.action);
              assert.equal(events.filter((a) => a === 'approve').length, 1);
              assert.equal(events.filter((a) => a === 'submit').length, 2);
              assert.equal(
                events.filter((a) => a === 'transfer_owner').length,
                1,
              );
            } else throw Error('Unexpected native checkpoint');
            child.send({ event: 'continue', name: m['name'] });
          } else if (m['event'] === 'done') {
            assert.equal(m['uploads'], 3);
            assert.ok(Number(m['requests']) > 20);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done)
          reject(Error(`Native organization child exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      regionId: f.scope.home.regionId,
      categoryId: f.category.id,
      png: png.toString('base64'),
      actors,
      profileIds,
    });
    await finished;
  },
);
