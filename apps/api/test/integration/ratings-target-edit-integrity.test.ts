import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { ratingEditFixture } from '../support/rating-edit-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { ratingTargetEditIntentHash } from '../../src/ratings/management/target-edit/requests.js';

const ownerTables = async (pool: Pool) =>
  (
    await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND
   (table_schema='whaleu_ratings' OR (table_schema='whaleu_community' AND table_name LIKE 'rating_%'))
   ORDER BY table_schema,table_name`,
    )
  ).rows;
const snapshot = async (
  pool: Pool,
  tables: Awaited<ReturnType<typeof ownerTables>>,
) => {
  const result: Record<string, unknown> = {};
  for (const { table_schema: schema, table_name: table } of tables) {
    assert.match(schema, /^[a-z_]+$/);
    assert.match(table, /^[a-z_]+$/);
    result[`${schema}.${table}`] = (
      await pool.query(
        `SELECT to_jsonb(r) row FROM ${schema}.${table} r ORDER BY to_jsonb(r)::text`,
      )
    ).rows;
  }
  return result;
};

test('M2B real 0056 to 0057 upgrade preserves original definitions, rotated lifecycle history, revoked Review and irreversible owner tombstones', async (t) => {
  const f = await ratingDiscussionFixture(56);
  t.after(() => f.close());
  const owner = await f.actor();
  const catalog = await f.catalog(owner, { count: 3 });
  const [rotated, revoked, deleted] = catalog.targets;
  assert.ok(rotated && revoked && deleted);
  const originalRevision = rotated.revision;
  for (const active of [false, true]) {
    rotated.revision = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_ratings.targets SET active=$2,revision=$3 WHERE id=$1',
        [rotated.id, active, rotated.revision],
      ),
    );
  }
  await setRatingReviewState(f.pool, revoked.approval.decisionId, 'revoked');
  const deletion = await f
    .auth(
      request(f.http).post(
        `/v1/ratings/management/owner-deletion/targets/${deleted.id}`,
      ),
      owner,
    )
    .send({
      clientRequestId: randomUUID(),
      expectedTargetRevision: deleted.revision,
    });
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  assert.equal(deletion.body.outcome, 'applied');
  const oldTables = await ownerTables(f.pool);
  const before = await snapshot(f.pool, oldTables);
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  );
  await runMigrations(
    f.pool,
    migrations.filter((m) => Number(m.name.slice(0, 4)) <= 57),
    { mode: 'up' },
  );
  assert.deepEqual(
    await snapshot(f.pool, oldTables),
    before,
    'Upgrade must not rewrite any old authority/history row or epoch',
  );
  const anchored = (
    await f.pool.query<{
      definition_revision: string;
      applied_target_revision: string;
      revision: string;
      exact: boolean;
    }>(
      `SELECT v.definition_revision,v.applied_target_revision,t.revision,
     (v.name,v.description,v.envelope,v.publication_transaction,v.published_at)=(t.name,t.description,t.envelope,t.creation_transaction,t.created_at) exact
     FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_versions v ON v.target_id=t.id AND v.content_version=1 WHERE t.id=$1`,
      [rotated.id],
    )
  ).rows[0]!;
  assert.equal(anchored.definition_revision, originalRevision);
  assert.equal(anchored.applied_target_revision, originalRevision);
  assert.equal(anchored.revision, rotated.revision);
  assert.equal(anchored.exact, true);
  assert.equal(
    (
      await f.pool.query<{ n: number }>(
        `SELECT count(*)::integer n FROM whaleu_ratings.target_state_revisions s
     LEFT JOIN whaleu_ratings.target_definition_lifecycles l ON (l.target_id,l.target_revision)=(s.target_id,s.revision)
     JOIN whaleu_ratings.targets t ON t.id=s.target_id
     WHERE l.target_id IS NULL OR l.content_version<>1 OR l.definition_revision::text<>t.envelope->>'targetRevision'`,
      )
    ).rows[0]!.n,
    0,
  );
  assert.equal(
    (
      await f.pool.query<{ allowed: boolean }>(
        `SELECT whaleu_community.rating_target_definition_current(target_id,content_version,definition_revision,applied_target_revision,envelope) allowed
     FROM whaleu_ratings.target_definition_versions WHERE target_id=$1`,
        [revoked.id],
      )
    ).rows[0]!.allowed,
    false,
    'Backfill must not wash a revoked v1 decision into current allow',
  );
  assert.equal(
    (
      await f.pool.query<{ retained: boolean }>(
        `SELECT NOT t.active AND d.after_revision=t.revision AND l.content_version=1 retained FROM whaleu_ratings.targets t
     JOIN whaleu_ratings.target_owner_tombstones d ON d.target_id=t.id
     JOIN whaleu_ratings.target_definition_lifecycles l ON (l.target_id,l.target_revision)=(t.id,t.revision) WHERE t.id=$1`,
        [deleted.id],
      )
    ).rows[0]!.retained,
    true,
  );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_ratings.targets SET active=true,revision=gen_random_uuid() WHERE id=$1',
        [deleted.id],
      ),
    ),
  );
  // A normal fresh target INSERT after upgrading still produces all three v1
  // facts through normal triggers and retains its legacy v1 Review binding.
  const fresh = (await f.catalog(owner)).targets[0]!;
  assert.equal(
    (
      await f.pool.query<{ exact: boolean }>(
        `SELECT v.content_version=1 AND v.definition_revision=t.revision AND h.content_version=1
      AND l.content_version=1 AND b.envelope=v.envelope exact
     FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_versions v ON v.target_id=t.id
     JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
     JOIN whaleu_ratings.target_definition_lifecycles l ON (l.target_id,l.target_revision)=(t.id,t.revision)
     JOIN whaleu_community.rating_approval_bindings b ON b.kind='target' AND b.subject_id=t.id WHERE t.id=$1`,
        [fresh.id],
      )
    ).rows[0]!.exact,
    true,
  );
});

test('M2B raw SQL requires the entire exact edit cause in both directions; successful helpers are proved before adversarial variants', async (t) => {
  const f = await ratingEditFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    outsider = await f.actor();
  const catalog = await f.catalog(owner, { count: 2 });
  const target = catalog.targets[0]!,
    other = catalog.targets[1]!;
  const context = await f.editContext(owner, target.id);
  const intent = f.editIntent(context, {
    name: 'Exactly reviewed revised target',
    description: 'Version two, no new score baseline.',
  });
  const prepared = await f.prepareEdit(owner, intent);
  assert.match(prepared.contextRevision, /^[A-Za-z0-9_-]{43}$/);
  const approved = await f.approveEdit(owner, intent);
  const hash = ratingTargetEditIntentHash(intent);
  const observed = await ownerTables(f.pool);
  const transaction = <T>(work: (tx: PoolClient) => Promise<T>) =>
    inTransaction(
      f.pool,
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        await tx.query(
          'LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE',
        );
        return work(tx);
      },
      { isolationLevel: 'read committed' },
    );
  const rejectsUnchanged = async (
    work: (tx: PoolClient) => Promise<unknown>,
  ) => {
    const before = await snapshot(f.pool, observed);
    await assert.rejects(transaction(work));
    assert.deepEqual(
      await snapshot(f.pool, observed),
      before,
      'Every failed chain must roll back all facts and public epochs',
    );
  };
  const begin = async (tx: PoolClient) => {
    assert.equal(
      (
        await tx.query<{ hash: string }>(
          'SELECT whaleu_ratings.target_edit_intent_hash($1::jsonb) hash',
          [JSON.stringify(intent)],
        )
      ).rows[0]!.hash,
      hash,
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'edit_target',$3)",
      [owner.accountId, intent.clientRequestId, hash],
    );
  };
  const transition = async (
    tx: PoolClient,
    patch: Record<string, unknown> = {},
  ) => {
    const fields: Record<string, unknown> = {
      id: randomUUID(),
      actor_account_id: owner.accountId,
      request_id: intent.clientRequestId,
      intent_hash: hash,
      intent,
      target_id: target.id,
      before_revision: context.revision,
      after_revision: prepared.revision,
      before_definition_revision: context.definitionRevision,
      after_definition_revision: prepared.definitionRevision,
      before_content_version: context.contentVersion,
      after_content_version: prepared.contentVersion,
      context_revision: prepared.contextRevision,
      ...patch,
    };
    const columns = Object.keys(fields);
    return (
      await tx.query<{ id: string; occurred_at: string }>(
        `INSERT INTO whaleu_ratings.target_edit_transitions(${columns.join(',')}) SELECT ${columns.map((key) => `a.${key}`).join(',')}
       FROM jsonb_populate_record(NULL::whaleu_ratings.target_edit_transitions,$1::jsonb) a RETURNING id,${ratingIso('occurred_at')} occurred_at`,
        [JSON.stringify(fields)],
      )
    ).rows[0]!;
  };
  const version = (tx: PoolClient, patch: Record<string, unknown> = {}) =>
    tx.query(
      `INSERT INTO whaleu_ratings.target_definition_versions SELECT a.* FROM jsonb_populate_record(NULL::whaleu_ratings.target_definition_versions,
     (SELECT jsonb_build_object('target_id',e.target_id,'content_version',e.after_content_version,'definition_revision',e.after_definition_revision,
      'applied_target_revision',e.after_revision,'name',e.intent->>'name','description',e.intent->>'description','envelope',p.envelope,
      'publication_transaction',e.mutation_transaction::text,'published_at',e.occurred_at) FROM whaleu_ratings.target_edit_transitions e
      JOIN whaleu_ratings.target_edit_preparations p ON (p.account_id,p.request_id)=(e.actor_account_id,e.request_id)
      WHERE e.actor_account_id=$1 AND e.request_id=$2)||$3::jsonb) a`,
      [owner.accountId, intent.clientRequestId, JSON.stringify(patch)],
    );
  const state = (tx: PoolClient) =>
    tx.query(
      'UPDATE whaleu_ratings.targets SET active=true,revision=$2 WHERE id=$1',
      [target.id, prepared.revision],
    );
  const head = (tx: PoolClient) =>
    tx.query(
      'UPDATE whaleu_ratings.target_definition_heads SET content_version=$2,definition_revision=$3 WHERE target_id=$1',
      [target.id, prepared.contentVersion, prepared.definitionRevision],
    );
  const binding = (tx: PoolClient, patch: Record<string, unknown> = {}) =>
    tx.query(
      `INSERT INTO whaleu_community.rating_target_definition_bindings(target_id,content_version,definition_revision,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
     SELECT a.target_id,a.content_version,a.definition_revision,a.decision_id,a.account_id,a.operation,a.envelope_version,a.digest,a.envelope,a.scope
     FROM jsonb_populate_record(NULL::whaleu_community.rating_target_definition_bindings,$1::jsonb) a`,
      [
        JSON.stringify({
          target_id: target.id,
          content_version: prepared.contentVersion,
          definition_revision: prepared.definitionRevision,
          decision_id: approved.decisionId,
          account_id: owner.accountId,
          operation: 'edit_rating_target',
          envelope_version: 3,
          digest: approved.digest,
          envelope: approved.envelope,
          scope: approved.envelope.scope,
          ...patch,
        }),
      ],
    );
  const receipt = (
    tx: PoolClient,
    occurredAt: string,
    patch: Record<string, unknown> = {},
  ) =>
    tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [
        owner.accountId,
        intent.clientRequestId,
        JSON.stringify({
          requestId: intent.clientRequestId,
          operation: 'edit_target',
          outcome: 'applied',
          targetId: target.id,
          revision: prepared.revision,
          definitionRevision: prepared.definitionRevision,
          contentVersion: prepared.contentVersion,
          occurredAt,
          ...patch,
        }),
      ],
    );
  const full = async (tx: PoolClient) => {
    await begin(tx);
    const e = await transition(tx, {
      occurred_at: '2020-01-01T00:00:00.000001Z',
    });
    assert.match(
      e.occurred_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    assert.notEqual(e.occurred_at, '2020-01-01T00:00:00.000001Z');
    await version(tx);
    await state(tx);
    await head(tx);
    await binding(tx);
    await receipt(tx, e.occurred_at);
    return e;
  };
  await t.test(
    'complete raw cause passes forced deferred verification and a forced rollback restores every row',
    async () => {
      const before = await snapshot(f.pool, observed),
        rollback = new Error('Verified full edit cause; force rollback');
      await assert.rejects(
        transaction(async (tx) => {
          const e = await full(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.equal(
            (
              await tx.query<{ exact: boolean }>(
                `SELECT e.occurred_at=v.published_at AND v.envelope=b.envelope AND t.revision=e.after_revision
          AND l.definition_revision=v.definition_revision AND h.content_version=v.content_version
          AND s.mutation_transaction=e.mutation_transaction AND b.publication_transaction=e.mutation_transaction exact
         FROM whaleu_ratings.target_edit_transitions e JOIN whaleu_ratings.targets t ON t.id=e.target_id
         JOIN whaleu_ratings.target_definition_versions v ON v.target_id=t.id AND v.content_version=e.after_content_version
         JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
         JOIN whaleu_ratings.target_state_revisions s ON (s.target_id,s.revision)=(t.id,t.revision)
         JOIN whaleu_ratings.target_definition_lifecycles l ON (l.target_id,l.target_revision)=(t.id,t.revision)
         JOIN whaleu_community.rating_target_definition_bindings b ON (b.target_id,b.content_version,b.definition_revision)=(v.target_id,v.content_version,v.definition_revision)
         WHERE e.id=$1`,
                [e.id],
              )
            ).rows[0]!.exact,
            true,
          );
          throw rollback;
        }),
        (error: unknown) => error === rollback,
      );
      assert.deepEqual(await snapshot(f.pool, observed), before);
    },
  );
  await t.test(
    'each independent endpoint and every incomplete forward chain is rejected at commit',
    async () => {
      await rejectsUnchanged(begin);
      await rejectsUnchanged(version);
      await rejectsUnchanged(binding);
      await rejectsUnchanged(head);
      await rejectsUnchanged(state);
      await rejectsUnchanged((tx) =>
        tx.query(
          'INSERT INTO whaleu_ratings.target_state_revisions(target_id,revision,active) VALUES($1,$2,true)',
          [target.id, prepared.revision],
        ),
      );
      await rejectsUnchanged((tx) =>
        tx.query(
          'INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES($1,$2,$3,$4)',
          [
            target.id,
            prepared.revision,
            prepared.contentVersion,
            prepared.definitionRevision,
          ],
        ),
      );
      for (const missing of [
        'after_transition',
        'version',
        'state',
        'head',
        'binding',
        'receipt',
      ]) {
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          const e = await transition(tx);
          if (missing === 'after_transition') return;
          if (missing !== 'version') await version(tx);
          if (missing !== 'state') await state(tx);
          if (missing !== 'head') await head(tx);
          if (missing !== 'binding') await binding(tx);
          if (missing !== 'receipt') await receipt(tx, e.occurred_at);
        });
      }
      for (const outcome of ['applied', 'noop', 'rejected'])
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              owner.accountId,
              intent.clientRequestId,
              JSON.stringify(
                outcome === 'rejected'
                  ? {
                      requestId: intent.clientRequestId,
                      operation: 'edit_target',
                      outcome,
                      code: 'RATING_EDIT_CANCELLED',
                    }
                  : {
                      requestId: intent.clientRequestId,
                      operation: 'edit_target',
                      outcome,
                      targetId: target.id,
                      revision: prepared.revision,
                      definitionRevision: prepared.definitionRevision,
                      contentVersion: prepared.contentVersion,
                      occurredAt: new Date().toISOString(),
                    },
              ),
            ],
          );
        });
    },
  );
  await t.test(
    'transition and immutable version cannot cross actor, lifecycle, definition, text, catalog, scope or version boundaries',
    async () => {
      for (const patch of [
        { actor_account_id: outsider.accountId },
        { target_id: other.id },
        { before_revision: randomUUID() },
        { after_revision: context.revision },
        { before_definition_revision: randomUUID() },
        { after_definition_revision: context.definitionRevision },
        { before_content_version: 2 },
        { after_content_version: 3 },
        { context_revision: 'A'.repeat(43) },
        { mutation_transaction: '0' },
        { intent_hash: '0'.repeat(64) },
        { intent: { ...intent, name: 'Substituted text' } },
        { intent: { ...intent, regionId: f.scope.home.regionId } },
        { intent: { ...intent, categoryId: randomUUID() } },
        { intent: { ...intent, expectedCatalogRevision: randomUUID() } },
        { intent: { ...intent, assetIds: [randomUUID()] } },
        { intent: { ...intent, administrator: true } },
      ])
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          await transition(tx, patch);
        });
      for (const patch of [
        { target_id: other.id },
        { content_version: 3 },
        { definition_revision: randomUUID() },
        { applied_target_revision: context.revision },
        { name: 'Changed after Review' },
        { description: 'Changed after Review' },
        { envelope: target.approval.envelope },
        { publication_transaction: '0' },
        { published_at: '2020-01-01T00:00:00.000001Z' },
      ])
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          await transition(tx);
          await version(tx, patch);
        });
      for (const patch of [
        { definition_revision: context.definitionRevision },
        { content_version: 1 },
        { target_id: other.id },
        { decision_id: target.approval.decisionId },
        { account_id: outsider.accountId },
        { envelope: { ...approved.envelope, name: 'Unreviewed replacement' } },
      ])
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          await transition(tx);
          await version(tx);
          await state(tx);
          await head(tx);
          await binding(tx, patch);
        });
    },
  );
  await t.test(
    'receipt bytes, time and shape are exact even with an otherwise complete cause',
    async () => {
      for (const patch of [
        { revision: randomUUID() },
        { definitionRevision: context.definitionRevision },
        { contentVersion: '2' },
        { contentVersion: 3 },
        { targetId: other.id },
        { operation: 'create_target' },
        { outcome: 'noop' },
        { occurredAt: '2020-01-01T00:00:00.000001Z' },
        { creator: owner.accountId },
      ])
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          const e = await transition(tx);
          await version(tx);
          await state(tx);
          await head(tx);
          await binding(tx);
          await receipt(tx, e.occurred_at, patch);
        });
      for (const change of [
        (s: string) => s.replace(/Z$/, '+00:00'),
        (s: string) => s.replace('T', ' '),
        (s: string) => s.replace(/\.\d{6}Z$/, 'Z'),
      ]) {
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          const e = await transition(tx);
          await version(tx);
          await state(tx);
          await head(tx);
          await binding(tx);
          await receipt(tx, change(e.occurred_at));
        });
      }
      await rejectsUnchanged(async (tx) => {
        await full(tx);
        await tx.query(
          'UPDATE whaleu_ratings.targets SET active=false,revision=gen_random_uuid() WHERE id=$1',
          [target.id],
        );
      });
      await rejectsUnchanged(async (tx) => {
        await full(tx);
        await tx.query(
          'UPDATE whaleu_ratings.target_definition_heads SET content_version=1,definition_revision=$2 WHERE target_id=$1',
          [target.id, context.definitionRevision],
        );
      });
    },
  );
  await t.test(
    'the prepared session must still be current when deferred publication verification runs',
    async () => {
      for (const mutateBefore of [true, false]) {
        await rejectsUnchanged(async (tx) => {
          const expire = () =>
            tx.query(
              `UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout'
           WHERE id=(SELECT session_id FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2)`,
              [owner.accountId, intent.clientRequestId],
            );
          if (mutateBefore) await expire();
          await full(tx);
          if (!mutateBefore) await expire();
        });
      }
    },
  );
  await t.test(
    'noop and closure observations cannot invent text equality or coexist with published artifacts',
    async () => {
      await rejectsUnchanged(async (tx) => {
        await begin(tx);
        await tx.query(
          `INSERT INTO whaleu_ratings.target_edit_noops(actor_account_id,request_id,intent_hash,intent,target_id,revision,definition_revision,content_version,context_revision)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
          [
            owner.accountId,
            intent.clientRequestId,
            hash,
            JSON.stringify(intent),
            target.id,
            context.revision,
            context.definitionRevision,
            context.contentVersion,
            prepared.contextRevision,
          ],
        );
      });
      for (const code of [
        'RATING_UNAVAILABLE',
        'CONTENT_REVIEW_UNAVAILABLE',
        'VERIFICATION_UNAVAILABLE',
        'SAFETY_UNAVAILABLE',
      ]) {
        await rejectsUnchanged(async (tx) => {
          await begin(tx);
          await tx.query(
            'INSERT INTO whaleu_ratings.target_edit_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,$5)',
            [
              owner.accountId,
              intent.clientRequestId,
              hash,
              JSON.stringify(intent),
              code,
            ],
          );
        });
      }
      await rejectsUnchanged(async (tx) => {
        await full(tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.target_edit_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,'RATING_EDIT_CANCELLED')",
          [
            owner.accountId,
            intent.clientRequestId,
            hash,
            JSON.stringify(intent),
          ],
        );
      });
    },
  );
  await t.test(
    'a committed raw edit is replayed by the service; same normalized text emits only an immutable noop',
    async () => {
      const original = (
        await f.pool.query(
          "SELECT to_jsonb(t)-ARRAY['revision','active'] original FROM whaleu_ratings.targets t WHERE id=$1",
          [target.id],
        )
      ).rows[0]!.original;
      const e = await transaction(full);
      const replay = await f.commitEdit(
        owner,
        intent,
        prepared.contextRevision,
      );
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.occurredAt, e.occurred_at);
      assert.equal(replay.body.contentVersion, 2);
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT to_jsonb(t)-ARRAY['revision','active'] original FROM whaleu_ratings.targets t WHERE id=$1",
            [target.id],
          )
        ).rows[0]!.original,
        original,
      );
      const current = await f.editContext(owner, target.id);
      const unchanged = f.editIntent(current);
      const noopPrepared = await f.prepareEdit(owner, unchanged);
      const publicTables = observed.filter(({ table_name }) =>
        [
          'targets',
          'target_state_revisions',
          'target_definition_versions',
          'target_definition_heads',
          'target_definition_lifecycles',
          'rating_target_definition_bindings',
          'random_pool_epoch',
          'navigation_epoch',
        ].includes(table_name),
      );
      const before = await snapshot(f.pool, publicTables);
      const noop = await f.commitEdit(
        owner,
        unchanged,
        noopPrepared.contextRevision,
      );
      assert.equal(noop.status, 200, JSON.stringify(noop.body));
      assert.equal(noop.body.outcome, 'noop');
      assert.equal(noop.body.revision, current.revision);
      assert.equal(noop.body.definitionRevision, current.definitionRevision);
      assert.equal(noop.body.contentVersion, 2);
      assert.deepEqual(
        await snapshot(f.pool, publicTables),
        before,
        'Noop must create no public artifact or epoch change',
      );
      const cancelledIntent = f.editIntent(current, {
        name: 'Never published cancellation',
      });
      const cancelled = await f
        .auth(
          request(f.http).post('/v1/ratings/management/owner-edit/cancel'),
          owner,
        )
        .send(cancelledIntent);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.code, 'RATING_EDIT_CANCELLED');
      for (const table of [
        'target_definition_versions',
        'target_definition_lifecycles',
        'target_edit_preparations',
        'target_edit_transitions',
        'target_edit_noops',
        'target_edit_closures',
      ]) {
        const column =
          table === 'target_edit_preparations'
            ? 'account_id'
            : table === 'target_edit_closures' ||
                table === 'target_edit_noops' ||
                table === 'target_edit_transitions'
              ? 'actor_account_id'
              : 'target_id';
        for (const sql of [
          `UPDATE whaleu_ratings.${table} SET ${column}=${column}`,
          `DELETE FROM whaleu_ratings.${table}`,
          `TRUNCATE whaleu_ratings.${table} CASCADE`,
        ]) {
          await rejectsUnchanged((tx) => tx.query(sql));
        }
      }
      for (const sql of [
        'UPDATE whaleu_community.rating_target_definition_bindings SET target_id=target_id',
        'DELETE FROM whaleu_community.rating_target_definition_bindings',
        'TRUNCATE whaleu_community.rating_target_definition_bindings CASCADE',
        'DELETE FROM whaleu_ratings.target_definition_heads',
        'TRUNCATE whaleu_ratings.target_definition_heads CASCADE',
      ]) {
        await rejectsUnchanged((tx) => tx.query(sql));
      }
    },
  );
});
