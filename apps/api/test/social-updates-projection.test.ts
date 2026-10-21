import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type {
  CommunityRepository,
  StoredComment,
  StoredPost,
  StoredReply,
} from '../src/community/community.repository.js';
import type { SocialSource } from '../src/community/social-source/contracts.js';
import { CommunitySocialProjectionFacade } from '../src/community/social-source/projection.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  registerTransactionDeadline,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type {
  PublicProfileFacade,
  PublicProfileRecord,
} from '../src/profile/public-profile.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import { requireAllowedSafetyRelationship } from '../src/safety/relationship-proof.js';

function fixture(kind: 'post' | 'comment' | 'reply' | 'follow' = 'reply') {
  const actor = randomUUID(),
    recipient = randomUUID(),
    profileId = randomUUID(),
    actorProfileId = randomUUID();
  const post: StoredPost = {
    id: randomUUID(),
    space_id: randomUUID(),
    account_id: kind === 'post' ? recipient : randomUUID(),
    category: 'discussion',
    text: 'Private post text must never leave this projection',
    author_mode: 'anonymous',
    comments_policy: 'restricted',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date('2026-10-20T00:00:00.000Z'),
  };
  const root: StoredComment = {
    id: randomUUID(),
    post_id: post.id,
    account_id: kind === 'comment' ? recipient : randomUUID(),
    text: 'Private root text',
    author_mode: 'anonymous',
    visibility: 'approved',
    deleted_at: null,
    created_at: post.published_at,
  };
  const targetReply: StoredReply = {
    ...root,
    id: randomUUID(),
    account_id: randomUUID(),
    root_comment_id: root.id,
    target_reply_id: null,
    sequence: '1',
  };
  const reply: StoredReply = {
    ...targetReply,
    id: randomUUID(),
    account_id: recipient,
    target_reply_id: targetReply.id,
    sequence: '2',
  };
  const source: SocialSource = {
    id: randomUUID(),
    kind: kind === 'follow' ? 'follow' : 'like',
    actorAccountId: actor,
    recipientAccountId: recipient,
    resourceKind: kind === 'follow' ? 'profile' : kind,
    resourceId:
      kind === 'follow'
        ? profileId
        : kind === 'post'
          ? post.id
          : kind === 'comment'
            ? root.id
            : reply.id,
    postId: kind === 'follow' ? null : post.id,
    rootCommentId: kind === 'comment' || kind === 'reply' ? root.id : null,
    replyId: kind === 'reply' ? reply.id : null,
    targetReplyId: kind === 'reply' ? targetReply.id : null,
    occurredAt: '2026-10-20T00:00:00.000001Z',
    sourceEpochId: randomUUID(),
  };
  const calls: string[] = [];
  const queries: { sql: string; values: unknown[] }[] = [];
  const inactive = new Set<string>();
  const missing = new Set<string>();
  const invisible = new Set<string>();
  const profileRows = new Map<string, PublicProfileRecord>([
    [
      profileId,
      {
        accountId: recipient,
        profileId,
        displayName: 'Recipient',
        bio: 'Recipient private bio',
        hideProfilePosts: false,
      },
    ],
    [
      actorProfileId,
      {
        accountId: actor,
        profileId: actorProfileId,
        displayName: 'Current public name',
        bio: 'Actor private bio',
        hideProfilePosts: true,
      },
    ],
  ]);
  const state = {
    authority: 'allow' as 'allow' | 'deny' | 'unavailable',
    edge: true,
    profileVisibility: 'available' as
      'available' | 'unavailable' | 'blocked_by_you',
    finalBlocked: false,
    retired: false,
    erasing: false,
    lifecycle: 'active',
    edgeLock: true,
    deadline: null as number | null,
    error: null as Error | null,
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (
        sql ===
        'SELECT id,lifecycle FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT'
      ) {
        assert.deepEqual(values, [[actor, recipient].sort()]);
        return {
          rows: [actor, recipient]
            .sort()
            .map((id) => ({ id, lifecycle: state.lifecycle })),
          rowCount: 2,
        };
      }
      if (
        sql ===
        'SELECT whaleu_account_deletion.follow_source_retired($1) AS retired,whaleu_account_deletion.follow_source_erasing($1) AS erasing'
      ) {
        assert.deepEqual(values, [source.id]);
        return {
          rows: [{ retired: state.retired, erasing: state.erasing }],
          rowCount: 1,
        };
      }
      if (
        sql ===
        'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked'
      ) {
        assert.deepEqual(values, [`whaleu:following:${actor}`]);
        return { rows: [{ locked: state.edgeLock }], rowCount: 1 };
      }
      if (
        sql.startsWith('SELECT pg_advisory') ||
        sql.startsWith('SET CONSTRAINTS') ||
        sql.startsWith('LOCK TABLE') ||
        sql.includes('set_config(')
      )
        return { rows: [], rowCount: 1 };
      if (sql.includes('FROM whaleu_community.user_follows')) {
        assert.deepEqual(values, [actor, recipient, profileId]);
        return { rows: state.edge ? [{}] : [], rowCount: state.edge ? 1 : 0 };
      }
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('FROM unnest($1::uuid[],$2::uuid[],$3::boolean[])'))
        return {
          rows: (values[0] as string[]).map((_id, index) => ({
            ordinal: index + 1,
            outgoing: false,
            incoming: state.finalBlocked,
          })),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date('2026-10-20T00:00:00.000Z') }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const repository = {
    comment: async (id: string, client: PoolClient, locked: boolean) => {
      assert.equal(client, tx);
      assert.equal(locked, true);
      calls.push(`root:${id}`);
      if (missing.has(id)) throw new ApplicationError('COMMENT_NOT_FOUND');
      return root;
    },
    reply: async (id: string, client: PoolClient, locked: boolean) => {
      assert.equal(client, tx);
      assert.equal(locked, true);
      calls.push(`reply:${id}`);
      if (missing.has(id)) throw new ApplicationError('REPLY_NOT_FOUND');
      return id === reply.id ? reply : targetReply;
    },
  } as unknown as CommunityRepository;
  const access = {
    projectionPost: async (id: string, viewer: string, client: PoolClient) => {
      calls.push(`post:${id}`);
      assert.equal(client, tx);
      assert.equal(viewer, recipient);
      if (state.error) throw state.error;
      if (
        missing.has(id) ||
        invisible.has(id) ||
        post.visibility !== 'approved' ||
        post.deleted_at
      )
        throw new ApplicationError('POST_NOT_FOUND');
      return { post, space: { id: post.space_id } };
    },
    authorization: {
      resolve: async (_viewer: string, _space: unknown, client: PoolClient) => {
        registerTransactionDeadline(
          client,
          state.deadline,
          'COMMUNITY_UNAVAILABLE',
        );
        return {
          kind: state.authority,
          value: { phoneVerified: false, studentVerified: false },
        };
      },
    },
    visible: async (
      viewer: string,
      content: StoredComment,
      client: PoolClient,
      purpose: string,
    ) => {
      assert.equal(viewer, recipient);
      assert.equal(client, tx);
      assert.equal(purpose, 'direct_post');
      calls.push(`visible:${content.id}`);
      return (
        content.visibility === 'approved' &&
        !content.deleted_at &&
        !invisible.has(content.id)
      );
    },
  } as unknown as CommunityAccessService;
  const identity = {
    activeAccount: async (id: string) => {
      calls.push(`active:${id}`);
      return !inactive.has(id);
    },
  } as unknown as IdentityService;
  const profiles = {
    find: async (id: string) => {
      calls.push(`profile:${id}`);
      return profileRows.get(id) ?? null;
    },
    ownReference: async (id: string) => {
      calls.push(`reference:${id}`);
      return id === actor ? actorProfileId : null;
    },
  } as unknown as PublicProfileFacade;
  const profileVisibility = {
    read: async (viewer: string, author: string, client: PoolClient) => {
      assert.equal(viewer, recipient);
      assert.equal(author, actor);
      calls.push('profile-relationship');
      if (state.profileVisibility === 'available')
        requireAllowedSafetyRelationship(
          viewer,
          author,
          'public_profile',
          client,
        );
      return { status: state.profileVisibility };
    },
  } as unknown as ProfileVisibilityFacade;
  return {
    facade: new CommunitySocialProjectionFacade(
      repository,
      access,
      identity,
      profiles,
      profileVisibility,
    ),
    tx,
    calls,
    queries,
    actor,
    recipient,
    profileId,
    actorProfileId,
    profileRows,
    post,
    root,
    reply,
    targetReply,
    source,
    inactive,
    missing,
    invisible,
    state,
  };
}

