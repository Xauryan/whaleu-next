import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import { registerTransactionDeadline } from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { ApplicationErrorCode } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import type {
  CommunityRepository,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunitySpace, PostView } from '../src/community/contracts.js';
import type { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
import {
  searchAnchorFollows,
  searchPositionSchema,
} from '../src/community/search/cursor.js';
import type {
  SearchAnchor,
  SearchPosition,
} from '../src/community/search/cursor.js';
import type { SearchQuery } from '../src/community/search/contracts.js';
import type {
  SearchCandidate,
  SearchRepository,
  SearchStructuralScope,
} from '../src/community/search/repository.js';
import { SearchService } from '../src/community/search/service.js';
import { requireAllowedSafetyRelationship } from '../src/safety/relationship-proof.js';

const spaceId = randomUUID();
const ownerId = randomUUID();
function errorCode(code: ApplicationErrorCode) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === code;
}
interface Fixture {
  post: StoredPost;
  at: string;
  allowed: boolean | 'unavailable';
  listing: {
    subtype: string;
    urgency: 'normal' | 'urgent';
    resolution: 'open' | 'resolved';
  } | null;
}
function fixtures(count: number): Fixture[] {
  return Array.from({ length: count }, (_, index) => {
    const at = `2026-10-08T00:00:00.${String(999999 - index).padStart(6, '0')}Z`;
    return {
      post: {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        space_id: spaceId,
        account_id: ownerId,
        category: 'discussion',
        text: 'no match',
        author_mode: 'named',
        comments_policy: 'open',
        visibility: 'approved',
        deleted_at: null,
        published_at: new Date(at),
      },
      at,
      allowed: true,
      listing: null,
    };
  });
}
function harness(rows: Fixture[]) {
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 9999999999999,
    refreshExpiresAt: 9999999999999,
  };
  const space: CommunitySpace = {
    id: spaceId,
    kind: 'regional',
    name: 'Synthetic region',
    isActive: true,
    operatingRegionId: randomUUID(),
  };
  const state = {
    now: Date.parse('2026-10-08T00:00:00.000Z'),
    phone: 'verified' as 'verified' | 'unverified' | 'unavailable',
    phoneUntil: null as number | null,
    sessionUntil: null as number | null,
    sessionError: null as ApplicationErrorCode | null,
    sessionChecks: 0,
    candidateCalls: 0,
    namedProof: false,
    finalOutgoing: false,
    beforeCandidates: null as ((call: number) => void) | null,
    beforeLock: null as ((id: string) => void) | null,
    afterSerialize: null as (() => void) | null,
    afterCreate: null as (() => void) | null,
    afterSession: null as (() => void) | null,
    corruptCandidates: null as SearchCandidate[] | null,
  };
  const events: string[] = [];
  const inspected: string[] = [];
  const serialized: string[] = [];
  const locked: string[] = [];
  const records = new Map<
    string,
    { scope: string; position: SearchPosition }
  >();
  let pending: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      events.push(sql);
      if (sql.startsWith('BEGIN')) pending = [];
      if (sql === 'ROLLBACK')
        for (const token of pending) records.delete(token);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('WITH ORDINALITY AS r(viewer,author,bilateral')) {
        const viewers = values[0] as string[];
        return {
          rows: viewers.map((_, i) => ({
            ordinal: i + 1,
            outgoing: state.finalOutgoing,
            incoming: false,
          })),
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.now) }] };
      return { rows: [] };
    },
    release: () => events.push('released'),
  } as unknown as PoolClient;
  const community = {
    database: {
      transaction: <T>(
        operation: (tx: PoolClient) => Promise<T>,
        options: { isolationLevel?: 'read committed' },
      ) => {
        assert.equal(options.isolationLevel, 'read committed');
        return inTransaction(
          { connect: async () => tx } as unknown as Pick<Pool, 'connect'>,
          operation,
          options,
        );
      },
    },
    space: async () => {
      events.push('space');
      return space;
    },
    post: async (id: string) => {
      events.push('post');
      locked.push(id);
      state.beforeLock?.(id);
      const row = rows.find((item) => item.post.id === id);
      if (!row) throw new ApplicationError('POST_NOT_FOUND');
      return row.post;
    },
  } as unknown as CommunityRepository;
  const identity = {
    session: async (_token: string, client: PoolClient) => {
      events.push('session');
      state.sessionChecks++;
      if (state.sessionError) throw new ApplicationError(state.sessionError);
      registerTransactionDeadline(
        client,
        state.sessionUntil,
        'ACCESS_TOKEN_EXPIRED',
      );
      state.afterSession?.();
      return session;
    },
  } as unknown as IdentityService;
  const access = {
    authority: async (
      _actor: string,
      _space: CommunitySpace,
      client: PoolClient,
      context: unknown,
    ) => {
      events.push('authority');
      assert.deepEqual(context, { phoneOnly: true });
      if (state.phone === 'unavailable')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (state.phone === 'verified')
        registerTransactionDeadline(
          client,
          state.phoneUntil,
          'PHONE_VERIFICATION_REQUIRED',
        );
      return { phoneVerified: state.phone === 'verified' };
    },
    advisory: async () => {
      events.push('advisory');
      return null;
    },
    visible: async (
      actor: string | null,
      post: StoredPost,
      client: PoolClient,
      purpose: string,
    ) => {
      events.push('visible');
      inspected.push(post.id);
      assert.equal(purpose, 'list_projection');
      const row = rows.find((item) => item.post.id === post.id)!;
      if (row.allowed === 'unavailable')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (
        row.allowed &&
        state.namedProof &&
        actor &&
        post.author_mode === 'named'
      )
        requireAllowedSafetyRelationship(
          actor,
          post.account_id,
          'list_projection',
          client,
        );
      return row.allowed;
    },
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async (post: StoredPost) => {
      events.push('serialize');
      serialized.push(post.id);
      state.afterSerialize?.();
      return {
        id: post.id,
        text: post.text,
        publishedAt: post.published_at.toISOString(),
      } as PostView;
    },
  } as unknown as CommunitySerializer;
  const cursors = {
    get: async (
      token: string,
      scope: string,
      _tx: PoolClient,
      parse: (value: unknown) => SearchPosition,
    ) => {
      events.push('cursor:get');
      const record = records.get(token);
      if (!record) throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      if (record.scope !== scope)
        throw new BadRequestException('Invalid request');
      try {
        return parse(record.position);
      } catch {
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      }
    },
    create: async (scope: string, _bucket: unknown, value: unknown) => {
      events.push('cursor:create');
      const position = searchPositionSchema.parse(value);
      const token = randomBytes(32).toString('base64url');
      records.set(token, { scope, position });
      pending.push(token);
      state.afterCreate?.();
      return token;
    },
  } as unknown as DiscoveryCursorRepository;
  const searches = {
    candidates: async (
      scope: SearchStructuralScope,
      after: SearchAnchor | null,
    ) => {
      events.push('candidates');
      state.beforeCandidates?.(++state.candidateCalls);
      assert.deepEqual(Object.keys(scope).sort(), [
        'category',
        'excludeUrgentTrading',
        'spaceId',
        'tradingSubtype',
      ]);
      if (state.corruptCandidates) return state.corruptCandidates;
      return rows
        .filter(
          (row) =>
            row.post.space_id === scope.spaceId &&
            row.post.visibility === 'approved' &&
            row.post.deleted_at === null &&
            (scope.category === null || row.post.category === scope.category) &&
            (scope.tradingSubtype === null ||
              row.listing?.subtype === scope.tradingSubtype) &&
            (!scope.excludeUrgentTrading || row.listing?.urgency !== 'urgent'),
        )
        .map((row) => ({ id: row.post.id, at: row.at }))
        .filter((row) => after === null || searchAnchorFollows(row, after))
        .sort((a, b) =>
          searchAnchorFollows(a, b) ? 1 : searchAnchorFollows(b, a) ? -1 : 0,
        )
        .slice(0, 129);
    },
    exactAnchor: async (anchor: SearchAnchor) =>
      rows.find((row) => row.post.id === anchor.id)?.at === anchor.at,
    tradingFilter: async (id: string) =>
      rows.find((row) => row.post.id === id)?.listing ?? null,
  } as unknown as SearchRepository;
  return {
    service: new SearchService(
      community,
      access,
      serializer,
      identity,
      cursors,
      searches,
    ),
    state,
    space,
    session,
    events,
    inspected,
    serialized,
    locked,
    records,
  };
}
const query: SearchQuery = { spaceId, q: 'whale', limit: 10 };

