/** Newly issued school grants flow through the genuine historical mutation
 * owners. Only the independent super is seeded; no school grant, target content,
 * moderation receipt, pin or avatar transition is fabricated by this suite. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import request from 'supertest';
import {
  schoolAdminManagementSchema,
  schoolAdminManagementReceiptSchema,
} from '../../src/authorization/school-admin-management/contracts.js';
import {
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalReceiptSchema,
} from '../../src/community/admin-discussion-removal/contracts.js';
import {
  adminPostRemovalManagementSchema,
  adminPostRemovalReceiptSchema,
} from '../../src/community/admin-removal/contracts.js';
import {
  avatarModerationManagementSchema,
  avatarModerationReceiptSchema,
} from '../../src/profile/avatar-moderation/contracts.js';
import {
  moderationManagementSchema,
  moderationReceiptSchema,
} from '../../src/profile/moderation/contracts.js';
import { avatarCurrentSchema } from '../../src/profile/avatar/selection-contract.js';
import {
  pinDetailSchema,
  pinReceiptSchema,
} from '../../src/community/post-pins/contracts.js';
import type { PinCommand } from '../../src/community/post-pins/contracts.js';
import { safeErrorResponseSchema } from '../../src/http/error-contracts.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import type { AdminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

type Actor = { accountId: string; accessToken: string };
type Http = Parameters<typeof request>[0];
const schoolPath = '/v1/admin/school-administrators';

/** The target creates its own profile through the Profile owner. The public
 * reference is then read from its ordinary avatar endpoint, never invented. */
async function managementJourney(
  http: Http,
  pool: Pool,
  superAdmin: Actor,
  manager: Actor,
) {
  const own = await request(http)
    .get('/v1/me/profile')
    .set('Authorization', `Bearer ${manager.accessToken}`);
  profileOk(own);
  profileOk(
    await request(http)
      .patch('/v1/me/profile')
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ expectedRevision: own.body.revision, nickname: 'SchoolManager' }),
  );
  const reference = await request(http)
    .get('/v1/me/profile/avatar')
    .set('Authorization', `Bearer ${manager.accessToken}`);
  profileOk(reference);
  const { profileId } = avatarCurrentSchema.parse(reference.body);
  assert.ok(profileId);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=$1',
        [manager.accountId],
      )
    ).rowCount,
    0,
    'The tested consumer starts with no seeded grant of any role',
  );
  const epoch = async () =>
    BigInt(
      (
        await pool.query<{ revision: string }>(
          'SELECT revision::text FROM whaleu_majors.major_delete_authority_epoch WHERE singleton',
        )
      ).rows[0]!.revision,
    );
  let previousGrant: string | null = null;
  return async (
    action: 'appoint' | 'reassign' | 'revoke',
    regionId?: string,
  ) => {
    const response = await request(http)
      .get(`${schoolPath}/management`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .query({ targetProfileId: profileId });
    profileOk(response);
    const view = schoolAdminManagementSchema.parse(response.body);
    assert.equal(view.actions[action], true);
    const body = {
      clientRequestId: randomUUID(),
      targetProfileId: profileId,
      expectedStateVersion: view.stateVersion,
      action,
      ...(regionId ? { regionId } : {}),
    };
    const beforeEpoch = await epoch();
    const result = await request(http)
      .post(`${schoolPath}/commands`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send(body);
    profileOk(result);
    const receipt = schoolAdminManagementReceiptSchema.parse(result.body);
    assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
    assert.equal(
      await epoch(),
      beforeEpoch + (action === 'reassign' ? 2n : 1n),
      'Actual management grant DML advances the existing 0124 authority epoch',
    );
    const evidence = (
      await pool.query<{
        old_grant_id: string | null;
        new_grant_id: string | null;
        actor_role: string;
      }>(
        `SELECT e.old_grant_id,e.new_grant_id,g.role actor_role
         FROM whaleu_authorization.school_admin_assignment_events e
         JOIN whaleu_authorization.role_grants g ON g.id=e.actor_grant_id
         WHERE e.actor_id=$1 AND e.request_id=$2 AND e.subject_id=$3`,
        [superAdmin.accountId, body.clientRequestId, manager.accountId],
      )
    ).rows;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.actor_role, 'super_admin');
    assert.equal(evidence[0]!.old_grant_id, previousGrant);
    const current = (
      await pool.query<{ id: string; operating_region_id: string }>(
        `SELECT id,operating_region_id FROM whaleu_authorization.role_grants
         WHERE account_id=$1 AND role='school_admin' AND revoked_at IS NULL`,
        [manager.accountId],
      )
    ).rows;
    if (action === 'revoke') {
      assert.deepEqual(current, []);
      assert.equal(evidence[0]!.new_grant_id, null);
    } else {
      assert.equal(current.length, 1);
      assert.equal(current[0]!.operating_region_id, regionId);
      assert.equal(current[0]!.id, evidence[0]!.new_grant_id);
      assert.notEqual(current[0]!.id, previousGrant);
    }
    if (previousGrant)
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_authorization.role_grants WHERE id=$1 AND revoked_at IS NOT NULL',
            [previousGrant],
          )
        ).rowCount,
        1,
      );
    previousGrant = current[0]?.id ?? null;
    return previousGrant;
  };
}

