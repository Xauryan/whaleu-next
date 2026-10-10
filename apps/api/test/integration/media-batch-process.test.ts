import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { readyBatch } from '../support/media/batch-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';

function event(
  child: ChildProcess,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, 20000);
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
      reject(new Error(`Child exited before ${expected}: ${code}/${signal}`));
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
const exitOf = (
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

test(
  'actual native SIGKILL at Media reserve/body freeze gap and committed unknown seal resumes exact typed cancellation without image files',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const root = await mkdtemp(join(tmpdir(), 'whaleu-native-batch-process-')),
      children: ChildProcess[] = [];
    try {
      const actor = await f.actor(),
        port = (f.app.getHttpServer().address() as AddressInfo).port;
      for (const mode of ['reserved-before-body', 'seal-unknown'] as const)
        await t.test(mode, async () => {
          const ready = await readyBatch(f, actor, 3, [
            { bytes, mime: 'image/png' },
          ]);
          assert.equal(ready.status.status, 'ready_unbound');
          if (ready.status.status !== 'ready_unbound')
            throw new Error('Not ready');
          const body = {
            clientRequestId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            category: 'discussion',
            text: 'Actual process termination with complete three image identity',
            imageAssetIds: ready.status.orderedAssets.map(
              (image) => image.assetId,
            ),
            authorMode: 'named',
            commentsPolicy: 'open',
          };
          const journalPath = join(root, `${mode}.json`);
          const launch = () => {
            const child = fork(
              fileURLToPath(
                new URL(
                  '../support/media/native-batch-process.mjs',
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
          const first = launch(),
            cut = event(
              first,
              mode === 'reserved-before-body' ? 'reserved' : 'seal-committed',
            );
          first.send({
            command: 'start',
            mode,
            credentials: actor,
            journalPath,
            port,
            status: ready.status,
            body,
          });
          await cut;
          const killed = exitOf(first);
          first.kill('SIGKILL');
          assert.deepEqual(await killed, { code: null, signal: 'SIGKILL' });
          const persistedText = await readFile(journalPath, 'utf8'),
            persisted = JSON.parse(persistedText) as Record<
              string,
              { version: number; phase?: string; members?: unknown[] }
            >;
          const media = Object.entries(persisted).find(([key]) =>
            key.startsWith('whaleu.media.batch.pending.v3:'),
          )?.[1];
          assert.ok(media);
          assert.equal(media.members?.length, 3);
          assert.equal(
            Object.keys(persisted).some((key) =>
              key.startsWith('whaleu.community.pending.v1:'),
            ),
            mode === 'seal-unknown',
          );
          for (const secret of [
            actor.accessToken,
            actor.refreshToken,
            journalPath,
          ])
            assert.equal(persistedText.includes(secret), false);
          const mediaText = JSON.stringify(media);
          assert.equal(mediaText.includes(body.text), false);
          assert.equal(mediaText.includes('filePath'), false);
          const second = launch(),
            resumed = event(second, 'cancelled'),
            finished = exitOf(second);
          second.send({
            command: 'start',
            mode: 'resume-and-explicitly-cancel',
            credentials: actor,
            journalPath,
            port,
          });
          const result = await resumed;
          assert.equal(result['batchRequestId'], ready.identity.batchRequestId);
          assert.deepEqual(await finished, { code: 0, signal: null });
          const fence = (
            await f.pool.query<{ intent_hash: string }>(
              'SELECT intent_hash FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, body.clientRequestId],
            )
          ).rows[0];
          assert.ok(fence);
          const late = await request(f.app.getHttpServer())
            .post('/v1/community/posts')
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(body);
          assert.ok(late.status >= 400);
          assert.equal(late.body.error.code, 'MEDIA_REQUEST_CANCELLED');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                [body.imageAssetIds],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT state FROM whaleu_media.publication_batches WHERE id=$1',
                [ready.status.batchId],
              )
            ).rows[0]?.state,
            'terminal',
          );
        });
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
