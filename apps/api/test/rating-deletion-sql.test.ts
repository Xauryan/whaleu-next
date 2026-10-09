import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const sql = readFileSync(
  new URL('../migrations/0053_rating_deletion_authority.sql', import.meta.url),
  'utf8',
);
const effects = readFileSync(
  new URL(
    '../migrations/0046_rating_effects_and_source_registry.sql',
    import.meta.url,
  ),
  'utf8',
);
const subscriptions = readFileSync(
  new URL(
    '../migrations/0051_rating_target_subscriptions.sql',
    import.meta.url,
  ),
  'utf8',
);
function body(source: string, name: string) {
  const result = source.match(
    new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION whaleu_ratings\\.${name}\\([\\s\\S]*?END \\$\\$;`,
    ),
  );
  assert.ok(result, name);
  return result[0];
}
test('administrator deletion extends exact typed effect shapes without changing versions one through three', () => {
  const previous = subscriptions.match(
    /ADD CONSTRAINT rating_effect_typed_version CHECK\(([\s\S]*?)\n\);/,
  )![1]!;
  const current = sql.match(
    /ADD CONSTRAINT rating_effect_typed_version CHECK\(([\s\S]*?)\n\);/,
  )![1]!;
  assert.equal(
    current
      .split('\n OR (source_version=4')[0]!
      .replaceAll(' AND admin_delete_audit_id IS NULL', ''),
    previous,
  );
  assert.match(
    current,
    /source_version=4 AND rule_version='rating-admin-delete-v1'/,
  );
  assert.match(current, /event_kind IN \('root_deleted','reply_deleted'\)/);
  assert.match(
    current,
    /expected_experience_units=0 AND expected_direct_notice_obligations=0/,
  );
  const oldRecord = body(effects, 'record_effect');
  const newRecord = body(sql, 'record_effect');
  const ownerBranch = ' INSERT INTO whaleu_ratings.effect_events(id,event_kind';
  assert.equal(
    newRecord.slice(newRecord.indexOf(ownerBranch)),
    oldRecord.slice(oldRecord.indexOf(ownerBranch)),
  );
});
test('cleanup preserves immutable rows and keeps public insert-only parent checks', () => {
  const reply = body(sql, 'reply_change');
  assert.match(reply, /targets WHERE id=NEW.target_id FOR UPDATE NOWAIT/);
  assert.match(
    reply,
    /comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT/,
  );
  assert.ok(
    reply.indexOf("IF TG_OP='UPDATE'") <
      reply.indexOf(
        'IF t.active IS DISTINCT FROM true OR r.deleted_at IS NOT NULL',
      ),
  );
  assert.match(reply, /Invalid direct reply ancestry/);
  assert.match(
    reply,
    /to_jsonb\(NEW\)-ARRAY\['deleted_at','delete_request_id','admin_delete_audit_id','revision'\]/,
  );
  assert.match(body(sql, 'root_parent_lock'), /TG_OP='UPDATE' OR active/);
  assert.doesNotMatch(
    sql,
    /DROP TRIGGER (?:rating_reply_review|rating_comment_review|rating_reply_head|z_rating_root_order_content)/,
  );
});
test('audit, transition, receipt and lifecycle event retain bidirectional exact links', () => {
  assert.match(sql, /rating_deletion_exact_cause CHECK/);
  assert.match(
    sql,
    /effective_comment_transition_id uuid REFERENCES whaleu_ratings.comment_transitions/,
  );
  assert.match(
    sql,
    /effective_reply_transition_id uuid REFERENCES whaleu_ratings.reply_transitions/,
  );
  assert.match(
    sql,
    /WHEN\(NEW.operation NOT IN \('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply'\)\)/,
  );
  assert.match(
    sql,
    /CREATE CONSTRAINT TRIGGER rating_admin_delete_audit_complete/,
  );
  assert.match(sql, /CREATE CONSTRAINT TRIGGER rating_admin_request_causal/);
  assert.match(
    body(sql, 'transition_effect_complete'),
    /e.actor_account_id,e.request_id[\s\S]*\(actor,request/,
  );
  assert.match(
    body(sql, 'transition_effect_complete'),
    /Reply continuation head incomplete/,
  );
  assert.match(
    body(sql, 'verify_admin_delete_request'),
    /Administrator noop cannot create a lifecycle effect/,
  );
  assert.match(
    body(sql, 'verify_admin_delete_request'),
    /whaleu_ratings.subscription_fanout_sources/,
  );
});
test('origin evidence and audits are empty, immutable and independently scoped', () => {
  assert.doesNotMatch(
    sql,
    /INSERT INTO whaleu_ratings\.(?:target_origin_sources|target_origin_heads|admin_delete_audits)/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER rating_origin_source_immutable BEFORE UPDATE OR DELETE/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER rating_admin_delete_audit_immutable BEFORE UPDATE OR DELETE/,
  );
  assert.match(sql, /rating_origin_retain BEFORE TRUNCATE/);
  assert.match(sql, /rating_admin_delete_audit_retain BEFORE TRUNCATE/);
  assert.match(body(sql, 'origin_head_guard'), /NEW.revision<=OLD.revision/);
  assert.match(
    body(sql, 'admin_delete_audit_guard'),
    /region->>'coverage'='complete' AND community_group->>'coverage'='complete'/,
  );
  assert.doesNotMatch(
    body(sql, 'admin_delete_audit_guard'),
    /category_id|affiliation|is_active/,
  );
});
