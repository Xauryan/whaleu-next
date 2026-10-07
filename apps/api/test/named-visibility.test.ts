import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CommunityAccessService } from '../src/community/community-access.service.js';
import type {
  CommunityVisibilityPort,
  Decision,
  VisibilityPurpose,
  VisibilitySubject,
} from '../src/community/community-policy.js';
import type {
  CommunityRepository,
  StoredComment,
  StoredPost,
  StoredReply,
} from '../src/community/community.repository.js';
import { CommunityContentIdentityService } from '../src/community/content-identity.service.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import { FormationService } from '../src/community/formation/service.js';
import type {
  FormationRepository,
  StoredFormationMember,
} from '../src/community/formation/repository.js';
import type { SavedRepository } from '../src/community/saved/repository.js';
import { CommunityUpdatesFacade } from '../src/community/updates.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { AuthorDisplayService } from '../src/profile/author-display.service.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';
import { verified } from './support/community-fixtures.js';

const viewer = 'viewer';
const purposes = [
  'list_projection',
  'direct_post',
  'named_interaction',
] as const satisfies readonly VisibilityPurpose[];
const allowed: Decision = { kind: 'allow', value: undefined };
const now = new Date('2026-10-07T00:00:00.000Z');
type Directions = { outgoing: boolean; incoming: boolean };
const noBlocks: Directions = { outgoing: false, incoming: false };
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

/** Synthetic queries cover lock ordering and facade lookups without a pool,
 * database lease, environment switches, or production fixture adapters. */
function fixture() {
  const post: StoredPost = {
    id: 'post',
    space_id: 'space',
    account_id: 'post-author',
    category: 'discussion',
    text: 'A post',
    author_mode: 'named',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: now,
  };
  const comment: StoredComment = {
    id: 'comment',
    post_id: post.id,
    account_id: 'comment-author',
    text: 'A comment',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: now,
  };
  const reply: StoredReply = {
    ...comment,
    id: 'reply',
    account_id: 'reply-author',
    text: 'A reply',
    root_comment_id: comment.id,
    target_reply_id: null,
    sequence: '1',
  };
  const space: CommunitySpace = {
    id: 'space',
    kind: 'regional',
    name: 'Synthetic',
    isActive: true,
    operatingRegionId: 'region',
  };
  const trace: string[] = [];
  const checks: {
    viewer: string | null;
    subject: VisibilitySubject;
    tx: PoolClient;
    purpose: VisibilityPurpose;
  }[] = [];
  const directionCalls: Parameters<SafetyRepository['directions']>[] = [];
  const state = {
    post,
    comment,
    reply,
    base: allowed,
    scopeError: null as Error | null,
    blocks: new Map<string, Directions | null>(),
    queryRows: (_sql: string): unknown[] => [],
  };
  const tx = {
    query: async (sql: string) => {
      trace.push('query');
      return { rows: state.queryRows(sql) };
    },
  } as unknown as PoolClient;
  const base: CommunityVisibilityPort = {
    check: async (viewer, subject, tx, purpose) => {
      trace.push(`visibility:${subject.contentId}:${purpose}`);
      checks.push({ viewer, subject, tx, purpose });
      return state.base;
    },
  };
  const records = {
    directions: async (...args: Parameters<SafetyRepository['directions']>) => {
      directionCalls.push(args);
      trace.push(`blocks:${args[1]}:${args[2]}`);
      return state.blocks.has(args[1]) ? state.blocks.get(args[1])! : noBlocks;
    },
  } as unknown as SafetyRepository;
  const visibility = new NamedBlockVisibility(base, records);
  const repository = {
    post: async (id: string, transaction: PoolClient, write = false) => {
      assert.equal(transaction, tx);
      assert.equal(id, post.id);
      trace.push(`post:${write}`);
      return state.post;
    },
    space: async () => {
      trace.push('space');
      if (state.scopeError) throw state.scopeError;
      return space;
    },
    comment: async (id: string, transaction: PoolClient, lock = false) => {
      assert.equal(transaction, tx);
      assert.equal(id, comment.id);
      trace.push(`comment:${lock}`);
      return state.comment;
    },
    reply: async (id: string, transaction: PoolClient, lock = false) => {
      assert.equal(transaction, tx);
      assert.equal(id, reply.id);
      trace.push(`reply:${lock}`);
      return state.reply;
    },
  } as unknown as CommunityRepository;
  const authority = verified('region');
  const identity = {
    activeAccount: async () => true,
  } as unknown as IdentityService;
  const access = new CommunityAccessService(
    identity,
    {
      resolve: async () => {
        trace.push('authority');
        return { kind: 'allow', value: authority };
      },
    },
    visibility,
    repository,
  );
  return {
    access,
    authority,
    checks,
    directionCalls,
    identity,
    repository,
    space,
    state,
    trace,
    tx,
    visibility,
  };
}

