/** Real commands on the real 0132 schema, then additive upgrade and actual
 * IdentityMaintenance. Disposable synthetic source, no provider or real data. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { ProfileAvatarModerationService } from '../../src/profile/avatar-moderation/service.js';
import { ProfileAvatarModerationService as HistoricalAvatarModerationService } from '../support/historical-avatar-moderation/service.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import { HistoricalContentDefinitionRepository } from '../support/historical-content-definition/configure.js';
import { historicalTextSourceAbsenceSql } from '../support/historical-content-definition/configure.js';
import { CampusService } from '../../src/campus/campus.service.js';
import { DatabaseService } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { IdentityMaintenance } from '../../src/identity/maintenance.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import type { EffectiveContentEnvelopeV1 } from '../../src/community/content-review/contracts.js';
import type { ContentScopeSnapshot } from '../../src/community/content-review/contracts.js';
import { CommunitySubscriptionEnrollment } from '../../src/community/subscription-component/enrollment.js';
import { CommunityLikeEnrollment } from '../../src/community/like-component/enrollment.js';
import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { CommunityCommentEnrollment } from '../../src/community/comment-component/enrollment.js';
import { enrollPublishedHotProcessing } from '../../src/community/hot-score/storage.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

/** Seed only publication prerequisites, not the moderation commands under test.
 * Current publication requires the 0171 reference owner, absent at 0132. Keep
 * the real historical schema and its guards rather than installing future DDL
 * or disabling current reference allocation. All facts below are synthetic. */
async function historicalContent(
  f: Awaited<ReturnType<typeof profileAvatarModerationFixture>>,
  accountId: string,
  postId: string | null = null,
) {
  const kind = postId === null ? 'post' : 'comment';
  const id = randomUUID(),
    requestId = randomUUID();
  const envelope: EffectiveContentEnvelopeV1 = {
    version: 1,
    accountId,
    purpose: postId === null ? 'publish_post' : 'publish_comment',
    spaceId: f.scope.home.spaceId,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId,
    rootCommentId: null,
    targetReplyId: null,
    text: `Synthetic historical ${kind}`,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope: {
      originalSpaceId: f.scope.home.spaceId,
      originalRegionId: f.scope.home.regionId,
      authorOriginRegionId: f.scope.home.regionId,
      identityRegionId: f.scope.home.regionId,
      topologySnapshotId: f.scope.topologySnapshotId,
      sync: 'none',
    },
  };
  const approval = await approveEnvelope(f.pool, envelope);
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      'INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,$4,$5)',
      [
        accountId,
        requestId,
        approval.digest,
        envelope.purpose,
        {
          requestId,
          operation: envelope.purpose,
          outcome: 'created',
          resourceId: id,
          createdAt: new Date().toISOString(),
        },
      ],
    );
    if (postId === null)
      await tx.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion',$4,'named','open')",
        [id, f.scope.home.spaceId, accountId, envelope.text],
      );
    else
      await tx.query(
        "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'named')",
        [id, postId, accountId, envelope.text],
      );
    await tx.query(
      "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES($1,$2,$3,$4,'native_publication')",
      [kind, id, accountId, requestId],
    );
    await tx.query(
      'INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,1,$6,$7,$8)',
      [
        kind,
        id,
        approval.decisionId,
        accountId,
        envelope.purpose,
        approval.digest,
        approval.envelope,
        approval.envelope.scope,
      ],
    );
    if (postId === null) {
      const canonical = {
        postId: id,
        ownerId: accountId,
        publicationRequestId: requestId,
      };
      for (const owner of [
        new CommunitySubscriptionEnrollment(),
        new CommunityViewEnrollment(),
        new CommunityCommentEnrollment(),
        new CommunityLikeEnrollment(),
      ])
        await owner.enrollPublishedPost(canonical, tx);
      await enrollPublishedHotProcessing(id, tx);
    }
  });
  return { kind, id };
}

