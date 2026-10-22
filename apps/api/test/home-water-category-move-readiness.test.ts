import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reclassificationCommandSchema } from '../src/community/category-reclassification/contracts.js';
import type { CategoryCommandReviewEnvelope } from '../src/community/category-reclassification/proof-contracts.js';

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

test('original water evidence can be represented without becoming a command target', () => {
  const previous: CategoryCommandReviewEnvelope['previous'] = {
    revision: 0,
    eventId: null,
    category: 'water',
  };
  assert.equal(previous.category, 'water');
  const command = {
    clientRequestId: '00000000-0000-4000-8000-000000000001',
    postId: '00000000-0000-4000-8000-000000000002',
    expectedRevision: 0,
    targetCategory: 'water',
  };
  assert.equal(reclassificationCommandSchema.safeParse(command).success, false);
  assert.equal(
    reclassificationCommandSchema.safeParse({
      ...command,
      targetCategory: 'discussion',
    }).success,
    true,
  );
});

test('0178 alone does not claim water move-out: its existing category owner still excludes V7 sources', () => {
  // Structural readiness audit, not a substitute for a PostgreSQL transition test.
  // A separately admitted successor must replace this explicit limitation test.
  const category = migration('0127_scoped_category_reclassification.sql');
  const rating = migration('0148_community_rating_target_links.sql');
  const home = migration('0178_home_publication_protocol.sql');
  assert.match(
    category,
    /AND whaleu_community\.post_category_candidate\(p\.category\) AND b\.envelope_version IN\(1,2\)/,
  );
  assert.match(
    category,
    /original_category text NOT NULL CHECK\(whaleu_community\.post_category_candidate\(original_category\)\)/,
  );
  assert.match(
    category,
    /previous_category text NOT NULL CHECK\(whaleu_community\.post_category_candidate\(previous_category\)\)/,
  );
  assert.match(rating, /post_category_supported_pre_rating_link\(postid\)/);
  assert.doesNotMatch(
    home,
    /CREATE(?: OR REPLACE)? FUNCTION whaleu_community\.post_category_(?:supported|policy_allows|policy_definition_valid)\s*\(/,
  );
  assert.match(
    home,
    /OR EXISTS\(SELECT 1 FROM whaleu_community\.post_category_heads WHERE post_id=p\.id\)/,
  );
});