test('named-block directions have an explicit one-way list and two-way direct/interaction matrix', async () => {
  for (const purpose of purposes) {
    for (const outgoing of [false, true]) {
      for (const incoming of [false, true]) {
        const f = fixture();
        f.state.blocks.set('author', { outgoing, incoming });
        const subject: VisibilitySubject = {
          contentId: 'content',
          authorMode: 'named',
          namedAccountId: 'author',
        };
        const expected: Decision = outgoing
          ? {
              kind: 'deny',
              reason:
                purpose === 'direct_post'
                  ? 'POST_BLOCKED_BY_YOU'
                  : 'POST_NOT_FOUND',
            }
          : incoming && purpose !== 'list_projection'
            ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
            : allowed;
        assert.deepEqual(
          await f.visibility.check(viewer, subject, f.tx, purpose),
          expected,
          JSON.stringify({ purpose, outgoing, incoming }),
        );
        assert.deepEqual(f.checks, [{ viewer, subject, tx: f.tx, purpose }]);
        assert.deepEqual(f.directionCalls, [[viewer, 'author', purpose, f.tx]]);
      }
    }
  }
});

test('base denial and unavailability short-circuit every named-block purpose', async () => {
  for (const purpose of purposes) {
    for (const decision of [
      { kind: 'unavailable' },
      { kind: 'deny', reason: 'POST_NOT_FOUND' },
    ] as const) {
      const f = fixture();
      f.state.base = decision;
      assert.equal(
        await f.visibility.check(
          viewer,
          { contentId: 'post', authorMode: 'named', namedAccountId: 'author' },
          f.tx,
          purpose,
        ),
        decision,
      );
      assert.equal(f.directionCalls.length, 0);
    }
  }
});

test('anonymous visibility never reads even a forged hidden named account or calls block directions', async () => {
  // This compile-time failure also guards the discriminated privacy boundary.
  // @ts-expect-error Anonymous subjects cannot carry the underlying account ID.
  const malformed: VisibilitySubject = {
    contentId: 'anonymous',
    authorMode: 'anonymous',
    namedAccountId: 'secret',
  };
  Object.defineProperty(malformed, 'namedAccountId', {
    get: () => assert.fail('Anonymous account must never be inspected'),
  });
  for (const purpose of purposes) {
    const f = fixture();
    assert.equal(
      await f.visibility.check(viewer, malformed, f.tx, purpose),
      allowed,
    );
    f.state.base = { kind: 'unavailable' };
    assert.deepEqual(
      await f.visibility.check(viewer, malformed, f.tx, purpose),
      { kind: 'unavailable' },
    );
    assert.equal(f.directionCalls.length, 0);
  }
});