// A denied body is a trap: even reading it, not just matching it, fails the test.
function privateBody(row: Fixture) {
  Object.defineProperty(row.post, 'text', {
    get: () => {
      throw new Error('denied body accessed');
    },
  });
}

test('search authorizes before matching; nonmatching and sentinel cards never serialize or evaluate their body', async () => {
  const rows = fixtures(129);
  rows[0]!.allowed = false;
  privateBody(rows[0]!);
  rows[1]!.post.text = '  WhAlE\r\n原样  ';
  privateBody(rows[128]!);
  const h = harness(rows);
  const result = await h.service.search('token', query);
  assert.equal(result.continuation, 'scan_pending');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.text, '  WhAlE\r\n原样  ');
  assert.deepEqual(h.serialized, [rows[1]!.post.id]);
  assert.equal(h.inspected.length, 128);
  assert.equal(h.inspected.includes(rows[128]!.post.id), false);
  assert.deepEqual([...new Set(h.locked)], [...new Set(h.locked)].sort());
  const record = h.records.get(result.nextCursor!)!;
  assert.deepEqual(record.position.after, {
    id: rows[127]!.post.id,
    at: rows[127]!.at,
  });
  assert.deepEqual(record.position.visible, {
    id: rows[1]!.post.id,
    at: rows[1]!.at,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'continuation',
    'items',
    'nextCursor',
  ]);
  const creation = h.events.indexOf('cursor:create');
  assert.equal(h.events[creation - 1], 'session');
  assert.equal(
    h.events
      .slice(creation + 1)
      .some((x) =>
        [
          'post',
          'visible',
          'serialize',
          'authority',
          'candidates',
          'session',
        ].includes(x),
      ),
    false,
  );
});