test('like/save project only current locators, never actor, preview or live memberships', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const f = fixture(kind);
    const result = await f.facade.project(f.source, f.tx);
    assert.deepEqual(result, {
      kind: 'like',
      target: {
        type: 'community',
        postId: f.post.id,
        commentId: f.source.rootCommentId,
        replyId: f.source.replyId,
      },
    });
    assert.ok(!f.calls.some((call) => /profile|reference/.test(call)));
    assert.equal(JSON.stringify(result).includes(f.actor), false);
    assert.equal(JSON.stringify(result).includes(f.recipient), false);
    assert.ok(
      f.queries.every(({ sql }) => sql.startsWith('SELECT pg_advisory')),
    );
    if (kind === 'post')
      assert.deepEqual(
        await f.facade.project({ ...f.source, kind: 'save' }, f.tx),
        { ...result, kind: 'save' },
      );
    else
      assert.equal(
        await f.facade.project({ ...f.source, kind: 'save' }, f.tx),
        null,
      );
  }
});

test('reply ancestry locks post then root then sorted replies, including reply-to target', async () => {
  const f = fixture();
  assert.ok(await f.facade.project(f.source, f.tx));
  assert.deepEqual(f.calls.slice(0, 4), [
    `post:${f.post.id}`,
    `root:${f.root.id}`,
    ...[f.reply.id, f.targetReply.id].sort().map((id) => `reply:${id}`),
  ]);
  for (const id of [f.root.id, f.reply.id, f.targetReply.id])
    assert.ok(f.calls.includes(`visible:${id}`));
});

