/** Static source evidence only; PostgreSQL execution lives in the integration suite. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const sql = read('0178_home_publication_protocol.sql');
const predecessor = read('0175_community_text_sources.sql');
function body(source: string, name: string): string {
  const match = new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION whaleu_community\\.${name}\\([\\s\\S]*?AS (\\$\\w*\\$)([\\s\\S]*?)\\1;`,
  ).exec(source);
  assert.ok(match, name);
  return match[2]!;
}

test('forward migration verifies literal predecessor source hashes before adapting or resealing', () => {
  const guards = [
    ...sql.matchAll(
      /\('whaleu_community\.([a-z_]+)\([^']*\)','([a-f0-9]{64})',/g,
    ),
  ];
  assert.equal(guards.length, 39);
  const sources = readdirSync(new URL('../migrations/', import.meta.url))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < '0178_')
    .map(read);
  for (const [, name, digest] of guards) {
    const source = sources.findLast((text) =>
      new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION whaleu_community\\.${name}\\(`,
      ).test(text),
    );
    assert.ok(source, name);
    assert.equal(
      createHash('sha256').update(body(source, name!)).digest('hex'),
      digest,
      name,
    );
  }
  assert.ok(sql.indexOf('DO $preimage$') < sql.indexOf('ALTER FUNCTION'));
  assert.match(
    sql,
    /reading_format_protocol\(\)->>'catalog' IS DISTINCT FROM whaleu_community\.reading_format_catalog\(\)/,
  );
  assert.doesNotMatch(
    sql,
    /^GRANT\s|SECURITY\s+DEFINER|DISABLE TRIGGER|session_replication_role|^INSERT INTO whaleu_community\.home_publication_(?:head|activations)/im,
  );
});

test('legacy scalar functions remain intact behind exact new-domain dispatch', () => {
  for (const [name, signature] of [
    ['profile_moderation_definition', 'text,uuid,jsonb'],
    ['text_source_definition', 'text,uuid,jsonb'],
    ['text_source_review_current', 'uuid,boolean'],
    ['text_source_assert', 'text,uuid'],
    ['text_source_authority_assert', 'text,uuid'],
    ['reading_format_source_current', 'text,uuid'],
  ]) {
    assert.ok(
      sql.includes(
        `ALTER FUNCTION whaleu_community.${name}(${signature}) RENAME TO ${name}_pre_home;`,
      ),
    );
    assert.ok(body(sql, name!).includes(`${name}_pre_home(`));
  }
  assert.doesNotMatch(
    sql,
    /(?:CREATE OR REPLACE|ALTER) FUNCTION whaleu_community\.(?:text_source_intent_hash|text_source_hash|content_canonical_json)\(/,
  );
  for (const name of [
    'content_binding_dm_definition',
    'related_review_policy_guard',
  ]) {
    const old = body(predecessor, name);
    const adapted = body(sql, name);
    assert.ok(adapted.startsWith(old.slice(0, old.indexOf('BEGIN') + 5)));
    assert.ok(adapted.endsWith(old.slice(old.indexOf('BEGIN') + 5)));
  }
});

test('renamed legacy qualified parameters are narrowly transformed after exact body preimage checks', () => {
  assert.match(sql, /DO \$relabel\$/);
  for (const name of ['text_source_assert', 'reading_format_source_current']) {
    const source =
      name === 'text_source_assert'
        ? predecessor
        : read('0176_durable_reading_formatting.sql');
    const original = body(source, name);
    assert.equal(original.split(`${name}.kind`).length - 1, 1);
    assert.ok(
      sql.includes(createHash('sha256').update(original).digest('hex')),
    );
  }
  assert.match(
    sql,
    /replace\(definition,qualified,item\.name\|\|'_pre_home\.kind'\)/,
  );
});

test('source absence is explicit and stored original receipt remains independent of effective classification', () => {
  assert.match(
    body(sql, 'home_envelope_valid'),
    /\(\(e->'textSource'\)-'sourceHash'\)/,
  );
  assert.match(
    body(sql, 'home_definition'),
    /descriptor IS DISTINCT FROM d\.envelope->'textSource'/,
  );
  assert.match(
    body(sql, 'home_publication_assert'),
    /\(\(e->'textSource'='null'::jsonb\) IS DISTINCT FROM \(s\.content_id IS NULL\)\)/,
  );
  for (const evidence of [
    'q.payload_hash',
    's.original_intent_hash',
    's.requested_author_mode',
    "receipt->>'outcome'",
    "receipt->>'resourceId'",
    "receipt->>'requestId'",
    'publication_cancel_fences',
    'report_origins',
    'outbox',
  ])
    assert.ok(
      body(sql, 'home_publication_assert').includes(evidence),
      evidence,
    );
  assert.match(
    body(sql, 'home_review_admitted'),
    /authorization_category:=i->>'category'/,
  );
  assert.match(
    body(sql, 'home_review_admitted'),
    /text_source_destination_current[\s\S]*authorization_category/,
  );
  assert.match(
    body(sql, 'home_parent_current'),
    /value->'homeParent' IS DISTINCT FROM jsonb_build_object\('postId',n.id,'decisionId',b.decision_id,'digest',b.digest\)/,
  );
});

test('immutable activation is separate from metadata and Review with fail-closed expiry', () => {
  const current = body(sql, 'home_publication_current');
  assert.match(
    current,
    /IF NOT EXISTS\(SELECT 1 FROM whaleu_community.home_publication_head WHERE slot=1\) THEN RETURN NULL/,
  );
  assert.match(
    current,
    /valid_until<=clock_timestamp\(\)[\s\S]*RAISE EXCEPTION/,
  );
  assert.match(
    body(sql, 'home_publication_preparation_guard'),
    /NEW.issued_at IS DISTINCT FROM date_trunc\('milliseconds',statement_timestamp\(\)\)/,
  );
  assert.match(
    body(sql, 'home_publication_activation_guard'),
    /p.expires_at<=clock_timestamp\(\)/,
  );
  assert.match(
    body(sql, 'home_activation_payload_current'),
    /sourceReviewPolicyId[\s\S]*issuer=p->>'operator'/,
  );
  assert.match(
    body(sql, 'home_review_assert'),
    /policy IS DISTINCT FROM \(CASE/,
  );
  assert.match(body(sql, 'home_review_admitted'), /home_parent_current\(e\)/);
});

test('late closure covers inherited sources plus Home metadata, source, receipts and current policy', () => {
  const oldInventory = predecessor.slice(
    predecessor.indexOf('-- Complete post-statement dependency closure'),
  );
  const inventory = sql.slice(
    sql.indexOf('-- Full post-statement dependency closure'),
  );
  for (const [, relation] of oldInventory.matchAll(
    /'(whaleu_[a-z_]+\.[a-z_]+)'/g,
  ))
    assert.ok(inventory.includes(`'${relation}'`), relation);
  for (const relation of [
    'home_post_dispositions',
    'home_discussion_parent_bindings',
    'home_policy_head',
    'home_publication_head',
  ])
    assert.ok(inventory.includes(`'whaleu_community.${relation}'`));
  assert.match(
    inventory,
    /AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT/,
  );
  assert.match(
    inventory,
    /home_causal_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    body(sql, 'home_review_capture'),
    /NEW.home_issuance_transaction IS NOT NULL THEN RAISE/,
  );
  assert.match(
    body(sql, 'home_review_capture'),
    /OLD.decision_id IS NULL AND NEW.decision_id IS NOT NULL/,
  );
  assert.doesNotMatch(
    body(sql, 'home_publication_authority'),
    /receipt->|'created' AND/,
  );
});

test('durable distribution proof never turns admission expiry into a public fallback', () => {
  const proof = body(sql, 'home_post_disposition_valid');
  assert.match(
    proof,
    /h.publication_transaction IS DISTINCT FROM p.publication_transaction/,
  );
  assert.match(proof, /home_policy_admissions WHERE id=/);
  assert.match(
    proof,
    /h.evidence->'admission' IS DISTINCT FROM jsonb_build_object/,
  );
  assert.doesNotMatch(
    proof,
    /home_policy_head|home_publication_head|clock_timestamp|home_review_current|home_definition/,
  );
  const formatting = body(sql, 'reading_format_source_current');
  assert.match(formatting, /passive_bookkeeping/);
  assert.match(
    formatting,
    /s.source_format<>'plain' OR s.reading_formatting IS DISTINCT FROM 'auto'/,
  );
  assert.match(formatting, /CASE kind WHEN 'post' THEN 300 ELSE 200 END/);
  assert.doesNotMatch(
    sql,
    /CREATE OR REPLACE FUNCTION whaleu_community.reading_format_(?:job_guard|slot_guard|plan|result_guard)/,
  );
});
