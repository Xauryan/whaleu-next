import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { negotiateCategoryIconProtocol } from '../src/ratings/category-management/icon-negotiation.js';

const id = (n: number) =>
  `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-10T00:00:00.000Z');
function fixture(installed = true) {
  const sql: string[] = [];
  const state = {
    installed,
    functionInstalled: installed,
    cause: {} as Record<string, unknown>,
    current: true,
    scopeKeys: ['global'],
    protocols: [{ id: id(1), logical_scope_key: 'global' }],
    registrations: [] as {
      id: string;
      protocol_version_id: string;
      logical_scope_key: string;
      current: boolean;
      valid_until: Date;
    }[],
  };
  const tx = {
    query: async (query: string) => {
      sql.push(query);
      if (query.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (query.includes('to_regclass'))
        return {
          rows: [
            {
              registration_relation: state.installed
                ? 'whaleu_ratings.category_icon_capability_sources'
                : null,
              current_function: state.functionInstalled
                ? 'whaleu_ratings.category_icon_capability_current(uuid,timestamptz)'
                : null,
            },
          ],
        };
      if (query.includes('SELECT h.scope_key,h.catalog_id'))
        return {
          rows: state.scopeKeys.map((scopeKey, index) => ({
            scope_key: scopeKey,
            catalog_id: id(20 + index),
            head_revision: id(30 + index),
            release_id: id(4),
            cause: state.cause,
          })),
        };
      if (query.includes('SELECT v.id,v.logical_scope_key'))
        return {
          rows: state.protocols.map((protocol) => ({
            ...protocol,
            current: state.current,
          })),
        };
      if (
        query.includes('FROM whaleu_ratings.category_icon_capability_sources')
      ) {
        assert.equal(
          state.installed,
          true,
          'Old schema must never query a Category relation',
        );
        return { rows: state.registrations };
      }
      if (query === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now }] };
      if (
        query.startsWith('LOCK TABLE') ||
        query.startsWith('SELECT set_config') ||
        query === 'SET CONSTRAINTS ALL IMMEDIATE'
      )
        return { rows: [] };
      throw new Error(`Unexpected query: ${query}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const registration = (version = id(1), current = true) => ({
    id: id(5),
    protocol_version_id: version,
    logical_scope_key: 'global',
    current,
    valid_until: new Date(now.getTime() + 60000),
  });
  return { tx, sql, state, registration };
}

test('negotiation proves absent Category registration on old and upgraded schemas', async () => {
  for (const installed of [false, true]) {
    const f = fixture(installed);
    assert.equal(
      await negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
      'legacy',
    );
    await checkTransactionDeadlines(f.tx);
    if (!installed)
      assert.equal(
        f.sql.some((sql) =>
          /(?:FROM|LOCK TABLE) whaleu_ratings\.category_icon_/.test(sql),
        ),
        false,
      );
  }
});

test('only the exact current Category registration permits icon negotiation', async () => {
  const f = fixture();
  f.state.registrations = [f.registration()];
  assert.equal(
    await negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
    'icon',
  );
  await checkTransactionDeadlines(f.tx);
});

test('held, stale, future and unknown registrations cannot downgrade to legacy', async () => {
  for (const registrations of [
    [fixture().registration(id(1), false)],
    [fixture().registration(id(6), false)],
    [fixture().registration(id(6), true)],
    [fixture().registration(), fixture().registration()],
  ]) {
    const f = fixture();
    f.state.registrations = registrations;
    await assert.rejects(
      negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
      { code: 'RATING_SCOPE_UNAVAILABLE' },
    );
  }
});

test('marked releases and partial installation fail closed without a registration', async () => {
  for (const installed of [false, true]) {
    for (const cause of [
      { categoryIconExtension: 'unknown' },
      { categoryIconDigest: 'a'.repeat(64) },
      { categoryIconScopeKeys: ['global'] },
      {
        categoryIconExtension: 'ratings-category-icon-v1',
        categoryIconDigest: 'a'.repeat(64),
        categoryIconScopeKeys: ['global'],
      },
    ]) {
      const f = fixture(installed);
      f.state.cause = cause;
      await assert.rejects(
        negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
        { code: 'RATING_SCOPE_UNAVAILABLE' },
      );
    }
  }
  const f = fixture();
  f.state.functionInstalled = false;
  await assert.rejects(
    negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
    { code: 'RATING_SCOPE_UNAVAILABLE' },
  );
});

test('explicitly excluded mixed scopes preserve legacy without new schema probes or locks', async () => {
  for (const installed of [false, true]) {
    const f = fixture(installed);
    f.state.cause = {
      categoryIconExtension: 'ratings-category-icon-v1',
      categoryIconDigest: 'a'.repeat(64),
      categoryIconScopeKeys: [`campus:${id(10)}`],
    };
    f.state.functionInstalled = !installed;
    f.state.registrations = [f.registration(id(6), false)];
    assert.equal(
      await negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
      'legacy',
    );
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.sql.some((sql) => sql.includes('category_icon_')),
      false,
    );
  }
});

test('a mixed public scope set cannot downgrade an adopted sibling or skip its registration', async () => {
  const f = fixture();
  const adoptedScope = `campus:${id(10)}`;
  f.state.scopeKeys = [adoptedScope, 'global'];
  f.state.protocols = [
    { id: id(1), logical_scope_key: id(11) },
    { id: id(2), logical_scope_key: 'global' },
  ];
  f.state.cause = {
    categoryIconExtension: 'ratings-category-icon-v1',
    categoryIconDigest: 'a'.repeat(64),
    categoryIconScopeKeys: [adoptedScope],
  };
  f.state.registrations = [{ ...f.registration(), logical_scope_key: id(11) }];
  await assert.rejects(
    negotiateCategoryIconProtocol([id(1), id(2)], f.state.scopeKeys, f.tx),
    { code: 'RATING_SCOPE_UNAVAILABLE' },
  );
});

test('scope adoption changes invalidate a retained legacy exclusion proof', async () => {
  const f = fixture();
  f.state.cause = {
    categoryIconExtension: 'ratings-category-icon-v1',
    categoryIconDigest: 'a'.repeat(64),
    categoryIconScopeKeys: [`campus:${id(10)}`],
  };
  assert.equal(
    await negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
    'legacy',
  );
  f.state.cause['categoryIconScopeKeys'] = [`campus:${id(10)}`, 'global'];
  await assert.rejects(checkTransactionDeadlines(f.tx), {
    code: 'RATING_SCOPE_UNAVAILABLE',
  });
});

test('registered absence remains proved after deferred waits and epoch changes', async () => {
  const f = fixture();
  assert.equal(
    await negotiateCategoryIconProtocol([id(1)], ['global'], f.tx),
    'legacy',
  );
  f.state.registrations = [f.registration(id(6), false)];
  await assert.rejects(checkTransactionDeadlines(f.tx), {
    code: 'RATING_SCOPE_UNAVAILABLE',
  });
});

test('negotiation preserves errors and rejects empty or duplicate input scope sets', async () => {
  for (const [protocols, keys] of [
    [[], ['global']],
    [[id(1)], []],
    [[id(1), id(1)], ['global']],
  ] as const) {
    const f = fixture();
    await assert.rejects(negotiateCategoryIconProtocol(protocols, keys, f.tx), {
      code: 'RATING_SCOPE_UNAVAILABLE',
    });
  }
  const failure = new Error('Database unavailable');
  const tx = {
    query: async () => {
      throw failure;
    },
  } as unknown as PoolClient;
  await assert.rejects(
    negotiateCategoryIconProtocol([id(1)], ['global'], tx),
    (error) => error === failure,
  );
});
