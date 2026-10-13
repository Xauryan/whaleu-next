/** Actual emitted App/Page/WXML -> ordinary AppModule -> disposable PostgreSQL.
 * Only native platform callbacks and local file handles are synthetic. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { adminDiscussionRemovalIntentHash } from '../../src/community/admin-discussion-removal/evidence.js';
import type { AdminDiscussionRemovalCommand } from '../../src/community/admin-discussion-removal/contracts.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
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

for (const kind of ['comment', 'reply'] as const)
  test(
    `emitted ${kind} admin removal: exact Detail/Thread targets, real images, durable interruption recovery, no notices or identity reads`,
    { timeout: 360000 },
    async (t) => {
      const f = await adminDiscussionRemovalFixture(true);
      t.after(() => f.close());
      const admin = await f.actor(),
        subject = await f.actor(),
        stranger = await f.actor();
      const grant = await f.grant(admin);
      const create = async (
        actor = subject,
        mode: 'named' | 'anonymous' = 'named',
        images = false,
      ) => {
        const post = await f.publish(
          stranger,
          images ? {} : { authorMode: mode },
          images,
        );
        const root = await f.discussion(
          kind === 'comment' ? actor : stranger,
          post.id,
          { authorMode: mode, images, text: images ? '' : 'Native root' },
        );
        const selected =
          kind === 'comment'
            ? root
            : await f.discussion(actor, post.id, {
                rootId: root.id,
                authorMode: mode,
                images,
                text: images ? '' : 'Native reply',
              });
        const descendant = await f.discussion(stranger, post.id, {
          rootId: root.id,
          authorMode: mode,
          ...(kind === 'reply' ? { targetReplyId: selected.id } : {}),
        });
        const sibling = await f.discussion(stranger, post.id, {
          authorMode: mode,
        });
        return {
          ...selected,
          postId: post.id,
          rootId: root.id,
          descendantId: descendant.id,
          siblingId: sibling.id,
          mode,
        };
      };
      const named = await create(),
        anonymous = await create(subject, 'anonymous'),
        image = await create(subject, 'named', true),
        own = await create(admin),
        cancelled = await create(),
        retry = await create(),
        stale = await create(),
        late = await create(),
        storage = await create();
      const entries = {
        named,
        anonymous,
        image,
        own,
        cancelled,
        retry,
        stale,
        late,
        storage,
      };
      const targets = Object.fromEntries(
        Object.entries(entries).map(([name, target]) => [
          name,
          { kind, id: target.id },
        ]),
      );
      const routes = Object.fromEntries(
        Object.values(entries).map((target) => [
          target.id,
          { postId: target.postId, rootId: target.rootId },
        ]),
      );
      const get = (path: string, actor = admin) =>
        request(f.http)
          .get(path)
          .set('Authorization', `Bearer ${actor.accessToken}`);
      const resourcePath = (id: string) =>
        `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${id}`;
      const stable = async () =>
        (
          await f.pool.query(`SELECT jsonb_build_object(
        'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
        'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_identity.accounts a),
        'personas',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.thread_personas p),
        'source',(SELECT jsonb_agg(to_jsonb(b) ORDER BY content_kind,content_id) FROM whaleu_community.content_approval_bindings b),
        'xp',(SELECT jsonb_agg(to_jsonb(o) ORDER BY event_key) FROM whaleu_community.outbox o WHERE event_type IN('post_deleted','comment_deleted','reply_deleted','moderation_removed'))) value`)
        ).rows[0]!.value;
      const original = await stable();
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/admin-discussion-removal-native-child.mjs',
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
                const command = value[
                  'command'
                ] as AdminDiscussionRemovalCommand;
                assert.equal(
                  value['requestHash'],
                  adminDiscussionRemovalIntentHash(admin.accountId, command),
                );
                const recovered = await f.removalRecovery(
                  admin,
                  command.clientRequestId,
                );
                profileOk(recovered);
                assert.equal(recovered.body.receipt.outcome, 'applied');
                assert.ok(
                  (await get(resourcePath(named.id), stranger)).status >= 400,
                );
                profileOk(
                  await get(`/v1/community/posts/${named.postId}`, stranger),
                );
                profileOk(
                  await get(
                    `/v1/community/comments/${named.siblingId}`,
                    stranger,
                  ),
                );
                const descendant = await get(
                  `/v1/community/replies/${named.descendantId}`,
                  stranger,
                );
                if (kind === 'comment') assert.ok(descendant.status >= 400);
                else {
                  profileOk(descendant);
                  assert.equal(descendant.body.target.status, 'unavailable');
                }
                const notices = await get('/v1/me/system-notices', subject);
                profileOk(notices);
                assert.equal(notices.body.items.length, 0);
                await withCommunityScopeWriter(f.pool, (tx) =>
                  tx.query(
                    'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                    [grant],
                  ),
                );
                const unavailable = await get(
                  '/v1/community/admin-discussion-removal/management',
                ).query(targets['retry']!);
                assert.ok(
                  unavailable.status >= 400,
                  'Grant actually revoked before source-independent cold recovery',
                );
                break;
              }
              case 'restore-grant-after-recovery':
                await f.grant(admin);
                break;
              case 'cancelled-late-original': {
                const result = await f.removalSend(
                  admin,
                  value['command'] as AdminDiscussionRemovalCommand,
                );
                profileOk(result);
                assert.equal(result.body.outcome, 'rejected');
                assert.equal(
                  result.body.code,
                  'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
                );
                profileOk(await get(resourcePath(cancelled.id), stranger));
                break;
              }
              case 'readable-target-version-change': {
                const before = await f.removalManagement(stale, admin);
                assert.equal(before.targetVersion, value['version']);
                await withCommunityScopeWriter(f.pool, (tx) =>
                  tx.query(
                    `UPDATE whaleu_community.${kind === 'comment' ? 'root_comments' : 'replies'} SET text=text WHERE id=$1`,
                    [stale.id],
                  ),
                );
                const after = await f.removalManagement(stale, admin);
                assert.notEqual(after.targetVersion, before.targetVersion);
                break;
              }
              default:
                throw Error(
                  `Unexpected native discussion-removal checkpoint: ${String(value['name'])}`,
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
              reject(Error(`Native discussion-removal exit ${code}: ${logs}`));
          });
          child.send({
            port: (f.http.address() as { port: number }).port,
            mediaPort: (f.app.getHttpServer().address() as { port: number })
              .port,
            admin: credentials(admin),
            subject: credentials(subject),
            stranger: credentials(stranger),
            targets,
            routes,
            kind,
            imageAssetId: image.body.imageAssetIds[0],
          });
        },
      );
      assert.ok(Number(done['httpCalls']) >= 30);
      assert.ok(Number(done['receiptReads']) >= 6);
      assert.equal(done['noticeCount'], 0);
      assert.ok(Number(done['mediaReads']) >= 1);
      assert.equal(done['privateIdentityReads'], 0);
      for (const [key, outcome, code] of [
        ['firstRequestId', 'applied', undefined],
        [
          'cancelledRequestId',
          'rejected',
          'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
        ],
        ['staleRequestId', 'rejected', 'ADMIN_DISCUSSION_REMOVAL_STALE'],
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
      for (const target of appliedTargets) {
        assert.ok((await get(resourcePath(target.id), stranger)).status >= 400);
        profileOk(await get(`/v1/community/posts/${target.postId}`, stranger));
        profileOk(
          await get(`/v1/community/comments/${target.siblingId}`, stranger),
        );
      }
      for (const target of [own, cancelled, stale])
        profileOk(await get(resourcePath(target.id), stranger));
      const bindings = (
        await f.pool.query(
          'SELECT id FROM whaleu_media.bindings WHERE asset_id=$1',
          [image.body.imageAssetIds[0]],
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
        assert.ok(
          (await request(f.app.getHttpServer()).get(path)).status >= 400,
        );
      }
      const counts = (
        await f.pool.query(
          `SELECT
        (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_commands) commands,
        (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_events) events,
        (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_transitions) transitions,
        (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_components) components,
        (SELECT count(*)::int FROM whaleu_notifications.admin_post_removal_notices) notices,
        (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$2 AND resource_id=ANY($1::uuid[])) cleanup,
        (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN('comment_deleted','reply_deleted','moderation_removed')) counterfeit`,
          [appliedTargets.map((target) => target.id), kind],
        )
      ).rows[0];
      assert.deepEqual(counts, {
        commands: 9,
        events: 6,
        transitions: 6,
        components: 6,
        notices: 0,
        cleanup: 6,
        counterfeit: 0,
      });
      assert.deepEqual(await stable(), original);
      for (const actor of [admin, subject, stranger]) {
        const notices = await get('/v1/me/system-notices', actor);
        profileOk(notices);
        assert.deepEqual(notices.body.items, []);
        assert.equal(notices.body.unreadCount, 0);
      }
      t.diagnostic(
        `Emitted ${kind}: ${String(done['httpCalls'])} real loopback exchanges, ${String(done['receiptReads'])} same-key receipt reads, ${String(done['mediaReads'])} real Media reads, six exact independent causes/jobs/components, no notices or owner XP, Detail/Thread and anonymous/image entry, grant-revoked cold recovery, cancellation, stale CAS, session/origin/storage isolation, and zero private-identity routes.`,
      );
    },
  );