test('missing, hidden or deleted ancestors and reply-to targets disclose nothing', async () => {
  for (const member of ['post', 'root', 'reply', 'targetReply'] as const)
    for (const failure of ['missing', 'hidden', 'deleted'] as const) {
      const f = fixture();
      if (failure === 'missing') f.missing.add(f[member].id);
      else if (failure === 'hidden') f[member].visibility = 'hidden';
      else f[member].deleted_at = new Date();
      assert.equal(await f.facade.project(f.source, f.tx), null);
    }
});

test('immutable ancestry, exact target ownership and locator shape are rechecked', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => (f.root.post_id = randomUUID()),
    (f: ReturnType<typeof fixture>) => (f.reply.post_id = randomUUID()),
    (f: ReturnType<typeof fixture>) => (f.reply.root_comment_id = randomUUID()),
    (f: ReturnType<typeof fixture>) => (f.targetReply.post_id = randomUUID()),
    (f: ReturnType<typeof fixture>) =>
      (f.targetReply.root_comment_id = randomUUID()),
    (f: ReturnType<typeof fixture>) => (f.reply.target_reply_id = null),
    (f: ReturnType<typeof fixture>) => (f.reply.account_id = randomUUID()),
    (f: ReturnType<typeof fixture>) => (f.source.resourceId = randomUUID()),
    (f: ReturnType<typeof fixture>) =>
      (f.source.targetReplyId = f.source.replyId),
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
  for (const kind of ['post', 'comment'] as const) {
    const f = fixture(kind);
    f.source.replyId = f.reply.id;
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
});

