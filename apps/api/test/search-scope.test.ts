import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CampusSearchRegionFacade } from '../src/campus/search-region.facade.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import { CommunityPhoneContinuation } from '../src/community/phone-continuation.js';
import { searchQuerySchema } from '../src/community/search/contracts.js';
import {
  federatedSearchPositionSchema,
  searchCursorScope,
  SEARCH_ORDER_ID,
} from '../src/community/search/cursor.js';
import { SEARCH_MATCHER_ID } from '../src/community/search/matching.js';
import { SearchRepository } from '../src/community/search/repository.js';
import {
  CommunitySearchScopeResolver,
  searchMembershipFingerprint,
} from '../src/community/search/scope.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { LocalSafetyPhoneSource } from '../src/verification/safety-phone.source.js';
const unavailable = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE';
const uuid = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function space(
  i: number,
  kind: 'regional' | 'global' = 'regional',
): CommunitySpace {
  return {
    id: uuid(i),
    kind,
    name: 'Synthetic ' + i,
    isActive: true,
    operatingRegionId: kind === 'regional' ? uuid(10000 + i) : null,
  };
}
function catalogHarness(
  spaces: CommunitySpace[],
  activity = new Map(
    spaces
      .filter((s) => s.operatingRegionId)
      .map((s) => [s.operatingRegionId!, true]),
  ),
) {
  const statements: string[] = [],
    lockedRegions: string[] = [],
    batches: number[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      statements.push(sql);
      if (
        sql.includes('FROM whaleu_community.spaces') &&
        sql.includes('LIMIT')
      ) {
        const rows = spaces
          .filter(
            (s) =>
              s.isActive &&
              (values[0] === 'all' || s.kind === values[0]) &&
              (values[1] === null || s.id > (values[1] as string)),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 256);
        return { rows };
      }
      if (sql.includes('FROM whaleu_community.spaces'))
        return {
          rows: spaces
            .filter((s) => (values[0] as string[]).includes(s.id))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      const ids = values[0] as string[];
      if (sql.includes('FOR SHARE')) {
        lockedRegions.push(...ids);
        batches.push(ids.length);
        return { rows: ids.map((id) => ({ id })) };
      }
      return {
        rows: ids
          .filter((id) => activity.has(id))
          .map((id) => ({ id, isActive: activity.get(id) })),
      };
    },
  } as unknown as PoolClient;
  return {
    resolver: new CommunitySearchScopeResolver(new CampusSearchRegionFacade()),
    tx,
    statements,
    lockedRegions,
    batches,
    activity,
  };
}

