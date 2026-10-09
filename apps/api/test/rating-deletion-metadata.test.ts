import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingDeletionRepository } from '../src/ratings/deletion/repository.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const commands: string[] = [];
  const state = { match: true };
  const tx = {
    query: async (sql: string) => {
      commands.push(sql);
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('set_config') || sql.startsWith('SET CONSTRAINTS'))
        return { rows: [] };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: new Date() }] };
      if (sql.includes('count(*)'))
        return { rows: [{ n: state.match ? 1 : 0 }] };
      if (sql.includes('FROM whaleu_ratings.targets'))
        return {
          rows: [
            { id: id(1), revision: id(2), active: false, region_id: id(3) },
          ],
        };
      return {
        rows: [
          {
            id: id(4),
            target_id: id(1),
            root_id: id(4),
            account_id: id(5),
            revision: id(6),
            deleted_at: '2026-10-09T00:00:00.000001Z',
          },
        ],
      };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, commands, state };
}
test('deletion reads only metadata and permits inactive targets and tombstoned parent metadata', async () => {
  const f = fixture(),
    repository = new RatingDeletionRepository();
  await repository.locator('reply', id(9), f.tx);
  const target = await repository.target(id(1), f.tx);
  const root = await repository.root(id(4), target.id, f.tx);
  await repository.reply(id(9), root.id, target.id, f.tx);
  assert.equal(target.active, false);
  assert.ok(root.deleted_at);
  assert.ok(
    f.commands.every(
      (sql) =>
        !/\b(body|persona|envelope|author_mode|category|catalog|review)\b/.test(
          sql,
        ),
    ),
  );
  assert.ok(f.commands.slice(1).every((sql) => sql.endsWith('FOR UPDATE')));
  await checkTransactionDeadlines(f.tx);
});
test('deletion target final proof preserves exact active/revision/region observation', async () => {
  const f = fixture();
  await new RatingDeletionRepository().target(id(1), f.tx);
  f.state.match = false;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'RATING_UNAVAILABLE',
  );
  const proof = f.commands.find((sql) => sql.includes('count(*)'))!;
  assert.match(proof, /t\.active=f\.active/);
  assert.match(proof, /t\.revision=f\.revision/);
  assert.match(proof, /t\.region_id IS NOT DISTINCT FROM f\.region_id/);
});
