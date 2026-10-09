import { publishPreDefinitionRatingRoot } from '../support/rating-pre-definition-upgrade-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { ratingTargetOwnerDeletionIntentHash } from '../../src/ratings/management/target-deletion/requests.js';

test('M2A upgrade leaves legacy definitions and Review/source history intact and raw SQL requires complete owner-deletion causality', async (t) => {
  const f = await ratingDiscussionFixture(55);
  t.after(() => f.close());
  const owner = await f.actor(),
    outsider = await f.actor();
  const catalog = await f.catalog(owner, { count: 3 });
  const [target, inactive, untouched] = catalog.targets;
  assert.ok(target && inactive && untouched);
  const oldRootIntent = f.body(catalog, target);
  await publishPreDefinitionRatingRoot(
    f,
    f.envelope(owner, catalog, target, oldRootIntent),
    { targetId: target.id, ...oldRootIntent },
    55,
  );
  inactive.revision = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
      [inactive.id, inactive.revision],
    ),
  );
  const oldTables = (
    await f.pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND (table_schema='whaleu_ratings' OR (table_schema='whaleu_community' AND table_name LIKE 'rating_approval_%')) ORDER BY table_schema,table_name`,
    )
  ).rows;
  const snapshotTables = async (tables: typeof oldTables) => {
    const rows: Record<string, unknown> = {};
    for (const { table_schema: schema, table_name: table } of tables) {
      assert.match(schema, /^[a-z_]+$/);
      assert.match(table, /^[a-z_]+$/);
      rows[`${schema}.${table}`] = (
        await f.pool.query(
          `SELECT to_jsonb(r) row FROM ${schema}.${table} r ORDER BY to_jsonb(r)::text`,
        )
      ).rows;
    }
    return rows;
  };
  const beforeUpgrade = await snapshotTables(oldTables);
  await runMigrations(
    f.pool,
    (
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      )
    ).filter((migration) => Number(migration.name.slice(0, 4)) <= 56),
    { mode: 'up' },
  );
  assert.deepEqual(await snapshotTables(oldTables), beforeUpgrade);
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='whaleu_ratings' AND table_name IN ('target_definition_versions','target_definition_heads')",
      )
    ).rowCount,
    0,
    'M2A must not partially install M2B definitions',
  );
  for (const table of [
    'target_owner_delete_audits',
    'target_owner_tombstones',
    'target_owner_delete_closures',
  ])
    assert.equal(
      (await f.pool.query(`SELECT 1 FROM whaleu_ratings.${table}`)).rowCount,
      0,
      'Existing inactive rows are not owner tombstones',
    );

  const transaction = <T>(work: (tx: PoolClient) => Promise<T>) =>
    inTransaction(
      f.pool,
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        return work(tx);
      },
      { isolationLevel: 'read committed' },
    );
  const observed = [
    ...oldTables,
    ...[
      'target_owner_delete_audits',
      'target_owner_tombstones',
      'target_owner_delete_closures',
    ].map((table_name) => ({ table_schema: 'whaleu_ratings', table_name })),
  ];
  const rejectsUnchanged = async (
    work: (tx: PoolClient) => Promise<unknown>,
  ) => {
    const before = await snapshotTables(observed);
    await assert.rejects(transaction(work));
    assert.deepEqual(await snapshotTables(observed), before);
  };
  const begin = async (tx: PoolClient, selected = target) => {
    const intent = {
      clientRequestId: randomUUID(),
      targetId: selected.id,
      expectedTargetRevision: selected.revision,
    };
    const hash = ratingTargetOwnerDeletionIntentHash(intent);
    assert.equal(
      (
        await tx.query<{ hash: string }>(
          'SELECT whaleu_ratings.owner_delete_intent_hash($1::jsonb) hash',
          [JSON.stringify(intent)],
        )
      ).rows[0]!.hash,
      hash,
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'delete_target',$3)",
      [owner.accountId, intent.clientRequestId, hash],
    );
    return { intent, hash, actor: owner.accountId };
  };
  const audit = async (
    tx: PoolClient,
    command: Awaited<ReturnType<typeof begin>>,
    patch: Record<string, unknown> = {},
  ) => {
    const fields = {
      id: randomUUID(),
      actor_account_id: command.actor,
      request_id: command.intent.clientRequestId,
      intent_hash: command.hash,
      intent: command.intent,
      target_id: command.intent.targetId,
      before_revision: command.intent.expectedTargetRevision,
      after_revision: randomUUID(),
      before_active: true,
      outcome: 'applied',
      source_delete_audit_id: null,
      ...patch,
    };
    const columns = Object.keys(fields);
    const result = (
      await tx.query<{
        id: string;
        after_revision: string;
        occurred_at: string;
      }>(
        `INSERT INTO whaleu_ratings.target_owner_delete_audits(${columns.join(',')})
      SELECT ${columns.map((column) => `a.${column}`).join(',')} FROM jsonb_populate_record(NULL::whaleu_ratings.target_owner_delete_audits,$1::jsonb) a
      RETURNING id,after_revision,${ratingIso('occurred_at')} occurred_at`,
        [JSON.stringify(fields)],
      )
    ).rows[0]!;
    return { ...command, ...result };
  };
  type Audit = Awaited<ReturnType<typeof audit>>;
  const apply = (tx: PoolClient, a: Audit) =>
    tx.query(
      'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
      [a.intent.targetId, a.after_revision],
    );
  const tombstone = (tx: PoolClient, a: Audit) =>
    tx.query(
      `INSERT INTO whaleu_ratings.target_owner_tombstones(target_id,delete_audit_id,cause,actor_account_id,request_id,after_revision,deleted_at)
    SELECT target_id,id,'owner_deleted',actor_account_id,request_id,after_revision,occurred_at FROM whaleu_ratings.target_owner_delete_audits WHERE id=$1`,
      [a.id],
    );
  const receipt = (
    tx: PoolClient,
    a: Audit,
    patch: Record<string, unknown> = {},
  ) =>
    tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [
        a.actor,
        a.intent.clientRequestId,
        JSON.stringify({
          requestId: a.intent.clientRequestId,
          operation: 'delete_target',
          outcome: 'applied',
          targetId: a.intent.targetId,
          revision: a.after_revision,
          occurredAt: a.occurred_at,
          ...patch,
        }),
      ],
    );

  await t.test(
    'raw request alone, fake terminal receipt and incomplete audit/lifecycle/tombstone combinations fail at commit',
    async () => {
      await rejectsUnchanged((tx) => begin(tx));
      for (const outcome of ['applied', 'noop', 'rejected'])
        await rejectsUnchanged(async (tx) => {
          const command = await begin(tx);
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              owner.accountId,
              command.intent.clientRequestId,
              JSON.stringify(
                outcome === 'rejected'
                  ? {
                      requestId: command.intent.clientRequestId,
                      operation: 'delete_target',
                      outcome,
                      code: 'RATING_NOT_FOUND',
                    }
                  : {
                      requestId: command.intent.clientRequestId,
                      operation: 'delete_target',
                      outcome,
                      targetId: target.id,
                      revision: target.revision,
                      occurredAt: new Date().toISOString(),
                    },
              ),
            ],
          );
        });
      for (const missing of [
        'everything_after_audit',
        'lifecycle',
        'tombstone',
        'receipt',
      ])
        await rejectsUnchanged(async (tx) => {
          const a = await audit(tx, await begin(tx));
          if (missing === 'everything_after_audit') return;
          if (missing !== 'lifecycle') await apply(tx, a);
          if (missing !== 'lifecycle' && missing !== 'tombstone')
            await tombstone(tx, a);
          if (missing !== 'receipt') await receipt(tx, a);
        });
      // Independent tombstone insertion cannot borrow an arbitrary target/source.
      await rejectsUnchanged(async (tx) => {
        const command = await begin(tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.target_owner_tombstones(target_id,delete_audit_id,cause,actor_account_id,request_id,after_revision,deleted_at) VALUES($1,$2,'owner_deleted',$3,$4,$5,clock_timestamp())",
          [
            target.id,
            randomUUID(),
            owner.accountId,
            command.intent.clientRequestId,
            target.revision,
          ],
        );
      });
      await rejectsUnchanged(async (tx) => {
        const command = await begin(tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.target_owner_delete_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,'RATING_TARGET_DELETION_CANCELLED')",
          [
            owner.accountId,
            command.intent.clientRequestId,
            command.hash,
            JSON.stringify(command.intent),
          ],
        );
      });
      await rejectsUnchanged(async (tx) => {
        const command = await begin(tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.target_owner_delete_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,'RATING_TARGET_DELETION_CANCELLED')",
          [
            owner.accountId,
            command.intent.clientRequestId,
            command.hash,
            JSON.stringify(command.intent),
          ],
        );
        await tx.query(
          'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [
            owner.accountId,
            command.intent.clientRequestId,
            JSON.stringify({
              requestId: command.intent.clientRequestId,
              operation: 'delete_target',
              outcome: 'rejected',
              code: 'RATING_TARGET_DELETION_CANCELLED',
            }),
          ],
        );
        await tx.query(
          'UPDATE whaleu_ratings.targets SET active=false,revision=gen_random_uuid() WHERE id=$1',
          [target.id],
        );
      });
    },
  );

  await t.test(
    'raw audit cannot lie about creator, before state, canonical intent, noop source or lifecycle revision',
    async () => {
      for (const patch of [
        { actor_account_id: outsider.accountId },
        { before_revision: randomUUID() },
        { before_active: false },
        { target_id: untouched.id },
        { after_revision: target.revision },
        { after_revision: '11111111-1111-0111-8111-111111111111' },
        { intent_hash: '0'.repeat(64) },
        { source_delete_audit_id: randomUUID() },
        {
          outcome: 'noop',
          after_revision: target.revision,
          before_active: false,
        },
        { mutation_transaction: '0' },
      ])
        await rejectsUnchanged(async (tx) => audit(tx, await begin(tx), patch));
      await rejectsUnchanged(async (tx) => {
        const command = await begin(tx);
        await audit(tx, command, {
          intent: { ...command.intent, creatorId: owner.accountId },
        });
      });
      await rejectsUnchanged(async (tx) =>
        audit(tx, await begin(tx, inactive), { before_active: true }),
      );
      for (const selected of [target, inactive])
        await rejectsUnchanged((tx) =>
          tx.query(
            'UPDATE whaleu_ratings.targets SET revision=$2 WHERE id=$1',
            [selected.id, randomUUID()],
          ),
        );
    },
  );

  await t.test(
    'positive complete raw cause proves the helpers; audit time is SQL-minted rather than caller-backdated',
    async () => {
      const before = await snapshotTables(observed);
      const rollback = new Error(
        'Verified complete owner-deletion cause; rollback this synthetic transaction',
      );
      await assert.rejects(
        transaction(async (tx) => {
          const sourceTime = (
            await tx.query<{ occurred_at: string }>(
              'SELECT occurred_at::text FROM whaleu_ratings.target_state_revisions WHERE target_id=$1 AND revision=$2',
              [target.id, target.revision],
            )
          ).rows[0]!.occurred_at;
          const a = await audit(tx, await begin(tx), {
            occurred_at: sourceTime,
          });
          assert.equal(
            (
              await tx.query<{ minted: boolean }>(
                'SELECT occurred_at>$2::timestamptz minted FROM whaleu_ratings.target_owner_delete_audits WHERE id=$1',
                [a.id, sourceTime],
              )
            ).rows[0]!.minted,
            true,
            'Caller-supplied old lifecycle time must not become deletion time',
          );
          await apply(tx, a);
          await tombstone(tx, a);
          await receipt(tx, a);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          const exact = (
            await tx.query<{ valid: boolean }>(
              `SELECT a.occurred_at=d.deleted_at AND a.occurred_at=(q.receipt->>'occurredAt')::timestamptz
        AND a.mutation_transaction=d.mutation_transaction AND a.mutation_transaction=s.mutation_transaction
        AND d.after_revision=t.revision AND NOT t.active valid
        FROM whaleu_ratings.target_owner_delete_audits a JOIN whaleu_ratings.target_owner_tombstones d ON d.delete_audit_id=a.id
        JOIN whaleu_ratings.targets t ON t.id=a.target_id JOIN whaleu_ratings.target_state_revisions s ON s.target_id=t.id AND s.revision=t.revision
        JOIN whaleu_ratings.requests q ON q.account_id=a.actor_account_id AND q.request_id=a.request_id WHERE a.id=$1`,
              [a.id],
            )
          ).rows[0]!;
          assert.equal(exact.valid, true);
          throw rollback;
        }),
        (error: unknown) => error === rollback,
      );
      assert.deepEqual(await snapshotTables(observed), before);
    },
  );

  await t.test(
    'even complete lifecycle facts reject changed receipt shape, revision, operation, target or time',
    async () => {
      for (const patch of [
        { targetId: untouched.id },
        { revision: randomUUID() },
        { outcome: 'noop' },
        { operation: 'delete_comment' },
        { occurredAt: '2026-01-01T00:00:00.000001Z' },
        { author: owner.accountId },
      ])
        await rejectsUnchanged(async (tx) => {
          const a = await audit(tx, await begin(tx));
          await apply(tx, a);
          await tombstone(tx, a);
          await receipt(tx, a, patch);
        });
      for (const change of [
        (time: string) => time.replace(/Z$/, '+00:00'),
        (time: string) => time.replace('T', ' '),
      ])
        await rejectsUnchanged(async (tx) => {
          const a = await audit(tx, await begin(tx));
          await apply(tx, a);
          await tombstone(tx, a);
          await receipt(tx, a, { occurredAt: change(a.occurred_at) });
        });
      await rejectsUnchanged(async (tx) => {
        const a = await audit(tx, await begin(tx));
        await apply(tx, a);
        await tombstone(tx, a);
        await receipt(tx, a);
        const command = await begin(tx);
        await audit(tx, command, {
          before_revision: a.after_revision,
          before_active: false,
        });
      });
    },
  );

  await t.test(
    'immutable definition columns stay closed even while presenting a valid applied cause',
    async () => {
      for (const [column, value] of [
        ['name', 'Forged title'],
        ['description', 'Forged text'],
        ['creator_id', outsider.accountId],
        ['source_id', randomUUID()],
        ['category_id', randomUUID()],
        ['region_id', f.scope.home.regionId],
        ['content_version', 2],
        ['envelope', '{}'],
      ] as const)
        await rejectsUnchanged(async (tx) => {
          const a = await audit(tx, await begin(tx));
          await tx.query(
            `UPDATE whaleu_ratings.targets SET active=false,revision=$2,${column}=$3 WHERE id=$1`,
            [target.id, a.after_revision, value],
          );
          await tombstone(tx, a);
          await receipt(tx, a);
        });
    },
  );

  await t.test(
    'committed owner tombstone, audit and rejection closure are retained and no target resurrection is possible',
    async () => {
      const input = {
        clientRequestId: randomUUID(),
        expectedTargetRevision: target.revision,
      };
      const deleted = await f
        .auth(
          request(f.http).post(
            `/v1/ratings/management/owner-deletion/targets/${target.id}`,
          ),
          owner,
        )
        .send(input);
      assert.equal(
        deleted.body.outcome,
        'applied',
        JSON.stringify(deleted.body),
      );
      const cancellation = await f
        .auth(
          request(f.http).post('/v1/ratings/management/owner-deletion/cancel'),
          owner,
        )
        .send({
          clientRequestId: randomUUID(),
          targetId: untouched.id,
          expectedTargetRevision: untouched.revision,
        });
      assert.equal(
        cancellation.body.code,
        'RATING_TARGET_DELETION_CANCELLED',
        JSON.stringify(cancellation.body),
      );
      for (const statement of [
        'UPDATE whaleu_ratings.targets SET active=true,revision=gen_random_uuid() WHERE id=$1',
        'UPDATE whaleu_ratings.targets SET revision=gen_random_uuid() WHERE id=$1',
        "UPDATE whaleu_ratings.targets SET name='Resurrected',revision=gen_random_uuid() WHERE id=$1",
        'DELETE FROM whaleu_ratings.targets WHERE id=$1',
      ])
        await rejectsUnchanged((tx) => tx.query(statement, [target.id]));
      for (const table of [
        'target_owner_delete_audits',
        'target_owner_tombstones',
        'target_owner_delete_closures',
      ]) {
        for (const statement of [
          `UPDATE whaleu_ratings.${table} SET request_id=gen_random_uuid()`,
          `DELETE FROM whaleu_ratings.${table}`,
          `TRUNCATE whaleu_ratings.${table} CASCADE`,
        ])
          await rejectsUnchanged((tx) => tx.query(statement));
      }
      assert.deepEqual(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/management/owner-deletion/requests/${input.clientRequestId}`,
            ),
            owner,
          )
        ).body,
        deleted.body,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT active FROM whaleu_ratings.targets WHERE id=$1',
            [target.id],
          )
        ).rows[0]!.active,
        false,
      );
    },
  );
});
