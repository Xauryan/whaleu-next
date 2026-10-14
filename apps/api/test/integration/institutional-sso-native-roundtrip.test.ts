import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  institutionalSsoFixture,
  institutionalRows,
} from '../support/institutional-sso-fixture.js';

test(
  'emitted institutional native Page, one-use trusted verifier, real HTTP/PG facts and UID with cold original-key recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/institutional-sso-native-worker.mjs',
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
    let mints = 0;
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        child.on('message', (raw: unknown) => {
          void (async () => {
            if (!raw || typeof raw !== 'object' || !('event' in raw))
              throw Error('Malformed native IPC');
            const m = raw as Record<string, unknown>;
            if (m['event'] === 'failure') throw Error(String(m['message']));
            if (m['event'] === 'mint') {
              mints++;
              const response = await f.mint(
                String(m['accountId']),
                String(m['requestId']),
              );
              child.send({
                event: 'minted',
                requestId: m['requestId'],
                authorizationResponse: response,
              });
            } else if (m['event'] === 'done') {
              finished = true;
              resolve(m);
            } else throw Error('Unknown native IPC event');
          })().catch(reject);
        });
        child.once('exit', (code) => {
          if (!finished) reject(Error(`Native child exited ${code}: ${logs}`));
        });
        child.send({
          port: f.port,
          home: f.home,
          privacyMarkers: ['00001234', 'synthetic-subject:'],
        });
      },
    );
    assert.equal(mints, 1);
    assert.equal(f.transport.calls, 1);
    const account = String(done['accountId']);
    const rows = await institutionalRows(f.pool, account);
    assert.equal(rows.completions, 1);
    assert.equal(rows.results, 1);
    assert.equal(rows.causes, 1);
    assert.equal(rows.assertions, 2);
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
          [account, String(done['requestId'])],
        )
      ).rows[0].state,
      'completed',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
          [account, String(done['cancelledRequestId'])],
        )
      ).rows[0].state,
      'cancelled',
    );
    assert.ok(!logs.includes('00001234'));
    assert.ok(!logs.includes('synthetic-response-'));
    assert.ok(
      Array.isArray(done['checkpoints']) && done['checkpoints'].length >= 4,
    );
  },
);
