import { searchMembershipFingerprint } from '../src/community/search/scope.js';
import type { CommunitySearchScopeResolver } from '../src/community/search/scope.js';
import type { CommunityPhoneContinuation } from '../src/community/phone-continuation.js';
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
import { SearchHitSerializer } from '../src/community/search/serializer.js';
import type {
  CommunityRepository,
  StoredPost,
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import type { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
import {
  searchAnchorFollows,
  searchPositionSchema,
  federatedSearchPositionSchema,
} from '../src/community/search/cursor.js';
import type {
  SearchAnchor,
  SearchPosition,
  FederatedSearchPosition,
} from '../src/community/search/cursor.js';
import type {
  SearchQuery,
  SearchSelector,
  SearchKind,
} from '../src/community/search/contracts.js';
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
  directAllowed?: boolean | 'unavailable';
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
interface ChildFixture {
  content: StoredComment | StoredReply;
  at: string;
  allowed: boolean | 'unavailable';
}
function harness(
  rows: Fixture[],
  extraSpaces: CommunitySpace[] = [],
  children: ChildFixture[] = [],
) {
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
  const catalog = [space, ...extraSpaces];
  const state = {
    now: Date.parse('2026-10-08T00:00:00.000Z'),
    phone: 'verified' as 'verified' | 'unverified' | 'unavailable',
    phoneUntil: null as number | null,
    sessionUntil: null as number | null,
    sessionError: null as ApplicationErrorCode | null,
    sessionChecks: 0,
    candidateCalls: 0,
    scopeCalls: 0,
    namedProof: false,
    finalOutgoing: false,
    beforeCandidates: null as ((call: number) => void) | null,
    beforeLock: null as ((id: string) => void) | null,
    afterSerialize: null as (() => void) | null,
    afterCreate: null as (() => void) | null,
    afterSession: null as (() => void) | null,
    corruptCandidates: null as SearchCandidate[] | null,
    corruptLocks: null as
      ((kind: SearchKind, rows: SearchCandidate[]) => SearchCandidate[]) | null,
  };
  const events: string[] = [];
  const inspected: string[] = [];
  const serialized: string[] = [];
  const locked: string[] = [];
  const lockOrder: string[] = [];
  const lockBatches: { kind: SearchKind; ids: readonly string[] }[] = [];
  const purposes: { id: string; purpose: string }[] = [];
  const bodyReads: string[] = [];
  const records = new Map<
    string,
    { scope: string; position: SearchPosition | FederatedSearchPosition }
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
      bodyReads.push(id);
      const row = rows.find((item) => item.post.id === id);
      if (!row) throw new ApplicationError('POST_NOT_FOUND');
      return row.post;
    },
    comment: async (id: string) => {
      bodyReads.push(id);
      return children.find(
        (item) =>
          item.content.id === id && !('root_comment_id' in item.content),
      )!.content;
    },
    reply: async (id: string) => {
      bodyReads.push(id);
      return children.find(
        (item) => item.content.id === id && 'root_comment_id' in item.content,
      )!.content;
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
    authority: async () => {
      throw new Error('Search continuation must use independent phone proof');
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
      purposes.push({ id: post.id, purpose });
      const row = rows.find((item) => item.post.id === post.id);
      const child = children.find((item) => item.content.id === post.id);
      const allowed = row
        ? purpose === 'direct_post'
          ? (row.directAllowed ?? row.allowed)
          : row.allowed
        : child!.allowed;
      if (allowed === 'unavailable')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (allowed && state.namedProof && actor && post.author_mode === 'named')
        requireAllowedSafetyRelationship(
          actor,
          post.account_id,
          purpose as 'list_projection' | 'direct_post',
          client,
        );
      return (
        allowed && post.visibility === 'approved' && post.deleted_at === null
      );
    },
  } as unknown as CommunityAccessService;
  const serializer = new SearchHitSerializer({
    author: async (post: StoredPost) => {
      events.push('serialize');
      serialized.push(post.id);
      state.afterSerialize?.();
      return {
        kind: 'anonymous',
        personaId: ownerId,
        displayName: 'Synthetic author',
        avatar: null,
        isPostAuthor: false,
      };
    },
  } as unknown as CommunitySerializer);
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
      const position = searchPositionSchema
        .or(federatedSearchPositionSchema)
        .parse(value);
      const token = randomBytes(32).toString('base64url');
      records.set(token, { scope, position });
      pending.push(token);
      state.afterCreate?.();
      return token;
    },
  } as unknown as DiscoveryCursorRepository;
  function metadata(kind: SearchKind, id: string): SearchCandidate | null {
    const row = rows.find((r) => kind === 'post' && r.post.id === id);
    if (row)
      return {
        id,
        kind,
        postId: id,
        rootCommentId: null,
        at: row.at,
        spaceId: row.post.space_id,
      };
    const child = children.find(
      (r) =>
        r.content.id === id &&
        (kind === 'reply') === 'root_comment_id' in r.content,
    );
    const parent =
      child && rows.find((r) => r.post.id === child.content.post_id);
    return child && parent
      ? {
          id,
          kind,
          postId: parent.post.id,
          rootCommentId:
            'root_comment_id' in child.content
              ? child.content.root_comment_id
              : child.content.id,
          at: child.at,
          spaceId: parent.post.space_id,
        }
      : null;
  }
  const searches = {
    candidates: async (
      scope: SearchStructuralScope,
      after: SearchAnchor | null,
    ) => {
      events.push('candidates');
      state.beforeCandidates?.(++state.candidateCalls);
      if (state.corruptCandidates) return state.corruptCandidates;
      const eligibleParents = rows.filter(
        (row) =>
          ('spaceId' in scope
            ? row.post.space_id === scope.spaceId
            : scope.regionalSpaceIds.includes(row.post.space_id) ||
              (scope.globalSpaceIds.includes(row.post.space_id) &&
                row.post.category === 'discussion')) &&
          row.post.visibility === 'approved' &&
          row.post.deleted_at === null &&
          (scope.category === null || row.post.category === scope.category) &&
          (scope.tradingSubtype === null ||
            row.listing?.subtype === scope.tradingSubtype) &&
          (!scope.excludeUrgentTrading || row.listing?.urgency !== 'urgent') &&
          (scope.postId === null || row.post.id === scope.postId),
      );
      return [
        ...eligibleParents.map((row) => ({
          id: row.post.id,
          kind: 'post' as const,
          postId: row.post.id,
          rootCommentId: null,
          at: row.at,
          spaceId: row.post.space_id,
        })),
        ...children
          .filter(
            (item) =>
              item.content.visibility === 'approved' &&
              !item.content.deleted_at &&
              eligibleParents.some((p) => p.post.id === item.content.post_id),
          )
          .map((item) => ({
            id: item.content.id,
            kind:
              'root_comment_id' in item.content
                ? ('reply' as const)
                : ('comment' as const),
            postId: item.content.post_id,
            rootCommentId:
              'root_comment_id' in item.content
                ? item.content.root_comment_id
                : item.content.id,
            at: item.at,
            spaceId: rows.find((r) => r.post.id === item.content.post_id)!.post
              .space_id,
          })),
      ]
        .filter(
          (row) =>
            scope.types.includes(row.kind) &&
            (scope.from === null || row.at >= scope.from) &&
            (scope.to === null || row.at < scope.to) &&
            (after === null || searchAnchorFollows(row, after)),
        )
        .sort((a, b) =>
          searchAnchorFollows(a, b) ? 1 : searchAnchorFollows(b, a) ? -1 : 0,
        )
        .slice(0, 129);
    },
    reference: async (anchor: SearchAnchor) => metadata(anchor.kind, anchor.id),
    lockCandidates: async (kind: SearchKind, ids: readonly string[]) => {
      lockBatches.push({ kind, ids });
      const result = ids.flatMap((id) => {
        locked.push(id);
        lockOrder.push(`${kind}:${id}`);
        state.beforeLock?.(id);
        const row = metadata(kind, id);
        return row ? [row] : [];
      });
      return state.corruptLocks?.(kind, result) ?? result;
    },
    exactAnchor: async (anchor: SearchAnchor) =>
      metadata(anchor.kind, anchor.id)?.at === anchor.at,
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
      {
        resolve: async (selector: SearchSelector, _tx: PoolClient) => {
          events.push('catalog');
          state.scopeCalls++;
          const members = catalog.filter(
            (s) => s.isActive && (selector === 'all' || s.kind === selector),
          );
          return {
            membershipFingerprint: searchMembershipFingerprint(
              selector,
              members,
            ),
            members,
            regionalSpaceIds: members
              .filter((s) => s.kind === 'regional')
              .map((s) => s.id),
            globalSpaceIds: members
              .filter((s) => s.kind === 'global')
              .map((s) => s.id),
            space: (id: string) => members.find((s) => s.id === id),
          };
        },
      } as unknown as CommunitySearchScopeResolver,
      {
        verified: async (_actor: string, client: PoolClient) => {
          events.push('authority');
          if (state.phone === 'unavailable')
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (state.phone === 'verified')
            registerTransactionDeadline(
              client,
              state.phoneUntil,
              'PHONE_VERIFICATION_REQUIRED',
            );
          return state.phone === 'verified';
        },
      } as CommunityPhoneContinuation,
    ),
    state,
    space,
    catalog,
    session,
    events,
    inspected,
    serialized,
    locked,
    lockOrder,
    lockBatches,
    purposes,
    bodyReads,
    records,
  };
}
const query: SearchQuery = { type: 'post', spaceId, q: 'whale', limit: 10 };

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
  assert.equal(
    result.items[0]!.snippet.segments.map((s) => s.text).join(''),
    '  WhAlE\r\n原样  ',
  );
  assert.deepEqual(h.serialized, [rows[1]!.post.id]);
  assert.equal(h.inspected.length, 128);
  assert.equal(h.inspected.includes(rows[128]!.post.id), false);
  assert.deepEqual([...new Set(h.locked)], [...new Set(h.locked)].sort());
  const record = h.records.get(result.nextCursor!)!;
  assert.deepEqual(record.position.after, {
    kind: 'post',
    id: rows[127]!.post.id,
    at: rows[127]!.at,
  });
  assert.deepEqual(record.position.visible, {
    kind: 'post',
    id: rows[1]!.post.id,
    at: rows[1]!.at,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'continuation',
    'effectiveTypes',
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
    final.items.map((item) => item.contentId),
    [rows[1099]!.post.id],
  );
  assert.equal(h.serialized.length, 1);
  const exact = harness(fixtures(128));
  assert.deepEqual(await exact.service.search(null, query), {
    items: [],
    effectiveTypes: ['post'],
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
      effectiveTypes: ['post'],
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
  const candidates = rows.map((row) => ({
    id: row.post.id,
    kind: 'post' as const,
    postId: row.post.id,
    rootCommentId: null,
    at: row.at,
    spaceId: row.post.space_id,
  }));
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
    (await h.service.search('token', query)).items.map((p) => p.contentId),
    rows.slice(1).map((r) => r.post.id),
  );
  assert.deepEqual(
    (
      await h.service.search('token', { ...query, category: 'trading' })
    ).items.map((p) => p.contentId),
    rows.map((r) => r.post.id),
  );
  assert.deepEqual(
    (
      await h.service.search('token', {
        ...query,
        category: 'trading',
        tradingSubtype: 'shuma',
      })
    ).items.map((p) => p.contentId),
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

function foreignSpace(kind: 'regional' | 'global'): CommunitySpace {
  return {
    id: randomUUID(),
    kind,
    isActive: true,
    name: 'Synthetic foreign ' + kind,
    operatingRegionId: kind === 'global' ? null : randomUUID(),
  };
}
test('federated all includes all sources and urgent/resolved trading; regional exact discussion remains distinct from global', async () => {
  const regional = foreignSpace('regional'),
    globalA = foreignSpace('global'),
    globalB = foreignSpace('global');
  const rows = fixtures(6);
  for (const row of rows) row.post.text = 'whale';
  rows[1]!.post.space_id = regional.id;
  rows[2]!.post.space_id = globalA.id;
  rows[3]!.post.space_id = globalB.id;
  for (const row of rows.slice(4)) {
    row.post.category = 'trading';
    row.listing = {
      subtype: 'shuma',
      urgency: 'urgent',
      resolution: 'resolved',
    };
  }
  rows[5]!.post.space_id = regional.id;
  const h = harness(rows, [regional, globalA, globalB]);
  const aggregate = { type: 'post' as const, q: 'whale', limit: 10 };
  for (const [scope, category, indices] of [
    ['all', undefined, [0, 1, 2, 3, 4, 5]],
    ['regional', undefined, [0, 1, 4, 5]],
    ['regional', 'discussion', [0, 1]],
    ['global', undefined, [2, 3]],
    ['regional', 'trading', [4, 5]],
  ] as const) {
    const result = await h.service.search('token', {
      ...aggregate,
      scope,
      ...(category ? { category } : {}),
    });
    assert.deepEqual(
      result.items.map((p) => p.contentId),
      indices.map((i) => rows[i]!.post.id),
    );
    for (const post of result.items)
      assert.equal(
        post.space.id,
        rows.find((r) => r.post.id === post.contentId)!.post.space_id,
      );
  }
  assert.equal(h.events.includes('space'), false);
  assert.equal(h.state.scopeCalls, 5);
});

test('federated fingerprint changes restart before scan; names and unrelated regional insertion do not invalidate global', async () => {
  const global = foreignSpace('global');
  const rows = fixtures(129);
  for (const row of rows) row.post.space_id = global.id;
  const h = harness(rows, [global]);
  const q = {
    type: 'post' as const,
    scope: 'global' as const,
    q: 'whale',
    limit: 10,
  };
  const first = await h.service.search('token', q);
  const saved = h.records.get(first.nextCursor!)!;
  assert.equal(saved.position.v, 4);
  assert.deepEqual(Object.keys(saved.position).sort(), [
    'after',
    'kind',
    'matcherId',
    'membershipFingerprint',
    'orderId',
    'v',
    'visible',
  ]);
  global.name = 'Renamed';
  h.catalog.push(foreignSpace('regional'));
  assert.equal(
    (await h.service.search('token', { ...q, cursor: first.nextCursor! }))
      .continuation,
    'end',
  );
  h.catalog.push(foreignSpace('global'));
  const calls = h.state.candidateCalls;
  await assert.rejects(
    h.service.search('token', { ...q, cursor: first.nextCursor! }),
    errorCode('DISCOVERY_RESTART_REQUIRED'),
  );
  assert.equal(h.state.candidateCalls, calls);
  for (const scope of ['all', 'regional'] as const) {
    await assert.rejects(
      h.service.search('token', { ...q, scope, cursor: first.nextCursor! }),
      BadRequestException,
    );
  }
});

test('aggregate unavailable phone on sparse preview fails without fake-space authority; empty scope still validates session', async () => {
  const h = harness(fixtures(129));
  h.state.phone = 'unavailable';
  await assert.rejects(
    h.service.search('token', {
      type: 'post',
      scope: 'all',
      q: 'whale',
      limit: 10,
    }),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(h.events.includes('space'), false);
  h.catalog.splice(0);
  assert.deepEqual(
    await h.service.search('token', {
      type: 'post',
      scope: 'all',
      q: 'whale',
      limit: 10,
    }),
    {
      items: [],
      effectiveTypes: ['post'],
      nextCursor: null,
      continuation: 'end',
    },
  );
  h.state.sessionError = 'SESSION_REVOKED';
  await assert.rejects(
    h.service.search('token', {
      type: 'post',
      scope: 'all',
      q: 'whale',
      limit: 10,
    }),
    errorCode('SESSION_REVOKED'),
  );
});

test('candidate source mismatch and changed exact structural coordinate fail before body visibility', async () => {
  const h = harness(fixtures(1));
  h.state.corruptCandidates = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'post',
      postId: '00000000-0000-4000-8000-000000000001',
      rootCommentId: null,
      at: '2026-10-08T00:00:00.999999Z',
      spaceId: randomUUID(),
    },
  ];
  await assert.rejects(
    h.service.search('token', {
      type: 'post',
      scope: 'all',
      q: 'whale',
      limit: 10,
    }),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(h.inspected.length, 0);
  h.state.corruptCandidates[0]!.spaceId = spaceId;
  h.state.corruptCandidates[0]!.at = '2026-10-08T00:00:00.123456Z';
  await assert.rejects(
    h.service.search('token', {
      type: 'post',
      scope: 'all',
      q: 'whale',
      limit: 10,
    }),
    errorCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(h.inspected.length, 0);
});

function discussionFixture(
  post: Fixture,
  kind: 'comment' | 'reply',
  id: string,
  at: string,
  rootId?: string,
): ChildFixture {
  return {
    allowed: true,
    at,
    content: {
      id,
      post_id: post.post.id,
      account_id: randomUUID(),
      author_mode: 'named',
      text: 'whale original child',
      visibility: 'approved',
      deleted_at: null,
      created_at: new Date(at),
      ...(kind === 'reply'
        ? {
            root_comment_id: rootId!,
            target_reply_id: randomUUID(),
            sequence: '1',
          }
        : {}),
    },
  };
}

test('comment and reply own bodies match independently and lightweight hits carry exact navigation without target disclosure', async () => {
  const rows = fixtures(1);
  const root = discussionFixture(
    rows[0]!,
    'comment',
    randomUUID(),
    '2026-10-08T01:00:00.123456Z',
  );
  const reply = discussionFixture(
    rows[0]!,
    'reply',
    randomUUID(),
    '2026-10-08T02:00:00.123456Z',
    root.content.id,
  );
  const h = harness(rows, [], [root, reply]);
  const page = await h.service.search('token', { ...query, type: 'all' });
  assert.deepEqual(page.effectiveTypes, ['post', 'comment', 'reply']);
  assert.deepEqual(
    page.items.map((i) => i.kind),
    ['reply', 'comment'],
  );
  assert.equal(page.items[0]!.createdAt, reply.at);
  assert.deepEqual(page.items[0]!.target, {
    kind: 'reply',
    postId: rows[0]!.post.id,
    rootCommentId: root.content.id,
    replyId: reply.content.id,
  });
  assert.equal(page.items[0]!.postSummary, 'no match');
  assert.equal(
    JSON.stringify(page).includes(
      (reply.content as StoredReply).target_reply_id!,
    ),
    false,
  );
  assert.equal(
    h.bodyReads.includes((reply.content as StoredReply).target_reply_id!),
    false,
  );
  for (const forbidden of [
    'text',
    'images',
    'commentCount',
    'replyCount',
    'discussionCount',
    'component',
    'viewer',
  ])
    assert.equal(forbidden in page.items[0]!, false);
  assert.deepEqual(h.lockOrder, [
    `post:${rows[0]!.post.id}`,
    `comment:${root.content.id}`,
    `reply:${reply.content.id}`,
  ]);
  assert.ok(
    h.purposes.some(
      (p) => p.id === rows[0]!.post.id && p.purpose === 'direct_post',
    ),
  );
});

test('child parent direct visibility differs from post list visibility and denied ancestry is never matched or serialized', async () => {
  for (const blocked of ['parent', 'root', 'reply'] as const) {
    const rows = fixtures(1);
    rows[0]!.post.text = 'whale parent';
    const root = discussionFixture(
      rows[0]!,
      'comment',
      randomUUID(),
      '2026-10-08T01:00:00.000000Z',
    );
    const reply = discussionFixture(
      rows[0]!,
      'reply',
      randomUUID(),
      '2026-10-08T02:00:00.000000Z',
      root.content.id,
    );
    if (blocked === 'parent') rows[0]!.directAllowed = false;
    else (blocked === 'root' ? root : reply).allowed = false;
    const hidden =
      blocked === 'parent'
        ? [root, reply]
        : blocked === 'root'
          ? [root, reply]
          : [reply];
    for (const item of hidden)
      Object.defineProperty(item.content, 'text', {
        get() {
          throw new Error('denied child text read');
        },
      });
    const h = harness(rows, [], [root, reply]);
    const page = await h.service.search('token', { ...query, type: 'all' });
    assert.equal(
      page.items.some((i) => i.kind === 'reply'),
      false,
    );
    assert.equal(
      page.items.some((i) => i.kind === 'post'),
      true,
    );
    for (const item of hidden)
      assert.equal(h.serialized.includes(item.content.id), false);
    if (blocked === 'parent')
      assert.equal(
        h.bodyReads.some(
          (id) => id === root.content.id || id === reply.content.id,
        ),
        false,
      );
  }
});

test('anonymous parent never bypasses root or reply unknown evidence, even for nonmatching child bodies', async () => {
  for (const unknown of ['root', 'reply'] as const)
    for (const body of ['whale', 'different']) {
      const rows = fixtures(1);
      rows[0]!.post.author_mode = 'anonymous';
      const root = discussionFixture(
        rows[0]!,
        'comment',
        randomUUID(),
        '2026-10-08T01:00:00.000000Z',
      );
      const reply = discussionFixture(
        rows[0]!,
        'reply',
        randomUUID(),
        '2026-10-08T02:00:00.000000Z',
        root.content.id,
      );
      const item = unknown === 'root' ? root : reply;
      item.allowed = 'unavailable';
      item.content.text = body;
      await assert.rejects(
        harness(rows, [], [root, reply]).service.search('token', {
          ...query,
          type: 'reply',
        }),
        errorCode('COMMUNITY_UNAVAILABLE'),
      );
    }
});

test('guest all is explicitly post-only and explicit child search requires login before metadata or body reads', async () => {
  const rows = fixtures(1);
  rows[0]!.post.text = 'whale';
  const root = discussionFixture(
    rows[0]!,
    'comment',
    randomUUID(),
    '2026-10-08T01:00:00.000000Z',
  );
  const h = harness(rows, [], [root]);
  const page = await h.service.search(null, { ...query, type: 'all' });
  assert.deepEqual(page.effectiveTypes, ['post']);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.kind, 'post');
  const calls = h.state.candidateCalls,
    reads = h.bodyReads.length;
  for (const type of ['comment', 'reply'] as const)
    await assert.rejects(
      h.service.search(null, { ...query, type }),
      errorCode('AUTHENTICATION_REQUIRED'),
    );
  assert.equal(h.state.candidateCalls, calls);
  assert.equal(h.bodyReads.length, reads);
});

test('cross-kind timestamp and UUID ties paginate once each; filters use the hit time and exact topic', async () => {
  const rows = fixtures(2);
  for (const row of rows) {
    row.at = '2026-10-08T01:00:00.123456Z';
    row.post.text = 'whale';
  }
  const root = discussionFixture(
    rows[0]!,
    'comment',
    rows[0]!.post.id,
    rows[0]!.at,
  );
  const reply = discussionFixture(
    rows[0]!,
    'reply',
    rows[0]!.post.id,
    rows[0]!.at,
    root.content.id,
  );
  const h = harness(rows, [], [root, reply]);
  const hits = [];
  let cursor: string | undefined;
  do {
    const page = await h.service.search('token', {
      ...query,
      type: 'all',
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    hits.push(...page.items.map((i) => `${i.kind}:${i.contentId}`));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(hits, [
    `post:${rows[1]!.post.id}`,
    `post:${rows[0]!.post.id}`,
    `comment:${root.content.id}`,
    `reply:${reply.content.id}`,
  ]);
  const filtered = await h.service.search('token', {
    ...query,
    type: 'reply',
    postId: rows[0]!.post.id,
    from: rows[0]!.at,
    to: '2026-10-08T01:00:00.123457Z',
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(
    (
      await h.service.search('token', {
        ...query,
        type: 'reply',
        to: rows[0]!.at,
      })
    ).items.length,
    0,
  );
});

test('reply sentinel metadata neither reads its body nor its root, and revoked visible root guard restarts', async () => {
  const rows = fixtures(128);
  const root = discussionFixture(
    rows[0]!,
    'comment',
    randomUUID(),
    '2026-10-07T00:00:00.000001Z',
  );
  const reply = discussionFixture(
    rows[0]!,
    'reply',
    randomUUID(),
    '2026-10-07T00:00:00.000002Z',
    root.content.id,
  );
  Object.defineProperty(reply.content, 'text', {
    get() {
      throw new Error('sentinel body accessed');
    },
  });
  const h = harness(rows, [], [root, reply]);
  const page = await h.service.search('token', { ...query, type: 'all' });
  assert.equal(page.continuation, 'scan_pending');
  assert.equal(h.bodyReads.includes(root.content.id), false);
  assert.equal(h.bodyReads.includes(reply.content.id), false);
  const one = fixtures(1);
  const visible = discussionFixture(
    one[0]!,
    'comment',
    randomUUID(),
    '2026-10-08T01:00:00.000000Z',
  );
  const guard = harness(one, [], [visible]);
  const first = await guard.service.search('token', {
    ...query,
    type: 'all',
    limit: 1,
  });
  visible.content.deleted_at = new Date();
  await assert.rejects(
    guard.service.search('token', {
      ...query,
      type: 'all',
      limit: 1,
      cursor: first.nextCursor!,
    }),
    errorCode('DISCOVERY_RESTART_REQUIRED'),
  );
});

test('batched locks include complete sentinel and visible-guard ancestry, even with the same UUID throughout every chain', async () => {
  const rows = fixtures(260);
  const children = rows.flatMap((row) => [
    discussionFixture(
      row,
      'comment',
      row.post.id,
      '2026-10-07T00:00:00.000000Z',
    ),
    discussionFixture(row, 'reply', row.post.id, row.at, row.post.id),
  ]);
  // The next page fills before this unknown, unread chain. Metadata locking
  // must neither authorize it nor register a mandatory proof for its body.
  children[100]!.allowed = 'unavailable';
  Object.defineProperty(children[101]!.content, 'text', {
    get() {
      throw new Error('off-page child body accessed');
    },
  });
  const h = harness(rows, [], children);
  const selected = { ...query, type: 'reply' as const, limit: 1 };
  const first = await h.service.search('token', selected);
  h.lockBatches.splice(0);
  h.lockOrder.splice(0);
  const next = await h.service.search('token', {
    ...selected,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    next.items.map((item) => item.contentId),
    [rows[1]!.post.id],
  );
  const expectedIds = rows
    .slice(0, 130)
    .map((row) => row.post.id)
    .sort();
  assert.deepEqual(
    h.lockBatches,
    (['post', 'comment', 'reply'] as const).map((kind) => ({
      kind,
      ids: expectedIds,
    })),
  );
  assert.deepEqual(
    h.lockOrder,
    (['post', 'comment', 'reply'] as const).flatMap((kind) =>
      expectedIds.map((id) => `${kind}:${id}`),
    ),
  );
  assert.equal(h.bodyReads.includes(rows[50]!.post.id), false);
  assert.equal(h.bodyReads.includes(rows[129]!.post.id), false);
});

test('batched metadata rejects malformed, extra, duplicate, unsorted and kind-confused rows before any body authorization', async () => {
  for (const corrupt of [
    (rows: SearchCandidate[]) => [...rows, rows[0]!],
    (rows: SearchCandidate[]) => [rows[0]!, rows[0]!],
    (rows: SearchCandidate[]) => [...rows].reverse(),
    (rows: SearchCandidate[]) => {
      const foreign = randomUUID();
      return [{ ...rows[0]!, id: foreign, postId: foreign }];
    },
    (rows: SearchCandidate[]) => [
      { ...rows[0]!, kind: 'comment' as const, rootCommentId: rows[0]!.id },
    ],
    (rows: SearchCandidate[]) => [
      { ...rows[0]!, at: '2026-10-08T00:00:00.123Z' },
    ],
    (rows: SearchCandidate[]) => [rows[0]!],
  ]) {
    const h = harness(fixtures(2));
    h.state.corruptLocks = (_kind, rows) => corrupt(rows);
    await assert.rejects(
      h.service.search('token', query),
      errorCode('COMMUNITY_UNAVAILABLE'),
    );
    assert.deepEqual(h.bodyReads, []);
    assert.equal(h.records.size, 0);
  }
});

test('batched child locks still reject missing ancestry and changed parent or root coordinates', async () => {
  for (const fault of [
    'missing-post',
    'missing-root',
    'changed-post',
    'changed-root',
  ] as const) {
    const rows = fixtures(2);
    const children = rows.flatMap((row) => [
      discussionFixture(row, 'comment', row.post.id, row.at),
      discussionFixture(row, 'reply', row.post.id, row.at, row.post.id),
    ]);
    const h = harness(rows, [], children);
    h.state.corruptLocks = (kind, locked) => {
      if (
        (kind === 'post' && fault === 'missing-post') ||
        (kind === 'comment' && fault === 'missing-root')
      )
        return locked.slice(1);
      if (
        kind === 'reply' &&
        (fault === 'changed-post' || fault === 'changed-root')
      )
        return locked.map((row, i) =>
          i === 0
            ? {
                ...row,
                ...(fault === 'changed-post'
                  ? { postId: rows[1]!.post.id }
                  : { rootCommentId: rows[1]!.post.id }),
              }
            : row,
        );
      return locked;
    };
    await assert.rejects(
      h.service.search('token', { ...query, type: 'reply' }),
      errorCode('COMMUNITY_UNAVAILABLE'),
    );
    assert.deepEqual(h.bodyReads, []);
  }
});