test('every contributing account must still be active, and self sources are suppressed', async () => {
  for (const member of [
    'actor',
    'recipient',
    'post',
    'root',
    'targetReply',
  ] as const) {
    const f = fixture();
    f.inactive.add(
      member === 'actor' || member === 'recipient'
        ? f[member]
        : f[member].account_id,
    );
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
  const f = fixture();
  assert.equal(
    await f.facade.project({ ...f.source, actorAccountId: f.recipient }, f.tx),
    null,
  );
  assert.deepEqual(f.calls, []);
});

test('read denial and dependency uncertainty redact rows; unrelated failures propagate', async () => {
  for (const authority of ['deny', 'unavailable'] as const) {
    const f = fixture();
    f.state.authority = authority;
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
  for (const code of [
    'COMMUNITY_UNAVAILABLE',
    'SAFETY_ACCESS_SUSPENDED',
  ] as const) {
    const f = fixture();
    f.state.error = new ApplicationError(code);
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
  const f = fixture();
  f.state.error = new Error('Unexpected database failure');
  await assert.rejects(f.facade.project(f.source, f.tx), f.state.error);
});

test('likes never turn an anonymous interaction actor into a named-profile or relationship lookup', async () => {
  const f = fixture('post');
  const first = await f.facade.project(f.source, f.tx);
  f.profileRows.clear();
  f.state.profileVisibility = 'blocked_by_you';
  const second = await f.facade.project(
    { ...f.source, actorAccountId: randomUUID() },
    f.tx,
  );
  assert.deepEqual(second, first);
  assert.ok(!f.calls.some((call) => /profile|reference/.test(call)));
});

test('follow projects only the current named actor, with a locked exact current edge', async () => {
  const f = fixture('follow');
  assert.deepEqual(await f.facade.project(f.source, f.tx), {
    kind: 'follow',
    target: { type: 'profile', profileId: f.actorProfileId },
    actor: { profileId: f.actorProfileId, displayName: 'Current public name' },
  });
  assert.ok(
    f.queries.some(
      ({ sql, values }) =>
        sql.includes('pg_try_advisory_xact_lock_shared') &&
        values[0] === `whaleu:following:${f.actor}`,
    ),
  );
  assert.ok(
    f.queries.some(
      ({ sql }) => sql.includes('user_follows') && sql.includes('FOR SHARE'),
    ),
  );
  await checkTransactionDeadlines(f.tx);
});

test('follow lifecycle locks precede edge gates and retirement never resolves a live persona', async () => {
  const live = fixture('follow');
  assert.ok(await live.facade.project(live.source, live.tx));
  const account = live.queries.findIndex(({ sql }) =>
    sql.includes('FROM whaleu_identity.accounts'),
  );
  const edge = live.queries.findIndex(({ sql }) =>
    sql.startsWith('SELECT pg_try_advisory'),
  );
  assert.ok(account >= 0 && account < edge);
  assert.match(live.queries[account]!.sql, /ORDER BY id FOR SHARE NOWAIT$/);
  assert.deepEqual(live.queries[account]!.values, [
    [live.actor, live.recipient].sort(),
  ]);
  for (const disposition of ['retired', 'erasing', 'cooling'] as const) {
    const f = fixture('follow');
    if (disposition === 'cooling') f.state.lifecycle = 'cooling';
    else f.state[disposition] = true;
    assert.equal(await f.facade.project(f.source, f.tx), null);
    assert.deepEqual(f.calls, []);
    assert.ok(!f.queries.some(({ sql }) => sql.includes('user_follows')));
  }
});

test('follow edge contention is unavailable and strict projections remain retryable', async () => {
  const f = fixture('follow');
  f.state.edgeLock = false;
  assert.equal(await f.facade.project(f.source, f.tx), null);
  await assert.rejects(
    f.facade.project(f.source, f.tx, true),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'COMMUNITY_UNAVAILABLE',
  );
  assert.deepEqual(f.calls, []);
});

test('follow removes all profile/target disclosure on edge, owner, lifecycle or relationship loss', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => (f.state.edge = false),
    (f: ReturnType<typeof fixture>) => f.inactive.add(f.actor),
    (f: ReturnType<typeof fixture>) => f.inactive.add(f.recipient),
    (f: ReturnType<typeof fixture>) => f.profileRows.delete(f.actorProfileId),
    (f: ReturnType<typeof fixture>) => f.profileRows.delete(f.profileId),
    (f: ReturnType<typeof fixture>) =>
      (f.profileRows.get(f.profileId)!.accountId = randomUUID()),
    (f: ReturnType<typeof fixture>) =>
      (f.profileRows.get(f.actorProfileId)!.accountId = randomUUID()),
    (f: ReturnType<typeof fixture>) =>
      (f.state.profileVisibility = 'unavailable'),
    (f: ReturnType<typeof fixture>) =>
      (f.state.profileVisibility = 'blocked_by_you'),
    (f: ReturnType<typeof fixture>) => (f.source.postId = f.post.id),
  ];
  for (const change of changes) {
    const f = fixture('follow');
    change(f);
    assert.equal(await f.facade.project(f.source, f.tx), null);
  }
});

test('managed transaction proof fails closed on late bilateral blocks and expired authority', async () => {
  const follow = fixture('follow');
  assert.ok(await follow.facade.project(follow.source, follow.tx));
  follow.state.finalBlocked = true;
  await assert.rejects(
    checkTransactionDeadlines(follow.tx),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'SAFETY_UNAVAILABLE',
  );
  const like = fixture('post');
  like.state.deadline = Date.parse('2026-10-19T23:59:59.999Z');
  assert.ok(await like.facade.project(like.source, like.tx));
  await assert.rejects(checkTransactionDeadlines(like.tx));
  const unmanaged = fixture();
  clearTransactionDeadlines(unmanaged.tx);
  await assert.rejects(
    unmanaged.facade.project(unmanaged.source, unmanaged.tx),
  );
});