test('sparse matches beyond the old 1024 cap progress in bounded structural batches; exact128 ends without sentinel request', async () => {
  const rows = fixtures(1100);
  rows[1099]!.post.text = 'whale';
  const h = harness(rows);
  let cursor: string | undefined;
  let pages = 0;
  let final;
  do {
    final = await h.service.search('token', {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    pages++;
    if (final.nextCursor) {
      const record = h.records.get(final.nextCursor)!;
      if (cursor)
        assert.equal(
          searchAnchorFollows(
            record.position.after,
            h.records.get(cursor)!.position.after,
          ),
          true,
        );
      assert.equal(final.continuation, 'scan_pending');
    }
    cursor = final.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(pages, 9);
  assert.equal(final.continuation, 'end');
  assert.deepEqual(
    final.items.map((item) => item.id),
    [rows[1099]!.post.id],
  );
  assert.equal(h.serialized.length, 1);
  const exact = harness(fixtures(128));
  assert.deepEqual(await exact.service.search(null, query), {
    items: [],
    nextCursor: null,
    continuation: 'end',
  });
  assert.equal(exact.records.size, 0);
});

test('full page uses structural more, not proof of another match, and stops before off-page visibility', async () => {
  const rows = fixtures(3);
  rows[0]!.post.text = 'whale';
  rows[1]!.post.text = 'WHale';
  rows[2]!.allowed = 'unavailable';
  const h = harness(rows);
  const first = await h.service.search('token', { ...query, limit: 2 });
  assert.equal(first.continuation, 'more');
  assert.equal(first.items.length, 2);
  assert.deepEqual(
    h.inspected,
    rows.slice(0, 2).map((row) => row.post.id),
  );
  await assert.rejects(
    h.service.search('token', {
      ...query,
      limit: 2,
      cursor: first.nextCursor!,
    }),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
});

test('guests and known unverified users get no successor even for empty scan batches; unknown phone is unavailable', async () => {
  for (const [token, phone, expected] of [
    [null, 'verified', 'login_required'],
    ['token', 'unverified', 'phone_verification_required'],
  ] as const) {
    const h = harness(fixtures(129));
    h.state.phone = phone;
    assert.deepEqual(await h.service.search(token, query), {
      items: [],
      nextCursor: null,
      continuation: expected,
    });
    assert.equal(h.records.size, 0);
  }
  const h = harness(fixtures(129));
  h.state.phone = 'unavailable';
  await assert.rejects(
    h.service.search('token', query),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(h.records.size, 0);
  const end = harness(fixtures(1));
  end.state.phone = 'unavailable';
  assert.equal((await end.service.search('token', query)).continuation, 'end');
});

test('presented sessions and cursor continuation require current independent session and phone authority', async () => {
  const h = harness(fixtures(129));
  h.state.sessionError = 'SESSION_REVOKED';
  await assert.rejects(
    h.service.search('bad', query),
    errorCode('SESSION_REVOKED'),
  );
  assert.equal(h.state.candidateCalls, 0);
  h.state.sessionError = null;
  const first = await h.service.search('token', query);
  const next = { ...query, cursor: first.nextCursor! };
  await assert.rejects(
    h.service.search(null, next),
    errorCode('AUTHENTICATION_REQUIRED'),
  );
  h.state.phone = 'unverified';
  await assert.rejects(
    h.service.search('token', next),
    errorCode('PHONE_VERIFICATION_REQUIRED'),
  );
  h.state.phone = 'unavailable';
  await assert.rejects(
    h.service.search('token', next),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  h.state.phone = 'verified';
  h.session.sessionId = randomUUID();
  await assert.rejects(h.service.search('token', next), BadRequestException);
});

test('visible guard is freshly authorized and matched; private scan anchor remains navigation only', async () => {
  const rows = fixtures(260);
  rows[0]!.post.text = 'whale';
  const h = harness(rows);
  const first = await h.service.search('token', query);
  const second = await h.service.search('token', {
    ...query,
    cursor: first.nextCursor!,
  });
  assert.equal(second.items.length, 0);
  assert.deepEqual(
    h.records.get(second.nextCursor!)!.position.visible,
    h.records.get(first.nextCursor!)!.position.visible,
  );
  rows[127]!.allowed = false; // A now-disallowed private after coordinate is not an authorization guard.
  assert.equal(
    (await h.service.search('token', { ...query, cursor: first.nextCursor! }))
      .continuation,
    'scan_pending',
  );
  for (const change of [
    () => {
      rows[0]!.allowed = false;
    },
    () => {
      rows[0]!.post.text = 'different';
    },
    () => {
      rows[0]!.at = '2026-10-08T00:00:00.999998Z';
    },
  ]) {
    rows[0]!.allowed = true;
    rows[0]!.post.text = 'whale';
    rows[0]!.at = '2026-10-08T00:00:00.999999Z';
    change();
    await assert.rejects(
      h.service.search('token', { ...query, cursor: first.nextCursor! }),
      errorCode('DISCOVERY_RESTART_REQUIRED'),
    );
  }
});

test('cursor scopes reject changed query/filter/limit; evicted or malformed private metadata restarts', async () => {
  const h = harness(fixtures(129));
  const first = await h.service.search('token', query);
  for (const patch of [
    { q: 'other' },
    { limit: 2 },
    { category: 'discussion' as const },
  ])
    await assert.rejects(
      h.service.search('token', {
        ...query,
        ...patch,
        cursor: first.nextCursor!,
      }),
      BadRequestException,
    );
  const record = h.records.get(first.nextCursor!)!;
  record.position.after.at = '2026-10-08T00:00:00.123Z';
  await assert.rejects(
    h.service.search('token', { ...query, cursor: first.nextCursor! }),
    errorCode('DISCOVERY_RESTART_REQUIRED'),
  );
  h.records.clear();
  await assert.rejects(
    h.service.search('token', { ...query, cursor: first.nextCursor! }),
    errorCode('DISCOVERY_RESTART_REQUIRED'),
  );
});

test('lock-and-reread rejects newly discovered or previously missing unlocked IDs', async () => {
  const rows = fixtures(2);
  const extra = fixtures(3)[2]!;
  const h = harness(rows);
  h.state.beforeCandidates = (call) => {
    if (call === 2) rows.push(extra);
  };
  await assert.rejects(
    h.service.search('token', query),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(h.inspected.length, 0);
  const initiallyPresent = fixtures(1);
  const original = initiallyPresent[0]!;
  const missing = harness(initiallyPresent);
  missing.state.beforeLock = () => {
    initiallyPresent.splice(0);
  };
  missing.state.beforeCandidates = (call) => {
    if (call === 2) initiallyPresent.push(original);
  };
  await assert.rejects(
    missing.service.search('token', query),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
});

test('noncanonical, oversized and nonprogressing candidate sequences fail closed', async () => {
  const rows = fixtures(130);
  const candidates = rows.map((row) => ({ id: row.post.id, at: row.at }));
  for (const bad of [
    candidates,
    [candidates[0]!, candidates[0]!],
    [candidates[1]!, candidates[0]!],
    [{ ...candidates[0]!, at: '2026-10-08T00:00:00.123Z' }],
  ]) {
    const h = harness(rows);
    h.state.corruptCandidates = bad;
    await assert.rejects(
      h.service.search('token', query),
      errorCode('COMMUNITY_UNAVAILABLE'),
    );
  }
});

test('unavailable visibility aborts independently of whether the readable body would match', async () => {
  for (const text of ['whale', 'no match']) {
    const rows = fixtures(1);
    rows[0]!.post.text = text;
    rows[0]!.allowed = 'unavailable';
    const h = harness(rows);
    await assert.rejects(
      h.service.search('token', query),
      errorCode('COMMUNITY_UNAVAILABLE'),
    );
    assert.equal(h.serialized.length, 0);
    assert.equal(h.records.size, 0);
  }
});

test('aggregate urgency exclusion differs from explicit trading; resolved listings remain searchable and missing component fails closed', async () => {
  const rows = fixtures(3);
  for (const row of rows) {
    row.post.category = 'trading';
    row.post.text = 'whale';
    row.listing = {
      subtype: 'shuma',
      urgency: 'normal',
      resolution: 'resolved',
    };
  }
  rows[0]!.listing!.urgency = 'urgent';
  rows[2]!.listing!.subtype = 'qiugou';
  const h = harness(rows);
  assert.deepEqual(
    (await h.service.search('token', query)).items.map((p) => p.id),
    rows.slice(1).map((r) => r.post.id),
  );
  assert.deepEqual(
    (
      await h.service.search('token', { ...query, category: 'trading' })
    ).items.map((p) => p.id),
    rows.map((r) => r.post.id),
  );
  assert.deepEqual(
    (
      await h.service.search('token', {
        ...query,
        category: 'trading',
        tradingSubtype: 'shuma',
      })
    ).items.map((p) => p.id),
    rows.slice(0, 2).map((r) => r.post.id),
  );
  rows[1]!.listing = null;
  await assert.rejects(
    h.service.search('token', query),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  h.space.kind = 'global';
  for (const category of ['trading', 'pets'] as const)
    await assert.rejects(
      h.service.search('token', { ...query, category }),
      BadRequestException,
    );
});

test('final session and phone deadlines abort and roll back cursor creation after deferred waits', async () => {
  for (const kind of ['phone', 'session'] as const) {
    const h = harness(fixtures(129));
    if (kind === 'phone') h.state.phoneUntil = h.state.now + 1000;
    else h.state.sessionUntil = h.state.now + 1000;
    h.state.afterCreate = () => {
      h.state.now += 2000;
    };
    await assert.rejects(
      h.service.search('token', query),
      errorCode(
        kind === 'phone'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'ACCESS_TOKEN_EXPIRED',
      ),
    );
    assert.equal(h.records.size, 0);
    assert.ok(h.events.includes('SET CONSTRAINTS ALL IMMEDIATE'));
    assert.ok(h.events.includes('ROLLBACK'));
    assert.equal(h.events.includes('COMMIT'), false);
  }
  const h = harness(fixtures(1));
  h.state.afterSerialize = () => {
    h.state.sessionError = 'SESSION_REVOKED';
  };
  h.state.afterSession = () => {
    h.state.sessionError = 'SESSION_REVOKED';
  };
  await assert.rejects(
    h.service.search('token', query),
    errorCode('SESSION_REVOKED'),
  );
  assert.equal(h.records.size, 0);
});

test('mandatory named relationship finalization remains fatal and rolls back any search successor', async () => {
  const rows = fixtures(129);
  rows[0]!.post.text = 'whale';
  const h = harness(rows);
  h.state.namedProof = true;
  h.state.afterCreate = () => {
    h.state.finalOutgoing = true;
  };
  await assert.rejects(
    h.service.search('token', query),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.ok(h.events.includes('cursor:create'));
  assert.ok(
    h.events.includes('LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT'),
  );
  assert.ok(h.events.includes('ROLLBACK'));
  assert.equal(h.records.size, 0);
});
