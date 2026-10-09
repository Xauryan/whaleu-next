import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test('admin deletion uses real grants and independent original campus with typed minimal durable receipts', async (t) => {
  const f = await ratingDeletionFixture();
  t.after(() => f.close());
  const author = await f.actor(),
    fixed = await f.actor({ affiliation: 'unverified', identity: false }),
    global = await f.actor(),
    ordinary = await f.actor();
  const fixedGrant = await f.grant(
    fixed,
    'school_admin',
    f.scope.home.regionId,
  );
  const globalGrant = await f.grant(global, 'super_admin');
  const catalog = await f.catalog(author, { count: 4 });
  const known = catalog.targets[0]!,
    unknown = catalog.targets[1]!,
    foreign = catalog.targets[2]!,
    schoolless = catalog.targets[3]!;
  const root = await f.publish(
    author,
    catalog,
    known,
    f.body(catalog, known, { authorMode: 'anonymous' }),
  );
  const reply = await f.publishReply(
    ordinary,
    catalog,
    known,
    root,
    f.replyBody(catalog, known, root, { authorMode: 'anonymous' }),
  );
  const unknownRoot = await f.publish(author, catalog, unknown);
  const foreignRoot = await f.publish(author, catalog, foreign);
  const schoollessRoot = await f.publish(author, catalog, schoolless);
  await f.origin(known.id, 'known_school', f.scope.home.campusId);
  await f.origin(foreign.id, 'known_school', f.scope.foreign.campusId);
  await f.origin(schoolless.id, 'schoolless');
  const beforeScores = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.score_summaries ORDER BY target_id',
    )
  ).rows;
  await t.test(
    'ordinary and wrong fixed scope cannot obtain metadata; absent/schoolless is not a school grant',
    async () => {
      for (const [actor, id] of [
        [ordinary, root.id],
        [fixed, foreignRoot.id],
        [fixed, unknownRoot.id],
        [fixed, schoollessRoot.id],
      ] as const) {
        const denied = await f.auth(
          request(f.http).get(`${f.path('comment', id)}/deletion-context`),
          actor,
        );
        assert.notEqual(denied.status, 200, JSON.stringify(denied.body));
        assert.ok(!JSON.stringify(denied.body).includes(author.accountId));
      }
    },
  );
  await t.test(
    'admin root deletion has separate cause/real actor, zero rewards, and keeps descendants independent',
    async () => {
      // The author's current selection moves outside this administrator's region.
      // The immutable target origin remains the sole school-scope input.
      await f.certify(author.accountId, { campusId: f.scope.foreign.campusId });
      const context = await f.context(fixed, 'comment', root.id);
      assert.deepEqual(
        Object.keys(context).sort(),
        [
          'subjectKind',
          'targetId',
          'rootId',
          'subjectId',
          'regionId',
          'targetRevision',
          'rootRevision',
          'revision',
          'deleted',
          'contextRevision',
        ].sort(),
      );
      const input = f.command(context);
      for (const [key, value] of Object.entries({
        accountId: author.accountId,
        regionId: f.scope.home.regionId,
        role: 'super_admin',
        body: 'forbidden',
        occurredAt: new Date().toISOString(),
      })) {
        const denied = await f.remove(fixed, 'comment', root.id, {
          ...input,
          [key]: value,
        });
        assert.equal(denied.status, 400, JSON.stringify(denied.body));
      }
      const applied = await f.remove(fixed, 'comment', root.id, input);
      assert.equal(
        applied.body.outcome,
        'applied',
        JSON.stringify(applied.body),
      );
      assert.equal(applied.body.operation, 'admin_delete_comment');
      assert.deepEqual(
        Object.keys(applied.body).sort(),
        [
          'requestId',
          'operation',
          'outcome',
          'targetId',
          'rootId',
          'subjectId',
          'revision',
          'occurredAt',
        ].sort(),
      );
      root.revision = applied.body.revision;
      const row = (
        await f.pool.query(
          'SELECT account_id,delete_request_id,admin_delete_audit_id FROM whaleu_ratings.comments WHERE id=$1',
          [root.id],
        )
      ).rows[0]!;
      assert.equal(row.account_id, author.accountId);
      assert.equal(row.delete_request_id, null);
      assert.ok(row.admin_delete_audit_id);
      const audit = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.admin_delete_audits WHERE id=$1',
          [row.admin_delete_audit_id],
        )
      ).rows[0]!;
      assert.equal(audit.actor_account_id, fixed.accountId);
      assert.equal(audit.author_account_id, author.accountId);
      assert.equal(audit.grant_id, fixedGrant);
      const effect = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.effect_events WHERE admin_delete_audit_id=$1',
          [audit.id],
        )
      ).rows;
      assert.equal(effect.length, 1);
      assert.equal(effect[0]!.source_version, 4);
      assert.equal(effect[0]!.actor_account_id, fixed.accountId);
      assert.equal(effect[0]!.expected_experience_units, 0);
      assert.equal(effect[0]!.expected_direct_notice_obligations, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
            [reply.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
      assert.deepEqual(
        (await f.remove(fixed, 'comment', root.id, input)).body,
        applied.body,
      );
      const conflict = await f.remove(fixed, 'comment', root.id, {
        ...input,
        expectedRevision: randomUUID(),
      });
      assert.equal(
        conflict.body.error?.code,
        'REQUEST_CONFLICT',
        JSON.stringify(conflict.body),
      );
      const ownerNoop = await f.deleteRoot(author, catalog, known, root);
      assert.equal(ownerNoop.outcome, 'noop', JSON.stringify(ownerNoop));
      assert.equal(ownerNoop.occurredAt, applied.body.occurredAt);
      const adminNoop = await f.remove(
        global,
        'comment',
        root.id,
        f.command(await f.context(global, 'comment', root.id)),
      );
      assert.equal(
        adminNoop.body.outcome,
        'noop',
        JSON.stringify(adminNoop.body),
      );
      assert.equal(adminNoop.body.occurredAt, applied.body.occurredAt);
      assert.equal(
        (
          await f.pool.query<{ valid: boolean }>(
            'SELECT authorized_at>occurred_at valid FROM whaleu_ratings.admin_delete_audits WHERE actor_account_id=$1 AND request_id=$2',
            [global.accountId, adminNoop.body.requestId],
          )
        ).rows[0]!.valid,
        true,
      );

      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind='root_deleted'",
            [root.id],
          )
        ).rows[0]!.n,
        1,
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
          [fixedGrant, fixed.accountId],
        ),
      );
      const receipt = await f.auth(
        request(f.http).get(
          `/v1/ratings/admin/requests/${input.clientRequestId}`,
        ),
        fixed,
      );
      assert.deepEqual(receipt.body, applied.body);
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/admin/requests/${input.clientRequestId}`,
            ),
            author,
          )
        ).status,
        404,
      );
    },
  );
  await t.test(
    'global grants authorize unknown and explicit-schoolless origins without fabricated campus',
    async () => {
      for (const subject of [unknownRoot, schoollessRoot]) {
        const result = await f.remove(
          global,
          'comment',
          subject.id,
          f.command(await f.context(global, 'comment', subject.id)),
        );
        assert.equal(
          result.body.outcome,
          'applied',
          JSON.stringify(result.body),
        );
        const audit = (
          await f.pool.query(
            'SELECT grant_id,origin_state,origin_campus_id FROM whaleu_ratings.admin_delete_audits WHERE actor_account_id=$1 AND request_id=$2',
            [global.accountId, result.body.requestId],
          )
        ).rows[0]!;
        assert.equal(audit.grant_id, globalGrant);
        assert.equal(
          audit.origin_state,
          subject.id === unknownRoot.id ? 'absent' : 'schoolless',
        );
        assert.equal(audit.origin_campus_id, null);
      }
    },
  );
  await t.test(
    'reply admin deletion beneath tombstoned root advances same reply head pipeline',
    async () => {
      const before = (
        await f.pool.query(
          'SELECT sequence::text FROM whaleu_ratings.reply_heads WHERE root_id=$1',
          [root.id],
        )
      ).rows[0]!.sequence;
      const result = await f.remove(
        global,
        'reply',
        reply.id,
        f.command(await f.context(global, 'reply', reply.id)),
      );
      assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
      const after = (
        await f.pool.query(
          'SELECT sequence::text FROM whaleu_ratings.reply_heads WHERE root_id=$1',
          [root.id],
        )
      ).rows[0]!.sequence;
      assert.ok(BigInt(after) > BigInt(before));
      reply.revision = result.body.revision;
      const noop = await f.deleteReply(ordinary, catalog, known, root, reply);
      assert.equal(noop.outcome, 'noop', JSON.stringify(noop));
      assert.equal(noop.occurredAt, result.body.occurredAt);
    },
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.score_summaries ORDER BY target_id',
      )
    ).rows,
    beforeScores,
  );
});
