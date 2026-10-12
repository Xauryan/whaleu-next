import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import {
  profileOk,
  setProfileAvatarReview,
} from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

/** The first design gate exercises the actual new SQL branch, HTTP owner and
 * exact old Media retirement. It is synthetic, never production acceptance. */
test(
  'scoped custom avatar clear uses real transitions, one shared revision and no synthetic self Review',
  { timeout: 180000 },
  async (t) => {
    const f = await profileAvatarModerationFixture();
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor(),
      other = await f.actor();
    const grant = await f.grant(admin);
    const chosen = await f.custom(subject),
      target = await f.publish(subject);
    await setProfileAvatarReview(f.pool, chosen.approved.decisionId, 'held');
    const before = (
      await f.pool.query(
        'SELECT to_jsonb(p) value FROM whaleu_profile.profiles p WHERE account_id=$1',
        [subject.accountId],
      )
    ).rows[0]!.value;
    const counters = async () =>
      (
        await f.pool.query(
          `SELECT (SELECT count(*)::int FROM whaleu_profile.avatar_command_receipts) self_receipts,(SELECT count(*)::int FROM whaleu_community.profile_avatar_approval_bindings) self_reviews,(SELECT count(*)::int FROM whaleu_profile.avatar_moderation_commands) commands,(SELECT count(*)::int FROM whaleu_profile.avatar_moderation_events) events,(SELECT count(*)::int FROM whaleu_profile.avatar_moderation_transitions) profiles,(SELECT count(*)::int FROM whaleu_profile.avatar_moderation_pointer_transitions) pointers,(SELECT count(*)::int FROM whaleu_notifications.profile_avatar_moderation_notices) notices`,
        )
      ).rows[0]!;
    const initial = await counters();
    const management = await f.management(
      { kind: target.kind, id: target.id },
      admin,
    );
    assert.deepEqual(Object.keys(management).sort(), [
      'canClearCustomAvatar',
      'displayName',
      'expectedAppearanceId',
      'revision',
      'target',
    ]);
    assert.equal(management.canClearCustomAvatar, true);
    assert.equal(management.expectedAppearanceId, chosen.appearanceId);
    const body = f.command(target, management.revision, chosen.appearanceId),
      applied = await f.send(admin, body);
    profileOk(applied);
    assert.equal(applied.body.outcome, 'applied');
    assert.equal(applied.body.revision, management.revision + 1);
    const after = (
      await f.pool.query(
        'SELECT to_jsonb(p) value FROM whaleu_profile.profiles p WHERE account_id=$1',
        [subject.accountId],
      )
    ).rows[0]!.value;
    assert.deepEqual(
      { ...after, revision: before.revision, updated_at: before.updated_at },
      before,
    );
    assert.deepEqual(await counters(), {
      self_receipts: initial.self_receipts,
      self_reviews: initial.self_reviews,
      commands: 1,
      events: 1,
      profiles: 1,
      pointers: 1,
      notices: 1,
    });
    const definition = (
      await f.pool.query(
        `SELECT d.*,whaleu_profile.avatar_moderation_definition_authorized(d.id) authorized FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id WHERE c.actor_id=$1`,
        [subject.accountId],
      )
    ).rows[0]!;
    assert.equal(definition.authority, 'scoped_moderation_clear');
    assert.deepEqual(definition.source, { kind: 'clear' });
    assert.equal(definition.binding_id, null);
    assert.equal(definition.authorized, true);
    const state = (
      await f.pool.query(
        `SELECT i.state,b.detached_at,b.detach_reason FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE a.id=$1`,
        [chosen.ready.status.assetId],
      )
    ).rows[0]!;
    assert.equal(state.state, 'cleanup_pending');
    assert.ok(state.detached_at);
    assert.equal(state.detach_reason, 'profile-avatar-replaced');
    const own = await request(f.http)
      .get('/v1/me/profile/avatar')
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(own);
    assert.equal(own.body.avatar.state, 'none');
    const pub = await request(f.http).get(
      `/v1/profiles/${chosen.current.profileId}/avatar`,
    );
    profileOk(pub);
    assert.equal(pub.body.avatar.state, 'none');
    const replay = await f.send(admin, body);
    profileOk(replay);
    assert.deepEqual(replay.body, applied.body);
    assert.equal((await counters()).notices, 1);
    const mismatch = await f.send(admin, {
      ...body,
      expectedAppearanceId: randomUUID(),
    });
    assert.equal(mismatch.status, 409);
    const stale = await f.send(admin, {
      ...body,
      clientRequestId: randomUUID(),
    });
    profileOk(stale);
    assert.equal(stale.body.code, 'PROFILE_AVATAR_MODERATION_STALE');
    const na = await f.send(
      admin,
      f.command(target, applied.body.revision, definition.id),
    );
    profileOk(na);
    assert.equal(na.body.code, 'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE');
    assert.equal((await counters()).events, 1);
    const view = await f.management(
      { kind: target.kind, id: target.id },
      admin,
    );
    assert.equal(view.canClearCustomAvatar, false);
    assert.equal(view.expectedAppearanceId, null);
    const notice = await request(f.http)
      .get('/v1/me/system-notices')
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(notice);
    assert.equal(notice.body.unreadCount, 1);
    assert.equal(notice.body.items[0].kind, 'profile_custom_avatar_cleared');
    assert.deepEqual(Object.keys(notice.body.items[0]).sort(), [
      'createdAt',
      'kind',
      'noticeId',
      'readAt',
    ]);
    const outsider = await request(f.http)
      .get('/v1/me/system-notices')
      .set('Authorization', `Bearer ${other.accessToken}`);
    profileOk(outsider);
    assert.equal(outsider.body.unreadCount, 0);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      ),
    );
    const history = await f.send(admin, body);
    profileOk(history);
    assert.deepEqual(history.body, applied.body);
    const persisted = await request(f.http)
      .get('/v1/me/profile/avatar')
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(persisted);
    assert.equal(persisted.body.avatar.state, 'none');
    const cancel = f.command(
      { kind: 'post', id: randomUUID() },
      0,
      randomUUID(),
    );
    const cancelled = await f.send(admin, cancel, true);
    profileOk(cancelled);
    assert.equal(cancelled.body.code, 'PROFILE_AVATAR_MODERATION_CANCELLED');
  },
);

