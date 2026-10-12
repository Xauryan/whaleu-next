/** Emitted App/Page/WXML -> ordinary AppModule -> disposable PostgreSQL.
 * Native callbacks are bounded simulation, not DevTools or device acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { adminPostRemovalIntentHash } from '../../src/community/admin-removal/evidence.js';
import type { AdminPostRemovalCommand } from '../../src/community/admin-removal/contracts.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});

test(
  'emitted admin removal handles anonymous and image posts, durable recovery/cancellation, account/origin isolation and owner-only notices',
  { timeout: 300000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor(),
      stranger = await f.actor();
    const grant = await f.grant(admin);
    const named = await f.publish(subject);
    const anonymous = await f.publish(subject, { authorMode: 'anonymous' });
    const image = await f.publish(subject, {}, true);
    const own = await f.publish(admin);
    const cancelled = await f.publish(subject),
      retry = await f.publish(subject);
    const stale = await f.publish(subject),
      late = await f.publish(subject),
      storage = await f.publish(subject);
    const comment = await f.child(stranger, named.id),
      reply = await f.child(subject, named.id, comment.id);
    const targets = Object.fromEntries(
      Object.entries({
        named,
        anonymous,
        image,
        own,
        cancelled,
        retry,
        stale,
        late,
        storage,
      }).map(([name, post]) => [name, { kind: 'post', id: post.id }]),
    );
    const get = (path: string, actor = admin) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const stable = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
    'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_identity.accounts a),
    'personas',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.thread_personas p),
    'source',(SELECT jsonb_agg(to_jsonb(b) ORDER BY content_kind,content_id) FROM whaleu_community.content_approval_bindings b)) value`)
      ).rows[0]!.value;
    const original = await stable();
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/admin-post-removal-native-child.mjs',
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
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    child.stdout?.resume();
    let logs = '';
    child.stderr?.on('data', (data) => {
      logs += String(data);
    });
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        const checkpoint = async (value: Record<string, unknown>) => {
          switch (value['name']) {
            case 'committed-loss-revoke-grant': {
              const command = value['command'] as AdminPostRemovalCommand;
              assert.equal(
                value['requestHash'],
                adminPostRemovalIntentHash(admin.accountId, command),
              );
              const recovered = await f.removalRecovery(
                admin,
                command.clientRequestId,
              );
              profileOk(recovered);
              assert.equal(recovered.body.receipt.outcome, 'applied');
              for (const path of [
                `/v1/community/posts/${named.id}`,
                `/v1/community/posts/${named.id}/comments`,
                `/v1/community/comments/${comment.id}`,
                `/v1/community/replies/${reply.id}`,
              ])
                assert.ok(
                  (await get(path, stranger)).status >= 400,
                  `Removed ancestor blocks ${path}`,
                );
              const notices = await get('/v1/me/system-notices', subject);
              profileOk(notices);
              assert.equal(notices.body.items.length, 1);
              assert.equal(notices.body.items[0].kind, 'admin_post_removed');
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                  [grant],
                ),
              );
              const unavailable = await get(
                '/v1/community/admin-post-removal/management',
              ).query({ kind: 'post', id: retry.id });
              assert.ok(
                unavailable.status >= 400,
                'Grant actually revoked before cold recovery',
              );
              break;
            }
            case 'restore-grant-after-recovery':
              await f.grant(admin);
              break;
            case 'cancelled-late-original': {
              const command = value['command'] as AdminPostRemovalCommand;
              const result = await f.removalSend(admin, command);
              profileOk(result);
              assert.equal(result.body.outcome, 'rejected');
              assert.equal(result.body.code, 'ADMIN_POST_REMOVAL_CANCELLED');
              profileOk(
                await get(`/v1/community/posts/${cancelled.id}`, stranger),
              );
              break;
            }
            case 'readable-target-version-change': {
              const before = await f.removalManagement(stale, admin);
              assert.equal(before.targetVersion, value['version']);
              // Independent writer changes physical tuple lineage, while ordinary
              // visible content stays byte-identical. Old native confirmation is stale.
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
                  [stale.id],
                ),
              );
              const after = await f.removalManagement(stale, admin);
              assert.notEqual(after.targetVersion, before.targetVersion);
              break;
            }
            default:
              throw Error(
                `Unexpected admin-removal native checkpoint: ${String(value['name'])}`,
              );
          }
          child.send({
            event: 'continue',
            name: value['name'],
            checkpointId: value['checkpointId'],
          });
        };
        child.on('message', (raw) => {
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
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!finished)
            reject(Error(`Admin removal native exit ${code}: ${logs}`));
        });
        child.send({
          port: (f.http.address() as { port: number }).port,
          mediaPort: (f.app.getHttpServer().address() as { port: number }).port,
          admin: credentials(admin),
          subject: credentials(subject),
          stranger: credentials(stranger),
          targets,
          imageAssetId: image.input.imageAssetIds[0],
        });
      },
    );
    t.diagnostic(
      `Emitted child completed ${String(done['httpCalls'])} HTTP exchanges, ${String(done['receiptReads'])} receipt reads, ${String(done['mediaReads'])} real media reads and ${String(done['noticeCount'])} owner notices before parent assertions.`,
    );
    assert.ok(Number(done['httpCalls']) >= 30);
    assert.ok(Number(done['receiptReads']) >= 6);
    assert.equal(done['noticeCount'], 6);
    assert.ok(Number(done['mediaReads']) >= 1);
    for (const [key, outcome, code] of [
      ['firstRequestId', 'applied', undefined],
      ['cancelledRequestId', 'rejected', 'ADMIN_POST_REMOVAL_CANCELLED'],
      ['staleRequestId', 'rejected', 'ADMIN_POST_REMOVAL_STALE'],
      ['retryRequestId', 'applied', undefined],
      ['lateRequestId', 'applied', undefined],
    ] as const) {
      const result = await f.removalRecovery(admin, String(done[key]));
      profileOk(result);
      assert.equal(result.body.state, 'recorded');
      assert.equal(result.body.receipt.outcome, outcome);
      assert.equal(result.body.receipt.code, code);
    }
    const appliedTargets = [named, anonymous, image, retry, late, storage];
    for (const target of appliedTargets)
      assert.ok(
        (await get(`/v1/community/posts/${target.id}`, stranger)).status >= 400,
      );
    for (const target of [own, cancelled, stale])
      profileOk(await get(`/v1/community/posts/${target.id}`, stranger));
    const bindings = (
      await f.pool.query(
        'SELECT id FROM whaleu_media.bindings WHERE asset_id=$1',
        [image.input.imageAssetIds[0]],
      )
    ).rows;
    assert.equal(bindings.length, 1);
    for (const variant of ['thumb-v1', 'display-v1']) {
      const path = `/v1/media/bindings/${bindings[0]!.id}/${variant}`;
      assert.ok(
        (
          await request(f.app.getHttpServer())
            .get(path)
            .set('Authorization', `Bearer ${stranger.accessToken}`)
        ).status >= 400,
      );
      assert.ok((await request(f.app.getHttpServer()).get(path)).status >= 400);
    }
    const counts = (
      await f.pool.query(
        `SELECT
    (SELECT count(*)::int FROM whaleu_community.admin_post_removal_commands) commands,
    (SELECT count(*)::int FROM whaleu_community.admin_post_removal_events) events,
    (SELECT count(*)::int FROM whaleu_community.admin_post_removal_transitions) transitions,
    (SELECT count(*)::int FROM whaleu_notifications.admin_post_removal_notices) notices,
    (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_kind='post' AND resource_id=ANY($1::uuid[])) cleanup,
    (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN('post_deleted','moderation_removed')) counterfeit`,
        [appliedTargets.map((target) => target.id)],
      )
    ).rows[0];
    assert.deepEqual(counts, {
      commands: 9,
      events: 6,
      transitions: 6,
      notices: 6,
      cleanup: 6,
      counterfeit: 0,
    });
    assert.deepEqual(await stable(), original);
    const notices = await get('/v1/me/system-notices', subject);
    profileOk(notices);
    assert.equal(notices.body.items.length, 6);
    assert.equal(notices.body.unreadCount, 5);
    const read = await request(f.http)
      .put(`/v1/me/system-notices/${String(done['readNoticeId'])}/read`)
      .set('Authorization', `Bearer ${subject.accessToken}`)
      .send({});
    profileOk(read);
    assert.equal(read.body.readAt, done['readAt']);
    const deniedRead = await request(f.http)
      .put(`/v1/me/system-notices/${String(done['readNoticeId'])}/read`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({});
    assert.equal(deniedRead.status, 404);
    t.diagnostic(
      `Emitted admin removal: ${String(done['httpCalls'])} real loopback exchanges, named/anonymous/image detail entry, owner fallback, lost-response cold recovery after grant revocation, immutable cancellation, identical retry, stale physical lineage, A/B/origin/relogin isolation, storage faults and six fixed owner-only notices.`,
    );
  },
);
