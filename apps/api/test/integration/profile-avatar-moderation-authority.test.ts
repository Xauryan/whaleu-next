/** Real authority/source writers and elapsed deadlines on the new clear path. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { avatarModerationReceiptSchema } from '../../src/profile/avatar-moderation/contracts.js';
import type {
  AvatarModerationCommand,
  AvatarModerationTarget,
} from '../../src/profile/avatar-moderation/contracts.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import {
  insertSyntheticAssertion,
  syntheticAssertion,
} from '../support/verification-fixtures.js';

type Fixture = Awaited<ReturnType<typeof profileAvatarModerationFixture>>;
type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;

// Append genuine immutable Verification evidence, retaining all other assertions.
// Reusing the old phone assertion exercises semantic ABA without disabling guards.
async function appendPhone(
  f: Fixture,
  tx: PoolClient,
  actor: ProfileActor,
  state: 'verified' | 'unverified',
  reuse?: string,
  expiresAt?: Date,
) {
  const previous = (
    await tx.query<{
      revision: number;
      affiliation_assertion_id: string | null;
      student_number_assertion_id: string | null;
      phone_assertion_id: string | null;
      application_state: string;
      application_coverage: string;
    }>(
      `SELECT h.revision,s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id,s.application_state,s.application_coverage
    FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1 FOR UPDATE OF h`,
      [actor.accountId],
    )
  ).rows[0]!;
  const assertion = syntheticAssertion(
    actor.accountId,
    f.scope.institutionId,
    'phone',
    {
      assertion_state: state,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
  );
  if (!reuse) await insertSyntheticAssertion(tx, assertion);
  const snapshot = randomUUID(),
    revision = previous.revision + 1;
  await tx.query(
    `INSERT INTO whaleu_verification.snapshots
    (id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      snapshot,
      actor.accountId,
      revision,
      previous.affiliation_assertion_id,
      previous.student_number_assertion_id,
      reuse ?? assertion.id,
      previous.application_state,
      previous.application_coverage,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_verification.events
    (id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
    VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_avatar_authority_adversary')`,
    [
      randomUUID(),
      actor.accountId,
      randomUUID(),
      previous.revision,
      snapshot,
      revision,
    ],
  );
  await tx.query(
    'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
    [actor.accountId, revision, snapshot],
  );
  return previous.phone_assertion_id;
}

async function revokeReview(query: Query, node: AvatarModerationTarget) {
  const result = await query(
    `WITH changed AS (
    INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
    SELECT gen_random_uuid(),decision_id,'revoked','complete','accepted','synthetic-profile-review','synthetic-avatar-source-revocation',clock_timestamp()
    FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2 RETURNING id,decision_id)
    UPDATE whaleu_community.content_approval_heads h SET event_id=changed.id FROM changed WHERE h.decision_id=changed.decision_id`,
    [node.kind, node.id],
  );
  assert.equal(
    result.rowCount,
    1,
    'A genuine immutable Review event replaces the exact source head',
  );
}
async function appendMediaSafety(
  query: Query,
  assetId: string,
  state: 'allow' | 'revoked',
  until: Date,
) {
  const asset = (
    await query(
      'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1 FOR UPDATE',
      [assetId],
    )
  ).rows[0]!;
  const head = (
    await query(
      'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
      [assetId],
    )
  ).rows[0]!;
  const revision = Number(head.revision) + 1,
    event = randomUUID();
  await query(
    `INSERT INTO whaleu_media.asset_safety_events
    (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
    VALUES($1,$2,$3,$4,$5,$6,'registered-synthetic-media',$7,'{}',clock_timestamp(),$8)`,
    [
      event,
      assetId,
      revision,
      state,
      asset.manifest_digest,
      asset.policy_revision,
      `synthetic-avatar-authority:${event}`,
      until,
    ],
  );
  assert.equal(
    (
      await query(
        'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
        [assetId, revision, event],
      )
    ).rowCount,
    1,
  );
}

test(
  'avatar clear retains exact authority and source facts through retirement and real deadline expiry',
  { timeout: 300000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    const database = f.moderationApp.get(DatabaseService),
      subject = await f.actor(),
      ancestor = await f.actor();
    const selected = await f.custom(subject),
      post = await f.publish(subject),
      parentPost = await f.publish(ancestor, {}, true),
      root = await f.child(ancestor, parentPost.id, null, true),
      reply = await f.child(subject, parentPost.id, root.id, true);
    const sourceAssets = (
      await f.pool.query<{ resource_id: string; asset_id: string }>(
        "SELECT resource_id,asset_id FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_id=ANY($1::uuid[]) AND detached_at IS NULL",
        [[parentPost.id, root.id, reply.id]],
      )
    ).rows;
    const assetFor = (node: AvatarModerationTarget) => {
      const row = sourceAssets.find((row) => row.resource_id === node.id);
      assert.ok(row);
      return row.asset_id;
    };
    const command = (target: AvatarModerationTarget = post) =>
      f.command(target, selected.current.revision, selected.appearanceId);
    const snapshot = async (
      actor: ProfileActor,
      target: AvatarModerationTarget,
    ) =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'profile',(SELECT to_jsonb(p) FROM whaleu_profile.profiles p WHERE account_id=$1),
    'avatar',whaleu_profile.moderation_avatar_facts($1),
    'retirement',whaleu_profile.avatar_moderation_retirement_facts((SELECT intent_id FROM whaleu_media.assets WHERE id=$2)),
    'inputs',whaleu_profile.avatar_moderation_input_facts($3,NULL,$4,$5),
    'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM whaleu_authorization.role_grants g WHERE account_id=$3),
    'identity',whaleu_profile.moderation_identity_facts($3,$6,$7),
    'actorSafety',(SELECT to_jsonb(s) FROM whaleu_safety.account_heads s WHERE account_id=$3),
    'mediaEpoch',(SELECT jsonb_agg(to_jsonb(m) ORDER BY slot) FROM whaleu_media.media_owner_states m),
    'verification',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_verification.snapshots s WHERE account_id=$3),
    'assertions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_verification.assertions a WHERE account_id=$3),
    'verificationEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM whaleu_verification.events e WHERE account_id=$3),
    'totals',jsonb_build_array(
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_commands),
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_events),
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_transitions),
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_pointer_transitions),
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_media_statements),
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_media_epochs),
      (SELECT count(*) FROM whaleu_profile.avatar_definitions),
      (SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices),
      (SELECT count(*) FROM whaleu_notifications.system_notice_ids),
      (SELECT count(*) FROM whaleu_notifications.system_notice_owners),
      (SELECT count(*) FROM whaleu_media.cleanup_obligations),
      (SELECT count(*) FROM whaleu_community.content_approval_events),
      (SELECT count(*) FROM whaleu_media.asset_safety_events))) value`,
          [
            subject.accountId,
            selected.ready.status.assetId,
            actor.accountId,
            target.kind,
            target.id,
            actor.sessionId,
            hashToken(actor.accessToken),
          ],
        )
      ).rows[0]!.value;
    const absent = async (
      actor: ProfileActor,
      body: AvatarModerationCommand,
    ) => {
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.accountId, body.clientRequestId],
          )
        ).rowCount,
        0,
      );
    };
    const tentative = async (
      tx: PoolClient,
      actor: ProfileActor,
      body: AvatarModerationCommand,
    ) => {
      const row = (
        await tx.query(
          `SELECT
      (SELECT count(*) FROM whaleu_profile.avatar_moderation_events WHERE actor_id=$1 AND request_id=$2)::integer events,
      (SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices WHERE recipient_account_id=$3)::integer notices,
      b.detached_at,i.state FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
      JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE b.asset_id=$4`,
          [
            actor.accountId,
            body.clientRequestId,
            subject.accountId,
            selected.ready.status.assetId,
          ],
        )
      ).rows[0]!;
      assert.equal(row.events, 1);
      assert.equal(row.notices, 1);
      assert.ok(row.detached_at instanceof Date);
      assert.equal(row.state, 'cleanup_pending');
    };
    const applied = (value: unknown, body: AvatarModerationCommand) => {
      const parsed = avatarModerationReceiptSchema.safeParse(value);
      return (
        parsed.success &&
        parsed.data.requestId === body.clientRequestId &&
        parsed.data.outcome === 'applied'
      );
    };
    const intercept = async (
      actor: ProfileActor,
      body: AvatarModerationCommand,
      hook: (
        sql: string,
        tx: PoolClient,
        query: Query,
        result: QueryResult,
      ) => Promise<void>,
      management = false,
    ) => {
      const original = database.transaction,
        execute = original.bind(database);
      database.transaction = (work, options) =>
        execute(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx) as Query;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            await hook(sql, tx, query, result);
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        return management
          ? await request(f.http)
              .get('/v1/community/profile-avatar-moderation/management')
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .query(body.target)
          : await f.send(actor, body);
      } finally {
        database.transaction = original;
      }
    };

    await t.test(
      'real session and token writers queued behind retained SHARE abort tentative retirement',
      async () => {
        for (const source of ['session', 'token'] as const) {
          const actor = await f.actor();
          await f.grant(actor);
          const body = command(),
            before = await snapshot(actor, body.target),
            writer = await f.pool.connect();
          const original = database.transaction,
            execute = original.bind(database);
          const pending: {
            value:
              | Promise<
                  | { ok: true; count: number | null }
                  | { ok: false; error: unknown }
                >
              | undefined;
          } = { value: undefined };
          let observed = false,
            open = false;
          try {
            await writer.query('BEGIN');
            open = true;
            // Only bounds the independent fixture writer, never the owner's 100/500ms budgets.
            await writer.query("SET LOCAL statement_timeout='8s'");
            const writerPid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            database.transaction = (work, options) =>
              execute(async (tx) => {
                const result = await work(tx);
                if (applied(result, body)) {
                  await tentative(tx, actor, body);
                  const commandPid = (
                    await tx.query<{ pid: number }>(
                      'SELECT pg_backend_pid() pid',
                    )
                  ).rows[0]!.pid;
                  const attempt =
                    source === 'session'
                      ? writer.query(
                          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                          [actor.sessionId],
                        )
                      : writer.query(
                          'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                          [hashToken(actor.accessToken)],
                        );
                  pending.value = attempt.then(
                    (value) => ({ ok: true as const, count: value.rowCount }),
                    (error) => ({ ok: false as const, error }),
                  );
                  const deadline = Date.now() + 5000;
                  while (Date.now() < deadline) {
                    const waiting = (
                      await f.pool.query<{ waiting: boolean }>(
                        "SELECT wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid)) waiting FROM pg_stat_activity WHERE pid=$1",
                        [writerPid, commandPid],
                      )
                    ).rows[0];
                    if (waiting?.waiting) {
                      observed = true;
                      break;
                    }
                    await sleep(10);
                  }
                  assert.equal(
                    observed,
                    true,
                    `${source} invalidator actually queues behind this clear`,
                  );
                }
                return result;
              }, options);
            const response = await f.send(actor, body);
            assert.equal(observed, true);
            assert.ok(response.status >= 400, JSON.stringify(response.body));
            const changed = await pending.value;
            assert.ok(changed?.ok);
            assert.equal(changed.count, 1);
            await writer.query('ROLLBACK');
            open = false;
            assert.deepEqual(await snapshot(actor, body.target), before);
            await absent(actor, body);
          } finally {
            database.transaction = original;
            if (pending.value) await pending.value;
            try {
              if (open) await writer.query('ROLLBACK');
            } finally {
              writer.release();
            }
          }
        }
      },
    );

    await t.test(
      'management and clear retain original phone and selected grant across valid replacement and ABA before enrollment',
      async () => {
        const actor = await f.actor(),
          grant = await f.grant(actor);
        for (const operation of ['management', 'command'] as const)
          for (const change of [
            'phone-unverified',
            'phone-valid-replacement',
            'phone-semantic-aba',
            'grant-revoked',
            'grant-valid-replacement',
            'grant-valid-tuple-aba',
          ] as const) {
            const body = command(),
              before = await snapshot(actor, body.target);
            let injected = false;
            const response = await intercept(
              actor,
              body,
              async (sql, tx, query, result) => {
                if (
                  injected ||
                  !/^SELECT\s+id\b/.test(sql.trimStart()) ||
                  !sql.includes('moderation_grant_allowed') ||
                  !sql.includes('LIMIT 1 FOR SHARE')
                )
                  return;
                injected = true;
                assert.equal(result.rows[0]?.id, grant);
                if (change === 'phone-unverified')
                  await appendPhone(f, tx, actor, 'unverified');
                else if (change === 'phone-valid-replacement')
                  await appendPhone(f, tx, actor, 'verified');
                else if (change === 'phone-semantic-aba') {
                  const originalPhone = await appendPhone(
                    f,
                    tx,
                    actor,
                    'unverified',
                  );
                  assert.ok(originalPhone);
                  await appendPhone(f, tx, actor, 'verified', originalPhone);
                } else if (change === 'grant-valid-tuple-aba') {
                  for (let n = 0; n < 2; n++)
                    assert.equal(
                      (
                        await query(
                          'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at,revoked_by_account_id=revoked_by_account_id WHERE id=$1',
                          [grant],
                        )
                      ).rowCount,
                      1,
                    );
                } else {
                  await query(
                    'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                    [grant, actor.accountId],
                  );
                  if (change === 'grant-valid-replacement')
                    await query(
                      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
            VALUES($1,$2,'school_admin',$3,$2,'synthetic:avatar-valid-replacement')`,
                      [randomUUID(), actor.accountId, f.scope.home.regionId],
                    );
                }
              },
              operation === 'management',
            );
            assert.equal(
              injected,
              true,
              `${operation}/${change} reaches exact source capture boundary`,
            );
            assert.ok(
              response.status >= 400,
              `${operation}/${change}: ${JSON.stringify(response.body)}`,
            );
            assert.deepEqual(await snapshot(actor, body.target), before);
            await absent(actor, body);
          }
      },
    );

    await t.test(
      'real target root and post ancestor Review and image Safety revocations cannot replace initially observed facts',
      async () => {
        const actor = await f.actor();
        await f.grant(actor);
        for (const node of [reply, root, parentPost])
          for (const source of ['Review', 'Safety'] as const) {
            const body = command(reply),
              before = await snapshot(actor, body.target);
            let injected = false,
              changed = false;
            const response = await intercept(
              actor,
              body,
              async (sql, _tx, query) => {
                if (
                  injected ||
                  !/^SELECT\s+id\b/.test(sql.trimStart()) ||
                  !sql.includes('moderation_grant_allowed') ||
                  !sql.includes('LIMIT 1 FOR SHARE')
                )
                  return;
                injected = true;
                if (source === 'Review') await revokeReview(query, node);
                else
                  await appendMediaSafety(
                    query,
                    assetFor(node),
                    'revoked',
                    new Date(Date.now() + 60000),
                  );
                changed = true;
              },
            );
            assert.equal(injected, true);
            assert.equal(
              changed,
              true,
              `${node.kind}/${source}: canonical source head truly changes before command admission`,
            );
            assert.ok(
              response.status >= 400,
              `${node.kind}/${source}: ${JSON.stringify(response.body)}`,
            );
            assert.deepEqual(await snapshot(actor, body.target), before);
            await absent(actor, body);
          }
      },
    );

    await t.test(
      'late grant token phone actor Safety and target or ancestor Review revocation rolls back all tentative retirement effects',
      async () => {
        for (const source of [
          'grant',
          'token',
          'phone',
          'actor-safety',
          'target-review',
          'root-review',
          'post-review',
        ] as const) {
          const actor = await f.actor(),
            grant = await f.grant(actor),
            body = command(reply),
            before = await snapshot(actor, reply);
          const original = database.transaction,
            execute = original.bind(database);
          let reached = false,
            changed = false;
          database.transaction = (work, options) =>
            execute(async (tx) => {
              const result = await work(tx);
              if (applied(result, body)) {
                await tentative(tx, actor, body);
                reached = true;
                if (source === 'grant')
                  await tx.query(
                    'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                    [grant, actor.accountId],
                  );
                else if (source === 'token')
                  await tx.query(
                    'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                    [hashToken(actor.accessToken)],
                  );
                else if (source === 'phone')
                  await appendPhone(f, tx, actor, 'unverified');
                else if (source === 'actor-safety')
                  await tx.query(
                    'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                    [actor.accountId],
                  );
                else
                  await revokeReview(
                    tx.query.bind(tx) as Query,
                    source === 'target-review'
                      ? reply
                      : source === 'root-review'
                        ? root
                        : parentPost,
                  );
                changed = true;
              }
              return result;
            }, options);
          let response;
          try {
            response = await f.send(actor, body);
          } finally {
            database.transaction = original;
          }
          assert.equal(
            reached,
            true,
            `${source}: complete clear and old-binding retirement exist before invalidation`,
          );
          assert.equal(
            changed,
            true,
            `${source}: real authority/source invalidation executes`,
          );
          assert.ok(
            response.status >= 400,
            `${source}: ${JSON.stringify(response.body)}`,
          );
          assert.deepEqual(await snapshot(actor, reply), before);
          await absent(actor, body);
        }
      },
    );

    await t.test(
      'grant token phone Safety and target or ancestor Review deadlines expire naturally after tentative retirement',
      async () => {
        const baselinePolicy = (
          await f.pool.query<{ id: string }>(
            "SELECT id FROM whaleu_community.content_approval_policies WHERE coverage='complete' AND provenance='accepted' AND valid_until IS NULL ORDER BY valid_from DESC,id DESC LIMIT 1",
          )
        ).rows[0]!.id;
        for (const source of [
          'grant',
          'token',
          'phone',
          'actor-safety',
          'target-media-safety',
          'ancestor-media-safety',
          'target-review',
          'ancestor-review',
          'review-policy',
        ] as const) {
          const actor = await f.actor();
          let target: AvatarModerationTarget = post,
            mediaAsset: string | undefined;
          if (
            source === 'target-media-safety' ||
            source === 'ancestor-media-safety'
          ) {
            const mediaPost = await f.publish(
              source === 'target-media-safety' ? subject : ancestor,
              {},
              true,
            );
            mediaAsset = mediaPost.input.imageAssetIds[0]!;
            target =
              source === 'target-media-safety'
                ? mediaPost
                : await f.child(subject, mediaPost.id);
          }
          // Persist a short real deadline before the initial authorization. Fixture
          // work uses actual source rows; no clock mocks or owner budget changes.
          const deadline = (
            await f.pool.query<{ deadline: Date }>(
              "SELECT clock_timestamp()+interval '3 seconds' deadline",
            )
          ).rows[0]!.deadline;
          if (source === 'grant')
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_authorization.role_grants
        (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at)
        VALUES($1,$2,'school_admin',$3,$2,'synthetic:avatar-deadline',$4)`,
                [
                  randomUUID(),
                  actor.accountId,
                  f.scope.home.regionId,
                  deadline,
                ],
              ),
            );
          else await f.grant(actor);
          if (source === 'token')
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(actor.accessToken), deadline],
              ),
            );
          else if (source === 'phone')
            await withCommunityScopeWriter(f.pool, (tx) =>
              appendPhone(f, tx, actor, 'verified', undefined, deadline),
            );
          else if (source === 'actor-safety')
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
                [actor.accountId, deadline],
              ),
            );
          else if (mediaAsset)
            await withCommunityScopeWriter(f.pool, (tx) =>
              appendMediaSafety(
                tx.query.bind(tx) as Query,
                mediaAsset!,
                'allow',
                deadline,
              ),
            );
          else if (
            source === 'target-review' ||
            source === 'ancestor-review' ||
            source === 'review-policy'
          ) {
            const author = source === 'ancestor-review' ? ancestor : subject;
            let policy = baselinePolicy;
            if (source === 'review-policy') {
              policy = randomUUID();
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  `INSERT INTO whaleu_community.content_approval_policies
            (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
            VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-review-owner','synthetic-avatar-policy-deadline',clock_timestamp()-interval '60 seconds',$2)`,
                  [policy, deadline],
                ),
              );
            }
            const input = publishPostSchema.parse({
              clientRequestId: randomUUID(),
              spaceId: f.scope.home.spaceId,
              category: 'discussion',
              text: 'Synthetic exact source deadline',
              imageAssetIds: [],
              authorMode: 'named',
              commentsPolicy: 'open',
            });
            await approveEnvelope(
              f.pool,
              await postApprovalEnvelope(
                f.app,
                f.pool,
                author.accountId,
                input,
              ),
              {
                policyRevisionId: policy,
                ...(source === 'review-policy'
                  ? {}
                  : { visibilityUntil: deadline }),
              },
            );
            const published = await request(f.app.getHttpServer())
              .post('/v1/community/posts')
              .set('Authorization', `Bearer ${author.accessToken}`)
              .send(input);
            profileOk(published, 201);
            assert.equal(published.body.outcome, 'created');
            target = { kind: 'post', id: published.body.resourceId as string };
            if (source === 'ancestor-review')
              target = await f.child(subject, target.id);
          }
          const body = command(target),
            before = await snapshot(actor, target),
            original = database.transaction,
            execute = original.bind(database);
          let reached = false,
            crossed = false;
          database.transaction = (work, options) =>
            execute(async (tx) => {
              const result = await work(tx);
              if (applied(result, body)) {
                await tentative(tx, actor, body);
                reached = true;
                assert.equal(
                  (
                    await tx.query<{ current: boolean }>(
                      'SELECT clock_timestamp()<$1::timestamptz current',
                      [deadline],
                    )
                  ).rows[0]!.current,
                  true,
                  `${source}: still current after actual retirement`,
                );
                await tx.query(
                  'SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.04)',
                  [deadline],
                );
                crossed = (
                  await tx.query<{ expired: boolean }>(
                    'SELECT clock_timestamp()>=$1::timestamptz expired',
                    [deadline],
                  )
                ).rows[0]!.expired;
              }
              return result;
            }, options);
          let response;
          try {
            response = await f.send(actor, body);
          } finally {
            database.transaction = original;
          }
          assert.equal(
            reached,
            true,
            `${source}: clear reaches full tentative retirement before deadline`,
          );
          assert.equal(
            crossed,
            true,
            `${source}: database clock naturally passes captured deadline`,
          );
          assert.ok(
            response.status >= 400,
            `${source}: ${JSON.stringify(response.body)}`,
          );
          assert.deepEqual(await snapshot(actor, target), before);
          await absent(actor, body);
        }
      },
    );
  },
);
