import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';

type Source = {
  relation: string;
  actorKey: string;
  compatibility137: { changed: boolean; originalMutationGuard: string };
};
const pgCode = (value: unknown): string | undefined =>
  value && typeof value === 'object' && 'code' in value
    ? String(value.code)
    : undefined;

test(
  'consumer forward compatibility preserves exact original zero-row owners without fabricating policy evidence or permitting row mutation',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const inventory = JSON.parse(
      await readFile(
        new URL(
          '../../../../docs/account-moderation/source-compatibility-0137.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Source[];
    assert.equal(inventory.length, 58);
    const changed = inventory.filter((row) => row.compatibility137.changed);
    assert.equal(changed.length, 21);
    assert.equal(
      changed.filter(
        (row) =>
          row.compatibility137.originalMutationGuard ===
          'unconditional_before_row',
      ).length,
      6,
    );
    const client = await f.pool.connect();
    const proofCount = async () =>
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text count FROM whaleu_safety.account_policy_consumer_proofs',
        )
      ).rows[0]!.count;
    try {
      for (const source of changed) {
        const table = source.relation;
        assert.match(table, /^whaleu_[a-z_]+\.[a-z_]+$/);
        assert.match(source.actorKey, /^[a-z_]+$/);
        const triggers = (
          await f.pool.query<{
            tgname: string;
            tgtype: number;
            tgenabled: string;
          }>(
            'SELECT tgname,tgtype,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',
            [table],
          )
        ).rows;
        assert.equal(
          triggers.some(
            (row) => row.tgname === 'account_policy_consumer_source_immutable',
          ),
          false,
        );
        assert.equal(
          triggers.some(
            (row) => row.tgname === 'account_policy_consumer_insert_statement',
          ),
          false,
        );
        for (const name of [
          'account_policy_consumer_capture',
          'account_policy_consumer_changed_update',
          'account_policy_consumer_changed_delete',
          'zz_account_policy_consumer_source_retain',
        ])
          assert.ok(
            triggers.some(
              (row) => row.tgname === name && row.tgenabled === 'O',
            ),
            `${table}: ${name}`,
          );
        assert.ok(
          triggers.some(
            (row) =>
              !row.tgname.includes('account_policy_consumer') &&
              (row.tgtype & 2) === 2 &&
              (row.tgtype & 24) === 24 &&
              row.tgenabled === 'O',
          ),
          `${table}: original immutable owner remains enabled`,
        );
        for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
          await client.query('BEGIN');
          try {
            const before = await proofCount();
            const sql =
              operation === 'INSERT'
                ? `INSERT INTO ${table} (${source.actorKey}) SELECT NULL::uuid WHERE false`
                : operation === 'UPDATE'
                  ? `UPDATE ${table} SET ${source.actorKey}=${source.actorKey} WHERE false`
                  : `DELETE FROM ${table} WHERE false`;
            if (
              operation !== 'INSERT' &&
              source.compatibility137.originalMutationGuard ===
                'unconditional_before_statement'
            ) {
              await assert.rejects(
                client.query(sql),
                (error: unknown) =>
                  pgCode(error) === '23514' &&
                  !(
                    error &&
                    typeof error === 'object' &&
                    'constraint' in error &&
                    error.constraint === 'account_policy_consumer_causal'
                  ),
                `${table}: original statement guard must still reject ${operation}`,
              );
            } else {
              assert.equal((await client.query(sql)).rowCount, 0);
              assert.equal(
                await proofCount(),
                before,
                `${table}: empty ${operation} cannot mint policy evidence`,
              );
              await client.query('SET CONSTRAINTS ALL IMMEDIATE');
            }
          } finally {
            await client.query('ROLLBACK');
          }
        }
      }
      // Real successful source and sidecar, not a fabricated receipt. Original
      // command immutability must remain authoritative before the fallback.
      const admin = await f.actor(),
        subject = await f.actor();
      await f.grant(admin, 'super_admin', null);
      await f.issue(
        admin,
        subject,
        await f.publish(subject),
        'interaction_mute',
      );
      for (const sql of [
        'UPDATE whaleu_community.admin_post_removal_commands SET actor_id=actor_id WHERE actor_id=$1',
        'DELETE FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1',
      ]) {
        await client.query('BEGIN');
        try {
          assert.ok(
            (
              await client.query(
                'SELECT 1 FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1',
                [admin.accountId],
              )
            ).rows.length,
          );
          await assert.rejects(
            client.query(sql, [admin.accountId]),
            (error: unknown) =>
              pgCode(error) === '23514' &&
              !!error &&
              typeof error === 'object' &&
              'where' in error &&
              String(error.where).includes('admin_post_removal_immutable'),
          );
        } finally {
          await client.query('ROLLBACK');
        }
      }
      const course = (
        await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef('whaleu_ratings.course_comment_fence()'::regprocedure) definition",
        )
      ).rows[0]!.definition;
      assert.match(course, /transaction_isolation/);
      assert.match(course, /read committed/);
      const admit = (
        await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef('whaleu_safety.account_policy_consumer_admit()'::regprocedure) definition",
        )
      ).rows[0]!.definition;
      assert.match(admit, /requires read committed/);
      assert.match(admit, /pg_trigger_depth\(\)\s*<>\s*2/);
    } finally {
      client.release();
    }
  },
);
