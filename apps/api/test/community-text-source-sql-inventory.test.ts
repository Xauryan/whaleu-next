/** Static structure evidence only. These assertions do not execute PostgreSQL. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(
  new URL('../migrations/0175_community_text_sources.sql', import.meta.url),
  'utf8',
);
const inherited = readFileSync(
  new URL(
    '../migrations/0138_related_campus_distribution.sql',
    import.meta.url,
  ),
  'utf8',
);
const body = (name: string) => {
  const start = migration.indexOf(`CREATE FUNCTION whaleu_community.${name}(`);
  assert.notEqual(start, -1, name);
  const end = migration.indexOf('$$;', migration.indexOf('AS $$', start));
  assert.notEqual(end, -1, name);
  return migration.slice(start, end);
};
const inventory = migration.slice(
  migration.indexOf('-- Complete post-statement dependency closure'),
);
const dependencies = [
  ...inventory.matchAll(/'(whaleu_[a-z_]+\.[a-z_]+)'/g),
].map((match) => match[1]!);

test('v2 post-write inventory explicitly covers every inherited generation source and direct v6 owner', () => {
  assert.equal(new Set(dependencies).size, dependencies.length);
  // Inspect exact predecessor loops, not a permissive unknown-SQL mock.
  const loops = [
    ...inherited.matchAll(
      /FOREACH (?:rel|relation) IN ARRAY ARRAY\[([^\]]*)\] LOOP\s+EXECUTE format\('CREATE TRIGGER a000_related_(?:actor|admission|distribution)_generation[^;]*;/g,
    ),
  ];
  assert.ok(loops.length >= 3);
  for (const loop of loops)
    for (const match of loop[1]!.matchAll(/'(whaleu_[a-z_]+\.[a-z_]+)'/g))
      assert.ok(dependencies.includes(match[1]!), match[1]);
  for (const relation of [
    'whaleu_community.spaces',
    'whaleu_media.bindings',
    'whaleu_community.community_text_sources',
    'whaleu_safety.account_punishment_heads',
    'whaleu_safety.account_punishments',
    'whaleu_safety.account_punishment_terminals',
    'whaleu_community.publication_cancel_fences',
    'whaleu_media.media_owner_states',
    'whaleu_community.post_distribution_bindings',
    'whaleu_community.trading_listings',
    'whaleu_community.post_rating_target_links',
    'whaleu_community.report_origins',
    'whaleu_community.publication_requests',
    'whaleu_community.outbox',
    'whaleu_community.text_review_requests',
  ])
    assert.ok(dependencies.includes(relation), relation);
  assert.match(
    inventory,
    /AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community\.text_source_recheck_authority\(\)/,
  );
});

test('v2 construction authority is independent of incomplete binding/receipt/effects', () => {
  const authority = body('text_source_authority_assert');
  assert.match(
    authority,
    /text_source_definition\(kind,target,d\.envelope->'scope'\)/,
  );
  assert.match(
    authority,
    /text_source_intent_hash\(e,s\.requested_author_mode\)/,
  );
  assert.match(authority, /text_source_review_current\(s\.decision_id,true\)/);
  assert.doesNotMatch(
    authority,
    /FROM whaleu_community\.(content_approval_bindings|report_origins|outbox)/,
  );
  assert.doesNotMatch(authority, /receipt->/);
  assert.match(
    body('text_source_recheck_transaction'),
    /text_source_assert\(s\.content_kind,s\.content_id\)/,
  );
  assert.match(
    body('text_source_recheck_authority'),
    /IF TG_OP='TRUNCATE' THEN PERFORM whaleu_community\.text_source_assert/,
  );
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER text_source_causal_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED/,
  );
});

test('v2 three active cohorts use server-stamped transactions, never xmin or timestamps', () => {
  const capture = body('text_source_cohort_capture');
  assert.match(
    capture,
    /NEW\.text_source_issuance_transaction IS NOT NULL THEN RAISE/,
  );
  assert.match(
    capture,
    /NEW\.text_source_transition_transaction IS DISTINCT FROM OLD\.text_source_transition_transaction THEN/,
  );
  assert.match(
    capture,
    /OLD\.decision_id IS NULL AND NEW\.decision_id IS NOT NULL/,
  );
  assert.match(
    capture,
    /NEW\.text_source_transition_transaction:=pg_current_xact_id\(\)/,
  );
  assert.match(
    capture,
    /NEW\.account_id,NEW\.client_request_id,NEW\.operation,NEW\.intent_hash/,
  );
  const review = body('text_source_review_cohorts_assert');
  assert.match(
    review,
    /text_source_transition_transaction=pg_current_xact_id\(\)/,
  );
  assert.match(
    review,
    /text_source_issuance_transaction=pg_current_xact_id\(\)/,
  );
  assert.match(review, /text_source_review_assert\(d\.envelope\)/);
  assert.doesNotMatch(
    review,
    /content_approval_heads|result='allow'|consume_until/,
  );
  assert.doesNotMatch(capture + review, /xmin|created_at=|evaluated_at=/);
  assert.match(
    migration,
    /envelope_version<>6 AND text_source_issuance_transaction IS NULL/,
  );
  assert.match(
    migration,
    /envelope->>'version'<>'6' AND text_source_transition_transaction IS NULL/,
  );
});

test('v2 latest exact consumption does not filter unusable newer decisions or revoke durable reads', () => {
  const current = body('text_source_review_current');
  const selector = current.slice(
    current.indexOf('AND (NOT consume OR d.id='),
    current.indexOf('AND (d.visibility_until IS NULL OR isfinite'),
  );
  assert.match(
    selector,
    /latest\.account_id,latest\.operation,latest\.envelope_version,latest\.digest/,
  );
  assert.match(
    selector,
    /ORDER BY latest\.evaluated_at DESC,latest\.id DESC LIMIT 1/,
  );
  assert.doesNotMatch(
    selector,
    /latest\.result|latest\.coverage|latest\.provenance|JOIN/,
  );
  assert.match(
    body('text_source_ancestors_current'),
    /text_source_review_current\(b\.decision_id\)/,
  );
  assert.doesNotMatch(
    body('text_source_ancestors_current'),
    /text_source_review_current\(b\.decision_id,true\)/,
  );
});

test('installed inventory selects exact original generation domains and shapes, not applicability', () => {
  const suite = readFileSync(
    new URL(
      './integration/community-text-source-storage.test.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    suite,
    /encode\(t\.tgargs,'hex'\) IN \('6163746f7200','61646d697373696f6e00','646973747269627574696f6e00'\)/,
  );
  assert.match(
    suite,
    /t\.tgtype=62 OR \(t\.tgrelid='whaleu_media\.bindings'::regclass AND t\.tgtype=58\)/,
  );
  assert.match(
    suite,
    /related_sync_media_binding_insert\(\)'::regprocedure AND t\.tgtype=4/,
  );
  assert.doesNotMatch(
    inventory,
    /'whaleu_community\.related_sync_polic(?:ies|y_heads)'/,
  );
});
