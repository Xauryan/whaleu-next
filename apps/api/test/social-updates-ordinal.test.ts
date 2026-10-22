import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DiscoveryContinuationFacade } from '../src/community/discovery-continuation.module.js';
import { SocialUpdatesCursors } from '../src/notifications/social/cursor.js';
import { SocialUpdatesRepository } from '../src/notifications/social/repository.js';
import type { StoredSocialNotice } from '../src/notifications/social/repository.js';

const account = randomUUID();
const at = '2026-10-20T00:00:00.123456Z';
const highOrdinal = '10000000000000000';
const row: StoredSocialNotice = {
  id: randomUUID(),
  source_id: randomUUID(),
  recipient_account_id: account,
  kind: 'follow',
  ordinal: highOrdinal,
  created_at: at,
  read_at: null,
};

function queryFixture(rows: unknown[]) {
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { tx, queries };
}

test('social head orders the bigint input, not its text output alias', async () => {
  const records = new SocialUpdatesRepository();
  const f = queryFixture([{ ordinal: highOrdinal }]);
  assert.equal(await records.head(account, 'followers', f.tx), highOrdinal);
  assert.deepEqual(f.queries, [
    {
      sql: 'SELECT ordinal::text FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND kind=$2 ORDER BY social_notices.ordinal DESC LIMIT 1',
      parameters: [account, 'follow'],
    },
  ]);
  assert.equal(await records.head(account, 'likes', queryFixture([]).tx), '0');
});

test('social page qualifies timestamp and bigint order while retaining exact numeric seek and lookahead', async () => {
  const records = new SocialUpdatesRepository();
  const f = queryFixture([row]);
  assert.deepEqual(await records.page(account, 'followers', 20, null, f.tx), [
    row,
  ]);
  const before = { beforeAt: at, beforeOrdinal: '9999999999999999' };
  assert.deepEqual(await records.page(account, 'followers', 20, before, f.tx), [
    row,
  ]);
  for (const { sql } of f.queries) {
    assert.match(sql, /ordinal::text/);
    assert.match(
      sql,
      /ORDER BY social_notices\.created_at DESC,social_notices\.ordinal DESC LIMIT/,
    );
    assert.doesNotMatch(sql, /ORDER BY (created_at|ordinal)\b/);
  }
  assert.match(f.queries[0]!.sql, /LIMIT \$3$/);
  assert.deepEqual(f.queries[0]!.parameters, [account, 'follow', 21]);
  assert.match(
    f.queries[1]!.sql,
    /AND \(created_at,ordinal\)<\(\$3::timestamptz,\$4::bigint\)/,
  );
  assert.match(f.queries[1]!.sql, /LIMIT \$5$/);
  assert.deepEqual(f.queries[1]!.parameters, [
    account,
    'follow',
    at,
    '9999999999999999',
    21,
  ]);
});

test('social unread independently keeps numeric order, exclusion and bounded candidate limit', async () => {
  const records = new SocialUpdatesRepository();
  const f = queryFixture([row]);
  const excluded = randomUUID();
  assert.deepEqual(
    await records.unread(account, 'followers', 33, f.tx, excluded),
    [row],
  );
  await records.unread(account, 'likes', 1, f.tx);
  for (const { sql } of f.queries) {
    assert.match(sql, /ordinal::text/);
    assert.match(sql, /WHERE recipient_account_id=\$1 AND kind=\$2/);
    assert.match(sql, /read_at IS NULL AND \(\$4::uuid IS NULL OR id<>\$4\)/);
    assert.match(sql, /ORDER BY social_notices\.ordinal DESC LIMIT \$3$/);
  }
  assert.deepEqual(
    f.queries.map((query) => query.parameters),
    [
      [account, 'follow', 33, excluded],
      [account, 'like', 1, null],
    ],
  );
});

test('v2 social cursor preserves decimal strings through JS-safe and decimal-length boundaries', async () => {
  let stored: unknown;
  const facade = {
    create: async (_scope: string, _account: string, position: unknown) => {
      stored = position;
      return 'opaque';
    },
    get: async (
      _cursor: string,
      _scope: string,
      _tx: PoolClient,
      decode: (value: unknown) => unknown,
    ) => decode(stored),
  } as unknown as DiscoveryContinuationFacade;
  const cursors = new SocialUpdatesCursors(facade);
  for (const ordinal of [
    '9',
    '10',
    '16',
    '99',
    '100',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
    '9999999999999999',
    highOrdinal,
    '9223372036854775807',
  ]) {
    const position = {
      head: ordinal,
      beforeAt: at,
      beforeOrdinal: ordinal,
    };
    assert.equal(
      await cursors.create(account, 'scope', position, {} as PoolClient),
      'opaque',
    );
    assert.deepEqual(await cursors.get('opaque', 'scope', {} as PoolClient), {
      v: 2,
      kind: 'social-updates',
      ...position,
    });
  }
});