test('guest and self checks retain the base policy without looking up a named pair', async () => {
  for (const purpose of purposes) {
    for (const accountId of [null, 'author']) {
      const f = fixture();
      const subject: VisibilitySubject = {
        contentId: 'post',
        authorMode: 'named',
        namedAccountId: 'author',
      };
      assert.equal(
        await f.visibility.check(accountId, subject, f.tx, purpose),
        allowed,
      );
      f.state.base = { kind: 'unavailable' };
      assert.deepEqual(
        await f.visibility.check(accountId, subject, f.tx, purpose),
        { kind: 'unavailable' },
      );
      assert.equal(f.directionCalls.length, 0);
    }
  }
});

test('missing block coverage remains unavailable for every purpose', async () => {
  for (const purpose of purposes) {
    const f = fixture();
    f.state.blocks.set(f.state.post.account_id, null);
    await assert.rejects(
      f.access.visible(viewer, f.state.post, f.tx, purpose),
      errorIs('COMMUNITY_UNAVAILABLE'),
    );
    assert.equal(f.directionCalls[0]?.[2], purpose);
  }
});

test('access constructs anonymous subjects without any stored private account or profile fields', async () => {
  const f = fixture();
  f.state.post.author_mode = 'anonymous';
  Object.defineProperties(f.state.post, {
    account_id: { get: () => assert.fail('Do not read the anonymous account') },
    namedAccountId: { value: 'forged-named-account', enumerable: true },
    profileId: { value: 'private-profile', enumerable: true },
  });
  for (const purpose of purposes) {
    assert.equal(
      await f.access.visible(viewer, f.state.post, f.tx, purpose),
      true,
    );
  }
  assert.deepEqual(
    f.checks.map(({ subject }) => subject),
    purposes.map(() => ({
      contentId: f.state.post.id,
      authorMode: 'anonymous',
    })),
  );
  assert.equal(f.directionCalls.length, 0);
});

test('hidden and deleted content is rejected before either visibility port or block lookup', async () => {
  for (const purpose of purposes) {
    for (const changes of [
      { visibility: 'hidden' as const },
      { deleted_at: now },
    ]) {
      const f = fixture();
      Object.assign(f.state.post, changes);
      assert.deepEqual(
        await f.access.visibilityDecision(viewer, f.state.post, f.tx, purpose),
        {
          kind: 'deny',
          reason: 'POST_NOT_FOUND',
        },
      );
      assert.equal(f.checks.length, 0);
      assert.equal(f.directionCalls.length, 0);
    }
  }
});

test('only opted-in direct post access explains an outgoing block', async () => {
  for (const explain of [false, true]) {
    const f = fixture();
    f.state.blocks.set(f.state.post.account_id, {
      outgoing: true,
      incoming: false,
    });
    await assert.rejects(
      f.access.accessiblePost('post', viewer, f.tx, false, explain),
      errorIs(explain ? 'POST_BLOCKED_BY_YOU' : 'POST_NOT_FOUND'),
    );
    assert.deepEqual(
      f.checks.map(({ purpose }) => purpose),
      ['direct_post'],
    );
    assert.ok(
      f.trace.indexOf('space') <
        f.trace.indexOf('blocks:post-author:direct_post'),
    );
  }
  const incoming = fixture();
  incoming.state.blocks.set(incoming.state.post.account_id, {
    outgoing: false,
    incoming: true,
  });
  await assert.rejects(
    incoming.access.accessiblePost('post', viewer, incoming.tx, false, true),
    errorIs('POST_NOT_FOUND'),
  );
});

test('live content and active scope are checked before an own-block explanation', async () => {
  for (const unavailable of ['hidden', 'deleted', 'scope'] as const) {
    const f = fixture();
    f.state.blocks.set(f.state.post.account_id, {
      outgoing: true,
      incoming: false,
    });
    if (unavailable === 'hidden') f.state.post.visibility = 'hidden';
    if (unavailable === 'deleted') f.state.post.deleted_at = now;
    if (unavailable === 'scope')
      f.state.scopeError = new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    await assert.rejects(
      f.access.accessiblePost('post', viewer, f.tx, false, true),
      errorIs('POST_NOT_FOUND'),
    );
    assert.equal(f.checks.length, 0);
    assert.equal(f.directionCalls.length, 0);
    assert.deepEqual(
      f.trace,
      unavailable === 'scope'
        ? ['query', 'post:false', 'space']
        : ['query', 'post:false'],
    );
  }
});

