import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const sql = readFileSync(
  new URL(
    '../migrations/0170_community_live_discussion_order.sql',
    import.meta.url,
  ),
  'utf8',
);
test('live ordering cutover is exact, synchronous and fully indexed without rewriting history', () => {
  assert.match(
    sql,
    /LOCK TABLE whaleu_community\.discussion_root_order IN SHARE ROW EXCLUSIVE MODE/,
  );
  assert.match(
    sql,
    /REFERENCES whaleu_community\.discussion_root_order\(root_id\) ON DELETE CASCADE/,
  );
  assert.match(
    sql,
    /SELECT root_id,post_id,created_at,like_count,head_id\s+FROM whaleu_community\.discussion_root_order WHERE live;/,
  );
  assert.match(
    sql,
    /AFTER INSERT OR UPDATE OR DELETE ON whaleu_community\.discussion_root_order FOR EACH ROW/,
  );
  for (const suffix of [
    '(post_id,like_count,created_at,root_id);',
    '(post_id,(-like_count),created_at,root_id);',
    '(post_id,created_at,root_id);',
  ])
    assert.ok(
      sql.includes(`ON whaleu_community.discussion_live_root_order${suffix}`),
    );
  assert.doesNotMatch(
    sql,
    /(?:INSERT INTO|UPDATE|DELETE FROM) whaleu_community\.(?:root_comments|discussion_root_order|discussion_order_events|discussion_order_memberships)\b/,
  );
});
test('live ordering guards direct and nested writes without reversing source locks', () => {
  assert.match(
    sql,
    /BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community\.discussion_live_root_order FOR EACH STATEMENT/,
  );
  assert.match(sql, /pg_trigger_depth\(\)<2/);
  assert.match(sql, /OLD\.root_id IS DISTINCT FROM NEW\.root_id/);
  assert.match(
    sql,
    /NEW\.head_id\) IS DISTINCT FROM \(p\.root_id,p\.post_id,p\.created_at,p\.like_count,p\.head_id\)/,
  );
  assert.match(
    sql,
    /NOT EXISTS\(SELECT 1 FROM whaleu_community\.discussion_root_order WHERE root_id=OLD\.root_id AND live\)/,
  );
  assert.match(sql, /BEFORE TRUNCATE.*discussion_order_immutable\(\)/);
  assert.doesNotMatch(sql, /FOR (?:NO KEY )?UPDATE|FOR SHARE|FOR KEY SHARE/);
});