const families = [
  [
    'profile-moderation',
    'whaleu_profile.moderation_commands',
    'reset_nickname',
  ],
  [
    'profile-avatar-moderation',
    'whaleu_profile.avatar_moderation_commands',
    'clear_custom_avatar',
  ],
  [
    'admin-post-removal',
    'whaleu_community.admin_post_removal_commands',
    'remove_post',
  ],
  [
    'admin-discussion-removal',
    'whaleu_community.admin_discussion_removal_commands',
    'remove_discussion',
  ],
] as const;

test(
  'historical commands survive terminal credential retention without blocking a mixed cleanup batch',
  { timeout: 240000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(false, 132);
    t.after(() => f.close());
    assert.ok(
      f.moderationApp.get(ProfileAvatarModerationService) instanceof
        HistoricalAvatarModerationService,
      'Pre-upgrade HTTP commands use the exact signed predecessor owner',
    );
    const historicalDefinitions: unknown = f.moderationApp.get(
      ContentDefinitionRepository,
    );
    assert.ok(
      historicalDefinitions instanceof HistoricalContentDefinitionRepository,
    );
    const identityService = () => f.app.get(IdentityService);
    const maintenance = () =>
      new IdentityMaintenance(f.moderationApp.get(DatabaseService));
    const subject = await f.actor(),
      stranger = await f.actor(),
      plain = await f.actor();
    await f.custom(subject);
    assert.equal(
      (
        await f.pool.query(
          "SELECT to_regclass('whaleu_community.content_reference_policy') present",
        )
      ).rows[0]!.present,
      null,
      'Historical publication preparation must not install the future reference schema',
    );
    const post = await historicalContent(f, subject.accountId);
    const discussionPost = await historicalContent(f, subject.accountId);
    const child = await historicalContent(
      f,
      subject.accountId,
      discussionPost.id,
    );
    const postScope = (
      await f.pool.query<{ scope: ContentScopeSnapshot }>(
        "SELECT scope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
        [post.id],
      )
    ).rows[0]!.scope;
    assert.equal(
      (await f.pool.query<{ absent: boolean }>(historicalTextSourceAbsenceSql))
        .rows[0]!.absent,
      true,
      'No future text-source table, function, index, trigger, column, constraint or type is installed',
    );
    const database = f.moderationApp.get(DatabaseService);
    assert.equal(
      (
        await database.transaction((tx) =>
          historicalDefinitions.current('post', post.id, postScope, tx),
        )
      ).kind,
      'allow',
    );
    await assert.rejects(
      database.transaction((tx) =>
        new ContentDefinitionRepository(
          f.moderationApp.get(CampusService),
        ).current('post', post.id, postScope, tx),
      ),
      { code: '42P01' },
      'Current reader still fails closed on the deliberately absent source schema',
    );
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const records: {
      path: string;
      table: string;
      actor: Actor;
      body: Record<string, unknown>;
      receipt: unknown;
    }[] = [];
    const get = (path: string, actor: Actor) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    for (const [family, table, action] of families) {
      const actor = await f.actor();
      await f.grant(actor);
      const target =
        family === 'admin-discussion-removal'
          ? child
          : { kind: post.kind, id: post.id };
      const path = `/v1/community/${family}`;
      const view = await get(`${path}/management`, actor).query(target);
      profileOk(view);
      const body = {
        clientRequestId: randomUUID(),
        target,
        action,
        ...(family.startsWith('profile')
          ? { expectedProfileRevision: view.body.revision }
          : { expectedTargetVersion: view.body.targetVersion }),
        ...(family === 'profile-avatar-moderation'
          ? { expectedAppearanceId: view.body.expectedAppearanceId }
          : {}),
      };
      const result = await request(f.http)
        .post(`${path}/commands`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
      profileOk(result);
      assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
      records.push({ path, table, actor, body, receipt: result.body });
    }
    // All four historical schemas really retain the offending FK before upgrade.
    const sessionFks = async () =>
      (
        await f.pool.query<{ table_name: string; conname: string }>(
          `SELECT conrelid::regclass::text table_name,conname FROM pg_constraint
     WHERE contype='f' AND confrelid='whaleu_identity.sessions'::regclass
     AND conrelid=ANY($1::regclass[]) ORDER BY conrelid::regclass::text`,
          [records.map((r) => r.table)],
        )
      ).rows;
    const originalFks = await sessionFks();
    assert.equal(originalFks.length, 4);
    const auditTables = (
      await f.pool.query<{
        schemaname: string;
        tablename: string;
        columns: string[];
      }>(
        `SELECT schemaname,tablename,(SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=schemaname AND table_name=tablename) columns FROM pg_tables WHERE schemaname IN ('whaleu_profile','whaleu_community','whaleu_notifications')
       AND (tablename LIKE '%moderation%' OR tablename LIKE 'admin_post_removal%' OR tablename LIKE 'admin_discussion_removal%' OR tablename IN ('system_notices','system_notice_ids'))
       ORDER BY schemaname,tablename`,
      )
    ).rows;
    const audits = async () => {
      const result: Record<string, unknown> = {};
      for (const { schemaname, tablename, columns } of auditTables) {
        result[`${schemaname}.${tablename}`] = (
          await f.pool.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) value FROM (SELECT ${columns.map((column) => `"${column}"`).join(',')} FROM "${schemaname}"."${tablename}") t`,
          )
        ).rows[0]!.value;
      }
      return result;
    };
    const originalAudits = await audits();
    const terminal = [...records.map((r) => r.actor), plain];
    for (const actor of terminal) {
      // Genuine Identity logout; HTTP auth mutation rate limiting is deliberately
      // unconfigured in this ordinary fixture (no provider/config override).
      await identityService().logout(actor.accessToken);
      await f.pool.query(
        "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp()-interval '40 days' WHERE id=$1",
        [actor.sessionId],
      );
    }
    const ids = terminal.map((a) => a.sessionId);
    const credentials = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
      'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_identity.sessions s WHERE id=ANY($1::uuid[])),
      'access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY token_hash) FROM whaleu_identity.access_tokens a WHERE session_id=ANY($1::uuid[])),
      'refresh',(SELECT jsonb_agg(to_jsonb(r) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens r WHERE session_id=ANY($1::uuid[]))) value`,
          [ids],
        )
      ).rows[0]!.value;
    const before = await credentials();
    const preview = await maintenance().run({
      mode: 'dry-run',
      batchSize: 100,
      retentionDays: 30,
    });
    assert.deepEqual(preview, {
      mode: 'dry-run',
      batchSize: 100,
      retentionDays: 30,
      candidateSessions: 5,
      accessTokens: 5,
      refreshTokens: 5,
      sessions: 5,
    });
    assert.deepEqual(await credentials(), before);
    // Prove each FK independently rejects deletion, never just the first family
    // encountered by a mixed DELETE. Every probe is rolled back, including tokens.
    for (const { actor, table } of records) {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(
          'DELETE FROM whaleu_identity.access_tokens WHERE session_id=$1',
          [actor.sessionId],
        );
        await tx.query(
          'DELETE FROM whaleu_identity.refresh_tokens WHERE session_id=$1',
          [actor.sessionId],
        );
        await assert.rejects(
          tx.query('DELETE FROM whaleu_identity.sessions WHERE id=$1', [
            actor.sessionId,
          ]),
          {
            code: '23503',
            constraint: originalFks.find((row) => row.table_name === table)!
              .conname,
          },
        );
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    }
    await assert.rejects(
      maintenance().run({ mode: 'apply', batchSize: 100, retentionDays: 30 }),
      { code: '23503' },
    );
    assert.deepEqual(
      await credentials(),
      before,
      'real maintenance failure rolls back the whole mixed batch',
    );
    assert.deepEqual(await audits(), originalAudits);
    // Upgrade the existing database through the genuine ordered migration runner.
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    await assert.rejects(
      f.moderationApp
        .get(ProfileAvatarModerationService)
        .recovery(
          records[1]!.actor.accessToken,
          String(records[1]!.body['clientRequestId']),
        ),
      /Historical avatar owner cannot cross an upgrade/,
    );
    await assert.rejects(
      database.transaction((tx) =>
        historicalDefinitions.current('post', post.id, postScope, tx),
      ),
      /Historical content definitions cannot cross an upgrade/,
    );
    await f.restartApp();
    assert.ok(
      f.moderationApp.get(ProfileAvatarModerationService) instanceof
        ProfileAvatarModerationService,
    );
    assert.equal(
      f.moderationApp.get(ProfileAvatarModerationService) instanceof
        HistoricalAvatarModerationService,
      false,
      'Upgrade restart restores the current owner without a historical adapter',
    );
    assert.ok(
      f.moderationApp.get(ContentDefinitionRepository) instanceof
        ContentDefinitionRepository,
    );
    assert.equal(
      f.moderationApp.get(ContentDefinitionRepository) instanceof
        HistoricalContentDefinitionRepository,
      false,
      'Upgrade restart restores the source-aware current definition reader',
    );
    for (const { schemaname, tablename, columns } of auditTables) {
      const added = (
        await f.pool.query<{ column_name: string }>(
          'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND NOT(column_name=ANY($3::text[]))',
          [schemaname, tablename, columns],
        )
      ).rows;
      for (const { column_name } of added) {
        assert.match(column_name, /^[a-z_]+$/);
        assert.equal(
          (
            await f.pool.query(
              `SELECT 1 FROM "${schemaname}"."${tablename}" WHERE "${column_name}" IS NOT NULL`,
            )
          ).rowCount,
          0,
          'New moderation metadata cannot invent historical evidence',
        );
      }
    }
    assert.deepEqual(await sessionFks(), []);
    assert.deepEqual(
      await audits(),
      originalAudits,
      'upgrade never rewrites audit evidence',
    );
    const afterPreview = await maintenance().run({
      mode: 'dry-run',
      batchSize: 100,
      retentionDays: 30,
    });
    assert.deepEqual(afterPreview, preview);
    const applied = await maintenance().run({
      mode: 'apply',
      batchSize: 100,
      retentionDays: 30,
    });
    assert.deepEqual(applied, { ...preview, mode: 'apply' });
    assert.deepEqual(await credentials(), {
      sessions: null,
      access: null,
      refresh: null,
    });
    assert.deepEqual(
      await audits(),
      originalAudits,
      'cleanup preserves complete command, event, effect and notice history',
    );
    assert.equal(
      (await maintenance().run({ mode: 'apply' })).candidateSessions,
      0,
    );
    for (const { actor, path, body, receipt, table } of records) {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0]!;
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: identity.provider,
          appId: identity.app_id,
          subject: identity.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      assert.equal(session.accountId, actor.accountId);
      assert.notEqual(session.sessionId, actor.sessionId);
      const fresh = { ...actor, ...session, accessToken, refreshToken };
      const recovery = `${path}/requests/${String(body['clientRequestId'])}`;
      const own = await get(recovery, fresh);
      profileOk(own);
      assert.deepEqual(own.body, { state: 'recorded', receipt });
      const other = await get(recovery, stranger);
      profileOk(other);
      assert.deepEqual(other.body, { state: 'not_recorded' });
      assert.equal((await get(recovery, actor)).status, 401);
      await assert.rejects(identityService().refresh(actor.refreshToken), {
        code: 'AUTHENTICATION_REQUIRED',
      });
      assert.equal(
        (
          await request(f.http)
            .post(`${path}/commands`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(body)
        ).status,
        401,
      );
      const retained = (
        await f.pool.query(
          `SELECT session_id FROM ${table} WHERE actor_id=$1 AND request_id=$2`,
          [actor.accountId, body['clientRequestId']],
        )
      ).rows[0]!;
      assert.equal(retained.session_id, actor.sessionId);
      await assert.rejects(
        f.pool.query(`UPDATE ${table} SET session_id=$1 WHERE actor_id=$2`, [
          fresh.sessionId,
          actor.accountId,
        ]),
        { code: '23514' },
      );
      // A newly revoked session cannot recover even though the historical record
      // and a valid account/request pair still exist.
      await identityService().logout(fresh.accessToken);
      assert.equal((await get(recovery, fresh)).status, 401);
    }
    profileOk(await get('/v1/me/profile', subject));
    profileOk(await get('/v1/me/profile', stranger));
    assert.deepEqual(await audits(), originalAudits);
  },
);
