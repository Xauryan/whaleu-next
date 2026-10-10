import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { lstat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
  publishDiscussionPost,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import type { BatchActor } from '../support/media/discussion-batch-fixture.js';
import {
  seedReviewPolicy,
  approveEnvelope,
} from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { SyntheticMediaStorage } from '../support/media/synthetic-storage.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  mediaBatchStatusSchema,
  mediaBatchRecoverySchema,
  mediaMemberStatusSchema,
} from '../../src/media/contracts-v4.js';
import type { MediaBatchIdentity } from '../../src/media/contracts-v4.js';
import { mediaGrantSchema } from '../../src/media/contracts-v2.js';
import type { DiscussionPublicationTarget } from '../../src/community/discussion/publication-target.js';

type Cut =
  | 'multipart-partial'
  | 'multipart-observed'
  | 'worker-output'
  | 'review-ready'
  | 'publication-committed'
  | null;
function event(
  child: ChildProcess,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${expected}`));
    }, 30000);
    timer.unref();
    const message = (raw: unknown) => {
      if (typeof raw !== 'object' || raw === null || !('event' in raw)) return;
      if (raw.event === 'failure') {
        cleanup();
        reject(new Error(JSON.stringify(raw)));
      } else if (raw.event === expected) {
        cleanup();
        resolve(raw as Record<string, unknown>);
      }
    };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited before ${expected}: ${code}/${signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
    };
    child.on('message', message);
    child.once('exit', exit);
  });
}
const exitOf = (
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
async function kill(child: ChildProcess): Promise<void> {
  const exited = exitOf(child);
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
}
const boundary = 'whaleu-v4-process-boundary';
const prefix = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`,
);
const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
function socketUpload(port: number, path: string, token: string) {
  let finish!: (response: { status: number; body: string }) => void;
  const result = new Promise<{ status: number; body: string }>((resolve) => {
    finish = resolve;
  });
  const socket = nodeRequest(
    {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Transfer-Encoding': 'chunked',
      },
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', () => finish({ status: 0, body: '' }));
      response.on('end', () =>
        finish({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    },
  );
  socket.on('error', () => finish({ status: 0, body: '' }));
  socket.on('close', () => finish({ status: 0, body: '' }));
  return { socket, result };
}

test(
  'separate v4 API and processing SIGKILL preserve exact committed effects and retain foreign writer obligations',
  { timeout: 600000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 90, height: 70, channels: 3, background: '#2e5973' },
    })
      .png()
      .toBuffer();
    const fixtures = [{ sha256: sha256(bytes), verdict: 'allow' as const }];
    const f = await syntheticMediaRuntimeFixture(fixtures),
      children: ChildProcess[] = [],
      sockets: ReturnType<typeof socketUpload>[] = [];
    try {
      await seedReviewPolicy(f.pool);
      const owner = await f.actor(),
        postId = await publishDiscussionPost(f, owner),
        http = f.app.getHttpServer();
      const storageRoot = await f.storage.processRoot();
      const databaseUrl = process.env['TEST_DATABASE_URL'];
      assert.ok(databaseUrl);
      // The private-root capability can reopen bytes, never mint the old process's
      // stop proof; non-owner disposal must leave the parent's root intact.
      const reopened =
        await SyntheticMediaStorage.reopenProcessRoot(storageRoot);
      await assert.rejects(
        reopened.retire(reopened.newObject()),
        /QUIESCENCE_UNAVAILABLE/,
      );
      await assert.rejects(
        f.storage.retire(f.storage.newObject()),
        /QUIESCENCE_UNAVAILABLE/,
      );
      await reopened.dispose();
      await access(storageRoot.root);
      await assert.rejects(
        SyntheticMediaStorage.reopenProcessRoot({
          ...storageRoot,
          marker: randomUUID(),
        }),
      );
      const bare = async (
        target: DiscussionPublicationTarget,
        text: string,
      ) => {
        const common = {
          clientRequestId: randomUUID(),
          text,
          imageAssetIds: [],
          authorMode: 'named' as const,
        };
        const body =
          target.kind === 'comment'
            ? common
            : { ...common, targetReplyId: target.targetReplyId };
        await approveEnvelope(
          f.pool,
          await discussionApprovalEnvelope(
            f.app,
            f.pool,
            owner.accountId,
            postId,
            body,
            target.kind === 'reply' ? target.rootCommentId : null,
          ),
        );
        const path =
          target.kind === 'comment'
            ? `/v1/community/posts/${postId}/comments`
            : `/v1/community/comments/${target.rootCommentId}/replies`;
        const result = await request(http)
          .post(path)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body);
        responseOk(result, 201);
        return result.body.resourceId as string;
      };
      const rootId = await bare(
        { kind: 'comment', postId },
        'Crash fixture root',
      );
      const replyId = await bare(
        { kind: 'reply', rootCommentId: rootId, targetReplyId: null },
        'Crash fixture target',
      );
      const targets: readonly DiscussionPublicationTarget[] = [
        { kind: 'comment', postId },
        { kind: 'reply', rootCommentId: rootId, targetReplyId: null },
        { kind: 'reply', rootCommentId: rootId, targetReplyId: replyId },
      ];
      const spawn = (
        mode: 'api' | 'worker',
        cut: Cut,
        stages?: readonly ('seal' | 'process' | 'review')[],
      ) => {
        const child = fork(
          fileURLToPath(
            new URL(
              '../support/media/discussion-server-process.ts',
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
        const ready = event(
          child,
          mode === 'api' ? 'api-ready' : cut ? 'checkpoint' : 'worker-complete',
        );
        child.send({
          command: 'start',
          mode,
          cut,
          stages,
          databaseUrl,
          storageRoot,
          fixtures,
        });
        return { child, ready };
      };
      const api = async (cut: Cut = null) => {
        const child = spawn('api', cut);
        const ready = await child.ready;
        assert.equal(typeof ready['port'], 'number');
        return {
          child: child.child,
          port: ready['port'] as number,
          writer: ready['writerInstanceId'],
        };
      };
      const worker = async (
        stages: readonly ('seal' | 'process' | 'review')[],
        cut: Cut = null,
      ) => {
        const running = spawn('worker', cut, stages);
        const result = await running.ready;
        return { ...running, result };
      };
      const url = (port: number) => `http://127.0.0.1:${port}`;
      const prepare = async (
        port: number,
        actor: BatchActor,
        target: DiscussionPublicationTarget,
      ) => {
        const identity: MediaBatchIdentity =
          target.kind === 'comment'
            ? {
                version: 2,
                batchRequestId: randomUUID(),
                draftId: randomUUID(),
                spaceId: f.scope.home.spaceId,
                purpose: 'community-comment-images',
                target,
              }
            : {
                version: 2,
                batchRequestId: randomUUID(),
                draftId: randomUUID(),
                spaceId: f.scope.home.spaceId,
                purpose: 'community-reply-images',
                target,
              };
        const auth = `Bearer ${actor.accessToken}`;
        const response = await request(url(port))
          .post('/v4/media/batches/prepare')
          .set('Authorization', auth)
          .send(identity);
        responseOk(response);
        const batch = mediaBatchStatusSchema.parse(response.body);
        assert.equal(batch.resolvedPostId, postId);
        assert.ok(batch.batchId);
        const input = {
          clientRequestId: randomUUID(),
          memberId: randomUUID(),
          sourceSlot: 0,
          declaration: {
            mime: 'image/png',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        };
        const selected = await request(url(port))
          .post(`/v4/media/batches/${batch.batchId}/members/prepare`)
          .set('Authorization', auth)
          .send(input);
        responseOk(selected);
        const member = mediaMemberStatusSchema.parse(selected.body);
        const granted = await request(url(port))
          .post(`/v4/media/upload-intents/${member.intentId}/grant`)
          .set('Authorization', auth)
          .send({});
        responseOk(granted);
        return {
          actor,
          auth,
          identity,
          batch,
          member,
          grant: mediaGrantSchema.parse(granted.body),
        };
      };
      const queryIntent = async (id: string) =>
        (
          await f.pool.query<{ state: string; generation: string }>(
            'SELECT state,generation FROM whaleu_media.upload_intents WHERE id=$1',
            [id],
          )
        ).rows[0]!;
      const status = async (
        port: number,
        prepared: Awaited<ReturnType<typeof prepare>>,
      ) => {
        const response = await request(url(port))
          .get(`/v4/media/upload-intents/${prepared.member.intentId}`)
          .set('Authorization', prepared.auth);
        responseOk(response);
        return mediaMemberStatusSchema.parse(response.body);
      };
      const finishUpload = async (
        port: number,
        prepared: Awaited<ReturnType<typeof prepare>>,
      ) => {
        responseOk(
          await request(url(port))
            .post(
              `/v4/media/upload-intents/${prepared.member.intentId}/uploads/${prepared.grant.grantId}`,
            )
            .set('Authorization', prepared.auth)
            .attach('file', bytes, {
              filename: 'fixture.png',
              contentType: 'image/png',
            }),
        );
        responseOk(
          await request(url(port))
            .post(
              `/v4/media/upload-intents/${prepared.member.intentId}/finalize`,
            )
            .set('Authorization', prepared.auth)
            .send({}),
        );
      };
      await t.test(
        'partial multipart process death retains scratch and foreign writer; no replacement admission',
        async () => {
          const actor = await f.actor(),
            first = await api('multipart-partial');
          const prepared = await prepare(first.port, actor, targets[0]!);
          const checkpoint = event(first.child, 'checkpoint');
          const upload = socketUpload(
            first.port,
            `/v4/media/upload-intents/${prepared.member.intentId}/uploads/${prepared.grant.grantId}`,
            actor.accessToken,
          );
          sockets.push(upload);
          upload.socket.write(prefix);
          upload.socket.write(
            bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
          );
          const point = await checkpoint;
          assert.equal(point['point'], 'multipart-partial');
          assert.equal(
            (await queryIntent(prepared.member.intentId)).state,
            'prepared',
          );
          const before = (
            await f.pool.query<{
              writer_token: string;
              writer_instance_id: string;
              state: string;
            }>(
              'SELECT w.writer_token,w.writer_instance_id,w.state FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1',
              [prepared.member.intentId],
            )
          ).rows;
          assert.equal(before.length, 1);
          assert.equal(before[0]!.writer_instance_id, first.writer);
          assert.notEqual(before[0]!.state, 'retired');
          const scratch = point['scratch'] as { key: string; version: string };
          const path = join(
            storageRoot.root,
            `${scratch.key}.${scratch.version}`,
          );
          assert.ok((await lstat(path)).size > 0);
          await kill(first.child);
          await upload.result;
          const restarted = await api();
          assert.notEqual(restarted.writer, first.writer);
          const recovered = await status(restarted.port, prepared);
          assert.equal(recovered.intentId, prepared.member.intentId);
          assert.equal(recovered.requestHash, prepared.member.requestHash);
          assert.equal(recovered.observation.status, 'prepared');
          if (recovered.observation.status === 'prepared')
            assert.ok(
              ['in_flight', 'reconcile_needed'].includes(
                recovered.observation.upload,
              ),
            );
          const blocked = await request(url(restarted.port))
            .post(`/v4/media/upload-intents/${prepared.member.intentId}/grant`)
            .set('Authorization', prepared.auth)
            .send({});
          assert.ok(blocked.status >= 400);
          assert.ok(
            ['MEDIA_UPLOAD_IN_FLIGHT', 'MEDIA_RECONCILE_NEEDED'].includes(
              blocked.body.error.code,
            ),
          );
          const replacement = await prepare(restarted.port, actor, targets[0]!);
          const forbidden = await request(url(restarted.port))
            .post(
              `/v4/media/upload-intents/${replacement.member.intentId}/uploads/${replacement.grant.grantId}`,
            )
            .set('Authorization', prepared.auth)
            .attach('file', bytes, {
              filename: 'fixture.png',
              contentType: 'image/png',
            });
          assert.ok(forbidden.status >= 400);
          assert.equal(forbidden.body.error.code, 'MEDIA_UPLOAD_IN_FLIGHT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=ANY($1::uuid[])',
                [[prepared.member.intentId, replacement.member.intentId]],
              )
            ).rowCount,
            0,
          );
          const after = (
            await f.pool.query<{
              writer_token: string;
              writer_instance_id: string;
              state: string;
            }>(
              'SELECT w.writer_token,w.writer_instance_id,w.state FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1',
              [prepared.member.intentId],
            )
          ).rows;
          assert.deepEqual(
            after,
            before,
            'Restart and denied replacement cannot mint retirement evidence',
          );
          assert.ok((await lstat(path)).size > 0);
          const cancelled = await request(url(restarted.port))
            .post(
              `/v4/media/batches/requests/${prepared.identity.batchRequestId}/cancel`,
            )
            .set('Authorization', prepared.auth)
            .send({ batchRequestHash: prepared.batch.batchRequestHash });
          responseOk(cancelled);
          const terminal = mediaBatchRecoverySchema.parse(cancelled.body);
          assert.equal(terminal.state, 'recorded');
          if (
            terminal.state !== 'recorded' ||
            terminal.status.status !== 'terminal'
          )
            throw new Error('Cancellation metadata missing');
          assert.equal(
            terminal.status.cleanup,
            'retained',
            'Dead foreign writer is not a quiescence proof',
          );
          assert.ok(
            (await lstat(path)).size > 0,
            'Cancellation retains exact scratch instead of inferring absence',
          );
          const obligations = await f.pool.query<{ state: string }>(
            'SELECT c.state FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts a ON a.id=c.object_attempt_id LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id WHERE coalesce(a.intent_id,wa.intent_id)=$1',
            [prepared.member.intentId],
          );
          assert.ok(obligations.rowCount && obligations.rowCount >= 2);
          assert.ok(obligations.rows.every((row) => row.state !== 'deleted'));
          const stillBlocked = await request(url(restarted.port))
            .post(
              `/v4/media/upload-intents/${replacement.member.intentId}/uploads/${replacement.grant.grantId}`,
            )
            .set('Authorization', prepared.auth)
            .attach('file', bytes, {
              filename: 'fixture.png',
              contentType: 'image/png',
            });
          assert.ok(stillBlocked.status >= 400);
          assert.equal(stillBlocked.body.error.code, 'MEDIA_UPLOAD_IN_FLIGHT');
          await kill(restarted.child);
        },
      );
      await t.test(
        'complete multipart observation survives lost response and a new API process',
        async () => {
          const actor = await f.actor(),
            first = await api('multipart-observed');
          const prepared = await prepare(first.port, actor, targets[1]!);
          const checkpoint = event(first.child, 'checkpoint'),
            upload = socketUpload(
              first.port,
              `/v4/media/upload-intents/${prepared.member.intentId}/uploads/${prepared.grant.grantId}`,
              actor.accessToken,
            );
          sockets.push(upload);
          upload.socket.end(Buffer.concat([prefix, bytes, ending]));
          assert.equal((await checkpoint)['point'], 'multipart-observed');
          assert.equal(
            (await queryIntent(prepared.member.intentId)).state,
            'prepared',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT writer_state FROM whaleu_media.upload_ingress WHERE object_attempt_id IN (SELECT id FROM whaleu_media.object_attempts WHERE intent_id=$1)',
                [prepared.member.intentId],
              )
            ).rows[0]?.writer_state,
            'observed',
          );
          await kill(first.child);
          await upload.result;
          const restarted = await api(),
            observed = await status(restarted.port, prepared);
          assert.equal(observed.observation.status, 'uploaded');
          assert.equal(observed.requestHash, prepared.member.requestHash);
          responseOk(
            await request(url(restarted.port))
              .post(
                `/v4/media/upload-intents/${prepared.member.intentId}/finalize`,
              )
              .set('Authorization', prepared.auth)
              .send({}),
          );
          const completed = await worker(['seal', 'process', 'review']);
          assert.deepEqual(
            completed.result['results'],
            ['seal', 'process', 'review'].map((stage) => ({
              stage,
              claimed: true,
            })),
          );
          assert.deepEqual(await exitOf(completed.child), {
            code: 0,
            signal: null,
          });
          assert.equal(
            (await status(restarted.port, prepared)).observation.status,
            'ready_unbound',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                [prepared.member.intentId],
              )
            ).rowCount,
            1,
          );
          await kill(restarted.child);
        },
      );
      await t.test(
        'processing child killed after durable output before commit reuses exact planned locators after real lease expiry',
        async () => {
          const actor = await f.actor(),
            prepared = await prepare(f.port, actor, targets[2]!);
          await finishUpload(f.port, prepared);
          const crashing = await worker(['seal', 'process'], 'worker-output');
          assert.equal(crashing.result['point'], 'worker-output');
          const planned = (
            await f.pool.query<{
              id: string;
              variant_name: string;
              provider: string;
              environment: string;
              bucket: string;
              object_key: string;
              object_version: string;
              state: string;
            }>(
              'SELECT id,variant_name,provider,environment,bucket,object_key,object_version,state FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY variant_name',
              [prepared.member.intentId],
            )
          ).rows;
          assert.equal(planned.length, 2);
          assert.ok(planned.every((row) => row.state === 'planned'));
          for (const row of planned)
            assert.ok(
              (
                await f.storage.measure({
                  provider: row.provider,
                  environment: row.environment,
                  bucket: row.bucket,
                  key: row.object_key,
                  version: row.object_version,
                })
              ).bytes > 0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                [prepared.member.intentId],
              )
            ).rowCount,
            0,
          );
          const lease = (
            await f.pool.query<{ lease_until: Date }>(
              "SELECT lease_until FROM whaleu_media.jobs WHERE intent_id=$1 AND kind='process' AND status='leased'",
              [prepared.member.intentId],
            )
          ).rows[0]!;
          await kill(crashing.child);
          const immediate = await worker(['process']);
          assert.deepEqual(immediate.result['results'], [
            { stage: 'process', claimed: false },
          ]);
          assert.deepEqual(await exitOf(immediate.child), {
            code: 0,
            signal: null,
          });
          // Observe the actual persisted lease deadline; never rewrite DB clocks,
          // claims, quotas, writer states, or process-instance ownership.
          await sleep(
            Math.max(0, lease.lease_until.getTime() - Date.now() + 100),
          );
          const recovered = await worker(['process', 'review']);
          assert.deepEqual(recovered.result['results'], [
            { stage: 'process', claimed: true },
            { stage: 'review', claimed: true },
          ]);
          assert.deepEqual(await exitOf(recovered.child), {
            code: 0,
            signal: null,
          });
          const after = (
            await f.pool.query<{
              id: string;
              variant_name: string;
              object_key: string;
              object_version: string;
            }>(
              'SELECT id,variant_name,object_key,object_version FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY variant_name',
              [prepared.member.intentId],
            )
          ).rows;
          assert.deepEqual(
            after,
            planned.map(({ id, variant_name, object_key, object_version }) => ({
              id,
              variant_name,
              object_key,
              object_version,
            })),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                [prepared.member.intentId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (await status(f.port, prepared)).observation.status,
            'ready_unbound',
          );
        },
      );
      await t.test(
        'review-ready committed by an independent worker remains ready after SIGKILL without reissuance',
        async () => {
          const actor = await f.actor(),
            prepared = await prepare(f.port, actor, targets[0]!);
          await finishUpload(f.port, prepared);
          const crashing = await worker(
            ['seal', 'process', 'review'],
            'review-ready',
          );
          assert.equal(crashing.result['point'], 'review-ready');
          assert.equal(
            (await queryIntent(prepared.member.intentId)).state,
            'ready',
          );
          const before = (
            await f.pool.query(
              'SELECT e.* FROM whaleu_media.asset_safety_events e JOIN whaleu_media.assets a ON a.id=e.asset_id WHERE a.intent_id=$1 ORDER BY e.id',
              [prepared.member.intentId],
            )
          ).rows;
          assert.equal(before.length, 1);
          await kill(crashing.child);
          const restarted = await api();
          assert.equal(
            (await status(restarted.port, prepared)).observation.status,
            'ready_unbound',
          );
          const idle = await worker(['review']);
          assert.deepEqual(idle.result['results'], [
            { stage: 'review', claimed: false },
          ]);
          assert.deepEqual(await exitOf(idle.child), { code: 0, signal: null });
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT e.* FROM whaleu_media.asset_safety_events e JOIN whaleu_media.assets a ON a.id=e.asset_id WHERE a.intent_id=$1 ORDER BY e.id',
                [prepared.member.intentId],
              )
            ).rows,
            before,
          );
          await kill(restarted.child);
        },
      );
      await t.test(
        'publication COMMIT with lost API response recovers one exact receipt binding set and outbox after restart',
        async () => {
          const actor = await f.actor(),
            ready = await readyDiscussionBatch(f, actor, targets[2]!, 3, [
              { bytes, mime: 'image/png' },
            ]),
            sealed = await sealDiscussionBatch(f, actor, ready.status, '');
          const crashing = await api('publication-committed'),
            checkpoint = event(crashing.child, 'checkpoint');
          const sent = request(url(crashing.port))
            .post(sealed.path)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(sealed.body)
            .then(
              (response) => response,
              () => null,
            );
          assert.equal((await checkpoint)['point'], 'publication-committed');
          const before = (
            await f.pool.query<{ receipt: Record<string, unknown> }>(
              'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, sealed.body.clientRequestId],
            )
          ).rows;
          assert.equal(before.length, 1);
          assert.equal(before[0]!.receipt['outcome'], 'created');
          await kill(crashing.child);
          await sent;
          const restarted = await api(),
            auth = `Bearer ${actor.accessToken}`;
          const receipt = await request(url(restarted.port))
            .get(`/v1/me/community/requests/${sealed.body.clientRequestId}`)
            .set('Authorization', auth);
          responseOk(receipt);
          assert.deepEqual(receipt.body, before[0]!.receipt);
          const replay = await request(url(restarted.port))
            .post(sealed.path)
            .set('Authorization', auth)
            .send(sealed.body);
          responseOk(replay, 201);
          assert.deepEqual(replay.body, receipt.body);
          const response = await request(url(restarted.port))
            .get(`/v4/media/batches/requests/${ready.identity.batchRequestId}`)
            .set('Authorization', auth);
          responseOk(response);
          const recovery = mediaBatchRecoverySchema.parse(response.body);
          assert.equal(recovery.state, 'recorded');
          if (
            recovery.state !== 'recorded' ||
            recovery.status.status !== 'bound_history'
          )
            throw new Error('Exact committed history missing');
          assert.equal(recovery.status.resolvedPostId, postId);
          assert.equal(recovery.status.parent.resourceKind, 'reply');
          assert.equal(
            recovery.status.parent.resourceId,
            receipt.body['resourceId'],
          );
          assert.deepEqual(
            recovery.status.orderedAssets.map((row) => row.assetId),
            sealed.body.imageAssetIds,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                [sealed.body.imageAssetIds],
              )
            ).rowCount,
            3,
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='reply_created'",
                [receipt.body['resourceId']],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                [actor.accountId, sealed.body.clientRequestId],
              )
            ).rowCount,
            1,
          );
          await kill(restarted.child);
        },
      );
    } finally {
      for (const upload of sockets) upload.socket.destroy();
      await Promise.all(
        children
          .filter(
            (child) => child.exitCode === null && child.signalCode === null,
          )
          .map(async (child) => {
            const exited = exitOf(child);
            child.kill('SIGKILL');
            await exited;
          }),
      );
      await f.close();
    }
  },
);
