/** Real HTTP, real Review, ordinary AppModule and disposable synthetic owner facts.
 * This proves the narrow Next slice, not production/source/provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import {
  moderationCommandSchema,
  moderationManagementSchema,
  moderationReceiptSchema,
} from '../../src/profile/moderation/contracts.js';
import { profileModerationFixture } from '../support/profile-moderation-fixture.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

type Command = ReturnType<typeof moderationCommandSchema.parse>;
type Target = Command['target'];
const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));

test(
  'content-bound nickname moderation preserves publication and anonymity, exact authority, shared CAS and actor-owned recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await profileModerationFixture();
    t.after(() => f.close());
    const http = f.app.getHttpServer();
    const admin = await f.actor();
    await f.grant(admin.accountId, 'school_admin', f.scope.home.regionId);
    type Actor = typeof admin;
    const get = (path: string, actor = admin) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const management = (target: Target, actor = admin) =>
      get('/v1/community/profile-moderation/management', actor).query(target);
    const send = (body: Command, actor = admin, cancel = false) =>
      request(http)
        .post(
          `/v1/community/profile-moderation/commands${cancel ? '/cancel' : ''}`,
        )
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const recovery = (id: string, actor = admin) =>
      get(`/v1/community/profile-moderation/requests/${id}`, actor);
    const command = (
      target: Target,
      expectedProfileRevision: number,
    ): Command => ({
      clientRequestId: randomUUID(),
      target,
      expectedProfileRevision,
      action: 'reset_nickname',
    });
    const profile = async (actor: Actor) => {
      const response = await get('/v1/me/profile', actor);
      ok(response);
      return response.body as {
        nickname: string | null;
        revision: number;
        bio: string;
        preferences: Record<string, boolean>;
      };
    };
    const state = async (target: Target, actor = admin) => {
      const response = await management(target, actor);
      ok(response);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(String(response.headers['vary']), /Authorization/i);
      const result = moderationManagementSchema.parse(response.body);
      assert.deepEqual(Object.keys(result).sort(), [
        'canReset',
        'displayName',
        'revision',
        'target',
      ]);
      assert.deepEqual(result.target, target);
      return result;
    };
    const apply = async (target: Target, actor = admin) => {
      const selected = await state(target, actor);
      const body = command(target, selected.revision);
      const response = await send(body, actor);
      ok(response);
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
      const receipt = moderationReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, 'applied');
      assert.deepEqual(Object.keys(receipt).sort(), [
        'action',
        'eventId',
        'expectedProfileRevision',
        'outcome',
        'recordedAt',
        'requestId',
        'revision',
        'target',
      ]);
      return { body, receipt };
    };
    const emptyCommand = async (body: Command, actor = admin) => {
      const response = await recovery(body.clientRequestId, actor);
      ok(response);
      assert.deepEqual(response.body, { state: 'not_recorded' });
    };
    const rejectedTarget = async (target: Target, actor = admin) => {
      const before = await counts();
      const result = await management(target, actor);
      assert.ok(result.status >= 400, JSON.stringify(result.body));
      const body = command(target, 0);
      const attempted = await send(body, actor);
      assert.ok(attempted.status >= 400, JSON.stringify(attempted.body));
      await emptyCommand(body, actor);
      assert.deepEqual(
        await counts(),
        before,
        'Denied reads/writes have no moderation side effects',
      );
    };
    const counts = async () =>
      (
        await f.pool.query(`SELECT
        (SELECT count(*)::integer FROM whaleu_profile.moderation_commands) commands,
        (SELECT count(*)::integer FROM whaleu_profile.moderation_events) events,
        (SELECT count(*)::integer FROM whaleu_profile.moderation_transitions) transitions,
        (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) notices`)
      ).rows[0];
    const retainedBytes = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
        'posts',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM whaleu_community.posts p),
        'comments',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM whaleu_community.root_comments c),
        'replies',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM whaleu_community.replies r),
        'personas',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM whaleu_community.thread_personas p),
        'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.content_kind,b.content_id),'[]') FROM whaleu_community.content_approval_bindings b)
      ) bytes`)
      ).rows[0]!.bytes;
    const profileBytes = async (actor: Actor) =>
      (
        await f.pool.query(
          "SELECT to_jsonb(p)-'nickname'-'revision'-'updated_at' bytes FROM whaleu_profile.profiles p WHERE account_id=$1",
          [actor.accountId],
        )
      ).rows[0]!.bytes;
    const detail = async (target: Target, actor = admin) => {
      const segment =
        target.kind === 'post'
          ? 'posts'
          : target.kind === 'comment'
            ? 'comments'
            : 'replies';
      const response = await get(
        `/v1/community/${segment}/${target.id}`,
        actor,
      );
      ok(response);
      return response.body;
    };

    await t.test(
      'all three named target kinds reset one Profile, retain original bytes and update cross-region public displays',
      async () => {
        const subject = await f.actor(),
          peer = await f.actor();
        const own = await profile(subject);
        ok(
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', `Bearer ${subject.accessToken}`)
            .send({
              expectedRevision: own.revision,
              nickname: 'OriginalNickname',
              bio: 'Keep this biography',
            }),
        );
        const post = await f.publish(subject);
        const elsewhere = await f.publish(subject, {
          spaceId: f.scope.foreign.spaceId,
        });
        const anonymous = await f.publish(subject, { authorMode: 'anonymous' });
        const parent = await f.publish(peer);
        const comment = await f.child(subject, parent.id);
        const reply = await f.child(subject, parent.id, comment.id);
        const anonymousComment = await f.child(
          subject,
          parent.id,
          null,
          'anonymous',
        );
        const anonymousReply = await f.child(
          subject,
          parent.id,
          comment.id,
          'anonymous',
        );
        const original = await retainedBytes(),
          stableProfile = await profileBytes(subject);
        const privateProfile = (await detail({ kind: 'post', id: post.id }))
          .author.profileId as string;
        const anonymousBefore = await Promise.all(
          [
            { kind: 'post' as const, id: anonymous.id },
            { kind: 'comment' as const, id: anonymousComment.id },
            { kind: 'reply' as const, id: anonymousReply.id },
          ].map(async (target) => (await detail(target)).author),
        );
        let prior = 'OriginalNickname',
          resetCount = 0;
        for (const target of [
          { kind: 'post' as const, id: post.id },
          { kind: 'comment' as const, id: comment.id },
          { kind: 'reply' as const, id: reply.id },
        ]) {
          const before = await profile(subject),
            total = await counts();
          const { body, receipt } = await apply(target);
          resetCount += 1;
          const next = await profile(subject);
          assert.match(next.nickname!, /^违规昵称[A-Za-z0-9]{6}$/);
          assert.notEqual(next.nickname, prior);
          prior = next.nickname!;
          assert.equal(next.revision, before.revision + 1);
          assert.deepEqual(await profileBytes(subject), stableProfile);
          assert.deepEqual(await retainedBytes(), original);
          assert.deepEqual(await counts(), {
            commands: total.commands + 1,
            events: total.events + 1,
            transitions: total.transitions + 1,
            notices: total.notices + 1,
          });
          for (const named of [
            target,
            { kind: 'post' as const, id: elsewhere.id },
          ]) {
            const view = await detail(named);
            assert.equal(view.author.displayName, next.nickname);
            assert.equal(view.author.profileId, privateProfile);
          }
          const replay = await send(body);
          ok(replay);
          assert.deepEqual(replay.body, receipt);
          const recovered = await recovery(body.clientRequestId);
          ok(recovered);
          assert.deepEqual(recovered.body, { state: 'recorded', receipt });
          const ownNotice = await get('/v1/me/system-notices', subject);
          ok(ownNotice);
          assert.equal(ownNotice.body.unreadCount, resetCount);
          const notice = ownNotice.body.items[0];
          assert.equal(notice.kind, 'profile_nickname_reset');
          assert.equal(notice.nickname, next.nickname);
          assert.deepEqual(Object.keys(notice).sort(), [
            'createdAt',
            'kind',
            'nickname',
            'noticeId',
            'readAt',
          ]);
          for (const privateValue of [
            subject.accountId,
            admin.accountId,
            privateProfile,
            post.approval.decisionId,
          ])
            assert.ok(
              !JSON.stringify({ receipt, notice }).includes(privateValue),
            );
        }
        const anonymousAfter = await Promise.all(
          [
            { kind: 'post' as const, id: anonymous.id },
            { kind: 'comment' as const, id: anonymousComment.id },
            { kind: 'reply' as const, id: anonymousReply.id },
          ].map(async (target) => (await detail(target)).author),
        );
        assert.deepEqual(anonymousAfter, anonymousBefore);
        for (const author of anonymousAfter)
          assert.equal(author.profileId, undefined);
        await rejectedTarget({ kind: 'post', id: elsewhere.id });
      },
    );

    await t.test(
      'target must be named, but its anonymous post and root ancestors are allowed',
      async () => {
        const ancestor = await f.actor(),
          subject = await f.actor();
        const post = await f.publish(ancestor, { authorMode: 'anonymous' });
        const root = await f.child(ancestor, post.id, null, 'anonymous');
        const comment = await f.child(subject, post.id);
        const reply = await f.child(subject, post.id, root.id);
        const anonymousReply = await f.child(
          subject,
          post.id,
          root.id,
          'anonymous',
        );
        const original = await retainedBytes();
        await apply({ kind: 'comment', id: comment.id });
        await apply({ kind: 'reply', id: reply.id });
        assert.deepEqual(await retainedBytes(), original);
        for (const target of [
          { kind: 'post' as const, id: post.id },
          { kind: 'comment' as const, id: root.id },
          { kind: 'reply' as const, id: anonymousReply.id },
        ])
          await rejectedTarget(target);
      },
    );

    await t.test(
      'self and administrator subjects are allowed; developer-only and browse-region authority are not',
      async () => {
        const developer = await f.actor(),
          otherAdmin = await f.actor(),
          superAdmin = await f.actor();
        await f.grant(developer.accountId, 'developer');
        await f.grant(
          otherAdmin.accountId,
          'school_admin',
          f.scope.foreign.regionId,
        );
        await f.grant(superAdmin.accountId, 'super_admin');
        const self = await f.publish(admin),
          protectedSubject = await f.publish(otherAdmin);
        await apply({ kind: 'post', id: self.id }, admin);
        await apply({ kind: 'post', id: protectedSubject.id }, admin);
        await rejectedTarget(
          { kind: 'post', id: protectedSubject.id },
          developer,
        );
        await rejectedTarget({ kind: 'post', id: self.id }, otherAdmin);
        const foreign = await f.publish(otherAdmin, {
          spaceId: f.scope.foreign.spaceId,
        });
        await apply({ kind: 'post', id: foreign.id }, superAdmin);
        const global = await f.publish(otherAdmin, {
          spaceId: f.scope.global.spaceId,
        });
        await rejectedTarget({ kind: 'post', id: global.id }, superAdmin);
      },
    );

    await t.test(
      'trading, poll and formation posts do not inherit category-reclassification exclusions',
      async () => {
        const subject = await f.actor();
        const trading = await f.publish(subject, {
          category: 'trading',
          trading: {
            subtype: 'shuma',
            price: '12.50',
            urgency: 'urgent',
            location: 'Synthetic pickup',
            contacts: { wechat: 'synthetic', qq: '', phone: '' },
          },
        });
        const poll = await f.publish(subject, {
          component: {
            kind: 'poll',
            question: 'Synthetic question',
            selectionMode: 'single',
            options: ['First', 'Second'],
          },
        });
        const formation = await f.publish(subject, {
          component: {
            kind: 'formation',
            capacity: 3,
            theme: 'Synthetic',
            contacts: { wechat: 'synthetic', qq: '', phone: '' },
            contactSharing: 'members_v1',
          },
        });
        const original = await retainedBytes();
        for (const post of [trading, poll, formation])
          await apply({ kind: 'post', id: post.id });
        assert.deepEqual(await retainedBytes(), original);
        const current = await profile(subject);
        const view = await detail({ kind: 'post', id: formation.id });
        assert.equal(
          view.component.formation.members[0].author.displayName,
          current.nickname,
        );
      },
    );

    await t.test(
      'shared Profile CAS rejects old management after owner biography or preference edits',
      async () => {
        const subject = await f.actor(),
          post = await f.publish(subject);
        const target = { kind: 'post' as const, id: post.id };
        for (const field of ['bio', 'preferences'] as const) {
          const selected = await state(target),
            body = command(target, selected.revision);
          const response = await request(http)
            .patch(field === 'bio' ? '/v1/me/profile' : '/v1/me/preferences')
            .set('Authorization', `Bearer ${subject.accessToken}`)
            .send(
              field === 'bio'
                ? {
                    expectedRevision: selected.revision,
                    bio: 'Concurrent owner edit',
                  }
                : {
                    expectedRevision: selected.revision,
                    preferences: { showHotTopic: false },
                  },
            );
          ok(response);
          const current = await profile(subject),
            total = await counts();
          const stale = await send(body);
          ok(stale);
          assert.deepEqual(stale.body, {
            requestId: body.clientRequestId,
            target,
            expectedProfileRevision: selected.revision,
            action: 'reset_nickname',
            outcome: 'rejected',
            code: 'PROFILE_MODERATION_STALE',
          });
          assert.deepEqual(await profile(subject), current);
          assert.deepEqual(await counts(), {
            ...total,
            commands: total.commands + 1,
          });
          const replay = await send(body);
          ok(replay);
          assert.deepEqual(replay.body, stale.body);
        }
      },
    );

    await t.test(
      'concurrent distinct keys share one CAS and repeated original key has one atomic result',
      async () => {
        const subject = await f.actor(),
          post = await f.publish(subject);
        const target = { kind: 'post' as const, id: post.id },
          selected = await state(target);
        const before = await counts();
        const results = await Promise.all([
          send(command(target, selected.revision)),
          send(command(target, selected.revision)),
        ]);
        results.forEach((result) => ok(result));
        assert.deepEqual(results.map((result) => result.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          results.find((result) => result.body.outcome === 'rejected')!.body
            .code,
          'PROFILE_MODERATION_STALE',
        );
        assert.deepEqual(await counts(), {
          commands: before.commands + 2,
          events: before.events + 1,
          transitions: before.transitions + 1,
          notices: before.notices + 1,
        });
        const next = await state(target),
          body = command(target, next.revision),
          total = await counts();
        const repeated = await Promise.all([send(body), send(body)]);
        repeated.forEach((result) => ok(result));
        assert.deepEqual(repeated[0]!.body, repeated[1]!.body);
        assert.equal(repeated[0]!.body.outcome, 'applied');
        assert.deepEqual(await counts(), {
          commands: total.commands + 1,
          events: total.events + 1,
          transitions: total.transitions + 1,
          notices: total.notices + 1,
        });
      },
    );

    await t.test(
      'private notice ownership, stable read retries and one notice per reset',
      async () => {
        const subject = await f.actor(),
          stranger = await f.actor(),
          post = await f.publish(subject);
        const { body } = await apply({ kind: 'post', id: post.id });
        await send(body);
        const page = await get('/v1/me/system-notices', subject);
        ok(page);
        assert.equal(page.body.items.length, 1);
        assert.equal(page.body.unreadCount, 1);
        const noticeId = page.body.items[0].noticeId as string;
        const read = (actor: Actor) =>
          request(http)
            .put(`/v1/me/system-notices/${noticeId}/read`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send({});
        const strangerPage = await get('/v1/me/system-notices', stranger);
        ok(strangerPage);
        assert.deepEqual(strangerPage.body.items, []);
        ok(await read(stranger), 404);
        const first = await read(subject),
          again = await read(subject);
        ok(first);
        ok(again);
        assert.deepEqual(first.body, again.body);
        assert.equal(first.body.unreadCount, 0);
        assert.equal(
          (await get('/v1/me/system-notices', subject)).body.items[0].readAt,
          first.body.readAt,
        );
      },
    );

    await t.test(
      'replay and recovery survive current grant/content loss, while fresh stale intent still requires authority',
      async () => {
        const localAdmin = await f.actor(),
          subject = await f.actor(),
          stranger = await f.actor();
        const grant = await f.grant(
          localAdmin.accountId,
          'school_admin',
          f.scope.home.regionId,
        );
        const post = await f.publish(subject),
          target = { kind: 'post' as const, id: post.id };
        const applied = await apply(target, localAdmin);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [grant, localAdmin.accountId],
          ),
        );
        await setReviewState(f.pool, post.approval.decisionId, 'revoked');
        const replay = await send(applied.body, localAdmin),
          recovered = await recovery(applied.body.clientRequestId, localAdmin);
        ok(replay);
        ok(recovered);
        assert.deepEqual(replay.body, applied.receipt);
        assert.deepEqual(recovered.body, {
          state: 'recorded',
          receipt: applied.receipt,
        });
        const other = await recovery(applied.body.clientRequestId, stranger);
        ok(other);
        assert.deepEqual(other.body, { state: 'not_recorded' });
        const fresh = command(target, applied.body.expectedProfileRevision);
        assert.ok((await send(fresh, localAdmin)).status >= 400);
        await emptyCommand(fresh, localAdmin);
        const mismatch = await send(
          {
            ...applied.body,
            expectedProfileRevision: applied.body.expectedProfileRevision + 1,
          },
          localAdmin,
        );
        ok(mismatch, 409);
        assert.equal(mismatch.body.error.code, 'REQUEST_CONFLICT');
        await f.pool.query(
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
          [localAdmin.sessionId],
        );
        assert.ok(
          (await recovery(applied.body.clientRequestId, localAdmin)).status >=
            400,
        );
      },
    );

    await t.test(
      'durable cancellation accepts nonexistent targets without target reads and wins one exact original-key race',
      async () => {
        const unprivileged = await f.actor();
        const missing = command({ kind: 'reply', id: randomUUID() }, 12),
          total = await counts();
        const cancelled = await send(missing, unprivileged, true);
        ok(cancelled);
        assert.deepEqual(cancelled.body, {
          requestId: missing.clientRequestId,
          target: missing.target,
          expectedProfileRevision: 12,
          action: 'reset_nickname',
          outcome: 'rejected',
          code: 'PROFILE_MODERATION_CANCELLED',
        });
        assert.deepEqual(await counts(), {
          ...total,
          commands: total.commands + 1,
        });
        const retry = await send(missing, unprivileged);
        ok(retry);
        assert.deepEqual(retry.body, cancelled.body);
        const subject = await f.actor(),
          post = await f.publish(subject),
          target = { kind: 'post' as const, id: post.id };
        const selected = await state(target),
          body = command(target, selected.revision),
          before = await counts();
        const [applied, cancel] = await Promise.all([
          send(body),
          send(body, admin, true),
        ]);
        ok(applied);
        ok(cancel);
        assert.deepEqual(applied.body, cancel.body);
        const delta = applied.body.outcome === 'applied' ? 1 : 0;
        assert.deepEqual(await counts(), {
          commands: before.commands + 1,
          events: before.events + delta,
          transitions: before.transitions + delta,
          notices: before.notices + delta,
        });
        assert.equal(
          (await profile(subject)).revision,
          selected.revision + delta,
        );
      },
    );

    await t.test(
      'target Review, full live ancestor chain and owner-hidden gates remain independent',
      async () => {
        const subject = await f.actor(),
          ancestor = await f.actor();
        const hidden = await f.publish(subject);
        const visible = await get(
          `/v1/me/community/posts/${hidden.id}/owner-visibility`,
          subject,
        );
        ok(visible);
        const conceal = await request(http)
          .post('/v1/me/community/owner-visibility-commands')
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send({
            clientRequestId: randomUUID(),
            postId: hidden.id,
            ownerHidden: true,
            expectedVersion: visible.body.version,
          });
        ok(conceal);
        assert.equal(conceal.body.outcome, 'applied');
        await rejectedTarget({ kind: 'post', id: hidden.id });
        const post = await f.publish(ancestor),
          root = await f.child(subject, post.id),
          reply = await f.child(subject, post.id, root.id);
        await setReviewState(f.pool, reply.approval.decisionId, 'revoked');
        await rejectedTarget({ kind: 'reply', id: reply.id });
        const liveReply = await f.child(subject, post.id, root.id);
        ok(
          await request(http)
            .delete(`/v1/community/comments/${root.id}`)
            .set('Authorization', `Bearer ${subject.accessToken}`),
          204,
        );
        await rejectedTarget({ kind: 'reply', id: liveReply.id });
        const parent = await f.publish(ancestor),
          child = await f.child(subject, parent.id);
        await setReviewState(f.pool, parent.approval.decisionId, 'revoked');
        await rejectedTarget({ kind: 'comment', id: child.id });
      },
    );

    await t.test(
      'late raw Profile changes or missing notice abort the entire event/receipt/transition closure',
      async () => {
        const subject = await f.actor(),
          post = await f.publish(subject),
          target = { kind: 'post' as const, id: post.id };
        const database = f.app.get(DatabaseService),
          original = database.transaction.bind(database);
        const corruptions: Array<(tx: PoolClient) => Promise<unknown>> = [
          (tx) =>
            tx.query(
              "UPDATE whaleu_profile.profiles SET nickname='LateRawWriter' WHERE account_id=$1",
              [subject.accountId],
            ),
          (tx) =>
            tx.query(
              'DELETE FROM whaleu_notifications.profile_moderation_notices WHERE recipient_account_id=$1',
              [subject.accountId],
            ),
        ];
        for (const corrupt of corruptions) {
          const selected = await state(target),
            body = command(target, selected.revision),
            before = await counts(),
            beforeProfile = await profile(subject);
          let injected = false;
          database.transaction = (work, options) =>
            original(async (tx) => {
              const result = await work(tx);
              if (
                result &&
                typeof result === 'object' &&
                'outcome' in result &&
                result.outcome === 'applied'
              ) {
                injected = true;
                await corrupt(tx);
              }
              return result;
            }, options);
          let response;
          try {
            response = await send(body);
          } finally {
            database.transaction = original;
          }
          assert.equal(
            injected,
            true,
            'The normal owner reached its complete apparent result before the raw late write',
          );
          assert.ok(response.status >= 400, JSON.stringify(response.body));
          assert.deepEqual(await profile(subject), beforeProfile);
          assert.deepEqual(await counts(), before);
          await emptyCommand(body);
        }
      },
    );
  },
);
