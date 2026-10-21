/** Static closure evidence only; this does not substitute for executing the SQL. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const sql = readFileSync(
  new URL('../migrations/0176_durable_reading_formatting.sql', import.meta.url),
  'utf8',
);
const names = [
  'reading_format_heads',
  'reading_format_jobs',
  'reading_format_results',
  'reading_format_slots',
];
test('four durable derived relations have immutable/transition, truncate and final graph guards', () => {
  for (const name of names) {
    assert.ok(sql.includes(`CREATE TABLE whaleu_community.${name}`));
    assert.match(
      sql,
      new RegExp(`BEFORE TRUNCATE ON whaleu_community\\.${name}`),
    );
    assert.ok(sql.includes(`'${name}'`));
  }
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s/);
  assert.match(sql, /source_fence\(\)/);
});
test('formal owner remains absent from erasure reviewed allowlist and retains exact reviewed SQL guards', () => {
  const registry = readFileSync(
    new URL('../src/account-deletion/owner-registry.ts', import.meta.url),
    'utf8',
  );
  for (const name of names) assert.equal(registry.includes(name), false);
  const draft = readFileSync(
    new URL('../migration-drafts/reading-formatting.sql', import.meta.url),
    'utf8',
  );
  const body = draft.slice(
    draft.indexOf('CREATE TABLE whaleu_community.reading_format_heads'),
  );
  assert.equal(
    sql.slice(
      sql.indexOf('CREATE TABLE whaleu_community.reading_format_heads'),
      sql.indexOf('-- A migration-created catalog seal'),
    ),
    body + '\n',
  );
  assert.doesNotMatch(
    sql,
    /current_database\(\).*whaleu_test|whaleu-reading-controlled-test/,
  );
  assert.match(sql, /reading_format_catalog\(\)/);
  assert.match(sql, /reading_format_protocol\(\)/);
});
test('source dependencies explicitly fence Identity, Review, canonical source, Media, visibility and category absence', () => {
  const relations = [
    'whaleu_identity.accounts',
    'whaleu_campus.operating_regions',
    'whaleu_community.community_text_sources',
    'whaleu_community.posts',
    'whaleu_community.root_comments',
    'whaleu_community.replies',
    'whaleu_community.spaces',
    'whaleu_community.content_approval_bindings',
    'whaleu_community.content_approval_decisions',
    'whaleu_community.content_approval_events',
    'whaleu_community.content_approval_heads',
    'whaleu_community.content_approval_policies',
    'whaleu_community.post_owner_visibility',
    'whaleu_community.post_category_heads',
    'whaleu_media.bindings',
    'whaleu_media.assets',
    'whaleu_media.upload_intents',
    'whaleu_media.asset_safety_heads',
    'whaleu_media.asset_safety_events',
    'whaleu_safety.account_punishment_heads',
    'whaleu_safety.account_punishments',
    'whaleu_safety.account_punishment_terminals',
  ];
  const late = sql.slice(
    sql.indexOf('CREATE FUNCTION whaleu_community.reading_format_late_guard'),
  );
  for (const relation of relations)
    assert.ok(late.includes(`'${relation}'`), relation);
  assert.match(sql, /passive_bookkeeping/);
  assert.doesNotMatch(sql, /account_punishment_allows\([^\n]*'interaction'/);
});
test('only next_probe_at/job_key forms persisted discovery ordering; retry is separately eligible', () => {
  const runtime = readFileSync(
    new URL('../src/community/reading-formatting/runtime.ts', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /ORDER BY j\.next_probe_at,j\.job_key LIMIT 8/);
  assert.match(runtime, /\(j\.next_probe_at,j\.job_key\)>/);
  assert.match(runtime, /j\.schedule_state IN \('runnable','deferred'\)/);
  assert.match(runtime, /j\.next_probe_at<=clock_timestamp\(\)/);
  assert.doesNotMatch(runtime, /ORDER BY next_probe_at/);
  assert.match(runtime, /next_attempt_at<=instant.now/);
  assert.match(runtime, /interval '5 seconds'/);
  assert.match(runtime, /interval '30 seconds'/);
});
test('independent SQL admission retains old scheduling clocks and server-derived result expiry', () => {
  const claim = sql.slice(
    sql.indexOf("IF NEW.state='running' THEN"),
    sql.indexOf("ELSIF NEW.state='complete' THEN"),
  );
  for (const predicate of [
    "OLD.schedule_state NOT IN ('runnable','deferred')",
    'OLD.next_probe_at IS NULL',
    'OLD.next_probe_at>instant',
    'OLD.next_attempt_at>instant',
    'NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at',
  ])
    assert.ok(claim.includes(predicate), predicate);
  assert.match(sql, /NEW\.lease_until:=j\.lease_until/);
  const deferred = sql.slice(
    sql.indexOf(
      'CREATE FUNCTION whaleu_community.reading_format_graph_assert()',
    ),
    sql.indexOf('-- Late writes'),
  );
  assert.match(deferred, /j\.write_transaction=pg_current_xact_id\(\)/);
  assert.match(
    deferred,
    /reading_format_source_current\(j\.content_kind,j\.content_id\)/,
  );
  assert.match(deferred, /r\.lease_until<=clock_timestamp\(\)/);
});
test('finite formatter URL detection is explicitly ASCII with C regex collation', () => {
  assert.ok(sql.includes('(body COLLATE "C")'));
  assert.ok(sql.includes('(^|[^A-Za-z0-9_])[A-Za-z0-9_]+://'));
  assert.doesNotMatch(sql, /\[\[:alnum:\]\]/);
});

test('retry CASE bounds cannot terminate the PL/pgSQL IF condition at their inner THEN', () => {
  // Source regression for the actual PostgreSQL 18 parse failure. This is not a SQL parser.
  // PL/pgSQL reads an IF expression to the first THEN at parenthesis depth zero.
  const retry = sql.slice(
    sql.indexOf("ELSIF NEW.state='pending' THEN"),
    sql.indexOf("ELSIF NEW.state='exhausted' THEN"),
  );
  assert.ok(
    retry.includes(
      "NEW.next_attempt_at NOT BETWEEN instant+(CASE OLD.claims WHEN 1 THEN interval '4.9 seconds' ELSE interval '29.9 seconds' END) AND instant+(CASE OLD.claims WHEN 1 THEN interval '5.1 seconds' ELSE interval '30.1 seconds' END)",
    ),
  );
  assert.doesNotMatch(retry, /instant\s*\+\s*CASE/);
  assert.ok(retry.includes("'Invalid reading retry'"));
});

test('polymorphic graph trigger binds only fields present on the dispatched relation', () => {
  const graph = sql.slice(
    sql.indexOf(
      'CREATE FUNCTION whaleu_community.reading_format_graph_assert()',
    ),
    sql.indexOf('-- Late writes'),
  );
  assert.match(
    graph,
    /IF TG_TABLE_NAME='reading_format_heads' THEN\s+key:=whaleu_community\.reading_format_key\(NEW\.content_kind,NEW\.content_id,NEW\.source_hash,NEW\.publication_request_id\);\s+ELSIF TG_TABLE_NAME IN \('reading_format_jobs','reading_format_results','reading_format_slots'\) THEN\s+key:=NEW\.job_key;/,
  );
  assert.doesNotMatch(graph, /key:=CASE/);
  assert.ok(graph.includes("'Unexpected reading graph relation'"));
  assert.ok(graph.includes('IF key IS NULL THEN RETURN NULL;END IF;'));
  const late = sql.slice(
    sql.indexOf('CREATE FUNCTION whaleu_community.reading_format_late_guard()'),
  );
  assert.doesNotMatch(late, /\b(?:NEW|OLD)\./);
});

test('real SQL fixture inspection orders canonical timestamp columns, not duplicate text output aliases', () => {
  const fixture = readFileSync(
    new URL('./integration/reading-formatting.test.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    fixture,
    /reading_format_jobs j ORDER BY j\.next_probe_at,j\.job_key/,
  );
  assert.doesNotMatch(fixture, /ORDER BY next_probe_at/);
});
