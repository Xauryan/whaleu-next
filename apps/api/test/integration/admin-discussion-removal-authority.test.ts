import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import type { AdminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  insertSyntheticAssertion,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import {
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import {
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import type { ApprovalFixtureOptions } from '../support/community-approval-fixtures.js';
import type { AdminDiscussionRemovalTarget } from '../../src/community/admin-discussion-removal/contracts.js';
// Append genuine immutable Verification evidence, retaining all other assertions.
// Reusing the old phone assertion exercises semantic ABA without disabling guards.
async function appendPhone(
  f: AdminDiscussionRemovalFixture,
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
    VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_discussion_authority_adversary')`,
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
      `synthetic-discussion-authority:${event}`,
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

async function reviewedPost(
  f: AdminDiscussionRemovalFixture,
  author: ProfileActor,
  options: ApprovalFixtureOptions,
) {
  const input = publishPostSchema.parse({
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion',
    text: 'Synthetic discussion ancestry deadline',
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  await approveEnvelope(
    f.pool,
    await postApprovalEnvelope(f.app, f.pool, author.accountId, input),
    options,
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/community/posts')
    .set('Authorization', `Bearer ${author.accessToken}`)
    .send(input);
  profileOk(response, 201);
  assert.equal(response.body.outcome, 'created');
  return { id: response.body.resourceId as string, input };
}
async function reviewedChild(
  f: AdminDiscussionRemovalFixture,
  author: ProfileActor,
  postId: string,
  rootId: string | null,
  options: ApprovalFixtureOptions,
) {
  const body = {
    clientRequestId: randomUUID(),
    text: 'Synthetic exact discussion Review deadline',
    imageAssetIds: [] as string[],
    authorMode: 'anonymous' as const,
    ...(rootId ? { targetReplyId: null } : {}),
  };
  await approveEnvelope(
    f.pool,
    await discussionApprovalEnvelope(
      f.app,
      f.pool,
      author.accountId,
      postId,
      body,
      rootId,
    ),
    options,
  );
  const response = await request(f.app.getHttpServer())
    .post(
      rootId
        ? `/v1/community/comments/${rootId}/replies`
        : `/v1/community/posts/${postId}/comments`,
    )
    .set('Authorization', `Bearer ${author.accessToken}`)
    .send(body);
  profileOk(response, 201);
  assert.equal(response.body.outcome, 'created');
  return {
    kind: rootId ? ('reply' as const) : ('comment' as const),
    id: response.body.resourceId as string,
    body,
  };
}

test(
  'both discussion kinds retain exact actor and every ancestry Review/Media deadline through tentative deletion and actual expiry',
  { timeout: 240000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture(true);
    t.after(() => f.close());
    const subject = await f.actor();
    const database = f.moderationApp.get(DatabaseService);
    const baselinePolicy = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM whaleu_community.content_approval_policies WHERE valid_until IS NULL AND coverage='complete' AND provenance='accepted' ORDER BY valid_from DESC,id DESC LIMIT 1",
      )
    ).rows[0]!.id;
    for (const kind of ['comment', 'reply'] as const) {
      for (const source of [
        'grant',
        'token',
        'session',
        'phone',
        'actor-safety',
        'target-media-safety',
        'root-media-safety',
        'post-media-safety',
        'target-review',
        'root-review',
        'post-review',
        'review-policy',
      ] as const) {
        if (
          kind === 'comment' &&
          (source === 'root-review' || source === 'root-media-safety')
        )
          continue;
        const actor = await f.actor();
        if (source !== 'grant') await f.grant(actor);
        // Media batches are complete before starting the real three-second
        // horizon, so provider simulation time cannot consume that horizon.
        let post = await f.publish(subject, {}, source === 'post-media-safety');
        let root = await f.discussion(subject, post.id, {
          images:
            source === 'root-media-safety' ||
            (source === 'target-media-safety' && kind === 'comment'),
        });
        let target =
          kind === 'comment'
            ? root
            : await f.discussion(subject, post.id, {
                rootId: root.id,
                images: source === 'target-media-safety',
              });
        const deadline = (
          await f.pool.query<{ deadline: Date }>(
            "SELECT clock_timestamp()+interval '3 seconds' deadline",
          )
        ).rows[0]!.deadline;
        if (source === 'grant')
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at)
             VALUES($1,$2,'school_admin',$3,$2,'synthetic-discussion-deadline',$4)`,
              [randomUUID(), actor.accountId, f.scope.home.regionId, deadline],
            ),
          );
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
        if (
          source === 'target-media-safety' ||
          source === 'root-media-safety' ||
          source === 'post-media-safety'
        ) {
          const asset =
            source === 'post-media-safety'
              ? post.input.imageAssetIds[0]!
              : source === 'root-media-safety'
                ? root.body.imageAssetIds[0]!
                : target.body.imageAssetIds[0]!;
          await withCommunityScopeWriter(f.pool, (tx) =>
            appendMediaSafety(
              tx.query.bind(tx) as (
                sql: string,
                values?: unknown[],
              ) => Promise<QueryResult>,
              asset,
              'allow',
              deadline,
            ),
          );
        }
        if (source === 'post-review') {
          const replacement = await reviewedPost(f, subject, {
            policyRevisionId: baselinePolicy,
            visibilityUntil: deadline,
          });
          post = { ...replacement, kind: 'post' };
          root = await reviewedChild(f, subject, post.id, null, {
            policyRevisionId: baselinePolicy,
          });
          target =
            kind === 'comment'
              ? root
              : await reviewedChild(f, subject, post.id, root.id, {
                  policyRevisionId: baselinePolicy,
                });
        }
        if (source === 'root-review') {
          root = await reviewedChild(f, subject, post.id, null, {
            policyRevisionId: baselinePolicy,
            visibilityUntil: deadline,
          });
          target = await reviewedChild(f, subject, post.id, root.id, {
            policyRevisionId: baselinePolicy,
          });
        }
        if (source === 'target-review' || source === 'review-policy') {
          let policy = baselinePolicy;
          if (source === 'review-policy') {
            policy = randomUUID();
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
               SELECT $1,'local-explicit-v1',1,'complete','accepted','synthetic-review-owner','synthetic-discussion-policy-deadline',valid_from-interval '1 second',$2
               FROM whaleu_community.content_approval_policies WHERE id=$3`,
                [policy, deadline, baselinePolicy],
              ),
            );
          }
          target = await reviewedChild(
            f,
            subject,
            post.id,
            kind === 'reply' ? root.id : null,
            {
              policyRevisionId: policy,
              ...(source === 'target-review'
                ? { visibilityUntil: deadline }
                : {}),
            },
          );
        }
        const management = await f.removalManagement(target, actor);
        const command = f.removalCommand(target, management.targetVersion);
        const original = database.transaction,
          execute = original.bind(database);
        let reached = false,
          expired = false;
        const relation = kind === 'comment' ? 'root_comments' : 'replies';
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
                  `SELECT c.deleted_at IS NOT NULL tombstone,
               (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_events e WHERE e.target_kind=$2 AND e.target_id=c.id) events,
               (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs j WHERE j.resource_kind=$2 AND j.resource_id=c.id AND j.phase='self') cleanup,
               (SELECT count(*)::int FROM whaleu_post_hotness.comment_sources s WHERE s.content_id=c.id AND s.transition='deleted') negative
               FROM whaleu_community.${relation} c WHERE c.id=$1`,
                  [target.id, kind],
                )
              ).rows[0]!;
              assert.deepEqual(tentative, {
                tombstone: true,
                events: 1,
                cleanup: 1,
                negative: 1,
              });
              assert.equal(
                (
                  await tx.query<{ before: boolean }>(
                    'SELECT clock_timestamp()<$1::timestamptz before',
                    [deadline],
                  )
                ).rows[0]!.before,
                true,
              );
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
          `${kind}/${source}: actual tentative deletion must precede the exact deadline`,
        );
        assert.equal(
          expired,
          true,
          `${kind}/${source}: PostgreSQL clock crossed the exact deadline`,
        );
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        assert.equal(
          (
            await f.pool.query(
              `SELECT deleted_at FROM whaleu_community.${relation} WHERE id=$1`,
              [target.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2',
              [actor.accountId, command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_discussion_removal_events WHERE target_kind=$1 AND target_id=$2',
              [kind, target.id],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM whaleu_post_hotness.comment_sources WHERE content_id=$1 AND transition='deleted'",
              [target.id],
            )
          ).rows[0]!.n,
          0,
        );
        t.diagnostic(
          JSON.stringify({
            kind,
            source,
            deadline: deadline.toISOString(),
            tentativeDeletionReached: reached,
            actualDeadlinePassed: expired,
            status: response.status,
            commandRolledBack: true,
          }),
        );
      }
    }
  },
);

