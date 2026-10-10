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
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
  publishDiscussionPost,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  seedReviewPolicy,
  approveEnvelope,
} from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import type { DiscussionPublicationTarget } from '../../src/community/discussion/publication-target.js';
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
  'actual v4 native SIGKILL at every two-key boundary preserves exact root/direct/targeted publication and settlement',
  { timeout: 720000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#83552b' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const directory = await mkdtemp(
      join(tmpdir(), 'whaleu-discussion-process-'),
    );
    const children: ChildProcess[] = [];
    try {
      await seedReviewPolicy(f.pool);
      const owner = await f.actor();
      const http = f.app.getHttpServer(),
        port = (http.address() as AddressInfo).port;
      const postId = await publishDiscussionPost(f, owner);
      const initialRoot = await readyDiscussionBatch(
        f,
        owner,
        { kind: 'comment', postId },
        1,
        [{ bytes, mime: 'image/png' }],
      );
      const rootPlan = await sealDiscussionBatch(
        f,
        owner,
        initialRoot.status,
        'process root',
      );
      const rootResponse = await request(http)
        .post(rootPlan.path)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(rootPlan.body);
      responseOk(rootResponse, 201);
      const rootId = rootResponse.body.resourceId as string;
      const initialReply = await readyDiscussionBatch(
        f,
        owner,
        { kind: 'reply', rootCommentId: rootId, targetReplyId: null },
        1,
        [{ bytes, mime: 'image/png' }],
      );
      const replyPlan = await sealDiscussionBatch(
        f,
        owner,
        initialReply.status,
        'process target',
      );
      const replyResponse = await request(http)
        .post(replyPlan.path)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(replyPlan.body);
      responseOk(replyResponse, 201);
      const targetReplyId = replyResponse.body.resourceId as string;
      const cuts = [
        'reserve',
        'body',
        'link',
        'seal',
        'dispatch',
        'receipt',
        'settlement',
        'community-clear',
        'media-clear',
      ] as const;
      const focusedCut = process.env['DISCUSSION_PROCESS_CUT'];
      assert.ok(
        focusedCut === undefined || cuts.some((cut) => cut === focusedCut),
        'Unknown focused process cut',
      );
      for (const [index, cut] of cuts.entries())
        if (focusedCut === undefined || focusedCut === cut)
          await t.test(cut, async () => {
            const actor = await f.actor();
            const target: DiscussionPublicationTarget =
              index % 3 === 0
                ? { kind: 'comment', postId }
                : {
                    kind: 'reply',
                    rootCommentId: rootId,
                    targetReplyId: index % 3 === 1 ? null : targetReplyId,
                  };
            const ready = await readyDiscussionBatch(f, actor, target, 3, [
              { bytes, mime: 'image/png' },
            ]);
            if (ready.status.status !== 'ready_unbound')
              throw new Error('Expected complete ready set');
            const common = {
              clientRequestId: randomUUID(),
              text: '',
              imageAssetIds: ready.status.orderedAssets.map((a) => a.assetId),
              authorMode: 'named' as const,
            };
            const body =
              target.kind === 'comment'
                ? common
                : { ...common, targetReplyId: target.targetReplyId };
            const attempt =
              target.kind === 'comment'
                ? {
                    version: 1,
                    accountId: actor.accountId,
                    operation: 'publish_comment',
                    postId,
                    payload: body,
                  }
                : {
                    version: 1,
                    accountId: actor.accountId,
                    operation: 'publish_reply',
                    postId,
                    rootCommentId: rootId,
                    payload: body,
                  };
            await approveEnvelope(f.pool, {
              ...(await discussionApprovalEnvelope(
                f.app,
                f.pool,
                actor.accountId,
                postId,
                body,
                target.kind === 'reply' ? rootId : null,
              )),
              images: ready.status.orderedAssets.map(
                ({ assetId, manifestDigest }) => ({
                  assetId,
                  digest: manifestDigest,
                }),
              ),
            });
            const journalPath = join(directory, `${cut}.json`);
            const launch = () => {
              const child = fork(
                fileURLToPath(
                  new URL(
                    '../../../wechat/test/support/native-discussion-process.mjs',
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
              checkpoint = event(first, 'checkpoint');
            first.send({
              command: 'start',
              credentials: actor,
              journalPath,
              port,
              mode: 'publish',
              cut,
              attempt,
              status: ready.status,
            });
            assert.equal((await checkpoint)['cut'], cut);
            const killed = exitOf(first);
            first.kill('SIGKILL');
            assert.deepEqual(await killed, { code: null, signal: 'SIGKILL' });
            const persisted = await readFile(journalPath, 'utf8');
            assert.ok(!persisted.includes(actor.accessToken));
            assert.ok(!persisted.includes(actor.refreshToken));
            assert.ok(!persisted.includes('filePath'));
            if (cut === 'reserve') {
              const check = launch(),
                answer = event(check, 'requires-explicit-cancel'),
                stopped = exitOf(check);
              check.send({
                command: 'start',
                credentials: actor,
                journalPath,
                port,
                mode: 'resume',
                attempt,
              });
              await answer;
              assert.deepEqual(await stopped, { code: 0, signal: null });
            }
            const second = launch();
            const outcome =
              cut === 'reserve'
                ? 'cancelled'
                : cut === 'community-clear'
                  ? 'settled-without-body'
                  : cut === 'media-clear'
                    ? 'already-cleared'
                    : 'settled';
            const settled = event(second, outcome),
              finished = exitOf(second);
            second.send({
              command: 'start',
              credentials: actor,
              journalPath,
              port,
              mode:
                cut === 'reserve' ? 'resume-and-explicitly-cancel' : 'resume',
              attempt,
            });
            await settled;
            assert.deepEqual(await finished, { code: 0, signal: null });
            assert.deepEqual(
              JSON.parse(await readFile(journalPath, 'utf8')),
              {},
            );
            const rows = await f.pool.query<{
              receipt: { outcome: string; resourceId: string } | null;
            }>(
              'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, body.clientRequestId],
            );
            if (cut === 'reserve') {
              assert.ok(
                rows.rows.length === 0 ||
                  rows.rows.every((row) => row.receipt?.outcome !== 'created'),
              );
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
                    'SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
                    [actor.accountId, body.clientRequestId],
                  )
                ).rowCount,
                1,
              );
            } else {
              assert.equal(rows.rowCount, 1);
              assert.equal(rows.rows[0]!.receipt?.outcome, 'created');
              const id = rows.rows[0]!.receipt!.resourceId;
              const bindings = await f.pool.query<{
                ordinal: number;
                resource_kind: string;
              }>(
                'SELECT ordinal,resource_kind FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) AND resource_id=$2 ORDER BY ordinal',
                [body.imageAssetIds, id],
              );
              assert.deepEqual(
                bindings.rows.map((r) => r.ordinal),
                [0, 1, 2],
              );
              assert.ok(
                bindings.rows.every((r) => r.resource_kind === target.kind),
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.outbox WHERE event_key=$1',
                    [`${target.kind}:${id}:created`],
                  )
                ).rowCount,
                1,
              );
            }
          });
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
