import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import type { ReadingSourceOwner } from '../src/community/reading-formatting/source-owner.js';
import { ReadingFormattingRuntime } from '../src/community/reading-formatting/runtime.js';
const id = '00000000-0000-4000-8000-000000000001';
for (const [name, row] of Object.entries({
  Markdown: {
    source_format: 'markdown',
    reading_formatting: null,
    body: '鲸'.repeat(400),
  },
  optOut: {
    source_format: 'plain',
    reading_formatting: 'off',
    body: '鲸'.repeat(400),
  },
  short: {
    source_format: 'plain',
    reading_formatting: 'auto',
    body: '鲸'.repeat(299),
  },
  absent: null,
}))
  test(`${name} publication never consults or mutates M2 schema`, async () => {
    let queries = 0;
    const tx = {
      query: async (sql: string) => {
        queries++;
        assert.ok(
          sql.startsWith(
            'SELECT s.source_hash,s.source_format,s.reading_formatting,',
          ),
        );
        return { rows: row ? [{ source_hash: 'a'.repeat(64), ...row }] : [] };
      },
    } as unknown as PoolClient;
    const owner = new ReadingFormattingRuntime(
      {} as DatabaseService,
      {} as ReadingSourceOwner,
    );
    await owner.enrollCreated('post', id, id, tx);
    assert.equal(queries, 1);
  });
