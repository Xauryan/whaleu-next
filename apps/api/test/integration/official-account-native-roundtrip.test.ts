import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { officialAccountFixture } from '../support/official-account-fixture.js';

test(
  'emitted native App/Page/WXML crosses real HTTP/PG: independent save/test, journal failure, lost response, double tap, restart and lifecycle fencing',
  { timeout: 180000 },
  async (t) => {
    const f = await officialAccountFixture();
    t.after(() => f.close());
    const body = '原生合成预览正文';
    await f.publish(body);
    await f.ready();
    await f.app.listen(0, '127.0.0.1');
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/official-account-native-worker.mjs',
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
    child.stdout?.on('data', (value) => {
      logs += String(value);
    });
    child.stderr?.on('data', (value) => {
      logs += String(value);
    });
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.once('error', reject);
      child.on('message', (raw: unknown) => {
        void (async () => {
          assert.ok(raw && typeof raw === 'object' && 'event' in raw);
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw new Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            const name = m['name'];
            if (name === 'saved-once' || name === 'run-test') {
              const rows = (
                await f.pool.query<{
                  operation: string;
                  intent: { requestId: string };
                }>(
                  'SELECT operation,intent FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
                  [f.world.author.accountId, m['requestId']],
                )
              ).rows;
              assert.equal(rows.length, 1);
              assert.equal(
                rows[0]!.operation,
                name === 'saved-once' ? 'config_save' : 'test_draft',
              );
              assert.equal(rows[0]!.intent.requestId, m['requestId']);
              if (name === 'saved-once')
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT author FROM whaleu_official.configs WHERE program_id=$1',
                      [f.programId],
                    )
                  ).rows[0]!.author,
                  '已单独保存的合成作者',
                );
              else await f.worker.runCycle();
            } else if (name === 'preview-no-effect') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_official.effects e JOIN whaleu_official.commands c ON c.id=e.command_id WHERE c.program_id=$1',
                    [f.programId],
                  )
                ).rows[0]!.n,
                0,
              );
            } else if (name === 'cancel-tombstone') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT id FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
                    [f.world.author.accountId, m['requestId']],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT intent_hash FROM whaleu_official.cancel_fences WHERE actor_ref=$1 AND request_id=$2',
                    [f.world.author.accountId, m['requestId']],
                  )
                ).rowCount,
                1,
              );
            } else if (name === 'revoke-capability') {
              await f.pool.query(
                'UPDATE whaleu_official.capabilities SET revoked_at=clock_timestamp() WHERE principal_ref=$1 AND program_id=$2',
                [f.world.author.accountId, f.programId],
              );
            } else if (name === 'revoked-no-dispatch') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_official.attempts a JOIN whaleu_official.effects e ON e.id=a.effect_id JOIN whaleu_official.commands c ON c.id=e.command_id WHERE c.actor_ref=$1 AND c.request_id=$2',
                    [f.world.author.accountId, m['requestId']],
                  )
                ).rows[0]!.n,
                0,
              );
            } else throw new Error('Unexpected native checkpoint');
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.ok(Number(m['requests']) >= 15);
            done = true;
          } else throw new Error('Unexpected native message');
        })().catch(reject);
      });
      child.once('exit', (code) => {
        if (code === 0 && done) resolve();
        else
          reject(new Error(`Native emitted journey exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: Number(new URL(await f.app.getUrl()).port),
      programId: f.programId,
      foreignProgram: randomUUID(),
      author: f.world.author,
      reader: f.world.reader,
      body,
    });
    await finished;
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_official.commands WHERE program_id=$1 AND operation='manual_publish'",
          [f.programId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.ok(
      !logs.includes(f.world.author.accessToken),
      'Synthetic bearer never logged',
    );
  },
);

test(
  'ordinary default-off AppModule remains unavailable through emitted native page',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const author = await createRuntimeActor(f.app);
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/official-account-native-worker.mjs',
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
    t.after(() => {
      if (!child.killed) child.kill();
    });
    let logs = '';
    child.stdout?.on('data', (value) => {
      logs += String(value);
    });
    child.stderr?.on('data', (value) => {
      logs += String(value);
    });
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.once('error', reject);
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('event' in raw)) {
          reject(new Error('Invalid native IPC'));
          return;
        }
        const m = raw as Record<string, unknown>;
        if (m['event'] === 'failure') reject(new Error(String(m['message'])));
        else if (m['event'] === 'done' && m['requests'] === 1) done = true;
        else reject(new Error('Unexpected default-off native IPC'));
      });
      child.once('exit', (code) =>
        code === 0 && done
          ? resolve()
          : reject(new Error(`Default native gate exited ${code}: ${logs}`)),
      );
    });
    child.send({
      disabled: true,
      port: f.port,
      programId: randomUUID(),
      author,
    });
    await finished;
  },
);