test('base unavailability is not rewritten as a hidden post or an own-block explanation', async () => {
  const f = fixture();
  f.state.base = { kind: 'unavailable' };
  await assert.rejects(
    f.access.accessiblePost('post', viewer, f.tx, false, true),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(f.directionCalls.length, 0);
});

test('named interactions use the two-way purpose and never disclose an own-block reason', async () => {
  for (const block of [
    { outgoing: true, incoming: false },
    { outgoing: false, incoming: true },
  ]) {
    const f = fixture();
    f.state.blocks.set(f.state.comment.account_id, block);
    await assert.rejects(
      f.access.interaction(viewer, f.state.comment, f.tx),
      errorIs('POST_NOT_FOUND'),
    );
    assert.deepEqual(
      f.checks.map(({ purpose }) => purpose),
      ['named_interaction'],
    );
    assert.equal(
      await f.access.visible(viewer, f.state.comment, f.tx, 'list_projection'),
      !block.outgoing,
    );
  }
});

test('comment access checks the parent directly and projects the child one way, for reads and writes', async () => {
  for (const write of [false, true]) {
    const f = fixture();
    f.state.blocks.set(f.state.comment.account_id, {
      outgoing: false,
      incoming: true,
    });
    const result = await f.access.accessibleComment(
      'comment',
      viewer,
      f.tx,
      write,
    );
    assert.equal(result.comment, f.state.comment);
    assert.deepEqual(
      f.checks.map(({ subject, purpose }) => [subject.contentId, purpose]),
      [
        ['post', 'direct_post'],
        ['comment', 'list_projection'],
      ],
    );
    assert.ok(
      f.trace.indexOf(`post:${write}`) < f.trace.indexOf('comment:true'),
    );
  }
});

test('reply access checks the parent directly, then root and reply as list projections', async () => {
  const f = fixture();
  for (const child of [f.state.comment, f.state.reply]) {
    f.state.blocks.set(child.account_id, { outgoing: false, incoming: true });
  }
  const result = await f.access.accessibleReply('reply', viewer, f.tx);
  assert.equal(result.reply, f.state.reply);
  assert.deepEqual(
    f.checks.map(({ subject, purpose }) => [subject.contentId, purpose]),
    [
      ['post', 'direct_post'],
      ['comment', 'list_projection'],
      ['reply', 'list_projection'],
    ],
  );
  assert.ok(f.trace.indexOf('post:false') < f.trace.indexOf('comment:true'));
  assert.ok(f.trace.indexOf('comment:true') < f.trace.indexOf('reply:true'));
});

test('blocked parent stops descendant access before child visibility or locked reads', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    const f = fixture();
    f.state.blocks.set(f.state.post.account_id, {
      outgoing: true,
      incoming: false,
    });
    await assert.rejects(
      kind === 'comment'
        ? f.access.accessibleComment('comment', viewer, f.tx)
        : f.access.accessibleReply('reply', viewer, f.tx),
      errorIs('POST_NOT_FOUND'),
    );
    assert.deepEqual(
      f.checks.map(({ subject }) => subject.contentId),
      ['post'],
    );
    assert.equal(f.trace.includes('comment:true'), false);
    assert.equal(f.trace.includes('reply:true'), false);
  }
});