async function ownerSnapshot(pool: Pool, tables: readonly string[]) {
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    assert.match(table, /^whaleu_[a-z_]+\.[a-z_]+$/);
    snapshot[table] = (
      await pool.query(
        `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) value
         FROM (SELECT to_jsonb(t) row FROM ${table} t) s`,
      )
    ).rows[0]!.value;
  }
  return snapshot;
}

const moderationTables = [
  'whaleu_community.posts',
  'whaleu_community.root_comments',
  'whaleu_community.replies',
  'whaleu_community.admin_post_removal_commands',
  'whaleu_community.admin_post_removal_events',
  'whaleu_community.admin_post_removal_transitions',
  'whaleu_community.admin_discussion_removal_commands',
  'whaleu_community.admin_discussion_removal_events',
  'whaleu_community.admin_discussion_removal_transitions',
  'whaleu_community.media_cleanup_jobs',
  'whaleu_profile.profiles',
  'whaleu_profile.moderation_commands',
  'whaleu_profile.moderation_events',
  'whaleu_profile.moderation_transitions',
  'whaleu_profile.avatar_current',
  'whaleu_profile.avatar_definitions',
  'whaleu_profile.avatar_moderation_commands',
  'whaleu_profile.avatar_moderation_events',
  'whaleu_profile.avatar_moderation_transitions',
  'whaleu_profile.avatar_moderation_pointer_transitions',
  'whaleu_notifications.admin_post_removal_notices',
  'whaleu_notifications.profile_moderation_notices',
  'whaleu_notifications.profile_avatar_moderation_notices',
  'whaleu_media.bindings',
  'whaleu_media.upload_intents',
  'whaleu_media.cleanup_obligations',
] as const;

type ModerationKind = 'post' | 'comment' | 'reply' | 'nickname' | 'avatar';
type ModerationBody = {
  clientRequestId: string;
  target: { kind: 'post' | 'comment' | 'reply'; id: string };
  expectedTargetVersion?: string;
  expectedProfileRevision?: number;
  expectedAppearanceId?: string;
  action: string;
};
type PreparedModeration = {
  kind: ModerationKind;
  path: string;
  tablePrefix: string;
  body: ModerationBody;
  checkApplied: () => Promise<void>;
};

