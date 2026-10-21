import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('cover owner-epoch source joins all unchanged administrative inventories', () => {
  const migration = readFileSync(
    new URL(
      '../migrations/0166_profile_cover_admin_inventory.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const owner of ['post', 'discussion']) {
    assert.match(
      migration,
      new RegExp(
        `CREATE TRIGGER a00_admin_${owner}_removal_source_statement\\s+BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE\\s+ON whaleu_media\\.profile_cover_request_markers\\s+FOR EACH STATEMENT\\s+EXECUTE FUNCTION whaleu_community\\.admin_${owner}_removal_source_statement_guard\\(\\);`,
      ),
    );
    assert.ok(migration.includes(`admin_${owner}_removal_inventory_current()`));
  }
  assert.match(
    migration,
    /CREATE TRIGGER a00_avatar_moderation_media_statement\s+BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE\s+ON whaleu_media\.profile_cover_request_markers\s+FOR EACH STATEMENT\s+EXECUTE FUNCTION whaleu_profile\.avatar_moderation_media_statement_guard\(\);/,
  );
  assert.ok(migration.includes('avatar_moderation_media_inventory_current()'));
  assert.doesNotMatch(
    migration,
    /DISABLE TRIGGER|DROP TRIGGER|CREATE OR REPLACE FUNCTION|RETURN true/i,
    'the fix adds the missing source guards without bypassing inventories',
  );
});
