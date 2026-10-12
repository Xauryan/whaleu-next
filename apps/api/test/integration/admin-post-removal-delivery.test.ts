import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { MessagingRepository } from '../../src/messaging/repository.js';
import {
  MEDIA_ATTACHMENT,
  UnavailableMedia,
} from '../../src/community/community-policy.js';
import type { MediaAttachmentPort } from '../../src/community/community-policy.js';
import {
  CommunityMediaCleanupFacade,
  COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE,
} from '../../src/community/media/cleanup-facade.js';
import { CommunityMediaCleanupWorker } from '../../src/community/media/cleanup-worker.js';
import { MEDIA_APPLICATION } from '../../src/media/application.js';
import type { MediaApplication } from '../../src/media/application.js';
import { MediaLifecycleRepository } from '../../src/media/lifecycle-repository.js';
import { canonicalDmEnvelope } from '../../src/community/content-review/dm-contracts.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import {
  profileOk,
  waitForProfileDeadline,
} from '../support/media/profile-runtime-fixture.js';
import { approveDm } from '../support/dm-owner-fixture.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const cleanupJoin = `FROM whaleu_media.cleanup_obligations c
 LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
 LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
 LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
 LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
 LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id`;

test(
  'admin tombstone denies every fresh and paused Media open without recalling final-authorized streams or existing DM history',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor(),
      viewer = await f.actor();
    await f.grant(admin);
    const http = f.app.getHttpServer();
    for (const discussion of [false, true])
      for (const variant of ['thumb-v1', 'display-v1'] as const) {
        const post = await f.publish(subject, {}, true);
        const target = discussion
          ? await f.child(subject, post.id, null, true)
          : post;
        const binding = (
          await f.pool.query(
            "SELECT id FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_id=$1 AND detached_at IS NULL",
            [target.id],
          )
        ).rows[0]!;
        const view = await f.removalManagement(post, admin),
          body = f.removalCommand(post, view.targetVersion);
        const open = f.storage.openExact.bind(f.storage);
        let changed = false;
        // Community Media is authenticated-only. A guest never reaches storage;
        // separately prove the session open paused after selecting exact bytes.
        f.storage.openExact = async (object, maximum) => {
          const opened = await open(object, maximum);
          if (!changed) {
            changed = true;
            const applied = await f.removalSend(admin, body);
            profileOk(applied);
            assert.equal(applied.body.outcome, 'applied');
          }
          return opened;
        };
        try {
          const guest = await request(http).get(
            `/v1/media/bindings/${binding.id}/${variant}`,
          );
          assert.notEqual(guest.status, 200);
          assert.equal(Buffer.isBuffer(guest.body), false);
          assert.equal(
            changed,
            false,
            'Guest authentication fails before any storage open',
          );
          const pending = request(http).get(
            `/v1/media/bindings/${binding.id}/${variant}`,
          );
          pending.set('Authorization', `Bearer ${viewer.accessToken}`);
          const denied = await pending;
          assert.equal(changed, true);
          assert.notEqual(denied.status, 200);
          assert.equal(Buffer.isBuffer(denied.body), false);
        } finally {
          f.storage.openExact = open;
        }
        for (const token of [null, viewer.accessToken])
          for (const v of ['thumb-v1', 'display-v1']) {
            const fresh = request(http).get(
              `/v1/media/bindings/${binding.id}/${v}`,
            );
            if (token) fresh.set('Authorization', `Bearer ${token}`);
            assert.notEqual((await fresh).status, 200);
          }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_media.bindings WHERE resource_id=$1 AND detached_at IS NULL',
              [target.id],
            )
          ).rows[0]!.n,
          1,
          'Logical source denial precedes paged binding retirement',
        );
      }
    const post = await f.publish(subject, {}, true);
    const binding = (
      await f.pool.query(
        "SELECT id FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_id=$1 AND detached_at IS NULL",
        [post.id],
      )
    ).rows[0]!;
    const authorized = await f.app
      .get<MediaApplication>(MEDIA_APPLICATION)
      .open(viewer.accessToken, binding.id, 'display-v1');
    try {
      await f.removalApply(post, admin);
      const chunks: Buffer[] = [];
      for await (const chunk of authorized.stream)
        chunks.push(Buffer.from(chunk));
      assert.ok(
        Buffer.concat(chunks).length > 0,
        'A stream already through final authorization is not recalled',
      );
    } finally {
      authorized.abort();
    }
    const dmPost = await f.publish(subject);
    const openBody = {
      clientRequestId: randomUUID(),
      entry: { kind: 'post' as const, postId: dmPost.id },
      initiationMode: 'named' as const,
    };
    const openConversation = () =>
      request(f.http)
        .post('/v1/private-messages/conversations')
        .set('Authorization', `Bearer ${viewer.accessToken}`)
        .send(openBody);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_messaging.coverage_heads WHERE account_id=ANY($1::uuid[])',
          [[subject.accountId, viewer.accountId, admin.accountId]],
        )
      ).rows[0]!.n,
      0,
    );
    const records = f.moderationApp.get(MessagingRepository),
      originalCoverage = records.coverage;
    let missingCoverageReached = false;
    records.coverage = async (actor, tx) => {
      try {
        return await originalCoverage.call(records, actor, tx);
      } catch (error) {
        missingCoverageReached = actor === viewer.accountId;
        throw error;
      }
    };
    try {
      const unavailable = await openConversation();
      profileOk(unavailable, 503);
      assert.equal(unavailable.body.error.code, 'DM_UNAVAILABLE');
      assert.equal(
        missingCoverageReached,
        true,
        'The real DM owner rejects missing local-inception coverage before source resolution',
      );
    } finally {
      records.coverage = originalCoverage;
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2',
          [viewer.accountId, openBody.clientRequestId],
        )
      ).rows[0]!.n,
      0,
    );
    // Same explicit synthetic local-inception facts as messagingRuntimeFixture.
    // This is not inferred historical coverage or a production/startup grant.
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const actor of [subject, viewer, admin]) {
        await tx.query(
          'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT DO NOTHING',
          [actor.accountId],
        );
        await tx.query(
          "INSERT INTO whaleu_messaging.coverage_heads(account_id,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until,revision) VALUES($1,'local','accepted','synthetic-dm-local','isolated-admin-removal-inception','isolated-test-policy',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',$2)",
          [actor.accountId, randomUUID()],
        );
      }
    });
    const opened = await openConversation();
    profileOk(opened);
    assert.notEqual(opened.body.outcome, 'rejected');
    const conversationId = opened.body.conversationId as string;
    const c = (
      await f.pool.query(
        'SELECT * FROM whaleu_messaging.conversations WHERE id=$1',
        [conversationId],
      )
    ).rows[0]!;
    const message = {
      clientRequestId: randomUUID(),
      text: 'This existing private conversation remains after source removal',
    };
    await approveDm(
      f.pool,
      canonicalDmEnvelope({
        version: 1,
        purpose: 'send_private_message',
        accountId: viewer.accountId,
        clientRequestId: message.clientRequestId,
        conversationId,
        contextDigest: c.context_digest,
        senderSlot: c.account0 === viewer.accountId ? 0 : 1,
        participantModes: [c.mode0, c.mode1],
        text: message.text,
        assetIds: [],
      }),
    );
    const sent = await request(f.http)
      .post(`/v1/private-messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .send(message);
    profileOk(sent);
    assert.notEqual(sent.body.outcome, 'rejected');
    await f.removalApply(dmPost, admin);
    const sourceOpen = await request(f.http)
      .post('/v1/private-messages/conversations')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        clientRequestId: randomUUID(),
        entry: { kind: 'post', postId: dmPost.id },
        initiationMode: 'named',
      });
    profileOk(sourceOpen);
    assert.equal(sourceOpen.body.outcome, 'rejected');
    assert.equal(sourceOpen.body.code, 'DM_ENTRY_UNAVAILABLE');
    for (const actor of [subject, viewer]) {
      const history = await request(f.http)
        .get(`/v1/private-messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${actor.accessToken}`);
      profileOk(history);
      assert.ok(JSON.stringify(history.body).includes(message.text));
    }
    t.diagnostic(
      JSON.stringify({
        missingCoverageReached,
        freshSourceOpen: sourceOpen.body.code,
        preservedHistoryParticipants: 2,
        pausedSessionVariants: 4,
        guestStorageOpens: 0,
      }),
    );
  },
);

