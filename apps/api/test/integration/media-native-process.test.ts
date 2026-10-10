import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';

function event(
  child: ChildProcess,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for native child ${expected}`));
    }, 15000);
    timer.unref();
    const message = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('event' in value))
        return;
      if (value.event === 'failure') {
        cleanup();
        reject(new Error(JSON.stringify(value)));
      } else if (value.event === expected) {
        cleanup();
        resolve(value as Record<string, unknown>);
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`Native child exited before ${expected}: ${code}/${signal}`),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exited);
    };
    child.on('message', message);
    child.once('exit', exited);
  });
}
function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
}

test(
  'actual native child SIGKILL and fresh same-actor process recover durable prepare uncertainty without new key or file',
  { timeout: 60000 },
  async () => {
    const registered = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      {
        sha256: createHash('sha256').update(registered).digest('hex'),
        verdict: 'allow',
      },
    ]);
    const root = await mkdtemp(
      join(tmpdir(), 'whaleu-native-journal-process-'),
    );
    const children: ChildProcess[] = [];
    try {
      const actor = await f.actor();
      const port = (f.app.getHttpServer().address() as AddressInfo).port;
      const journalPath = join(root, 'storage.json');
      const prepare = {
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
      };
      const launch = () => {
        const child = fork(
          fileURLToPath(
            new URL(
              '../support/media/native-recovery-process.mjs',
              import.meta.url,
            ),
          ),
          [],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        child.stderr?.resume();
        children.push(child);
        return child;
      };
      const first = launch();
      const committed = event(first, 'prepare-committed');
      first.send({
        command: 'start',
        mode: 'prepare-and-stop',
        credentials: actor,
        port,
        journalPath,
        prepare,
      });
      const receipt = await committed;
      const exited = exitOf(first);
      first.kill('SIGKILL');
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
      const persisted = JSON.parse(
        await readFile(journalPath, 'utf8'),
      ) as Record<
        string,
        { phase: string; intentId: string | null; clientRequestId: string }
      >;
      assert.equal(Object.keys(persisted).length, 1);
      const record = Object.values(persisted)[0]!;
      assert.equal(record.phase, 'prepare_uncertain');
      assert.equal(record.intentId, null);
      const serialized = JSON.stringify(persisted);
      for (const value of [
        actor.accessToken,
        actor.refreshToken,
        journalPath,
        'grantId',
        'filePath',
      ])
        assert.equal(serialized.includes(value), false);

      const provider = (
        await f.pool.query<{ app_id: string; subject: string }>(
          'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0]!;
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: provider.app_id,
          subject: provider.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      assert.notEqual(session.sessionId, actor.sessionId);
      const second = launch();
      const recovered = event(second, 'recovered');
      second.send({
        command: 'start',
        mode: 'recover',
        credentials: { ...session, accessToken, refreshToken },
        port,
        journalPath,
      });
      const recovery = await recovered;
      assert.equal(
        (recovery['view'] as { status: string }).status,
        'needs_reselection',
      );
      assert.equal(
        (recovery['record'] as { intentId: string }).intentId,
        receipt['intentId'],
      );
      assert.equal(
        (recovery['record'] as { clientRequestId: string }).clientRequestId,
        record.clientRequestId,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.upload_ingress'))
          .rowCount,
        0,
      );
      const cancelled = event(second, 'cancelled'),
        secondExit = exitOf(second);
      second.send({ command: 'cancel' });
      assert.equal(
        ((await cancelled)['view'] as { status: string }).status,
        'terminal',
      );
      assert.deepEqual(await secondExit, { code: 0, signal: null });
      assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), {});
      assert.equal(
        (
          await f.pool.query<{ state: string }>(
            'SELECT state FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
            [actor.accountId, prepare.clientRequestId],
          )
        ).rows[0]!.state,
        'terminal',
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = exitOf(child);
          child.kill('SIGKILL');
          await exited;
        }
      await rm(root, { recursive: true, force: true });
      await f.close();
    }
  },
);
