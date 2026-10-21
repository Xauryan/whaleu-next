/** Static/pure evidence only. PostgreSQL equivalence and ordering remain required. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  readingCatalogPreimageSql,
  readingCatalogSnapshotSql,
} from '../src/community/reading-formatting/catalog.js';

const migration = readFileSync(
  new URL('../migrations/0176_durable_reading_formatting.sql', import.meta.url),
  'utf8',
);
const original = migration.split('AS $catalog$')[1]!.split('$catalog$;')[0]!;
const normalize = (sql: string) =>
  sql.replaceAll('pg_catalog.', '').replace(/\s+/g, ' ').trim();

function arrayArguments(sql: string): string[] {
  const values: string[] = [];
  const marker = 'jsonb_build_array(';
  let from = 0;
  for (;;) {
    const start = sql.indexOf(marker, from);
    if (start < 0) return values;
    let depth = 1;
    let at = start + marker.length;
    const begin = at;
    while (depth > 0 && at < sql.length) {
      if (sql[at] === '(') depth++;
      else if (sql[at] === ')') depth--;
      at++;
    }
    assert.equal(depth, 0);
    values.push(normalize(sql.slice(begin, at - 1)));
    from = at;
  }
}

test('all original fact arrays and their field order remain exact', () => {
  assert.deepEqual(
    arrayArguments(readingCatalogSnapshotSql),
    arrayArguments(original),
  );
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    '4193cd2855e457dbc40ed24a5f1966735e0436b435455eca69e50cbd19893133',
    'Published 0176 body is not rewritten',
  );
  assert.match(
    readingCatalogSnapshotSql,
    /ORDER BY kind COLLATE pg_catalog\."C",key COLLATE pg_catalog\."C"/,
  );
});

test('global late guards and all prefix-matching functions remain visible', () => {
  assert.match(
    readingCatalogSnapshotSql,
    /target_triggers AS MATERIALIZED \(\s+SELECT t\.\* FROM relations r\s+JOIN pg_catalog\.pg_trigger t ON t\.tgrelid OPERATOR\(pg_catalog\.=\) r\.oid\s+WHERE NOT t\.tgisinternal\s+UNION ALL\s+SELECT t\.\* FROM pg_catalog\.pg_trigger t\s+WHERE NOT t\.tgisinternal AND t\.tgname OPERATOR\(pg_catalog\.=\) 'reading_late_guard'\s+AND NOT EXISTS \(SELECT 1 FROM relations r WHERE r\.oid OPERATOR\(pg_catalog\.=\) t\.tgrelid\)/,
  );
  assert.match(
    readingCatalogSnapshotSql,
    /p\.proname OPERATOR\(pg_catalog\.~~\) 'reading_format_%'::pg_catalog\.text/,
  );
  assert.match(
    readingCatalogSnapshotSql,
    /AND NOT\(p\.proname OPERATOR\(pg_catalog\.=\) 'reading_format_protocol'\s+AND p\.pronargs OPERATOR\(pg_catalog\.=\) 0\)\s+UNION\s+SELECT tgfoid FROM target_triggers/,
  );
  assert.doesNotMatch(
    readingCatalogSnapshotSql,
    /LIMIT|reading_format_catalog\(\)/,
  );
});

test('function and trigger-relation definitions use parameterized unique OID lookups', () => {
  assert.match(
    readingCatalogSnapshotSql,
    /CROSS JOIN LATERAL \(SELECT p\.oid,p\.proname,p\.pronamespace,p\.proowner FROM pg_catalog\.pg_proc p WHERE p\.oid OPERATOR\(pg_catalog\.=\) wanted\.oid OFFSET 0\) p/,
  );
  assert.match(
    readingCatalogSnapshotSql,
    /CROSS JOIN LATERAL \(SELECT c\.oid,c\.relname,c\.relnamespace FROM pg_catalog\.pg_class c WHERE c\.oid OPERATOR\(pg_catalog\.=\) t\.tgrelid OFFSET 0\) c/,
  );
});

test('parse-time names cannot depend on the caller search path', () => {
  assert.doesNotMatch(readingCatalogSnapshotSql, /::(?!pg_catalog\.)/);
  assert.doesNotMatch(readingCatalogSnapshotSql, /COLLATE (?!pg_catalog\.)/);
  const expression = readingCatalogSnapshotSql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^']*'/g, '')
    .replace(/OPERATOR\(pg_catalog\.(?:=|~~|\|\||>)\)/g, '');
  assert.doesNotMatch(expression, /=|~~|\|\||\bLIKE\b/);
  for (const name of [
    'pg_class',
    'pg_namespace',
    'pg_trigger',
    'pg_proc',
    'pg_attribute',
    'pg_attrdef',
    'pg_constraint',
    'pg_index',
  ])
    assert.doesNotMatch(
      readingCatalogSnapshotSql,
      new RegExp(`(?<!pg_catalog\\.)\\b${name}\\b`),
    );
});

test('one statement captures, computes under fixed path, and restores with LOCAL only', () => {
  assert.equal(
    (readingCatalogSnapshotSql.match(/set_config\(/g) ?? []).length,
    2,
  );
  assert.match(readingCatalogSnapshotSql, /saved_path AS MATERIALIZED/);
  assert.match(readingCatalogSnapshotSql, /captured AS MATERIALIZED/);
  assert.match(readingCatalogSnapshotSql, /restored AS MATERIALIZED/);
  assert.match(
    readingCatalogSnapshotSql,
    /SELECT CASE WHEN pg_catalog\.set_config\('search_path','pg_catalog',true\) OPERATOR\(pg_catalog\.=\) 'pg_catalog'\s+THEN \(WITH relations/,
  );
  assert.match(
    readingCatalogSnapshotSql,
    /CASE WHEN captured\.snapshot IS NOT NULL\s+THEN pg_catalog\.set_config\('search_path',saved_path\.original,true\)/,
  );
  assert.doesNotMatch(
    readingCatalogSnapshotSql,
    /statement_timeout|jit|set_config\([^\n]*false/,
  );
  assert.match(readingCatalogSnapshotSql, /AS "deparsePath"/);
  assert.match(readingCatalogSnapshotSql, /AS "searchPathRestored"/);
});

test('full-preimage differential query differs only in returning that same preimage', () => {
  assert.equal(
    readingCatalogPreimageSql
      .replace(",\n        'preimage',value", '')
      .replace(',decoded.preimage', '')
      .replace(',preimage pg_catalog.text', ''),
    readingCatalogSnapshotSql,
  );
  assert.doesNotMatch(
    readingCatalogSnapshotSql,
    /'preimage',value|decoded\.preimage/,
  );
});

test('trigger partition is disjoint and lossless for every scope/internal combination', () => {
  const triggers = readingCatalogSnapshotSql
    .split('target_triggers AS MATERIALIZED (')[1]!
    .split('), function_oids')[0]!;
  assert.equal(triggers.match(/WHERE NOT t\.tgisinternal/g)?.length, 2);
  assert.equal(triggers.match(/UNION ALL/g)?.length, 1);
  assert.doesNotMatch(triggers, /\bOR\b|\bANY\b|\bLIMIT\b/);
  for (const relationOwned of [false, true])
    for (const globallyNamed of [false, true])
      for (const internal of [false, true]) {
        const original = !internal && (relationOwned || globallyNamed);
        const branchA = !internal && relationOwned;
        const branchB = !internal && globallyNamed && !relationOwned;
        assert.equal(Number(branchA) + Number(branchB), Number(original));
      }
});
