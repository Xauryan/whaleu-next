import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  announcementMediaFixture,
  grantAnnouncementSchool,
} from '../support/media/announcement-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
test(
  'emitted announcement App/Page/WXML crosses actual HTTP/PG: private draft, bytes, publication loss recovery, public/guest, explicit popup ack, edit, deactivate and owner closure',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 40, height: 40, channels: 3, background: '#398278' },
      })
        .png()
        .toBuffer(),
      f = await announcementMediaFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actors = { owner: await f.actor(), member: await f.actor() },
      grant = await grantAnnouncementSchool(f, actors.owner);
    await f.pool.query(
      'UPDATE whaleu_profile.profiles SET selected_campus_id=$1 WHERE account_id=$2',
      [f.scope.home.campusId, actors.member.accountId],
    );
    const regionName = (
      await f.pool.query(
        'SELECT name FROM whaleu_campus.operating_regions WHERE id=$1',
        [f.scope.home.regionId],
      )
    ).rows[0].name;
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/announcement-authoring-native-worker.mjs',
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
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          if (!raw || typeof raw !== 'object' || !('event' in raw))
            throw Error('IPC');
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            if (m['name'] === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (m['name'] === 'no-ack')
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_announcements.popup_acknowledgements WHERE announcement_id=$1',
                    [m['id']],
                  )
                ).rows[0].n,
                0,
              );
            else if (m['name'] === 'move-grant') {
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                  [grant],
                ),
              );
              await grantAnnouncementSchool(
                f,
                actors.owner,
                'school_admin',
                f.scope.foreign.regionId,
              );
            } else if (m['name'] === 'verify-final') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_announcements.native_requests WHERE client_request_id=$1',
                    [m['requestId']],
                  )
                ).rows[0].n,
                1,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT state FROM whaleu_announcements.native_announcements WHERE id=$1',
                    [m['draft']],
                  )
                ).rows[0].state,
                'cancelled',
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_announcements.popup_acknowledgements WHERE announcement_id=$1',
                    [m['id']],
                  )
                ).rows[0].n,
                1,
              );
            } else throw Error('Unknown checkpoint');
            child.send({ event: 'continue', name: m['name'] });
          } else if (m['event'] === 'done') {
            assert.ok(Number(m['requests']) > 20);
            assert.equal(m['uploads'], 12);
            assert.ok(Number(m['reads']) >= 13);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done)
          reject(Error(`Native announcement worker exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      actors,
      regionName,
      campusId: f.scope.home.campusId,
      png: png.toString('base64'),
    });
    await finished;
  },
);