test('aggregate grammar is a strict disjoint union and does not coerce or accept public source inventories', () => {
  for (const scope of ['all', 'regional', 'global'])
    assert.equal(searchQuerySchema.safeParse({ scope, q: 'x' }).success, true);
  assert.equal(
    searchQuerySchema.safeParse({
      scope: 'regional',
      category: 'trading',
      tradingSubtype: 'shuma',
      q: 'x',
    }).success,
    true,
  );
  for (const patch of [
    {},
    { scope: 'related' },
    { scope: ['all'] },
    { scope: 'all', spaceId: randomUUID() },
    { scope: 'all', category: 'discussion' },
    { scope: 'global', category: 'discussion' },
    { scope: 'regional', tradingSubtype: 'shuma' },
    { scope: 'regional', category: 'discussion', tradingSubtype: 'shuma' },
    { scope: 'regional', category: ['trading'] },
    { scope: 'all', campusId: randomUUID() },
    { scope: 'all', operatingRegionId: randomUUID() },
    { scope: 'all', spaceIds: [randomUUID()] },
    { scope: 'all', membershipFingerprint: 'a'.repeat(64) },
  ])
    assert.equal(
      searchQuerySchema.safeParse({ q: 'x', ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});

test('aggregate cursor intents bind selector/query/filter/limit/account/session and preserve fixed-sized strict v4 metadata', () => {
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 1,
    refreshExpiresAt: 2,
  };
  const q = searchQuerySchema.parse({ scope: 'regional', q: 'x' }),
    hash = searchCursorScope(q, session);
  for (const changed of [
    { ...q, scope: 'all' as const },
    { ...q, q: 'X' },
    { ...q, limit: 9 },
    { ...q, category: 'discussion' as const },
    { ...q, category: 'trading' as const, tradingSubtype: 'shuma' as const },
  ])
    assert.notEqual(searchCursorScope(changed, session), hash);
  assert.notEqual(searchCursorScope(q, null), hash);
  assert.notEqual(
    searchCursorScope(q, { ...session, accountId: randomUUID() }),
    hash,
  );
  assert.notEqual(
    searchCursorScope(q, { ...session, sessionId: randomUUID() }),
    hash,
  );
  const members = Array.from({ length: 5000 }, (_, i) => space(i + 1));
  const fingerprint = searchMembershipFingerprint('regional', members);
  const position = {
    v: 4,
    kind: 'search',
    matcherId: SEARCH_MATCHER_ID,
    orderId: SEARCH_ORDER_ID,
    membershipFingerprint: fingerprint,
    after: { kind: 'post', id: uuid(1), at: '2026-10-08T00:00:00.123456Z' },
    visible: null,
  };
  assert.deepEqual(federatedSearchPositionSchema.parse(position), position);
  assert.ok(JSON.stringify(position).length < 450);
  for (const patch of [
    { v: 1 },
    { membershipFingerprint: 'A'.repeat(64) },
    { membershipFingerprint: 'a'.repeat(63) },
    { members: members.map((s) => s.id) },
    { q: 'private' },
    { after: { ...position.after, spaceId: uuid(9) } },
  ])
    assert.equal(
      federatedSearchPositionSchema.safeParse({ ...position, ...patch })
        .success,
      false,
    );
});

test('fingerprint is order-independent and names-independent but sensitive to exact semantic membership and kind/region', () => {
  const members = [space(1), space(2, 'global'), space(3)];
  const fingerprint = searchMembershipFingerprint('all', members);
  assert.equal(
    searchMembershipFingerprint(
      'all',
      [...members].reverse().map((s) => ({ ...s, name: 'Renamed' })),
    ),
    fingerprint,
  );
  for (const changed of [
    members.slice(1),
    [...members, space(4)],
    members.map((s, i) =>
      i === 0 ? { ...s, operatingRegionId: uuid(999) } : s,
    ),
    members.map((s, i) =>
      i === 0 ? { ...s, kind: 'global' as const, operatingRegionId: null } : s,
    ),
  ])
    assert.notEqual(searchMembershipFingerprint('all', changed), fingerprint);
  assert.throws(
    () => searchMembershipFingerprint('all', [members[0]!, members[0]!]),
    unavailable,
  );
  assert.throws(
    () => searchMembershipFingerprint('global', members),
    unavailable,
  );
});

test('complete catalog resolution exceeds metadata batches, locks regions in global order, excludes only known inactivity and never uses browse or count owners', async () => {
  const spaces = Array.from({ length: 1025 }, (_, i) => space(i + 1));
  for (const [i, s] of spaces.entries()) s.operatingRegionId = uuid(20000 - i);
  spaces.push(space(2000, 'global'), space(2001, 'global'));
  const h = catalogHarness(spaces);
  h.activity.set(spaces[3]!.operatingRegionId!, false);
  const scope = await h.resolver.resolve('all', h.tx);
  assert.equal(scope.members.length, 1026);
  assert.equal(scope.regionalSpaceIds.length, 1024);
  assert.equal(scope.globalSpaceIds.length, 2);
  assert.deepEqual(h.lockedRegions, [...h.lockedRegions].sort());
  assert.ok(h.batches.every((n) => n <= 256));
  assert.equal(scope.space(spaces[3]!.id), undefined);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.members), true);
  assert.equal(Object.isFrozen(scope.members[0]), true);
  assert.doesNotMatch(
    h.statements.join('\n'),
    /identity|affiliation|campuses|assignment|topology|discovery_count/,
  );
  assert.equal(
    scope.membershipFingerprint,
    searchMembershipFingerprint('all', scope.members),
  );
});