test(
  'admin cleanup reuses crash-safe pages of sixteen and real physical-retention and quiescence gates',
  { timeout: 360000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    const post = await f.publish(subject, {}, true),
      root = await f.child(subject, post.id, null, true);
    const replies = [];
    for (let i = 0; i < 18; i++)
      replies.push(await f.child(subject, post.id, root.id, i === 0));
    const unaffected = await f.publish(subject, {}, true);
    const untouched = (
      await f.pool.query(
        'SELECT to_jsonb(b) value FROM whaleu_media.bindings b WHERE resource_id=$1',
        [unaffected.id],
      )
    ).rows[0]!.value;
    await f.removalApply(post, admin);
    const job = (
      await f.pool.query(
        "SELECT id FROM whaleu_community.media_cleanup_jobs WHERE resource_kind='post' AND resource_id=$1",
        [post.id],
      )
    ).rows[0]!;
    const database = f.app.get(DatabaseService),
      media = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
    const worker = () =>
      new CommunityMediaCleanupWorker(
        database,
        new CommunityMediaCleanupFacade(),
        media,
      );
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM whaleu_community.media_cleanup_jobs j),'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM whaleu_media.bindings b),'cleanup',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_media.cleanup_obligations c)) value`,
        )
      ).rows[0]!.value;
    const before = await snapshot();
    const originalCleanupIds = new Set(
      ((before.cleanup ?? []) as { id: string }[]).map((row) => row.id),
    );
    class FailAfterDetach extends UnavailableMedia {
      override async detachMany(
        targets: readonly { kind: 'post' | 'comment' | 'reply'; id: string }[],
        tx: PoolClient,
      ) {
        assert.ok(media.detachMany);
        await media.detachMany(targets, tx);
        throw Error('SYNTHETIC_ADMIN_CLEANUP_ROLLBACK');
      }
    }
    await assert.rejects(
      new CommunityMediaCleanupWorker(
        database,
        new CommunityMediaCleanupFacade(),
        new FailAfterDetach(),
      ).runOnePage(job.id),
      /SYNTHETIC_ADMIN_CLEANUP_ROLLBACK/,
    );
    assert.deepEqual(await snapshot(), before);
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/media/discussion-cleanup-process.mjs',
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
    try {
      const paused = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              Error('Cleanup process did not pause after its actual detach'),
            ),
          20000,
        );
        child.on('message', (value: unknown) => {
          if (value && typeof value === 'object' && 'event' in value) {
            if (value.event === 'detached-before-cursor') {
              clearTimeout(timer);
              resolve();
            } else if (value.event === 'failure') {
              clearTimeout(timer);
              reject(Error(JSON.stringify(value)));
            }
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(Error('Cleanup process exited before the pause'));
        });
      });
      child.send({ command: 'run', jobId: job.id, pauseTarget: post.id });
      await paused;
      assert.deepEqual(await snapshot(), before);
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
      assert.deepEqual(
        await snapshot(),
        before,
        'Crash rolls back binding retirement and leaves original durable cursor',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
    const pages = [];
    for (let i = 0; i < 10; i++) {
      const result = await worker().runOnePage(job.id);
      pages.push(result);
      if (result.status === 'idle') break;
      assert.ok(result.detachedTargets <= COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE);
    }
    assert.ok(
      pages.some(
        (page) => page.status !== 'idle' && page.detachedTargets === 16,
      ),
    );
    assert.equal(pages.at(-1)?.status, 'idle');
    const done = (
      await f.pool.query(
        'SELECT phase,detached_targets,enumeration_completed_at FROM whaleu_community.media_cleanup_jobs WHERE id=$1',
        [job.id],
      )
    ).rows[0]!;
    assert.equal(done.phase, 'complete');
    assert.equal(Number(done.detached_targets), 20);
    assert.ok(done.enumeration_completed_at);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_media.bindings WHERE resource_id=ANY($1::uuid[]) AND detached_at IS NULL',
          [[post.id, root.id, ...replies.map((reply) => reply.id)]],
        )
      ).rows[0]!.n,
      0,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(b) value FROM whaleu_media.bindings b WHERE resource_id=$1',
          [unaffected.id],
        )
      ).rows[0]!.value,
      untouched,
    );
    const obligations = (
      await f.pool.query<{
        id: string;
        not_before: Date;
        created_at: Date;
        retention: number;
      }>(
        `SELECT c.id,c.not_before,c.created_at,extract(epoch FROM(c.not_before-c.created_at))::double precision retention ${cleanupJoin} JOIN whaleu_media.upload_intents i ON i.id=coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id) WHERE c.state='pending' AND i.state='cleanup_pending' ORDER BY c.not_before DESC`,
      )
    ).rows;
    assert.ok(obligations.length > 0);
    const newObligations = obligations.filter(
      (row) => !originalCleanupIds.has(row.id),
    );
    assert.ok(newObligations.length > 0);
    const newObligationIds = new Set(newObligations.map((row) => row.id));
    assert.ok(
      newObligations.every(
        (item) => item.retention >= 119.9 && item.retention <= 120.1,
      ),
      JSON.stringify(obligations),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND confirmed_deleted_at IS NOT NULL',
          [obligations.map((item) => item.id)],
        )
      ).rows[0]!.n,
      0,
    );
    // Existing ingress-scratch obligations are due immediately. Drain only
    // already-due work through the mature owner; new retirement debt must stay
    // pending until its actual stored two-minute deadline, without clock edits.
    const earlyCleanup = new SyntheticMediaCleanup(f.pool, f.storage);
    let early = 0;
    for (;;) {
      const result = await earlyCleanup.runOne();
      if (result === 'idle') break;
      assert.equal(result, 'deleted');
      assert.ok(++early <= originalCleanupIds.size);
    }
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND (state<>'pending' OR confirmed_deleted_at IS NOT NULL)",
          [[...newObligationIds]],
        )
      ).rows[0]!.n,
      0,
    );
    await waitForProfileDeadline(f.pool, newObligations[0]!.not_before);
    const lifecycle = new MediaLifecycleRepository();
    const lease = await withCommunityScopeWriter(f.pool, (tx) =>
      lifecycle.claimCleanup(tx),
    );
    assert.ok(lease);
    assert.ok(
      newObligationIds.has(lease.id),
      'Quiescence is tested on new tombstone retirement debt',
    );
    assert.equal(
      await withCommunityScopeWriter(f.pool, (tx) =>
        lifecycle.settleCleanup(lease, 'confirmed-absent', tx),
      ),
      'retained',
      'Physical deletion also requires exact quiescence, not merely elapsed retention',
    );
    const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
    let deleted = 0;
    for (let i = 0; i < 100; i++) {
      const result = await cleanup.runOne();
      if (result === 'idle') break;
      assert.equal(result, 'deleted');
      deleted++;
    }
    assert.equal(deleted, newObligations.length - 1);
    assert.ok(deleted > 0);
    t.diagnostic(
      JSON.stringify({
        cleanupTargets: Number(done.detached_targets),
        maximumPage: Math.max(
          ...pages.map((page) =>
            page.status === 'idle' ? 0 : page.detachedTargets,
          ),
        ),
        earlyScratchDeleted: early,
        retirementObligations: newObligations.length,
        physicallyDeleted: deleted,
        retainedWithoutQuiescence: 1,
      }),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND state NOT IN('deleted','retained')",
          [obligations.map((item) => item.id)],
        )
      ).rows[0]!.n,
      0,
    );
    const read = await request(f.app.getHttpServer())
      .get(`/v1/media/bindings/${untouched.id}/display-v1`)
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(read);
  },
);
