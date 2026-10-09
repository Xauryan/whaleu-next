import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ratingIso } from '../../src/ratings/repository.js';

test('administrator deletion SQL rejects forged causes, receipts and effects without rewriting history', async (t) => {
  const f = await ratingDeletionFixture();
  t.after(() => f.close());
  const author = await f.actor(),
    admin = await f.actor(),
    other = await f.actor();
  const grantId = await f.grant(admin, 'super_admin');
  const catalog = await f.catalog(author, { count: 2 });
  const target = catalog.targets[0]!,
    originTarget = catalog.targets[1]!;
  const root = await f.publish(author, catalog, target);
  const second = await f.publish(other, catalog, target);
  const reply = await f.publishReply(other, catalog, target, root);
  const transaction = <T>(work: (tx: PoolClient) => Promise<T>) =>
    inTransaction(
      f.pool,
      async (tx) => {
        await lockSafetyPolicy(tx);
        return work(tx);
      },
      { isolationLevel: 'read committed' },
    );
  const snapshot = async () =>
    (
      await f.pool.query(`SELECT
    (SELECT count(*)::int FROM whaleu_ratings.admin_delete_audits) audits,
    (SELECT count(*)::int FROM whaleu_ratings.comment_transitions) roots,
    (SELECT count(*)::int FROM whaleu_ratings.reply_transitions) replies,
    (SELECT count(*)::int FROM whaleu_ratings.effect_events) effects,
    (SELECT count(*)::int FROM whaleu_ratings.requests) requests`)
    ).rows[0];
  const fresh = async (
    tx: PoolClient,
    patch: Record<string, unknown> = {},
    suppliedTime: string | null = null,
  ) => {
    const id = randomUUID(),
      key = randomUUID(),
      revision = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'admin_delete_comment',$3)",
      [admin.accountId, key, 'a'.repeat(64)],
    );
    const fields = {
      id,
      actor_account_id: admin.accountId,
      session_id: admin.sessionId,
      request_id: key,
      intent_hash: 'a'.repeat(64),
      subject_kind: 'comment',
      target_id: target.id,
      root_id: root.id,
      subject_id: root.id,
      author_account_id: author.accountId,
      target_revision: target.revision,
      root_revision: root.revision,
      before_revision: root.revision,
      after_revision: revision,
      scope_kind: 'global',
      grant_id: grantId,
      grant_fingerprint: 'b'.repeat(64),
      origin_state: 'absent',
      origin_fingerprint: 'c'.repeat(64),
      context_revision: 'synthetic-sql-context',
      outcome: 'applied',
      ...patch,
    };
    const names = Object.keys(fields);
    const result = (
      await tx.query<{ occurred_at: string }>(
        `INSERT INTO whaleu_ratings.admin_delete_audits(${names.join(',')},occurred_at)
      SELECT ${names.map((name) => `a.${name}`).join(',')},coalesce($2::timestamptz,clock_timestamp())
      FROM jsonb_populate_record(NULL::whaleu_ratings.admin_delete_audits,$1::jsonb) a
      RETURNING ${ratingIso('occurred_at')} occurred_at`,
        [JSON.stringify(fields), suppliedTime],
      )
    ).rows[0]!;
    return { id, key, revision, occurredAt: result.occurred_at };
  };
  const receipt = async (
    tx: PoolClient,
    audit: Awaited<ReturnType<typeof fresh>>,
    patch: Record<string, unknown> = {},
  ) => {
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [
        admin.accountId,
        audit.key,
        JSON.stringify({
          requestId: audit.key,
          operation: 'admin_delete_comment',
          outcome: 'applied',
          targetId: target.id,
          rootId: root.id,
          subjectId: root.id,
          revision: audit.revision,
          occurredAt: audit.occurredAt,
          ...patch,
        }),
      ],
    );
  };
  const apply = (
    tx: PoolClient,
    audit: Awaited<ReturnType<typeof fresh>>,
    id = root.id,
  ) =>
    tx.query(
      'UPDATE whaleu_ratings.comments SET revision=$2,deleted_at=$3::timestamptz,admin_delete_audit_id=$4 WHERE id=$1',
      [id, audit.revision, audit.occurredAt, audit.id],
    );
  const rejectsUnchanged = async (
    work: (tx: PoolClient) => Promise<unknown>,
    pattern?: RegExp,
  ) => {
    const before = await snapshot();
    if (pattern) await assert.rejects(transaction(work), pattern);
    else await assert.rejects(transaction(work));
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await f.pool.query(
          'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
          [root.id],
        )
      ).rows[0]!.deleted_at,
      null,
    );
  };
  await t.test(
    'fixed origin topology validator accepts exact structure and rejects unrelated conflicts',
    async () => {
      const valid = structuredClone(f.scope.topology);
      const check = async (document: unknown) =>
        (
          await f.pool.query<{ valid: boolean }>(
            'SELECT whaleu_ratings.origin_topology_shape($1::jsonb) valid',
            [JSON.stringify(document)],
          )
        ).rows[0]!.valid;
      assert.equal(await check(valid), true);
      const duplicateGroup = structuredClone(valid);
      duplicateGroup.groups.push(duplicateGroup.groups[0]!);
      const duplicateRegion = structuredClone(valid);
      duplicateRegion.regions.push(duplicateRegion.regions[0]!);
      const duplicateAssignment = structuredClone(valid);
      duplicateAssignment.assignments.push(duplicateAssignment.assignments[0]!);
      const missingGroup = structuredClone(valid);
      missingGroup.regions[0]!.groupId = randomUUID();
      const wrongInstitution = structuredClone(valid);
      wrongInstitution.assignments[0]!.institutionId = randomUUID();
      for (const invalid of [
        duplicateGroup,
        duplicateRegion,
        duplicateAssignment,
        missingGroup,
        wrongInstitution,
        { ...valid, version: 2 },
        { ...valid, extra: true },
        { ...valid, assignments: null },
      ])
        assert.equal(await check(invalid), false);
    },
  );
  await t.test(
    'origin sources cannot mutate, disappear, rewind or transplant a source between targets',
    async () => {
      const first = await f.origin(
        originTarget.id,
        'known_school',
        f.scope.home.campusId,
      );
      const secondOrigin = await f.origin(originTarget.id, 'schoolless');
      for (const statement of [
        "UPDATE whaleu_ratings.target_origin_sources SET source_reference='forged' WHERE id=$1",
        'DELETE FROM whaleu_ratings.target_origin_sources WHERE id=$1',
        'TRUNCATE whaleu_ratings.target_origin_sources CASCADE',
        'DELETE FROM whaleu_ratings.target_origin_heads WHERE target_id=$1',
        'TRUNCATE whaleu_ratings.target_origin_heads CASCADE',
      ])
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              statement,
              statement.includes('$1')
                ? [statement.includes('heads') ? originTarget.id : first.id]
                : [],
            ),
          ),
        );
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_ratings.target_origin_heads SET source_id=$2,revision=$3 WHERE target_id=$1',
            [originTarget.id, first.id, first.revision],
          ),
        ),
        /cannot rewind/,
      );
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'INSERT INTO whaleu_ratings.target_origin_heads(target_id,source_id,revision) VALUES($1,$2,$3)',
            [target.id, secondOrigin.id, secondOrigin.revision],
          ),
        ),
        /source mismatch/,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT source_id,revision FROM whaleu_ratings.target_origin_heads WHERE target_id=$1',
            [originTarget.id],
          )
        ).rows[0],
        { source_id: secondOrigin.id, revision: secondOrigin.revision },
      );
    },
  );
  await t.test(
    'audit binds the real actor/session, author, immutable chain, and before revision',
    async () => {
      for (const patch of [
        { session_id: other.sessionId },
        { actor_account_id: other.accountId },
        { author_account_id: other.accountId },
        { subject_kind: 'reply' },
        { subject_id: reply.id },
        { target_revision: randomUUID() },
        { root_revision: randomUUID() },
        { before_revision: randomUUID() },
        { intent_hash: 'd'.repeat(64) },
        { grant_id: randomUUID() },
        {
          origin_state: 'known_school',
          origin_campus_id: f.scope.home.campusId,
        },
      ])
        await rejectsUnchanged(async (tx) => {
          await fresh(tx, patch);
        });
    },
  );
  await t.test(
    'missing or spoofed receipt and missing actual transition cannot commit an audit',
    async () => {
      await rejectsUnchanged(async (tx) => {
        await fresh(tx);
      });
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx);
        await receipt(tx, audit);
      }, /incomplete/);
      for (const patch of [
        { author: author.accountId },
        { revision: randomUUID() },
        { outcome: 'noop' },
        { occurredAt: '2026-01-01T00:00:00.000001Z' },
      ])
        await rejectsUnchanged(async (tx) => {
          const audit = await fresh(tx);
          await apply(tx, audit);
          await receipt(tx, audit, patch);
        });
    },
  );
  await t.test(
    'no cause, both causes, transplanted audit, resurrection and immutable content changes fail',
    async () => {
      await rejectsUnchanged((tx) =>
        tx.query(
          'UPDATE whaleu_ratings.comments SET deleted_at=clock_timestamp(),revision=$2 WHERE id=$1',
          [root.id, randomUUID()],
        ),
      );
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx),
          ownerKey = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'delete_comment',$3)",
          [author.accountId, ownerKey, 'e'.repeat(64)],
        );
        await tx.query(
          'UPDATE whaleu_ratings.comments SET deleted_at=$2::timestamptz,revision=$3,admin_delete_audit_id=$4,delete_request_id=$5 WHERE id=$1',
          [root.id, audit.occurredAt, audit.revision, audit.id, ownerKey],
        );
      }, /Invalid comment deletion/);
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx);
        await apply(tx, audit, second.id);
      }, /cause mismatch/);
      for (const field of ['body', 'account_id', 'target_id'])
        await rejectsUnchanged(async (tx) => {
          const audit = await fresh(tx);
          await tx.query(
            `UPDATE whaleu_ratings.comments SET ${field}=$5,deleted_at=$2::timestamptz,revision=$3,admin_delete_audit_id=$4 WHERE id=$1`,
            [
              root.id,
              audit.occurredAt,
              audit.revision,
              audit.id,
              field === 'body'
                ? 'forged content'
                : field === 'account_id'
                  ? other.accountId
                  : originTarget.id,
            ],
          );
        }, /Invalid comment deletion/);
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx);
        await apply(tx, audit);
        await receipt(tx, audit);
        await tx.query(
          'UPDATE whaleu_ratings.comments SET deleted_at=NULL,admin_delete_audit_id=NULL,revision=$2 WHERE id=$1',
          [root.id, randomUUID()],
        );
      }, /Invalid comment deletion/);
    },
  );
  await t.test(
    'applied deletion time is minted by SQL and cannot be backdated',
    async () => {
      const created = (
        await f.pool.query<{ created_at: string }>(
          'SELECT created_at::text FROM whaleu_ratings.comments WHERE id=$1',
          [root.id],
        )
      ).rows[0]!.created_at;
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx, {}, created);
        const proof = (
          await tx.query<{ valid: boolean }>(
            'SELECT occurred_at=authorized_at AND occurred_at>$2::timestamptz valid FROM whaleu_ratings.admin_delete_audits WHERE id=$1',
            [audit.id, created],
          )
        ).rows[0]!;
        assert.equal(
          proof.valid,
          true,
          'Caller time must not become effective deletion time',
        );
        await apply(tx, audit);
        await receipt(tx, audit);
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        const causalTime = (
          await tx.query<{ valid: boolean }>(
            `SELECT a.occurred_at=a.authorized_at
        AND c.deleted_at=a.occurred_at AND tr.occurred_at=a.occurred_at
        AND e.occurred_at=a.occurred_at AND (q.receipt->>'occurredAt')::timestamptz=a.occurred_at valid
        FROM whaleu_ratings.admin_delete_audits a
        JOIN whaleu_ratings.comments c ON c.admin_delete_audit_id=a.id
        JOIN whaleu_ratings.comment_transitions tr ON tr.admin_delete_audit_id=a.id
        JOIN whaleu_ratings.effect_events e ON e.admin_delete_audit_id=a.id
        JOIN whaleu_ratings.requests q ON q.account_id=a.actor_account_id AND q.request_id=a.request_id
        WHERE a.id=$1`,
            [audit.id],
          )
        ).rows[0]!;
        assert.equal(
          causalTime.valid,
          true,
          'All causal times must use the one database instant',
        );
        throw new Error('synthetic verified SQL time rollback');
      }, /synthetic verified SQL time rollback/);
    },
  );
  await t.test(
    'valid raw typed cause has one v4 event and cannot mint rewards or mixed/creation events',
    async () => {
      await rejectsUnchanged(async (tx) => {
        const audit = await fresh(tx);
        await apply(tx, audit);
        await receipt(tx, audit);
        const event = (
          await tx.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.effect_events WHERE admin_delete_audit_id=$1',
            [audit.id],
          )
        ).rows[0]!;
        assert.equal(
          (
            await tx.query(
              'SELECT count(*)::int n FROM whaleu_ratings.expected_reward_units($1)',
              [event.id],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await tx.query(
              'SELECT count(*)::int n FROM whaleu_ratings.expected_direct_notices($1)',
              [event.id],
            )
          ).rows[0]!.n,
          0,
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.reward_groups(id,event_id,source_version,event_kind,target_id,root_id,actor_account_id,root_author_id,occurred_at,enrollment_order,expected_unit_count)
        SELECT gen_random_uuid(),id,4,'root_created',target_id,root_id,actor_account_id,root_author_id,occurred_at,1,1 FROM whaleu_ratings.effect_events WHERE id=$1`,
          [event.id],
        );
      });
      for (const patch of [
        { event_kind: 'root_created' },
        { source_version: 1 },
        { like_transition_id: randomUUID() },
        { subscription_transition_id: randomUUID() },
        { actor_account_id: author.accountId },
        { expected_experience_units: 1 },
        { expected_direct_notice_obligations: 1 },
      ])
        await rejectsUnchanged(async (tx) => {
          const audit = await fresh(tx);
          await apply(tx, audit);
          await receipt(tx, audit);
          // Direct writes cannot impersonate the automatic transition-owned event.
          await tx.query(
            `INSERT INTO whaleu_ratings.effect_events OVERRIDING SYSTEM VALUE
        SELECT candidate.* FROM whaleu_ratings.effect_events existing
        CROSS JOIN LATERAL jsonb_populate_record(NULL::whaleu_ratings.effect_events,
          to_jsonb(existing)||$2::jsonb) candidate WHERE existing.admin_delete_audit_id=$1`,
            [audit.id, JSON.stringify({ ...patch, id: randomUUID() })],
          );
        });
    },
  );
});
