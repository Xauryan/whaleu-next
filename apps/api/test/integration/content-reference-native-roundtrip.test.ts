/** Authored emitted-native -> ordinary AppModule -> disposable PostgreSQL evidence.
 * Synthetic initialization only; no production migration/activation, provider,
 * actual WeChat rendering or physical-device acceptance is claimed. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { ContentReferenceAllocation } from '../../src/community/content-references/allocation.js';
import { ContentReferenceRepository } from '../../src/community/content-references/repository.js';
import type { ReferenceTarget } from '../../src/community/content-references/contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import {
  socialAuth,
  withSocialUpdatesFixture,
  type SocialActor,
  type SocialUpdatesFixture,
} from '../support/social-updates-fixture.js';

interface NativeInput {
  phase: 'inactive' | 'ready';
  port: number;
  credentials: SocialActor;
  sourcePostId: string;
  viewSpaceId: string;
  sourceCode?: string;
  targets?: {
    kind: ReferenceTarget['kind'];
    code: string;
    postId: string;
    rootCommentId?: string;
    replyId?: string;
  }[];
}
async function runNative(input: NativeInput): Promise<void> {
  const child = fork(
    fileURLToPath(
      new URL(
        '../fixtures/content-reference-native-worker.mjs',
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
  let logs = '',
    acknowledged = false;
  const append = (value: Buffer) => {
    logs = (logs + String(value)).slice(-8000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Native reference ${input.phase} worker exceeded 90 seconds`,
            ),
          ),
        90000,
      );
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0 && acknowledged) resolve();
        else
          reject(
            new Error(
              `Native reference ${input.phase} worker failed (exit ${code}, done ${acknowledged}): ${logs}`,
            ),
          );
      });
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('event' in raw)) return;
        if (raw.event === 'failure')
          reject(
            new Error(
              `Native reference ${input.phase}: ${'message' in raw ? String(raw.message) : 'unknown worker failure'}`,
            ),
          );
        if (raw.event === 'done') {
          if (
            !('phase' in raw) ||
            raw.phase !== input.phase ||
            !('referenceRequests' in raw) ||
            typeof raw.referenceRequests !== 'number' ||
            raw.referenceRequests < 1
          ) {
            reject(
              new Error(
                'Native reference worker returned an invalid completion report',
              ),
            );
            return;
          }
          acknowledged = true;
        }
      });
      child.send(input, (error) => {
        if (error) reject(error);
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
async function publishText(
  f: SocialUpdatesFixture,
  actor: SocialActor,
  text: string,
): Promise<string> {
  const body = {
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion' as const,
    authorMode: 'named' as const,
    text,
    commentsPolicy: 'open' as const,
    imageAssetIds: [],
  };
  await approveEnvelope(
    f.pool,
    await postApprovalEnvelope(f.app, f.pool, actor.accountId, body),
  );
  const response = await request(f.http)
    .post('/v1/community/posts')
    .set('Authorization', socialAuth(actor))
    .send(body)
    .timeout({ response: 12000, deadline: 15000 });
  assert.equal(
    response.status,
    201,
    'Exact approved synthetic source publication must succeed',
  );
  assert.equal(response.body.outcome, 'created');
  assert.equal(typeof response.body.resourceId, 'string');
  return response.body.resourceId as string;
}
async function state(f: SocialUpdatesFixture) {
  // Operational limiter accounting is deliberately excluded. Content allocation,
  // publication, outbox, notices and acknowledgments must not change on reads.
  return (
    await f.pool.query(`SELECT
    (SELECT count(*)::int FROM whaleu_community.posts) posts,
    (SELECT count(*)::int FROM whaleu_community.root_comments) comments,
    (SELECT count(*)::int FROM whaleu_community.replies) replies,
    (SELECT count(*)::int FROM whaleu_community.outbox) events,
    (SELECT count(*)::int FROM whaleu_community.content_reference_reservations) reservations,
    (SELECT count(*)::int FROM whaleu_community.content_reference_canonicals) canonicals,
    (SELECT jsonb_agg(jsonb_build_array(name,next_code::text) ORDER BY name) FROM whaleu_community.content_reference_sequences) counters,
    (SELECT count(*)::int FROM whaleu_notifications.notices) notices,
    (SELECT count(*)::int FROM whaleu_notifications.notices WHERE read_at IS NOT NULL) notice_reads,
    (SELECT count(*)::int FROM whaleu_notifications.social_notices) social_notices,
    (SELECT count(*)::int FROM whaleu_notifications.social_notices WHERE read_at IS NOT NULL) social_reads`)
  ).rows[0];
}

test(
  'emitted reference Page/component -> real inactive/ready HTTP and located reads, without allocation or acknowledgement',
  { timeout: 240000 },
  async () => {
    await withSocialUpdatesFixture(async (f) => {
      const owner = await f.actor(),
        reader = await f.actor();
      // Actor creation grants no public profile. Establish it through the ordinary
      // current-revision profile writer, never a direct identity/projection insert.
      const profile = await request(f.http)
        .get('/v1/me/profile')
        .set('Authorization', socialAuth(owner))
        .timeout({ response: 12000, deadline: 15000 });
      assert.equal(profile.status, 200);
      const named = await request(f.http)
        .patch('/v1/me/profile')
        .set('Authorization', socialAuth(owner))
        .send({
          expectedRevision: profile.body.revision,
          nickname: 'Reference_Owner',
        })
        .timeout({ response: 12000, deadline: 15000 });
      assert.equal(
        named.status,
        200,
        'Synthetic publisher must establish its own public nickname normally',
      );
      const inactive = await publishText(f, owner, '原样文字\n  #1234567  😀');
      const references = f.app.get(ContentReferenceRepository),
        allocation = f.app.get(ContentReferenceAllocation);
      const codeFor = (target: ReferenceTarget) =>
        inTransaction(f.pool, (tx) => references.canonical(target, tx));
      assert.equal(await codeFor({ kind: 'post', targetId: inactive }), null);
      await f.app.listen(0, '127.0.0.1');
      const port = (f.http.address() as AddressInfo).port;
      const beforeInactive = await state(f);
      await runNative({
        phase: 'inactive',
        port,
        credentials: reader,
        sourcePostId: inactive,
        viewSpaceId: f.scope.home.spaceId,
      });
      assert.deepEqual(
        await state(f),
        beforeInactive,
        'Inactive rendering does not allocate, publish or acknowledge',
      );

      // Trusted, explicit synthetic fixture initialization on an already-verified
      // empty/disposable loopback database. This is not a runtime/operator route.
      await inTransaction(f.pool, async (tx) => {
        await tx.query(
          "UPDATE whaleu_community.content_reference_policy SET state='allocating',initialization_id=$1,source_kind='synthetic',historical_cutoff=0 WHERE singleton",
          [randomUUID()],
        );
        const existing = await allocation.allocateForPublication(
          { kind: 'post', targetId: inactive },
          tx,
        );
        assert.equal(existing.state, 'allocated');
      });
      const targetPost = await publishText(f, owner, '真实接口的合成目标正文');
      const root = await f.comment(owner, targetPost),
        reply = await f.reply(owner, targetPost, root.id);
      const postCode = await codeFor({ kind: 'post', targetId: targetPost });
      const commentCode = await codeFor({ kind: 'comment', targetId: root.id });
      const replyCode = await codeFor({ kind: 'reply', targetId: reply.id });
      assert.ok(postCode && commentCode && replyCode);
      const sourcePostId = await publishText(
        f,
        owner,
        `保留空白\n  #${postCode}  #${commentCode}\n#${replyCode} 😀`,
      );
      const sourceCode = await codeFor({
        kind: 'post',
        targetId: sourcePostId,
      });
      assert.ok(sourceCode);
      await inTransaction(f.pool, async (tx) => {
        await references.policy(tx, 'update');
        const missing = await tx.query(`SELECT 1 FROM (
        SELECT 'post' kind,id FROM whaleu_community.posts UNION ALL
        SELECT 'comment' kind,id FROM whaleu_community.root_comments UNION ALL
        SELECT 'reply' kind,id FROM whaleu_community.replies) retained
        WHERE NOT EXISTS(SELECT 1 FROM whaleu_community.content_reference_canonicals c WHERE c.target_kind=retained.kind AND c.target_id=retained.id) LIMIT 1`);
        assert.equal(
          missing.rowCount,
          0,
          'Every retained synthetic target must have a canonical mapping before readiness',
        );
        await tx.query(
          "UPDATE whaleu_community.content_reference_policy SET state='ready',public_enabled=true WHERE singleton",
        );
      });
      const beforeReady = await state(f);
      await runNative({
        phase: 'ready',
        port,
        credentials: reader,
        sourcePostId,
        sourceCode,
        viewSpaceId: f.scope.home.spaceId,
        targets: [
          { kind: 'post', code: postCode, postId: targetPost },
          {
            kind: 'comment',
            code: commentCode,
            postId: targetPost,
            rootCommentId: root.id,
          },
          {
            kind: 'reply',
            code: replyCode,
            postId: targetPost,
            rootCommentId: root.id,
            replyId: reply.id,
          },
        ],
      });
      assert.deepEqual(
        await state(f),
        beforeReady,
        'Fresh resolution/navigation/located reads must not allocate, publish or acknowledge',
      );
      assert.equal(
        await codeFor({ kind: 'post', targetId: targetPost }),
        postCode,
      );
      assert.equal(
        await codeFor({ kind: 'comment', targetId: root.id }),
        commentCode,
      );
      assert.equal(
        await codeFor({ kind: 'reply', targetId: reply.id }),
        replyCode,
      );
    });
  },
);
