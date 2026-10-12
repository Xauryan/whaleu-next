/** Emitted App/Page/WXML -> ordinary AppModule -> disposable PostgreSQL.
 * This is bounded native platform simulation, not DevTools/device acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { profileModerationFixture } from '../support/profile-moderation-fixture.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));
const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});

test(
  'emitted nickname management covers post/comment/reply, cold original-key recovery, cancellation and shared-CAS refresh',
  { timeout: 240000 },
  async (t) => {
    const f = await profileModerationFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor(),
      stranger = await f.actor();
    await f.grant(admin.accountId, 'school_admin', f.scope.home.regionId);
    const post = await f.publish(subject),
      parent = await f.publish(stranger);
    const comment = await f.child(subject, parent.id),
      reply = await f.child(subject, parent.id, comment.id);
    const anonymous = await f.publish(subject, { authorMode: 'anonymous' });
    const foreign = await f.publish(subject, {
      spaceId: f.scope.foreign.spaceId,
    });
    const http = f.app.getHttpServer();
    const get = (path: string, actor = admin) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const ownerProfile = async () => {
      const result = await get('/v1/me/profile', subject);
      ok(result);
      return result.body as {
        revision: number;
        nickname: string | null;
        bio: string;
      };
    };
    const beforeProfile = await ownerProfile();
    const immutable = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'posts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM whaleu_community.posts p),
    'comments',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM whaleu_community.root_comments c),
    'replies',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM whaleu_community.replies r),
    'personas',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM whaleu_community.thread_personas p),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.content_kind,b.content_id) FROM whaleu_community.content_approval_bindings b)
  ) bytes`)
      ).rows[0]!.bytes;
    const originalBytes = await immutable();
    const anonymousBefore = await get(`/v1/community/posts/${anonymous.id}`);
    ok(anonymousBefore);
    const setHidden = async (ownerHidden: boolean) => {
      const state = await get(
        `/v1/me/community/posts/${post.id}/owner-visibility`,
        subject,
      );
      ok(state);
      const result = await request(http)
        .post('/v1/me/community/owner-visibility-commands')
        .set('Authorization', `Bearer ${subject.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          postId: post.id,
          ownerHidden,
          expectedVersion: state.body.version,
        });
      ok(result);
      assert.equal(result.body.outcome, 'applied');
    };
    const process = fork(
      fileURLToPath(
        new URL(
          '../support/profile-moderation-native-child.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (process.connected) process.disconnect();
      if (process.exitCode === null) process.kill();
    });
    process.stdout?.resume();
    let logs = '';
    process.stderr?.on('data', (data) => {
      logs += String(data);
    });
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        const checkpoint = async (value: Record<string, unknown>) => {
          switch (value['name']) {
            case 'hide-after-committed-loss': {
              const command = value['command'] as { clientRequestId: string };
              const recovered = await get(
                `/v1/community/profile-moderation/requests/${command.clientRequestId}`,
              );
              ok(recovered);
              assert.equal(recovered.body.receipt.outcome, 'applied');
              assert.equal(
                (await ownerProfile()).revision,
                beforeProfile.revision + 1,
              );
              await setHidden(true);
              const management = await get(
                '/v1/community/profile-moderation/management',
              ).query({ kind: 'post', id: post.id });
              assert.ok(
                management.status >= 400,
                JSON.stringify(management.body),
              );
              break;
            }
            case 'restore-after-cold-recovery':
              await setHidden(false);
              break;
            case 'three-kinds-applied': {
              const current = await ownerProfile();
              assert.equal(current.revision, beforeProfile.revision + 3);
              assert.match(current.nickname!, /^违规昵称[A-Za-z0-9]{6}$/);
              const view = await get(`/v1/community/posts/${foreign.id}`);
              ok(view);
              assert.equal(view.body.author.displayName, current.nickname);
              assert.deepEqual(await immutable(), originalBytes);
              break;
            }
            case 'owner-edit-before-native-submit': {
              const expectedRevision = Number(value['expectedRevision']);
              assert.equal((await ownerProfile()).revision, expectedRevision);
              const edit = await request(http)
                .patch('/v1/me/profile')
                .set('Authorization', `Bearer ${subject.accessToken}`)
                .send({
                  expectedRevision,
                  bio: 'Owner edit wins shared Profile CAS',
                });
              ok(edit);
              break;
            }
            default:
              throw Error(
                `Unexpected nickname native checkpoint: ${String(value['name'])}`,
              );
          }
          process.send({
            event: 'continue',
            name: value['name'],
            checkpointId: value['checkpointId'],
          });
        };
        process.on('message', (raw) => {
          const value = raw as Record<string, unknown>;
          if (value['event'] === 'checkpoint')
            void checkpoint(value).catch(reject);
          else if (value['event'] === 'failure') {
            finished = true;
            reject(Error(String(value['message'])));
          } else if (value['event'] === 'done') {
            finished = true;
            resolve(value);
          }
        });
        process.on('error', reject);
        process.on('exit', (code) => {
          if (!finished) reject(Error(`Nickname native exit ${code}: ${logs}`));
        });
        process.send({
          port: f.port,
          admin: credentials(admin),
          stranger: credentials(stranger),
          postTarget: { kind: 'post', id: post.id },
          commentTarget: { kind: 'comment', id: comment.id },
          replyTarget: { kind: 'reply', id: reply.id },
        });
      },
    );
    assert.deepEqual(done['targetKinds'], ['comment', 'post', 'reply']);
    assert.ok(Number(done['receiptReads']) >= 3);
    assert.ok(Number(done['httpCalls']) >= 12);
    for (const [key, outcome, code] of [
      ['firstRequestId', 'applied', undefined],
      ['cancelledRequestId', 'rejected', 'PROFILE_MODERATION_CANCELLED'],
      ['staleRequestId', 'rejected', 'PROFILE_MODERATION_STALE'],
    ] as const) {
      const receipt = await get(
        `/v1/community/profile-moderation/requests/${String(done[key])}`,
      );
      ok(receipt);
      assert.equal(receipt.body.state, 'recorded');
      assert.equal(receipt.body.receipt.outcome, outcome);
      assert.equal(receipt.body.receipt.code, code);
    }
    const after = await ownerProfile();
    assert.equal(after.revision, beforeProfile.revision + 4);
    assert.equal(after.bio, 'Owner edit wins shared Profile CAS');
    assert.deepEqual(await immutable(), originalBytes);
    const anonymousAfter = await get(`/v1/community/posts/${anonymous.id}`);
    ok(anonymousAfter);
    assert.deepEqual(anonymousAfter.body.author, anonymousBefore.body.author);
    const notices = await get('/v1/me/system-notices', subject);
    ok(notices);
    assert.equal(notices.body.items.length, 3);
    assert.equal(notices.body.unreadCount, 3);
    assert.ok(
      notices.body.items.every(
        (notice: { kind: string }) => notice.kind === 'profile_nickname_reset',
      ),
    );
    const rows = (
      await f.pool.query(`SELECT
    (SELECT count(*)::integer FROM whaleu_profile.moderation_commands) commands,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_events) events,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_transitions) transitions,
    (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) notices`)
    ).rows[0];
    assert.deepEqual(rows, {
      commands: 5,
      events: 3,
      transitions: 3,
      notices: 3,
    });
    t.diagnostic(
      `Emitted nickname journey: ${String(done['httpCalls'])} real loopback exchanges; all three targets, cold recovery, exact cancellation, stale CAS, immutable anonymity.`,
    );
  },
);
