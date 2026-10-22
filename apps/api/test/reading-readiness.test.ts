import {
  observeReadingFormatter,
  readingCapabilitySchema,
} from '../src/community/reading-formatting/capability.js';
import { textSourceCapabilitySchema } from '../src/community/text-source/protocol.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { readingCatalogSnapshotSql } from '../src/community/reading-formatting/catalog.js';
import {
  inspectReadingSchema,
  retainReadingSchema,
  requireReadingSchema,
} from '../src/community/reading-formatting/readiness.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const catalog = 'a'.repeat(64);
const body = readFileSync(
  new URL('../migrations/0176_durable_reading_formatting.sql', import.meta.url),
  'utf8',
)
  .split('AS $catalog$')[1]!
  .split('$catalog$;')[0]!;
const protocol = {
  version: 1,
  formatter: 'plain-cjk-slices-v2',
  generation: 1,
  migration: '0176_durable_reading_formatting.sql',
  catalog,
};
function fixture() {
  const presence = {
    homePresent: false,
    relations: 8,
    functions: 13,
    protocol: true,
    catalog: true,
    marker: {
      body: `SELECT '${JSON.stringify(protocol)}'::jsonb`,
      immutable: true,
      invoker: true,
      sql: true,
      config: ['search_path=pg_catalog'],
      scalar: true,
      sameOwner: true,
    },
    catalogFunction: {
      body,
      stable: true,
      invoker: true,
      sql: true,
      config: ['search_path=pg_catalog'],
      scalar: true,
    },
  };
  const state: {
    presence: unknown;
    snapshot: unknown;
    queries: string[];
    fail?: '55P03' | '57014' | '42P01' | 'rollback';
  } = {
    presence,
    snapshot: {
      catalog,
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    },
    queries: [],
  };
  const tx = {
    query: async (sql: string) => {
      state.queries.push(sql);
      if (sql === 'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked')
        return { rows: [{ locked: true }] };
      if (
        state.fail === 'rollback' &&
        sql === 'ROLLBACK TO SAVEPOINT optional_final_count_proof'
      )
        throw new Error('Fixture rollback failed');
      if (
        state.fail === '42P01' &&
        sql.startsWith('LOCK TABLE whaleu_community.reading_format_heads')
      )
        throw Object.assign(new Error('Fixture derived table dropped'), {
          code: '42P01',
        });
      if (
        (state.fail === '55P03' || state.fail === '57014') &&
        sql === readingCatalogSnapshotSql
      )
        throw Object.assign(new Error('Fixture schema query cancelled'), {
          code: state.fail,
        });
      if (sql.includes('count(*)::integer FROM pg_class'))
        return { rows: [state.presence] };
      if (sql === readingCatalogSnapshotSql) return { rows: [state.snapshot] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes("current_setting('statement_timeout')"))
        return { rows: [{ statement_timeout: '0', lock_timeout: '0' }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { state, presence, tx };
}
const unavailable = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE';
test('complete owner is sealed; a wholly absent owner is distinct from partial metadata', async () => {
  const f = fixture();
  assert.deepEqual(await inspectReadingSchema(f.tx), {
    status: 'ready',
    catalog,
  });
  f.state.presence = {
    homePresent: false,
    relations: 0,
    functions: 0,
    protocol: false,
    catalog: false,
    marker: null,
    catalogFunction: null,
  };
  assert.deepEqual(await inspectReadingSchema(f.tx), { status: 'missing' });
  for (const partial of [
    {
      homePresent: false,
      relations: 1,
      functions: 0,
      protocol: false,
      catalog: false,
    },
    {
      homePresent: false,
      relations: 0,
      functions: 1,
      protocol: false,
      catalog: false,
    },
    { ...f.presence, relations: 3 },
  ]) {
    f.state.presence = partial;
    await assert.rejects(inspectReadingSchema(f.tx), unavailable);
  }
});
for (const [name, mutate] of Object.entries({
  'unknown protocol': (f: ReturnType<typeof fixture>) => {
    f.presence.marker.body = `SELECT '${JSON.stringify({ ...protocol, version: 2 })}'::jsonb`;
  },
  'unknown protocol key': (f: ReturnType<typeof fixture>) => {
    f.presence.marker.body = `SELECT '${JSON.stringify({ ...protocol, extra: true })}'::jsonb`;
  },
  'nonliteral protocol': (f: ReturnType<typeof fixture>) => {
    f.presence.marker.body = "SELECT current_setting('fake.protocol')::jsonb";
  },
  'foreign owner': (f: ReturnType<typeof fixture>) => {
    f.presence.marker.sameOwner = false;
  },
  'definer marker': (f: ReturnType<typeof fixture>) => {
    f.presence.marker.invoker = false;
  },
  'mutated catalog function': (f: ReturnType<typeof fixture>) => {
    f.presence.catalogFunction.body = `SELECT '${catalog}'`;
  },
  'unsafe catalog path': (f: ReturnType<typeof fixture>) => {
    f.presence.catalogFunction.config = ['search_path=public'];
  },
  'guard catalog changed': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog: 'b'.repeat(64),
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
  },
  'wrong deparser path': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog,
      slots: [1, 2],
      deparsePath: 'public',
      searchPathRestored: true,
    };
  },
  'unrestored caller path': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog,
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: false,
    };
  },
  'missing path attestation': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = { catalog, slots: [1, 2] };
  },
  'missing slot': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog,
      slots: [1],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
  },
  'extra slot': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog,
      slots: [1, 2, 3],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
  },
  'reordered seed': (f: ReturnType<typeof fixture>) => {
    f.state.snapshot = {
      catalog,
      slots: [2, 1],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
  },
}))
  test(`readiness rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(inspectReadingSchema(f.tx), unavailable);
  });
test('required write readiness needs managed transaction and rejects schema mutation at final closure', async () => {
  const f = fixture();
  await assert.rejects(retainReadingSchema(f.tx), unavailable);
  startTransactionDeadlines(f.tx);
  try {
    await requireReadingSchema(f.tx);
    f.state.snapshot = {
      catalog: 'b'.repeat(64),
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
    assert.ok(
      f.state.queries.some((s) =>
        s.startsWith('LOCK TABLE whaleu_community.reading_format_heads'),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('unchanged required schema closes without queue data entering catalog identity', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    assert.equal(await retainReadingSchema(f.tx), true);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('v2 diagnostic installed state downgrades only its optional schema fact at final drift', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const value = await observeReadingFormatter(f.tx, 'automatic');
    assert.equal(value.schema, 'installed');
    assert.equal(value.worker.readiness, 'not_observed');
    f.state.snapshot = {
      catalog: 'b'.repeat(64),
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
    await checkTransactionDeadlines(f.tx);
    assert.equal(value.schema, 'unavailable');
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('v2 schema unavailable does not discard earlier mandatory proof', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    await requireReadingSchema(f.tx);
    f.state.snapshot = {
      catalog: 'b'.repeat(64),
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
    const value = await observeReadingFormatter(f.tx, 'disabled');
    assert.equal(value.schema, 'unavailable');
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('v2 source/formatter contracts keep independent readiness and exact v1 wire', () => {
  const source = {
    version: 1,
    authorMode: 'named',
    availability: 'available',
    operations: ['publish_post'],
    formats: ['plain', 'markdown'],
    readingFormatting: ['auto', 'off'],
    media: 'unavailable',
    markdownReferences: 'unavailable',
    formatter: 'not_configured',
  };
  assert.equal(
    textSourceCapabilitySchema.parse(source).formatter,
    'not_configured',
  );
  for (const schema of ['installed', 'missing', 'unavailable'])
    for (const requestedMode of ['disabled', 'manual_only', 'automatic']) {
      const wire = {
        ...source,
        version: 2,
        formatter: {
          version: 'plain-cjk-slices-v2',
          schema,
          worker: { requestedMode, readiness: 'not_observed' },
        },
      };
      assert.equal(
        readingCapabilitySchema.parse(wire).availability,
        'available',
      );
      assert.equal(textSourceCapabilitySchema.safeParse(wire).success, false);
      assert.equal(
        readingCapabilitySchema.safeParse({
          ...wire,
          formatter: {
            ...wire.formatter,
            worker: { requestedMode, readiness: 'running' },
          },
        }).success,
        false,
      );
    }
});

for (const failure of ['55P03', '57014', '42P01'] as const)
  test(`installed capability keeps source independent after final ${failure}`, async () => {
    const f = fixture();
    startTransactionDeadlines(f.tx);
    try {
      const value = await observeReadingFormatter(f.tx, 'automatic');
      assert.equal(value.schema, 'installed');
      f.state.fail = failure;
      await checkTransactionDeadlines(f.tx);
      assert.equal(value.schema, 'unavailable');
      assert.equal(value.worker.readiness, 'not_observed');
      assert.ok(
        f.state.queries.includes(
          'ROLLBACK TO SAVEPOINT optional_final_count_proof',
        ),
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  });
test('capability final rollback failure remains fatal', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const value = await observeReadingFormatter(f.tx, 'disabled');
    assert.equal(value.schema, 'installed');
    f.state.snapshot = {
      catalog: 'b'.repeat(64),
      slots: [1, 2],
      deparsePath: 'pg_catalog',
      searchPathRestored: true,
    };
    f.state.fail = 'rollback';
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      /Fixture rollback failed/,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('raw readiness and managed final proof execute the same collector without fallback', async () => {
  const raw = fixture();
  await inspectReadingSchema(raw.tx);
  assert.equal(
    raw.state.queries.filter((sql) => sql === readingCatalogSnapshotSql).length,
    1,
  );
  const managed = fixture();
  startTransactionDeadlines(managed.tx);
  try {
    await requireReadingSchema(managed.tx);
    await checkTransactionDeadlines(managed.tx);
    assert.equal(
      managed.state.queries.filter((sql) => sql === readingCatalogSnapshotSql)
        .length,
      2,
    );
    assert.equal(
      managed.state.queries.some((sql) =>
        sql.includes('SELECT whaleu_community.reading_format_catalog()'),
      ),
      false,
    );
  } finally {
    clearTransactionDeadlines(managed.tx);
  }
});