test('known empty catalog is distinct from missing malformed and unavailable region facts and partial catalog reread', async () => {
  const empty = catalogHarness([]);
  assert.equal(
    (await empty.resolver.resolve('all', empty.tx)).members.length,
    0,
  );
  const missing = catalogHarness([space(1)], new Map());
  await assert.rejects(
    missing.resolver.resolve('all', missing.tx),
    unavailable,
  );
  const malformed = catalogHarness([{ ...space(1), operatingRegionId: null }]);
  await assert.rejects(
    malformed.resolver.resolve('all', malformed.tx),
    unavailable,
  );
  const h = catalogHarness([space(1)]),
    original = h.tx.query.bind(h.tx);
  h.tx.query = (async (sql: string, values: unknown[]) =>
    sql.includes('ANY($1::uuid[])') && sql.includes('whaleu_community')
      ? { rows: [] }
      : original(sql, values)) as typeof h.tx.query;
  await assert.rejects(h.resolver.resolve('all', h.tx), unavailable);
  const unavailableOwner = new CommunitySearchScopeResolver({
    readSearchRegionActivity: async () => {
      throw new Error('offline');
    },
  } as CampusSearchRegionFacade);
  await assert.rejects(
    unavailableOwner.resolve('all', catalogHarness([space(1)]).tx),
    unavailable,
  );
});

test('Campus search owner rejects oversized, malformed, missing, duplicate and unsorted facts instead of treating unknown as inactive', async () => {
  const owner = new CampusSearchRegionFacade();
  await assert.rejects(
    owner.readSearchRegionActivity(
      Array.from({ length: 257 }, (_, i) => uuid(i + 1)),
      {} as PoolClient,
    ),
    unavailable,
  );
  for (const rows of [
    [],
    [{ id: uuid(1), isActive: null }],
    [
      { id: uuid(1), isActive: false },
      { id: uuid(1), isActive: true },
    ],
    [
      { id: uuid(2), isActive: true },
      { id: uuid(1), isActive: true },
    ],
  ]) {
    const tx = { query: async () => ({ rows }) } as unknown as PoolClient;
    await assert.rejects(
      owner.readSearchRegionActivity(
        rows.length === 2 ? [uuid(1), uuid(2)] : [uuid(1)],
        tx,
      ),
      unavailable,
    );
  }
});

test('aggregate SQL uses one129-coordinate body-independent global order and peek locking never fetches body', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new SearchRepository();
  await repository.candidates(
    {
      regionalSpaceIds: [uuid(1)],
      globalSpaceIds: [uuid(2)],
      category: null,
      tradingSubtype: null,
      excludeUrgentTrading: false,
      types: ['post', 'comment', 'reply'],
      from: null,
      to: null,
      postId: null,
    },
    null,
    tx,
  );
  await repository.lockCandidate('post', uuid(3), tx);
  assert.match(
    calls[0]!.sql,
    /ORDER BY p.published_at DESC,p.id DESC LIMIT 129/,
  );
  assert.doesNotMatch(
    calls.map((c) => c.sql).join('\n'),
    /SELECT \*|p\.text|body|ILIKE|LOWER|resolution|account_id|whaleu_(?:campus|safety|identity)/i,
  );
  assert.match(calls[1]!.sql, /FOR SHARE/);
});

test('independent phone continuation uses only the narrow source with unavailable mapping', async () => {
  const tx = {} as PoolClient;
  for (const status of ['verified', 'unverified', 'unavailable'] as const) {
    const source = {
      resolve: async (accountId: string, transaction: PoolClient) => {
        assert.equal(accountId, uuid(1));
        assert.equal(transaction, tx);
        return status === 'verified'
          ? { status, validUntil: null }
          : { status };
      },
    } as LocalSafetyPhoneSource;
    const proof = new CommunityPhoneContinuation(source);
    if (status === 'unavailable')
      await assert.rejects(proof.verified(uuid(1), tx), unavailable);
    else assert.equal(await proof.verified(uuid(1), tx), status === 'verified');
  }
});

test('additive catalog gates precede count epoch and disclose maintenance relation-lock limits', async () => {
  const sql = await readFile(
    new URL('../migrations/0028_federated_search_catalog.sql', import.meta.url),
    'utf8',
  );
  for (const gate of [
    'a_community_search_catalog_gate',
    'a_campus_search_catalog_gate',
  ])
    assert.ok(gate < 'a_discovery_count_epoch');
  assert.match(
    sql,
    /ALTER TRIGGER identity_region_catalog_gate[\s\S]*RENAME TO a_campus_search_catalog_gate/,
  );
  assert.match(
    sql,
    /BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.spaces/,
  );
  assert.match(sql, /outer-gate-first/);
  assert.match(sql, /relation locks already acquired/);
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE whaleu_|DELETE FROM/);
});