test('outgoing child blocks produce child-not-found without the direct-post explanation', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    const f = fixture();
    f.state.blocks.set(f.state[kind].account_id, {
      outgoing: true,
      incoming: false,
    });
    await assert.rejects(
      kind === 'comment'
        ? f.access.accessibleComment('comment', viewer, f.tx)
        : f.access.accessibleReply('reply', viewer, f.tx),
      errorIs(kind === 'comment' ? 'COMMENT_NOT_FOUND' : 'REPLY_NOT_FOUND'),
    );
    assert.equal(f.checks.at(-1)?.purpose, 'list_projection');
  }
});

test('formation roster checks the parent directly then projects members without revealing an anonymous creator', async () => {
  const f = fixture();
  f.state.post.author_mode = 'anonymous';
  f.state.queryRows = (sql) =>
    sql.includes('thread_personas')
      ? [{ id: 'persona', display_name: 'Anonymous whale' }]
      : [];
  const members: StoredFormationMember[] = [
    {
      id: 'creator',
      formation_id: 'formation',
      account_id: f.state.post.account_id,
      is_creator: true,
      joined_at: now,
      seat: 1,
      contact_sharing: 'members_v1',
    },
    {
      id: 'joiner',
      formation_id: 'formation',
      account_id: 'joiner-account',
      is_creator: false,
      joined_at: now,
      seat: 2,
      contact_sharing: 'members_v1',
    },
  ];
  f.state.blocks.set('joiner-account', { outgoing: false, incoming: true });
  const formations = {
    find: async () => ({
      id: 'formation',
      post_id: 'post',
      capacity: 5,
      theme: 'A meetup',
      reconciliation: 'current',
    }),
    members: async () => members,
  } as unknown as FormationRepository;
  const profiles = {
    find: async () => ({ profileId: 'joiner-profile', displayName: 'Joiner' }),
  } as unknown as AuthorDisplayService;
  const service = new FormationService(
    f.repository,
    f.access,
    formations,
    profiles,
  );
  const result = await service.project(f.state.post, viewer, f.authority, f.tx);
  assert.deepEqual(
    result?.members.map(({ id }) => id),
    ['creator', 'joiner'],
  );
  assert.deepEqual(
    f.checks.map(({ subject, purpose }) => [subject, purpose]),
    [
      [{ contentId: 'post', authorMode: 'anonymous' }, 'direct_post'],
      [{ contentId: 'post', authorMode: 'anonymous' }, 'list_projection'],
      [
        {
          contentId: 'joiner',
          authorMode: 'named',
          namedAccountId: 'joiner-account',
        },
        'list_projection',
      ],
    ],
  );
  assert.deepEqual(
    f.directionCalls.map(([, accountId, purpose]) => [accountId, purpose]),
    [['joiner-account', 'list_projection']],
  );
});

test('a reverse-only named block keeps the formation feed card visible but withholds its full roster', async () => {
  const f = fixture();
  f.state.blocks.set(f.state.post.account_id, {
    outgoing: false,
    incoming: true,
  });
  let rosterReads = 0;
  const formations = {
    find: async () => ({
      id: 'formation',
      post_id: 'post',
      capacity: 5,
      theme: 'A meetup',
      reconciliation: 'current',
    }),
    members: async () => {
      rosterReads++;
      assert.fail('The reverse-blocked roster must not be loaded');
    },
  } as unknown as FormationRepository;
  const profiles = {
    find: async () => assert.fail('No member profile may be loaded'),
  } as unknown as AuthorDisplayService;
  const service = new FormationService(
    f.repository,
    f.access,
    formations,
    profiles,
  );
  assert.equal(
    await f.access.visible(viewer, f.state.post, f.tx, 'list_projection'),
    true,
  );
  assert.equal(
    await service.project(f.state.post, viewer, f.authority, f.tx),
    null,
  );
  assert.equal(rosterReads, 0);
  assert.deepEqual(
    f.checks.map(({ subject, purpose }) => [subject.contentId, purpose]),
    [
      ['post', 'list_projection'],
      ['post', 'direct_post'],
    ],
  );
});