async function prepareModeration(
  f: AdminPostRemovalFixture,
  manager: Actor,
  spaceId: string,
  kind: ModerationKind,
): Promise<PreparedModeration> {
  const subject = await f.actor();
  if (kind === 'avatar') await f.custom(subject);
  const post = await f.publish(subject, { spaceId });
  const root =
    kind === 'comment' || kind === 'reply'
      ? await f.child(subject, post.id)
      : null;
  const target =
    kind === 'reply'
      ? await f.child(subject, post.id, root!.id)
      : (root ?? { kind: 'post' as const, id: post.id });
  const name =
    kind === 'post'
      ? 'admin-post-removal'
      : kind === 'comment' || kind === 'reply'
        ? 'admin-discussion-removal'
        : kind === 'nickname'
          ? 'profile-moderation'
          : 'profile-avatar-moderation';
  const path = `/v1/community/${name}`;
  const tablePrefix =
    kind === 'post'
      ? 'whaleu_community.admin_post_removal'
      : kind === 'comment' || kind === 'reply'
        ? 'whaleu_community.admin_discussion_removal'
        : kind === 'nickname'
          ? 'whaleu_profile.moderation'
          : 'whaleu_profile.avatar_moderation';
  const response = await request(f.http)
    .get(`${path}/management`)
    .set('Authorization', `Bearer ${manager.accessToken}`)
    .query({ kind: target.kind, id: target.id });
  profileOk(response);
  let body: ModerationBody;
  if (kind === 'post' || kind === 'comment' || kind === 'reply') {
    const view =
      kind === 'post'
        ? adminPostRemovalManagementSchema.parse(response.body)
        : adminDiscussionRemovalManagementSchema.parse(response.body);
    body = {
      clientRequestId: randomUUID(),
      target: view.target,
      expectedTargetVersion: view.targetVersion,
      action: kind === 'post' ? 'remove_post' : 'remove_discussion',
    };
  } else if (kind === 'nickname') {
    const view = moderationManagementSchema.parse(response.body);
    body = {
      clientRequestId: randomUUID(),
      target: view.target,
      expectedProfileRevision: view.revision,
      action: 'reset_nickname',
    };
  } else {
    const view = avatarModerationManagementSchema.parse(response.body);
    assert.equal(view.canClearCustomAvatar, true);
    assert.ok(view.expectedAppearanceId);
    body = {
      clientRequestId: randomUUID(),
      target: view.target,
      expectedProfileRevision: view.revision,
      expectedAppearanceId: view.expectedAppearanceId,
      action: 'clear_custom_avatar',
    };
  }
  return {
    kind,
    path,
    tablePrefix,
    body,
    checkApplied: async () => {
      if (kind === 'post' || kind === 'comment' || kind === 'reply') {
        const table =
          kind === 'post'
            ? 'posts'
            : kind === 'comment'
              ? 'root_comments'
              : 'replies';
        const row = (
          await f.pool.query(
            `SELECT deleted_at FROM whaleu_community.${table} WHERE id=$1`,
            [target.id],
          )
        ).rows[0];
        assert.ok(row?.deleted_at, `${kind} is actually removed by its owner`);
        if (kind !== 'post')
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
                [post.id],
              )
            ).rows[0]!.deleted_at,
            null,
            'Discussion removal does not delete its parent post',
          );
      } else {
        const profile = await request(f.http)
          .get('/v1/me/profile')
          .set('Authorization', `Bearer ${subject.accessToken}`);
        profileOk(profile);
        assert.equal(profile.body.revision, body.expectedProfileRevision! + 1);
        if (kind === 'nickname')
          assert.match(profile.body.nickname, /^违规昵称[A-Za-z0-9]{6}$/);
        else {
          const avatar = await request(f.http)
            .get('/v1/me/profile/avatar')
            .set('Authorization', `Bearer ${subject.accessToken}`);
          profileOk(avatar);
          assert.equal(
            avatarCurrentSchema.parse(avatar.body).avatar.state,
            'none',
          );
          const definition = (
            await f.pool.query(
              `SELECT d.authority,d.source,d.binding_id FROM whaleu_profile.avatar_current c
               JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id WHERE c.actor_id=$1`,
              [subject.accountId],
            )
          ).rows[0];
          assert.deepEqual(definition, {
            authority: 'scoped_moderation_clear',
            source: { kind: 'clear' },
            binding_id: null,
          });
        }
      }
    },
  };
}

