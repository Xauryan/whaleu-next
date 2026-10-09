import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import { grantDmTemporary } from '../support/dm-owner-fixture.js';
import { dmConversationSchema } from '../../src/messaging/contracts.js';
test('PM012 three immutable identities, exact source provenance and symmetric privacy-safe blocks', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(() => f.close());
  await t.test(
    'canonical concurrent named opens collapse; modes do not silently collide',
    async () => {
      const a = await f.actor(),
        b = await f.actor();
      const entry = { kind: 'profile' as const, profileId: b.profileId };
      const [one, two] = await Promise.all([
        f.open(a, entry),
        f.open(a, entry),
      ]);
      assert.equal(one.conversationId, two.conversationId);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.participants WHERE conversation_id=$1',
            [one.conversationId],
          )
        ).rowCount,
        2,
      );
      const namedPost = await f.publish(b, 'named', true);
      const named = await f.open(
          a,
          { kind: 'post', postId: namedPost },
          'named',
        ),
        mixed = await f.open(
          a,
          { kind: 'post', postId: namedPost },
          'anonymous',
        );
      assert.notEqual(named.conversationId, mixed.conversationId);
      const view = dmConversationSchema.parse(
        (await f.get(a, `conversations/${mixed.conversationId}`)).body,
      );
      assert.equal(view.self.mode, 'anonymous');
      assert.equal(view.peer.mode, 'named');
      assert.equal(view.self.profileId, null);
      assert.equal(view.blockScope, 'named_and_conversation');
    },
  );
  await t.test(
    'unknown and false post opt-in cannot grant mixed initiation',
    async () => {
      const a = await f.actor(),
        b = await f.actor();
      for (const flag of [undefined, false]) {
        const postId = await f.publish(b, 'named', flag);
        const reply = await f.post(a, 'conversations', {
          clientRequestId: randomUUID(),
          entry: { kind: 'post', postId },
          initiationMode: 'anonymous',
        });
        assert.equal(
          reply.body.code,
          'DM_ENTRY_UNAVAILABLE',
          JSON.stringify(reply.body),
        );
      }
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.participants WHERE account_id=$1',
            [a.accountId],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'anonymous identities reuse same-post personas and ignore hidden named graph',
    async () => {
      const a = await f.actor(),
        b = await f.actor();
      const direct = await f.open(a, {
        kind: 'profile',
        profileId: b.profileId,
      });
      assert.equal(
        (
          await f.post(a, `conversations/${direct.conversationId}/block`, {
            clientRequestId: randomUUID(),
          })
        ).body.outcome,
        'applied',
      );
      const postId = await f.publish(b, 'anonymous'),
        opened = await f.open(a, { kind: 'post', postId }, 'anonymous'),
        id = opened.conversationId;
      assert.equal(
        (await f.send(a, id, 'anonymous first')).response.body.outcome,
        'applied',
      );
      const view = dmConversationSchema.parse(
        (await f.get(b, `conversations/${id}`)).body,
      );
      assert.equal(view.self.mode, 'anonymous');
      assert.equal(view.peer.mode, 'anonymous');
      assert.equal(view.peer.profileId, null);
      assert.equal(JSON.stringify(view).includes(a.accountId), false);
      assert.equal(JSON.stringify(view).includes(a.profileId), false);
      const stored = (
        await f.pool.query<{ context: Record<string, unknown> }>(
          'SELECT context FROM whaleu_messaging.conversations WHERE id=$1',
          [id],
        )
      ).rows[0]!.context;
      await f.open(a, { kind: 'post', postId }, 'anonymous');
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT context FROM whaleu_messaging.conversations WHERE id=$1',
            [id],
          )
        ).rows[0]!.context,
        stored,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=ANY($2::uuid[])',
            [postId, [a.accountId, b.accountId]],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await f.post(b, `conversations/${id}/block`, {
            clientRequestId: randomUUID(),
          })
        ).body.outcome,
        'applied',
      );
      for (const who of [a, b])
        assert.equal(
          (
            await f.post(who, `conversations/${id}/messages`, {
              clientRequestId: randomUUID(),
              text: 'stopped',
            })
          ).body.code,
          'DM_SEND_UNAVAILABLE',
        );
      await f.post(b, `conversations/${id}/hide`, {
        clientRequestId: randomUUID(),
      });
      await f.post(b, `conversations/${id}/reopen`, {
        clientRequestId: randomUUID(),
      });
      assert.equal(
        (await f.get(b, `conversations/${id}`)).body.blockedByYou,
        true,
      );
    },
  );
  await t.test(
    'both mixed block actions independently close both send directions',
    async () => {
      for (const blocker of ['named', 'anonymous']) {
        const anonymous = await f.actor(),
          named = await f.actor(),
          postId = await f.publish(named, 'named', true),
          opened = await f.open(
            anonymous,
            { kind: 'post', postId },
            'anonymous',
          ),
          id = opened.conversationId;
        const actor = blocker === 'named' ? named : anonymous;
        const block = await f.post(actor, `conversations/${id}/block`, {
          clientRequestId: randomUUID(),
        });
        assert.equal(block.body.outcome, 'applied', JSON.stringify(block.body));
        for (const who of [named, anonymous])
          assert.equal(
            (
              await f.post(who, `conversations/${id}/messages`, {
                clientRequestId: randomUUID(),
                text: 'blocked',
              })
            ).body.code,
            'DM_SEND_UNAVAILABLE',
          );
        const global = (
          await f.pool.query(
            'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2 AND active',
            [anonymous.accountId, named.accountId],
          )
        ).rowCount;
        assert.equal(global, blocker === 'anonymous' ? 1 : 0);
        const repeated = await f.post(actor, `conversations/${id}/block`, {
          clientRequestId: randomUUID(),
        });
        assert.equal(
          repeated.body.outcome,
          'noop',
          JSON.stringify(repeated.body),
        );
      }
    },
  );
  await t.test(
    'source deletion rejects new entry but retains member history and sending',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        postId = await f.publish(b, 'anonymous'),
        opened = await f.open(a, { kind: 'post', postId }, 'anonymous'),
        id = opened.conversationId;
      assert.equal(
        (await f.send(a, id, 'retained')).response.body.outcome,
        'applied',
      );
      assert.equal(
        (
          await f.auth(
            request(f.http).delete(`/v1/community/posts/${postId}`),
            b,
          )
        ).status,
        204,
      );
      const view = (await f.get(a, `conversations/${id}`)).body;
      assert.equal(view.source.available, false);
      assert.equal(
        (await f.get(b, `conversations/${id}/messages`)).body.items[0].text,
        'retained',
      );
      assert.equal(
        (await f.send(b, id, 'reply after source gone')).response.body.outcome,
        'applied',
      );
      const denied = await f.post(a, 'conversations', {
        clientRequestId: randomUUID(),
        entry: { kind: 'post', postId },
        initiationMode: 'anonymous',
      });
      assert.equal(denied.body.code, 'DM_ENTRY_UNAVAILABLE');
    },
  );
  await t.test(
    'comment/reply entries bind exact ancestry and retain each entry provenance',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        c = await f.actor(),
        postId = await f.publish(c, 'named', false),
        otherPost = await f.publish(c, 'named', false);
      const root = await f.discussion(b, postId),
        reply = await f.discussion(b, postId, root),
        nested = await f.discussion(b, postId, root, reply);
      const commentEntry = {
        kind: 'comment' as const,
        postId,
        commentId: root,
      };
      const opened = await f.open(a, commentEntry, 'anonymous');
      const replyEntry = {
        kind: 'reply' as const,
        postId,
        rootCommentId: root,
        replyId: nested,
      };
      const reopened = await f.open(a, replyEntry, 'anonymous');
      assert.equal(opened.conversationId, reopened.conversationId);
      const rows = (
        await f.pool.query<{
          provenance: { entry: unknown; targetReplyId: string | null };
        }>(
          'SELECT provenance FROM whaleu_messaging.entry_provenance WHERE conversation_id=$1 ORDER BY created_at',
          [opened.conversationId],
        )
      ).rows;
      assert.deepEqual(rows[0]!.provenance.entry, commentEntry);
      assert.deepEqual(rows[1]!.provenance.entry, replyEntry);
      assert.equal(rows[1]!.provenance.targetReplyId, reply);
      for (const entry of [
        { ...commentEntry, postId: otherPost },
        { ...replyEntry, postId: otherPost },
        { ...replyEntry, rootCommentId: randomUUID() },
      ]) {
        const denied = await f.post(a, 'conversations', {
          clientRequestId: randomUUID(),
          entry,
          initiationMode: 'anonymous',
        });
        assert.equal(
          denied.body.code,
          'DM_ENTRY_UNAVAILABLE',
          JSON.stringify(denied.body),
        );
      }
      const receipt = await f.send(a, opened.conversationId, 'exact recipient');
      assert.equal(receipt.response.body.outcome, 'applied');
      assert.equal((await f.get(b, 'unread')).body.count, 1);
      assert.equal((await f.get(c, 'unread')).body.count, 0);
    },
  );
  await t.test(
    'mixed named locator independently reauthorizes hidden, blocked and removed profile destinations',
    async () => {
      const anonymous = await f.actor(),
        named = await f.actor(),
        postId = await f.publish(named, 'named', true),
        opened = await f.open(anonymous, { kind: 'post', postId }, 'anonymous'),
        id = opened.conversationId;
      const initial = dmConversationSchema.parse(
        (await f.get(anonymous, `conversations/${id}`)).body,
      );
      const locator = initial.peer.profileId;
      assert.equal(locator, named.profileId);
      const navigate = (suffix = '') =>
        f.auth(
          request(f.http).get(`/v1/profiles/${locator}${suffix}`),
          anonymous,
        );
      await f.pool.query(
        "UPDATE whaleu_profile.profiles SET preferences=jsonb_set(preferences,'{hideProfilePosts}','true'),revision=revision+1 WHERE account_id=$1",
        [named.accountId],
      );
      const hidden = await navigate('/posts');
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
      assert.equal(hidden.body.status, 'hidden');
      assert.deepEqual(hidden.body.items, []);
      assert.equal(
        (await f.get(anonymous, `conversations/${id}`)).body.peer.profileId,
        locator,
      );
      const direct = await f.open(named, {
        kind: 'profile',
        profileId: anonymous.profileId,
      });
      assert.equal(
        (
          await f.post(named, `conversations/${direct.conversationId}/block`, {
            clientRequestId: randomUUID(),
          })
        ).body.outcome,
        'applied',
      );
      const blocked = await navigate();
      assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
      assert.deepEqual(blocked.body, {
        status: 'unavailable',
        profileId: locator,
      });
      // Explicit target denial never rewrites the mixed named locator or reveals
      // a reverse blocker flag in the anonymous conversation.
      const retained = (await f.get(anonymous, `conversations/${id}`)).body;
      assert.equal(retained.peer.profileId, locator);
      assert.equal(retained.sendAvailability, 'available');
      assert.equal('blockedByPeer' in retained, false);
      await f.pool.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [named.accountId],
      );
      assert.deepEqual((await navigate()).body, {
        status: 'unavailable',
        profileId: locator,
      });
      await f.pool.query(
        "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
        [named.accountId],
      );
      await f.pool.query(
        'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
        [named.accountId],
      );
      assert.deepEqual((await navigate()).body, {
        status: 'unavailable',
        profileId: locator,
      });
    },
  );
  await t.test(
    'DM temporary authority is independent, phone exception only unread, coverage unknown not zero',
    async () => {
      const b = await f.actor(),
        a = await f.actor({ affiliation: 'unverified', identity: false });
      const missing = await f.post(a, 'conversations', {
        clientRequestId: randomUUID(),
        entry: { kind: 'profile', profileId: b.profileId },
        initiationMode: 'named',
      });
      assert.equal(missing.status, 503, JSON.stringify(missing.body));
      await grantDmTemporary(f.pool, a.accountId);
      assert.ok(
        (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
      );
      const noPhone = await f.actor({ phone: 'unverified' });
      assert.equal((await f.get(noPhone, 'unread')).status, 200);
      assert.equal((await f.get(noPhone, 'conversations')).status, 403);
      await f.pool.query(
        "UPDATE whaleu_messaging.coverage_heads SET coverage='missing' WHERE account_id=$1",
        [a.accountId],
      );
      const unknown = await f.get(a, 'unread');
      assert.equal(unknown.status, 503);
      assert.equal(unknown.body.count, undefined);
    },
  );
});
