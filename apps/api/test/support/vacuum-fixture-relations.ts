import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { migrationSchemaNames } from './migration-schemas.js';

/** Only after this disposable fixture has claimed/migrated its application schemas.
 * One real VACUUM statement retains the connection's original statement budget.
 * Enumerate ordinary tables (including partition leaves), never shared catalogs.
 */
export async function vacuumFixtureRelations(pool: Pool): Promise<void> {
  const tx = await pool.connect();
  try {
    const identity = (
      await tx.query<{ database: string; address: string }>(
        'SELECT current_database() database,host(inet_server_addr()) address',
      )
    ).rows[0]!;
    assert.equal(identity.database, 'whaleu_test');
    assert.ok(['127.0.0.1', '::1'].includes(identity.address));
    const relations = (
      await tx.query<{ oid: number; name: string; owned: boolean }>(
        `SELECT c.oid,format('%I.%I',n.nspname,c.relname) name,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) owned
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=ANY($1::text[]) AND c.relkind='r' ORDER BY n.nspname,c.relname`,
        [migrationSchemaNames],
      )
    ).rows;
    assert.ok(relations.length > 0);
    assert.ok(
      relations.every((row) => row.owned),
      'All maintained tables must belong to the fixture role',
    );
    // Partitioned parents themselves contain no rows; all ordinary leaves are
    // above. Refuse an inheritance/partition edge that could escape this owner.
    assert.equal(
      (
        await tx.query(
          `SELECT 1 FROM pg_inherits i
      JOIN pg_class p ON p.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=p.relnamespace
      JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace
      WHERE (pn.nspname=ANY($1::text[]))<>(cn.nspname=ANY($1::text[]))`,
          [migrationSchemaNames],
        )
      ).rowCount,
      0,
    );
    const stats = async () =>
      (
        await tx.query<{ relid: number; vacuums: string; analyzes: string }>(
          'SELECT relid,vacuum_count::text vacuums,analyze_count::text analyzes FROM pg_stat_all_tables WHERE relid=ANY($1::oid[]) ORDER BY relid',
          [relations.map((row) => row.oid)],
        )
      ).rows;
    await tx.query('SELECT pg_stat_clear_snapshot()');
    const before = await stats();
    assert.equal(before.length, relations.length);
    const result = await tx.query(
      `VACUUM (ANALYZE) ${relations.map((row) => row.name).join(',')}`,
    );
    assert.equal(result.command, 'VACUUM');
    await tx.query('SELECT pg_stat_force_next_flush()');
    await tx.query('SELECT pg_stat_clear_snapshot()');
    const after = await stats();
    assert.equal(after.length, before.length);
    for (const [index, row] of after.entries()) {
      assert.equal(row.relid, before[index]!.relid);
      assert.ok(
        BigInt(row.vacuums) > BigInt(before[index]!.vacuums),
        `Real VACUUM must finish for relation ${row.relid}`,
      );
      assert.ok(
        BigInt(row.analyzes) > BigInt(before[index]!.analyzes),
        `Real ANALYZE must finish for relation ${row.relid}`,
      );
    }
  } finally {
    tx.release();
  }
}