test('privileged identity facade still applies direct parent and one-way child visibility', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    const f = fixture();
    f.state.blocks.set(f.state[kind].account_id, {
      outgoing: false,
      incoming: true,
    });
    const service = new CommunityContentIdentityService(f.repository, f.access);
    const result = await service.resolve({ kind, id: kind }, viewer, f.tx);
    assert.equal(result?.accountId, f.state[kind].account_id);
    assert.equal(f.checks[0]?.purpose, 'direct_post');
    assert.equal(f.checks.at(-1)?.purpose, 'list_projection');
    f.state.blocks.set(f.state[kind].account_id, {
      outgoing: true,
      incoming: false,
    });
    assert.equal(await service.resolve({ kind, id: kind }, viewer, f.tx), null);
  }
});

test('formation identity resolution projects a creator persona or named joiner with an explicit list purpose', async () => {
  for (const isCreator of [true, false]) {
    const f = fixture();
    f.state.post.author_mode = 'anonymous';
    const accountId = isCreator ? f.state.post.account_id : 'joiner-account';
    f.state.queryRows = (sql) => {
      if (sql.startsWith('SELECT f.post_id')) return [{ post_id: 'post' }];
      if (sql.startsWith('SELECT m.account_id')) {
        return [{ account_id: accountId, is_creator: isCreator }];
      }
      return [];
    };
    f.state.blocks.set(accountId, { outgoing: false, incoming: true });
    const service = new CommunityContentIdentityService(f.repository, f.access);
    const result = await service.resolve(
      { kind: 'formation_member', id: 'membership' },
      viewer,
      f.tx,
    );
    assert.equal(result?.accountId, accountId);
    assert.equal(result?.authorMode, isCreator ? 'anonymous' : 'named');
    assert.deepEqual(
      f.checks.map(({ subject, purpose }) => [subject, purpose]),
      [
        [{ contentId: 'post', authorMode: 'anonymous' }, 'direct_post'],
        [
          isCreator
            ? { contentId: 'post', authorMode: 'anonymous' }
            : {
                contentId: 'membership',
                authorMode: 'named',
                namedAccountId: accountId,
              },
          'list_projection',
        ],
      ],
    );
    assert.equal(f.directionCalls.length, isCreator ? 0 : 1);
  }
});

test('update eligibility uses direct parent and list child purposes before constructing previews', async () => {
  const f = fixture();
  for (const child of [f.state.comment, f.state.reply]) {
    f.state.blocks.set(child.account_id, { outgoing: false, incoming: true });
  }
  let previews = 0;
  const serializer = {
    images: async () => {
      previews++;
      return [];
    },
    author: async () => ({
      kind: 'named',
      profileId: 'reply-profile',
      displayName: 'Reply author',
      avatar: null,
    }),
  } as unknown as CommunitySerializer;
  const saved = { preferences: async () => null } as unknown as SavedRepository;
  const service = new CommunityUpdatesFacade(
    f.repository,
    f.access,
    serializer,
    saved,
    f.identity,
  );
  const target = { postId: 'post', commentId: 'comment', replyId: 'reply' };
  const recipient = {
    accountId: viewer,
    reason: 'direct',
    saveEpochId: null,
  } as const;
  assert.equal(
    (await service.eligible(target, recipient, f.tx)).outcome,
    'eligible',
  );
  assert.deepEqual(
    f.checks.map(({ subject, purpose }) => [subject.contentId, purpose]),
    [
      ['post', 'direct_post'],
      ['comment', 'list_projection'],
      ['reply', 'list_projection'],
    ],
  );
  assert.equal(previews, 1);
  f.state.blocks.set(f.state.reply.account_id, {
    outgoing: true,
    incoming: false,
  });
  assert.deepEqual(await service.eligible(target, recipient, f.tx), {
    outcome: 'suppressed',
    code: 'target_inaccessible',
  });
  assert.equal(previews, 1);
});
