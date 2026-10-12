/** Non-null reviewed synthetic avatar, but the moderation HTTP runtime is ordinary AppModule. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  syntheticProfileRuntimeFixture,
  seedSyntheticAvatarCatalog,
  selectProfileAvatar,
  profileOk,
} from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';

test(
  'nickname-only reset preserves actual avatar identity, Review and delivered bytes, sharing CAS with owner avatar selection',
  { timeout: 120000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#266a8f' },
    })
      .png()
      .toBuffer();
    const f = await syntheticProfileRuntimeFixture([
      {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        verdict: 'allow',
      },
    ]);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    const catalog = await seedSyntheticAvatarCatalog(
      f,
      bytes,
      'image/png',
      16,
      12,
    );
    const source = {
      kind: 'catalog' as const,
      catalogVersion: catalog.catalogVersion,
      itemId: catalog.itemId,
    };
    const first = await selectProfileAvatar(f, subject, {
      protocol: 'profile-media-v1',
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      source,
    });
    assert.equal(first.current.avatar.state, 'available');
    assert.ok(first.current.avatar.appearanceId);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
      VALUES($1,$2,'school_admin',$3,$2,'synthetic:nickname-avatar-preservation')`,
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      ),
    );
    const ordinary = await f.startOrdinaryRuntime(),
      http = ordinary.getHttpServer();
    const input = publishPostSchema.parse({
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion',
      text: 'Synthetic avatar-preserving nickname management',
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
    });
    await approveEnvelope(
      f.pool,
      await postApprovalEnvelope(ordinary, f.pool, subject.accountId, input),
    );
    const published = await request(http)
      .post('/v1/community/posts')
      .set('Authorization', `Bearer ${subject.accessToken}`)
      .send(input);
    profileOk(published, 201);
    assert.equal(published.body.outcome, 'created');
    const target = { kind: 'post', id: published.body.resourceId as string };
    const management = async () => {
      const response = await request(http)
        .get('/v1/community/profile-moderation/management')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query(target);
      profileOk(response);
      return response.body as { revision: number; displayName: string };
    };
    const command = (expectedProfileRevision: number) => ({
      clientRequestId: randomUUID(),
      target,
      expectedProfileRevision,
      action: 'reset_nickname',
    });
    const submit = (body: object) =>
      request(http)
        .post('/v1/community/profile-moderation/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(body);
    const snapshot = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'current',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.actor_id) FROM whaleu_profile.avatar_current c),
    'definitions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM whaleu_profile.avatar_definitions d),
    'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.actor_id,c.client_request_id) FROM whaleu_profile.avatar_command_receipts c),
    'reviews',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM whaleu_community.profile_avatar_approval_decisions d),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.appearance_id) FROM whaleu_community.profile_avatar_approval_bindings b)
  ) bytes`)
      ).rows[0]!.bytes;
    const download = async (appearance: string) => {
      const result = await request(f.app.getHttpServer()).get(
        `/v1/profiles/${first.current.profileId}/avatar/${appearance}/thumb-v1`,
      );
      profileOk(result);
      assert.deepEqual(result.body, bytes);
    };
    await download(first.current.avatar.appearanceId);
    const before = await snapshot(),
      initial = await management();
    assert.equal(initial.revision, 1);
    const applied = await submit(command(initial.revision));
    profileOk(applied);
    assert.equal(applied.body.outcome, 'applied');
    assert.equal(applied.body.revision, 2);
    assert.deepEqual(await snapshot(), before);
    await download(first.current.avatar.appearanceId);
    const pending = command((await management()).revision);
    const second = await selectProfileAvatar(f, subject, {
      protocol: 'profile-media-v1',
      clientRequestId: randomUUID(),
      expectedRevision: 2,
      source,
    });
    assert.equal(second.current.revision, 3);
    assert.notEqual(
      second.current.avatar.appearanceId,
      first.current.avatar.appearanceId,
    );
    assert.ok(second.current.avatar.appearanceId);
    const afterOwnerSelection = await snapshot();
    const stale = await submit(pending);
    profileOk(stale);
    assert.equal(stale.body.outcome, 'rejected');
    assert.equal(stale.body.code, 'PROFILE_MODERATION_STALE');
    assert.deepEqual(await snapshot(), afterOwnerSelection);
    const reset = await submit(command(3));
    profileOk(reset);
    assert.equal(reset.body.outcome, 'applied');
    assert.equal(reset.body.revision, 4);
    assert.deepEqual(await snapshot(), afterOwnerSelection);
    await download(second.current.avatar.appearanceId);
    const notices = await request(http)
      .get('/v1/me/system-notices')
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(notices);
    assert.equal(notices.body.items.length, 2);
    assert.equal(notices.body.unreadCount, 2);
  },
);
