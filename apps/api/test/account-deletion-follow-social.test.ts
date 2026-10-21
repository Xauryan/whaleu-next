import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import {
  eraseFollowSocial,
  FOLLOW_SOCIAL_PAGE_SIZE,
  followSocialRetention,
} from '../src/account-deletion/owners/follow-social.js';
import {
  INVENTORY_VERSION,
  ownerKeys,
  accountDeletionCapability,
} from '../src/account-deletion/contracts.js';
import {
  supportedTables,
  deletionMetadataRelations,
} from '../src/account-deletion/owner-registry.js';

test('follow-social protocol supersedes legacy follow without enabling public deletion', () => {
  assert.equal(INVENTORY_VERSION, 'account-deletion-local-0173-v1');
  assert.ok(ownerKeys.includes('follow-social'));
  assert.equal(
    (ownerKeys as readonly string[]).includes('legacy-follow'),
    false,
  );
  assert.equal(accountDeletionCapability().status, 'unavailable');
  assert.equal(FOLLOW_SOCIAL_PAGE_SIZE, 100);
  assert.ok(followSocialRetention.some((item) => item.includes('identifiers')));
  for (const table of ['social_sources', 'discovery_cursors'])
    assert.ok(supportedTables.has('whaleu_community.' + table));
  for (const table of [
    'follow_scopes',
    'follow_pages',
    'follow_mutations',
    'follow_source_intents',
    'follow_source_retirements',
    'follow_source_erasures',
    'follow_head_advances',
  ])
    assert.ok(
      deletionMetadataRelations.has('whaleu_account_deletion.' + table),
    );
});

test('owner cannot turn a pending bounded SQL page into a completion receipt', async () => {
  let calls = 0;
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      calls++;
      assert.equal(args[0], 'request');
      assert.match(sql, /follow_social_page/);
      return { rows: [{ complete: false }] };
    },
  } as unknown as PoolClient;
  assert.equal(await eraseFollowSocial(tx, 'request'), null);
  assert.equal(calls, 1);
});

test('owner requires actual final SQL proof instead of manufacturing an empty hash', async () => {
  for (const proof of [null, '', 'not-a-proof']) {
    const tx = {
      query: async (sql: string) => ({
        rows: [
          sql.includes('follow_social_page') ? { complete: true } : { proof },
        ],
      }),
    } as unknown as PoolClient;
    await assert.rejects(
      eraseFollowSocial(tx, 'request'),
      /FOLLOW_SOCIAL_PROOF_UNAVAILABLE/,
    );
  }
  const tx = {
    query: async (sql: string) => ({
      rows: [
        sql.includes('follow_social_page')
          ? { complete: true }
          : { proof: 'a'.repeat(64) },
      ],
    }),
  } as unknown as PoolClient;
  assert.equal(await eraseFollowSocial(tx, 'request'), 'a'.repeat(64));
});

test('source-reviewed SQL exposes finite causal phases rather than generic immutable bypasses', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0173_account_deletion_follow_social.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    sql,
    /DISABLE\s+TRIGGER|session_replication_role|CREATE\s+OR\s+REPLACE\s+FUNCTION\s+whaleu_experience\.immutable_row|set_config\s*\(/i,
  );
  assert.match(sql, /mutation_transaction=pg_current_xact_id\(\)/);
  assert.match(sql, /LIMIT 101/);
  assert.match(
    sql,
    /item_count integer NOT NULL CHECK\(item_count BETWEEN 0 AND 100\)/,
  );
  assert.match(sql, /FOR SHARE NOWAIT/);
  assert.match(sql, /pg_try_advisory_xact_lock/);
  assert.match(sql, /ORDER BY h\.account_id FOR UPDATE NOWAIT/);
  assert.match(sql, /ORDER BY w\.source_id FOR UPDATE NOWAIT/);
  assert.match(sql, /follow_row_key\(\$2,to_jsonb\(t\)\) FOR UPDATE NOWAIT/);
  assert.match(
    sql,
    /outcome='account_deleted' AND notice_id IS NULL AND kind='follow'/,
  );
  assert.match(
    sql,
    /Every removed incoming edge requires exact follower revision evidence/,
  );
  assert.match(
    sql,
    /follow_page_complete AFTER INSERT[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    sql,
    /NOT whaleu_account_deletion\.inventory_current\(NEW.request_id\)/,
  );
  assert.match(sql, /item.supported IS DISTINCT FROM/);
  assert.match(sql, /source_fingerprint=e.source_fingerprint/);
  assert.match(
    sql,
    /coordinator_shape_hash=whaleu_account_deletion\.coordinator_shape\(\)/,
  );
  const cause = sql.match(
    /CREATE FUNCTION whaleu_account_deletion\.follow_cause\(request uuid\)[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(cause);
  assert.match(cause, /c\.request_id=r\.id AND c\.generation=r\.generation/);
  assert.match(cause, /c\.mutation_transaction=pg_current_xact_id\(\)/);
  assert.match(
    cause,
    /a\.deletion_request_id=r\.id AND a\.lifecycle_generation=r\.generation/,
  );
  assert.match(sql, /follow_cursor_position_valid/);
  assert.match(sql, /9223372036854775807/);
  assert.match(
    sql,
    /EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow/,
  );
  assert.match(sql, /BEFORE TRUNCATE ON/);
  assert.match(sql, /Follow and notification ownership is immutable/);
  assert.match(
    sql,
    /Retired or erased social source identity is permanently reserved/,
  );
});