test(
  'new management grants authorize actual post, comment, reply, nickname and avatar mutations only in their current region',
  { timeout: 300000 },
  async (t) => {
    const f = await adminPostRemovalFixture();
    t.after(() => f.close());
    const superAdmin = await f.actor(),
      manager = await f.actor();
    await f.grant(superAdmin, 'super_admin', null);
    const transition = await managementJourney(
      f.http,
      f.pool,
      superAdmin,
      manager,
    );
    const send = (item: PreparedModeration, body = item.body, cancel = false) =>
      request(f.http)
        .post(`${item.path}/commands${cancel ? '/cancel' : ''}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send(body);
    const committed: { item: PreparedModeration; receipt: unknown }[] = [];
    const prepareRegion = async (spaceId: string, grantId: string) => {
      const pending: PreparedModeration[] = [];
      for (const kind of [
        'post',
        'comment',
        'reply',
        'nickname',
        'avatar',
      ] as const) {
        const item = await prepareModeration(f, manager, spaceId, kind);
        const response = await send(item);
        profileOk(response);
        const receipt =
          kind === 'post'
            ? adminPostRemovalReceiptSchema.parse(response.body)
            : kind === 'comment' || kind === 'reply'
              ? adminDiscussionRemovalReceiptSchema.parse(response.body)
              : kind === 'nickname'
                ? moderationReceiptSchema.parse(response.body)
                : avatarModerationReceiptSchema.parse(response.body);
        assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
        await item.checkApplied();
        const evidence = (
          await f.pool.query(
            `SELECT c.grant_id command_grant,e.grant_id event_grant
             FROM ${item.tablePrefix}_commands c
             JOIN ${item.tablePrefix}_events e USING(actor_id,request_id)
             WHERE c.actor_id=$1 AND c.request_id=$2`,
            [manager.accountId, item.body.clientRequestId],
          )
        ).rows;
        assert.deepEqual(evidence, [
          { command_grant: grantId, event_grant: grantId },
        ]);
        committed.push({ item, receipt });
        pending.push(await prepareModeration(f, manager, spaceId, kind));
      }
      return pending;
    };
    const deny = async (items: PreparedModeration[]) => {
      const before = await ownerSnapshot(f.pool, moderationTables);
      for (const item of items) {
        const displayed = await request(f.http)
          .get(`${item.path}/management`)
          .set('Authorization', `Bearer ${manager.accessToken}`)
          .query(item.body.target);
        profileOk(displayed, 403);
        assert.equal(
          safeErrorResponseSchema.parse(displayed.body).error.code,
          'AUTHORIZATION_REQUIRED',
        );
        for (const body of [
          item.body,
          { ...item.body, clientRequestId: randomUUID() },
        ]) {
          const denied = await send(item, body);
          profileOk(denied, 403);
          assert.equal(
            safeErrorResponseSchema.parse(denied.body).error.code,
            'AUTHORIZATION_REQUIRED',
          );
          const recovery = await request(f.http)
            .get(`${item.path}/requests/${body.clientRequestId}`)
            .set('Authorization', `Bearer ${manager.accessToken}`);
          profileOk(recovery);
          assert.deepEqual(recovery.body, { state: 'not_recorded' });
        }
      }
      assert.deepEqual(
        await ownerSnapshot(f.pool, moderationTables),
        before,
        'Old displayed and fresh requests create no mutation, event, receipt, notice or retirement',
      );
    };
    const history = async () => {
      const before = await ownerSnapshot(f.pool, moderationTables);
      for (const { item, receipt } of committed) {
        for (const cancel of [false, true]) {
          const replay = await send(item, item.body, cancel);
          profileOk(replay);
          assert.deepEqual(replay.body, receipt);
        }
        const recovery = await request(f.http)
          .get(`${item.path}/requests/${item.body.clientRequestId}`)
          .set('Authorization', `Bearer ${manager.accessToken}`);
        profileOk(recovery);
        assert.deepEqual(recovery.body, { state: 'recorded', receipt });
        await item.checkApplied();
      }
      assert.deepEqual(await ownerSnapshot(f.pool, moderationTables), before);
    };
    const homeGrant = await transition('appoint', f.scope.home.regionId);
    assert.ok(homeGrant);
    const homePending = await prepareRegion(f.scope.home.spaceId, homeGrant);
    const relatedGrant = await transition('reassign', f.scope.related.regionId);
    assert.ok(relatedGrant);
    assert.notEqual(relatedGrant, homeGrant);
    await deny(homePending);
    await history();
    const relatedPending = await prepareRegion(
      f.scope.related.spaceId,
      relatedGrant,
    );
    await transition('revoke');
    await deny([...homePending, ...relatedPending]);
    await history();
  },
);

test(
  'new management grants govern real pin and unpin mutations while old committed pin receipts remain historical after reassign and revoke',
  { timeout: 180000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const http = f.app.getHttpServer();
    const superAdmin = await f.actor(),
      manager = await f.actor(),
      author = await f.actor();
    await f.grant(superAdmin.accountId, 'super_admin');
    const transition = await managementJourney(
      http,
      f.pool,
      superAdmin,
      manager,
    );
    for (const scope of [f.scope.home, f.scope.related])
      await f.bind(scope.spaceId, 'regional', scope.regionId);
    const send = (body: PinCommand) =>
      request(http)
        .post('/v1/community/post-pin-commands')
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send(body);
    const pin = (postId: string): PinCommand => ({
      operation: 'pin',
      clientRequestId: randomUUID(),
      postId,
      durationHours: 24,
      level: 2,
    });
    const unpin = (postId: string, pinId: string): PinCommand => ({
      operation: 'unpin',
      clientRequestId: randomUUID(),
      postId,
      pinId,
    });
    const committed: { body: PinCommand; receipt: unknown }[] = [];
    const apply = async (body: PinCommand, grantId: string) => {
      const response = await send(body);
      profileOk(response);
      const receipt = pinReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      assert.ok('pinId' in receipt);
      const stored = (
        await f.pool.query<{ grant_id: string }>(
          'SELECT grant_id FROM whaleu_community.post_pin_commands WHERE actor_id=$1 AND request_id=$2',
          [manager.accountId, body.clientRequestId],
        )
      ).rows;
      assert.deepEqual(stored, [{ grant_id: grantId }]);
      committed.push({ body, receipt });
      return receipt.pinId;
    };
    const detail = async (postId: string) => {
      const response = await request(http)
        .get(`/v1/community/posts/${postId}/pin`)
        .set('Authorization', `Bearer ${manager.accessToken}`);
      profileOk(response);
      return pinDetailSchema.parse(response.body);
    };
    const prepareRegion = async (spaceId: string, grantId: string) => {
      const post = await f.publish(author, spaceId);
      assert.equal((await detail(post.id)).canPin, true);
      const first = await apply(pin(post.id), grantId);
      assert.equal((await detail(post.id)).pin?.pinId, first);
      await apply(unpin(post.id, first), grantId);
      assert.equal((await detail(post.id)).pin, null);
      const current = await apply(pin(post.id), grantId);
      const displayed = await detail(post.id);
      assert.equal(displayed.canUnpin, true);
      assert.equal(displayed.pin?.pinId, current);
      return [pin(post.id), unpin(post.id, current)];
    };
    const tables = [
      'whaleu_community.post_pin_commands',
      'whaleu_community.post_pins',
      'whaleu_community.post_pin_heads',
      'whaleu_community.post_pin_closures',
      'whaleu_community.post_pin_reads',
      'whaleu_community.posts',
    ];
    const deny = async (commands: PinCommand[]) => {
      const before = await ownerSnapshot(f.pool, tables);
      for (const command of commands) {
        const displayed = await detail(command.postId);
        assert.equal(displayed.canPin, false);
        assert.equal(displayed.canUnpin, false);
        for (const body of [
          command,
          { ...command, clientRequestId: randomUUID() },
        ]) {
          const response = await send(body);
          profileOk(response, 403);
          assert.equal(
            safeErrorResponseSchema.parse(response.body).error.code,
            'AUTHORIZATION_REQUIRED',
          );
          const recovery = await request(http)
            .get(`/v1/me/community/post-pin-requests/${body.clientRequestId}`)
            .set('Authorization', `Bearer ${manager.accessToken}`);
          profileOk(recovery, 404);
          assert.equal(
            safeErrorResponseSchema.parse(recovery.body).error.code,
            'REQUEST_NOT_FOUND',
          );
        }
      }
      assert.deepEqual(await ownerSnapshot(f.pool, tables), before);
    };
    const history = async () => {
      const before = await ownerSnapshot(f.pool, tables);
      for (const { body, receipt } of committed) {
        const replay = await send(body);
        profileOk(replay);
        assert.deepEqual(replay.body, receipt);
        const recovered = await request(http)
          .get(`/v1/me/community/post-pin-requests/${body.clientRequestId}`)
          .set('Authorization', `Bearer ${manager.accessToken}`);
        profileOk(recovered);
        assert.deepEqual(recovered.body, receipt);
      }
      assert.deepEqual(
        await ownerSnapshot(f.pool, tables),
        before,
        'Replaying an old pin or unpin receipt never restores or removes a current pin',
      );
    };
    const homeGrant = await transition('appoint', f.scope.home.regionId);
    assert.ok(homeGrant);
    const homePending = await prepareRegion(f.scope.home.spaceId, homeGrant);
    const relatedGrant = await transition('reassign', f.scope.related.regionId);
    assert.ok(relatedGrant);
    await deny(homePending);
    await history();
    const relatedPending = await prepareRegion(
      f.scope.related.spaceId,
      relatedGrant,
    );
    await transition('revoke');
    await deny([...homePending, ...relatedPending]);
    await history();
  },
);
