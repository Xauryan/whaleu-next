import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  activityPublicationFixture,
  approvedActivityOrganizer,
} from '../support/activity-publication-fixture.js';
test(
  'emitted App/Page/WXML actual transports: organizer → cover/gallery review → frozen publication review → lost response recovery → public images/QR/history/cancel',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 40, height: 40, channels: 3, background: '#2b6581' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actors = {
        owner: await f.actor(),
        reviewer: await f.actor(),
        other: await f.actor(),
      },
      org = await approvedActivityOrganizer(
        f,
        actors.owner,
        actors.reviewer,
        png,
      );
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/activity-publication-native-worker.mjs',
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
            throw Error('Native IPC');
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            if (m['name'] === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (m['name'] === 'review-activity') {
              assert.deepEqual(await f.reviewProcessor.processOne(), {
                state: 'reviewed',
                result: 'allow',
              });
            } else if (m['name'] === 'verify-final') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
                  )
                ).rows[0].n,
                2,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::integer n FROM whaleu_activities.publication_receipts WHERE client_request_id=$1',
                    [m['requestId']],
                  )
                ).rows[0].n,
                1,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT original_publisher_account_id FROM whaleu_activities.native_activities WHERE id=$1',
                    [m['activityId']],
                  )
                ).rows[0].original_publisher_account_id,
                actors.owner.accountId,
              );
              assert.equal(
                (
                  await f.pool.query(
                    "SELECT count(*)::integer n FROM whaleu_activities.publication_drafts WHERE state='cancelled'",
                  )
                ).rows[0].n,
                1,
              );
              assert.deepEqual(await f.reviewProcessor.processOne(), {
                state: 'idle',
              });
            } else throw Error('Unexpected native checkpoint');
            child.send({ event: 'continue', name: m['name'] });
          } else if (m['event'] === 'done') {
            assert.equal(m['uploads'], 3);
            assert.ok(Number(m['reads']) >= 4);
            assert.ok(Number(m['requests']) >= 20);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done)
          reject(Error(`Native activity child exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      organizationId: org.id,
      actors,
      png: png.toString('base64'),
    });
    await finished;
  },
);
