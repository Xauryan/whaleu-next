import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';

test(
  'scoped content retains independent source4 admin cleanup with one zero-reward event per audit',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const owner = f.creator,
      admin = await f.actor();
    await f.grant(admin, 'super_admin');
    const target = await f.createScopedTarget(owner);
    const root = await f.executeCommand(
      owner,
      await f.commandIntent(owner, 'create_comment_scoped', {
        targetId: target.id,
        expectedTargetRevision: target.revision,
        authorMode: 'anonymous',
        body: 'Scoped admin cleanup root',
        assetIds: [],
      }),
    );
    const rootResult = scopedSuccess(root.receipt).result;
    const reply = await f.executeCommand(
      owner,
      await f.commandIntent(owner, 'create_reply_scoped', {
        targetId: target.id,
        expectedTargetRevision: target.revision,
        rootId: rootResult['subjectId'],
        expectedRootRevision: rootResult['revision'],
        replyTo: null,
        authorMode: 'anonymous',
        body: 'Scoped admin cleanup reply',
        assetIds: [],
      }),
    );
    const replyResult = scopedSuccess(reply.receipt).result;
    assert.ok(root.approved);
    assert.ok(reply.approved);
    assert.ok(target.approved);
    for (const approved of [root.approved, reply.approved, target.approved])
      await setRatingReviewState(f.pool, approved.decisionId, 'revoked');
    const before = await f.scopedEffects();
    const requests: string[] = [];
    for (const [kind, id] of [
      ['reply', String(replyResult['replyId'])],
      ['comment', String(rootResult['subjectId'])],
    ] as const) {
      const context = await f.context(admin, kind, id);
      const input = f.command(context);
      const removed = await f.remove(admin, kind, id, input);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(removed.body.outcome, 'applied');
      assert.deepEqual(
        (await f.remove(admin, kind, id, input)).body,
        removed.body,
      );
      requests.push(input.clientRequestId);
    }
    const after = await f.scopedEffects();
    assert.equal(after['events'], before['events'] + 2);
    for (const key of [
      'groups',
      'units',
      'obligations',
      'notices',
      'subscriptionNotices',
      'likeTransitions',
      'subscriptionTransitions',
    ])
      assert.equal(after[key], before[key], key);
    const rows = (
      await f.pool.query(
        `SELECT e.event_kind,e.source_version,e.rule_version,e.expected_experience_units,e.expected_direct_notice_obligations,
       e.request_id,e.actor_account_id,a.request_id audit_request,a.actor_account_id audit_actor,a.subject_kind,
       coalesce(c.request_id,r.request_id) transition_request,coalesce(c.admin_delete_audit_id,r.admin_delete_audit_id) transition_audit,a.id audit_id,coalesce(c.revision,r.revision) transition_revision,a.after_revision
     FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.admin_delete_audits a ON a.id=e.admin_delete_audit_id
     LEFT JOIN whaleu_ratings.comment_transitions c ON c.id=e.comment_transition_id
     LEFT JOIN whaleu_ratings.reply_transitions r ON r.id=e.reply_transition_id
     WHERE e.target_id=$1 AND e.request_id=ANY($2::uuid[]) ORDER BY e.event_kind`,
        [target.id, requests],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.event_kind),
      ['reply_deleted', 'root_deleted'],
    );
    for (const row of rows) {
      assert.equal(row.source_version, 4);
      assert.equal(row.rule_version, 'rating-admin-delete-v1');
      assert.equal(row.expected_experience_units, 0);
      assert.equal(row.expected_direct_notice_obligations, 0);
      assert.equal(row.actor_account_id, admin.accountId);
      assert.equal(row.audit_actor, admin.accountId);
      assert.equal(row.request_id, row.audit_request);
      assert.equal(row.transition_request, null);
      assert.equal(row.transition_audit, row.audit_id);
      assert.equal(row.transition_revision, row.after_revision);
      assert.equal(
        row.subject_kind,
        row.event_kind === 'root_deleted' ? 'comment' : 'reply',
      );
    }
  },
);
