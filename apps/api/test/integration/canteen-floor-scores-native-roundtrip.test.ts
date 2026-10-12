import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { floorRatingFixture } from '../support/canteen-floor-score-fixture.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
const credentials = (a: SessionCredentials): SessionCredentials => ({
  accountId: a.accountId,
  sessionId: a.sessionId,
  accessToken: a.accessToken,
  refreshToken: a.refreshToken,
  expiresAt: a.expiresAt,
  refreshExpiresAt: a.refreshExpiresAt,
});
test(
  'emitted registered floor selector/Page/WXML → actual HTTP/AppModule/PostgreSQL decimal publication, original receipt/cancel recovery and account/hide fencing',
  { timeout: 180000 },
  async (t) => {
    const f = await floorRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false });
    const floor = f.add({ floorKey: 'B1-mezzanine' }),
      second = f.add(),
      unknown = f.add({
        history: 'unknown',
        canteenId: randomUUID(),
        canteenRevision: randomUUID(),
        canteenName: 'Other Synthetic Canteen',
      });
    await f.accept([floor, second, unknown]);
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_ratings.window_entries'))
        .rowCount,
      0,
    );
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/canteen-floor-scores-native-worker.mjs',
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
    const checkpoints: string[] = [];
    await new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure')
            throw Error(String(m['message']) + '\n' + logs);
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            checkpoints.push(name);
            if (name === 'first-committed') {
              const row = (
                await f.pool.query<{ score: string }>(
                  'SELECT score::text FROM whaleu_ratings.floor_score_events WHERE request_id=$1',
                  [m['requestId']],
                )
              ).rows;
              assert.deepEqual(row, [{ score: '1.25' }]);
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'first-recovered') {
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
              );
            } else if (name === 'cancel-committed') {
              const row = (
                await f.pool.query<{ receipt: { code: string } }>(
                  'SELECT receipt FROM whaleu_ratings.floor_commands WHERE request_id=$1',
                  [m['requestId']],
                )
              ).rows[0]!;
              assert.equal(row.receipt.code, 'FLOOR_SCORE_CANCELLED');
              await f.certify(actor.accountId, {
                phone: 'unverified',
                affiliation: 'unverified',
                identity: false,
              });
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'cancel-recovered') {
              await f.certify(actor.accountId, {
                affiliation: 'unverified',
                identity: false,
              });
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
              );
            } else throw Error('Unknown checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.deepEqual(checkpoints, [
              'first-committed',
              'first-recovered',
              'cancel-committed',
              'cancel-recovered',
            ]);
            assert.equal(m['nativeCommands'], 3);
            assert.ok(Number(m['receiptReads']) >= 4);
            const rows = (
              await f.pool.query<{ score: string }>(
                'SELECT score::text FROM whaleu_ratings.floor_score_events ORDER BY score',
              )
            ).rows;
            assert.deepEqual(rows, [{ score: '1.25' }, { score: '4.75' }]);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.floor_score_heads',
                )
              ).rowCount,
              2,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.floor_commands',
                )
              ).rowCount,
              3,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.window_score_heads',
                )
              ).rowCount,
              0,
            );
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done)
          reject(Error('Floor native worker exited ' + code + ': ' + logs));
      });
      child.send({
        port: f.port,
        actor: credentials(actor),
        other: credentials(other),
        floorId: floor.floorId,
        secondFloorId: second.floorId,
        unknownFloorId: unknown.floorId,
        canteenId: floor.canteenId,
      });
    });
  },
);