test(
  'avatar retirement composes with exact same-owner target and every ancestor image',
  { timeout: 240000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    const post = await f.publish(subject, {}, true);
    const root = await f.child(subject, post.id, null, true);
    const reply = await f.child(subject, post.id, root.id, true);
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT whaleu_profile.avatar_moderation_media_facts('reply',$1) value`,
          [reply.id],
        )
      ).rows[0]!.value;
    const before = await snapshot();
    for (const target of [
      { kind: 'post' as const, id: post.id },
      root,
      reply,
    ]) {
      const avatar = await f.custom(subject);
      const result = await f.apply(target, admin);
      assert.equal(result.receipt.revision, avatar.current.revision + 1);
      assert.deepEqual(
        await snapshot(),
        before,
        'Target+ancestor Media facts retain exact tuple identities through avatar detach',
      );
      const live = (
        await f.pool.query(
          `SELECT count(*)::int count FROM whaleu_media.bindings WHERE owner_kind='community' AND detached_at IS NULL`,
        )
      ).rows[0]!.count;
      assert.equal(live, 3);
    }
  },
);

test(
  'avatar clear preserves content-bound non-anonymous scope, special content kinds and current grant on new rejections',
  { timeout: 240000 },
  async (t) => {
    const f = await profileAvatarModerationFixture();
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor(),
      developer = await f.actor(),
      wrong = await f.actor(),
      unverified = await f.actor({ phone: 'unverified' });
    await f.grant(admin);
    await f.grant(developer, 'developer', null);
    await f.grant(wrong, 'school_admin', f.scope.foreign.regionId);
    await f.grant(unverified);
    const chosen = await f.custom(subject),
      post = await f.publish(subject),
      target = { kind: 'post' as const, id: post.id };
    const totals = async () =>
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_profile.avatar_moderation_commands',
        )
      ).rows[0]!.n;
    for (const actor of [developer, wrong, unverified]) {
      const before = await totals(),
        command = f.command(target, 0, chosen.appearanceId);
      const management = await request(f.http)
        .get('/v1/community/profile-avatar-moderation/management')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .query(target);
      assert.notEqual(management.status, 200);
      const denied = await f.send(actor, command);
      assert.notEqual(denied.status, 200);
      assert.equal(await totals(), before);
    }
    const forbidden = await request(f.http)
      .post('/v1/community/profile-avatar-moderation/commands')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        ...f.command(target, chosen.current.revision, chosen.appearanceId),
        subjectAccountId: subject.accountId,
      });
    assert.equal(forbidden.status, 400);
    const anonPost = await f.publish(subject, { authorMode: 'anonymous' }),
      anonRoot = await f.child(subject, post.id, null, false, 'anonymous'),
      anonReply = await f.child(
        subject,
        post.id,
        anonRoot.id,
        false,
        'anonymous',
      );
    for (const target of [
      { kind: 'post' as const, id: anonPost.id },
      anonRoot,
      anonReply,
    ]) {
      const before = await totals();
      const denied = await f.send(
        admin,
        f.command(target, chosen.current.revision, chosen.appearanceId),
      );
      assert.notEqual(denied.status, 200);
      assert.equal(await totals(), before);
      assert.ok(!JSON.stringify(denied.body).includes(subject.accountId));
    }
    // Existing publication correctly keeps an author's own anonymous thread
    // anonymous. Use a distinct ancestor to prove genuinely named child targets.
    const ancestor = await f.actor(),
      anonymousParent = await f.publish(ancestor, { authorMode: 'anonymous' }),
      anonymousAncestor = await f.child(
        ancestor,
        anonymousParent.id,
        null,
        false,
        'anonymous',
      ),
      namedUnderAnonymous = await f.child(subject, anonymousParent.id),
      namedReplyUnderAnonymous = await f.child(
        subject,
        anonymousParent.id,
        anonymousAncestor.id,
      );
    const anonymousBefore = (
      await f.pool.query(
        'SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM whaleu_community.thread_personas p',
      )
    ).rows[0]!.value;
    await f.apply(namedUnderAnonymous, admin);
    await f.custom(subject);
    await f.apply(namedReplyUnderAnonymous, admin);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM whaleu_community.thread_personas p',
        )
      ).rows[0]!.value,
      anonymousBefore,
    );
    const patches = [
      {
        category: 'trading' as const,
        trading: {
          subtype: 'shuma' as const,
          price: '12.50',
          urgency: 'urgent' as const,
          location: 'Synthetic pickup',
          contacts: { wechat: 'synthetic', qq: '', phone: '' },
        },
      },
      {
        component: {
          kind: 'poll' as const,
          question: 'Synthetic avatar question',
          selectionMode: 'single' as const,
          options: ['First', 'Second'],
        },
      },
      {
        component: {
          kind: 'formation' as const,
          capacity: 3,
          theme: 'Synthetic',
          contacts: { wechat: 'synthetic', qq: '', phone: '' },
          contactSharing: 'members_v1' as const,
        },
      },
    ];
    for (const patch of patches) {
      await f.custom(subject);
      const source = await f.publish(subject, patch);
      await f.apply(source, admin);
    }
    const count = (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_profile.avatar_moderation_events',
      )
    ).rows[0]!.n;
    assert.equal(count, 5);
    const { seedSyntheticAvatarCatalog, selectProfileAvatar } =
      await import('../support/media/profile-runtime-fixture.js');
    const catalog = await seedSyntheticAvatarCatalog(
      f,
      f.bytes,
      'image/png',
      24,
      18,
    );
    const own = (
      await f.pool.query<{ revision: number }>(
        'SELECT revision FROM whaleu_profile.profiles WHERE account_id=$1',
        [subject.accountId],
      )
    ).rows[0]!;
    const selected = await selectProfileAvatar(f, subject, {
      protocol: 'profile-media-v1',
      clientRequestId: randomUUID(),
      expectedRevision: own.revision,
      source: {
        kind: 'catalog',
        catalogVersion: catalog.catalogVersion,
        itemId: catalog.itemId,
      },
    });
    assert.ok(selected.current.avatar.appearanceId);
    const management = await f.management(target, admin);
    assert.equal(management.canClearCustomAvatar, false);
    assert.equal(management.expectedAppearanceId, null);
    const noEffect = await f.send(
      admin,
      f.command(
        target,
        selected.current.revision,
        selected.current.avatar.appearanceId,
      ),
    );
    profileOk(noEffect);
    assert.equal(
      noEffect.body.code,
      'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_profile.avatar_moderation_events',
        )
      ).rows[0]!.n,
      count,
    );
    const superAdmin = await f.actor();
    await f.grant(superAdmin, 'super_admin', null);
    await f.custom(subject);
    const foreignTarget = await f.publish(subject, {
      spaceId: f.scope.foreign.spaceId,
    });
    const foreignClear = await f.apply(foreignTarget, superAdmin);
    assert.equal(foreignClear.receipt.outcome, 'applied');
  },
);