test(
  'both kinds reject missing, wrong-region, developer-only, future, expired and revoked authority without creating a command',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    const post = await f.publish(subject);
    const root = await f.discussion(subject, post.id, {
      authorMode: 'anonymous',
    });
    const reply = await f.discussion(subject, post.id, { rootId: root.id });
    for (const authority of [
      'missing',
      'wrong-region',
      'developer',
      'future',
      'expired',
      'revoked',
    ] as const) {
      const actor = await f.actor();
      if (authority === 'wrong-region')
        await f.grant(actor, 'school_admin', f.scope.foreign.regionId);
      if (authority === 'developer') await f.grant(actor, 'developer', null);
      if (authority === 'future' || authority === 'expired')
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at)
           VALUES($1,$2,'school_admin',$3,$2,'synthetic-discussion-invalid-authority',
           CASE WHEN $4='future' THEN clock_timestamp()+interval '1 hour' ELSE clock_timestamp()-interval '2 hours' END,
           CASE WHEN $4='expired' THEN clock_timestamp()-interval '1 hour' ELSE NULL END)`,
            [randomUUID(), actor.accountId, f.scope.home.regionId, authority],
          ),
        );
      if (authority === 'revoked') {
        const grant = await f.grant(actor);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
            [grant],
          ),
        );
      }
      for (const target of [root, reply]) {
        const management = await f.removalManagement(target, admin);
        const command = f.removalCommand(target, management.targetVersion);
        const denied = await f.removalSend(actor, command);
        assert.ok(
          denied.status >= 400,
          `${target.kind}/${authority}: ${JSON.stringify(denied.body)}`,
        );
        const recovery = await f.removalRecovery(
          actor,
          command.clientRequestId,
        );
        profileOk(recovery);
        assert.deepEqual(recovery.body, { state: 'not_recorded' });
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_discussion_removal_events WHERE target_kind=$1 AND target_id=$2',
              [target.kind, target.id],
            )
          ).rows[0]!.n,
          0,
        );
      }
    }
  },
);

test(
  'missing or revoked Review on the selected child and each true ancestor denies both kinds without broadening read scope',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    for (const kind of ['comment', 'reply'] as const) {
      for (const source of ['target', 'root', 'post'] as const) {
        if (kind === 'comment' && source === 'root') continue;
        const post = await f.publish(subject);
        const root = await f.discussion(subject, post.id);
        const target =
          kind === 'comment'
            ? root
            : await f.discussion(subject, post.id, {
                rootId: root.id,
                authorMode: 'anonymous',
              });
        const selected: { kind: string; id: string } =
          source === 'post' ? post : source === 'root' ? root : target;
        const original = await f.removalManagement(target, admin);
        const decision = (
          await f.pool.query<{ decision_id: string }>(
            'SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2',
            [selected.kind, selected.id],
          )
        ).rows[0]!.decision_id;
        const event = randomUUID();
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
             VALUES($1,$2,'allow','missing','accepted','synthetic-review-owner','synthetic-discussion-missing-coverage',clock_timestamp())`,
            [event, decision],
          );
          await tx.query(
            'UPDATE whaleu_community.content_approval_heads SET event_id=$1 WHERE decision_id=$2',
            [event, decision],
          );
        });
        for (const state of ['missing', 'revoked'] as const) {
          if (state === 'revoked')
            await setReviewState(f.pool, decision, 'revoked');
          const management = await request(f.http)
            .get('/v1/community/admin-discussion-removal/management')
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .query({ kind: target.kind, id: target.id });
          assert.ok(
            management.status >= 400,
            `${kind}/${source}/${state}: ${JSON.stringify(management.body)}`,
          );
          const command = f.removalCommand(target, original.targetVersion);
          const denied = await f.removalSend(admin, command);
          assert.ok(denied.status >= 400, JSON.stringify(denied.body));
          const recovery = await f.removalRecovery(
            admin,
            command.clientRequestId,
          );
          profileOk(recovery);
          assert.deepEqual(recovery.body, { state: 'not_recorded' });
          const relation = kind === 'comment' ? 'root_comments' : 'replies';
          assert.equal(
            (
              await f.pool.query(
                `SELECT deleted_at FROM whaleu_community.${relation} WHERE id=$1`,
                [target.id],
              )
            ).rows[0]!.deleted_at,
            null,
          );
        }
      }
    }
    // A stored row without any Review/native registration is never accepted as
    // an ordinary readable target. Do not fabricate or backfill its history.
    const post = await f.publish(subject),
      root = await f.discussion(subject, post.id);
    const missingRoot = randomUUID(),
      missingReply = randomUUID();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Synthetic unreviewed child','anonymous')",
        [missingRoot, post.id, subject.accountId],
      );
      await tx.query(
        "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'Synthetic unreviewed reply','named')",
        [missingReply, post.id, root.id, subject.accountId],
      );
    });
    const targets: AdminDiscussionRemovalTarget[] = [
      { kind: 'comment', id: missingRoot },
      { kind: 'reply', id: missingReply },
    ];
    for (const target of targets) {
      const command = f.removalCommand(target, '0'.repeat(64));
      const response = await f.removalSend(admin, command);
      assert.ok(response.status >= 400, JSON.stringify(response.body));
      const recovered = await f.removalRecovery(admin, command.clientRequestId);
      profileOk(recovered);
      assert.deepEqual(recovered.body, { state: 'not_recorded' });
    }
  },
);

test(
  'ordinary content removal does not invent target-admin protection or a target-author phone requirement',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor();
    await f.grant(admin);
    for (const role of ['school_admin', 'super_admin', 'developer'] as const) {
      const author = await f.actor();
      await f.grant(
        author,
        role,
        role === 'school_admin' ? f.scope.home.regionId : null,
      );
      const post = await f.publish(author);
      const root = await f.discussion(author, post.id, {
        authorMode: 'anonymous',
      });
      const reply = await f.discussion(author, post.id, { rootId: root.id });
      await withCommunityScopeWriter(f.pool, (tx) =>
        appendPhone(f, tx, author, 'unverified'),
      );
      await f.removalApply(reply, admin);
      await f.removalApply(root, admin);
      const notices = await request(f.http)
        .get('/v1/me/system-notices')
        .set('Authorization', `Bearer ${author.accessToken}`);
      profileOk(notices);
      assert.deepEqual(notices.body.items, []);
      const grants = await f.pool.query(
        'SELECT revoked_at FROM whaleu_authorization.role_grants WHERE account_id=$1',
        [author.accountId],
      );
      assert.equal(grants.rows.length, 1);
      assert.equal(grants.rows[0]!.revoked_at, null);
    }
  },
);
