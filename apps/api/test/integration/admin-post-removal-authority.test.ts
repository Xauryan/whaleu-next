import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import type { AdminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  insertSyntheticAssertion,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
// Append genuine immutable Verification evidence, retaining all other assertions.
// Reusing the old phone assertion exercises semantic ABA without disabling guards.
async function appendPhone(
  f: AdminPostRemovalFixture,
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

async function appendMediaSafety(
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>,
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
  'admin post removal captures exact token session grant phone Safety and Review deadlines before tentative deletion',
  { timeout: 180000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const subject = await f.actor();
    const normalPost = await f.publish(subject);
    const database = f.moderationApp.get(DatabaseService);
    const baselinePolicy = (
      await f.pool.query(
        "SELECT id FROM whaleu_community.content_approval_policies WHERE valid_until IS NULL AND coverage='complete' AND provenance='accepted' ORDER BY valid_from DESC,id DESC LIMIT 1",
      )
    ).rows[0]!.id;
    for (const source of [
      'grant',
      'token',
      'session',
      'phone',
      'actor-safety',
      'target-media-safety',
      'target-review',
      'review-policy',
    ] as const) {
      const actor = await f.actor();
      let post =
        source === 'target-media-safety'
          ? await f.publish(subject, {}, true)
          : normalPost;
      const deadline = (
        await f.pool.query<{ deadline: Date }>(
          "SELECT clock_timestamp()+interval '3 seconds' deadline",
        )
      ).rows[0]!.deadline;
      if (source === 'grant')
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic-admin-removal-deadline',$4)`,
            [randomUUID(), actor.accountId, f.scope.home.regionId, deadline],
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
      if (source === 'session')
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_identity.sessions SET access_expires_at=$2,refresh_expires_at=$2,absolute_expires_at=$2 WHERE id=$1',
            [actor.sessionId, deadline],
          ),
        );
      if (source === 'phone')
        await withCommunityScopeWriter(f.pool, (tx) =>
          appendPhone(f, tx, actor, 'verified', undefined, deadline),
        );
      if (source === 'actor-safety')
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
            [actor.accountId, deadline],
          ),
        );
      if (source === 'target-media-safety')
        await withCommunityScopeWriter(f.pool, (tx) =>
          appendMediaSafety(
            tx.query.bind(tx) as (
              sql: string,
              values?: unknown[],
            ) => Promise<QueryResult>,
            post.input.imageAssetIds[0]!,
            'allow',
            deadline,
          ),
        );
      if (source === 'target-review' || source === 'review-policy') {
        let policy = baselinePolicy;
        if (source === 'review-policy') {
          policy = randomUUID();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until) VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-review-owner','synthetic-admin-policy-deadline',clock_timestamp()-interval '60 seconds',$2)`,
              [policy, deadline],
            ),
          );
        }
        const input = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion',
          text: 'Synthetic administrative exact deadline',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
        });
        await approveEnvelope(
          f.pool,
          await postApprovalEnvelope(f.app, f.pool, subject.accountId, input),
          {
            policyRevisionId: policy,
            ...(source === 'target-review'
              ? { visibilityUntil: deadline }
              : {}),
          },
        );
        const published = await request(f.app.getHttpServer())
          .post('/v1/community/posts')
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send(input);
        profileOk(published, 201);
        assert.equal(published.body.outcome, 'created');
        post = { kind: 'post', id: published.body.resourceId, input };
      }
      const management = await f.removalManagement(post, actor),
        command = f.removalCommand(post, management.targetVersion);
      const original = database.transaction,
        execute = original.bind(database);
      let reached = false,
        expired = false;
      database.transaction = (work, options) =>
        execute(async (tx) => {
          const result = await work(tx);
          if (
            result &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'applied'
          ) {
            const tentative = (
              await tx.query(
                `SELECT p.deleted_at IS NOT NULL tombstone,(SELECT count(*)::int FROM whaleu_notifications.admin_post_removal_notices n JOIN whaleu_community.admin_post_removal_events e ON e.id=n.event_id WHERE e.target_id=p.id) notices FROM whaleu_community.posts p WHERE p.id=$1`,
                [post.id],
              )
            ).rows[0]!;
            assert.deepEqual(tentative, { tombstone: true, notices: 1 });
            reached = true;
            await tx.query(
              'SELECT pg_sleep(GREATEST(0,extract(epoch FROM($1::timestamptz-clock_timestamp())))+0.02)',
              [deadline],
            );
            expired = (
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
        response = await f.removalSend(actor, command);
      } finally {
        database.transaction = original;
      }
      assert.equal(
        reached,
        true,
        `${source}: complete tentative deletion reached before actual deadline`,
      );
      assert.equal(
        expired,
        true,
        `${source}: PostgreSQL actual clock passed retained exact deadline`,
      );
      assert.ok(response.status >= 400, JSON.stringify(response.body));
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
            [post.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.accountId, command.clientRequestId],
          )
        ).rows[0]!.n,
        0,
      );
      t.diagnostic(
        JSON.stringify({
          source,
          deadline: deadline.toISOString(),
          tentativeDeletionReached: reached,
          actualDeadlinePassed: expired,
          status: response.status,
          commandRolledBack: true,
        }),
      );
    }
    const admin = await f.actor();
    await f.grant(admin);
    await f.removalApply(normalPost, admin);
    await withCommunityScopeWriter(f.pool, (tx) =>
      appendPhone(f, tx, subject, 'unverified'),
    );
    const notice = await request(f.http)
      .get('/v1/me/system-notices')
      .set('Authorization', `Bearer ${subject.accessToken}`);
    profileOk(notice);
    assert.equal(notice.body.items[0].kind, 'admin_post_removed');
  },
);
