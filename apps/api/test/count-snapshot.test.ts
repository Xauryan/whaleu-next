import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { types } from 'pg';
import type { PoolClient } from 'pg';
import type { CampusService } from '../src/campus/campus.service.js';
import type { CampusContentScopeFacade } from '../src/campus/content-scope.facade.js';
import type { RuntimeConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { checkpointTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { SafetyContentVisibilityFacade } from '../src/safety/content-visibility.facade.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';
import { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityAuthorizationPort } from '../src/community/community-policy.js';
import { CommunityRepository } from '../src/community/community.repository.js';
import type {
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type {
  ApprovalBinding,
  ApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import {
  canonicalEnvelope,
  approvalDigest,
  operationForKind,
} from '../src/community/content-review/contracts.js';
import type {
  ContentKind,
  EffectiveContentEnvelope,
} from '../src/community/content-review/contracts.js';
import { ContentReviewCountFacade } from '../src/community/content-review/count-snapshot.facade.js';
import {
  ContentReviewCountRepository,
  SnapshotReadBudget,
  contentKey,
} from '../src/community/content-review/count-snapshot.repository.js';
import type { CountReviewSnapshot } from '../src/community/content-review/count-snapshot.repository.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import type { LikedCandidate } from '../src/community/liked/repository.js';

function fixture(collision = false) {
  const viewer = randomUUID(),
    postId = randomUUID(),
    rootId = collision ? postId : randomUUID(),
    replyId = collision ? postId : randomUUID(),
    spaceId = randomUUID(),
    regionId = randomUUID();
  const now = Date.parse('2026-10-07T00:00:00.000Z');
  const post: DefinitionPost = {
    id: postId,
    space_id: spaceId,
    account_id: randomUUID(),
    category: 'discussion',
    text: 'Reviewed post',
    author_mode: 'named',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date(now - 10000),
    publication_state: 'published',
  };
  const root: StoredComment = {
    id: rootId,
    post_id: postId,
    account_id: randomUUID(),
    text: 'Reviewed root',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(now - 9000),
  };
  const reply: StoredReply = {
    id: replyId,
    post_id: postId,
    root_comment_id: rootId,
    target_reply_id: randomUUID(),
    account_id: randomUUID(),
    text: 'Reviewed exact reply',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(now - 8000),
    sequence: '1',
  };
  const snapshot: CountReviewSnapshot = {
    posts: new Map([[postId, post]]),
    roots: new Map([[rootId, root]]),
    replies: new Map([[replyId, reply]]),
    spaces: new Map([
      [
        spaceId,
        {
          id: spaceId,
          is_active: true,
          kind: 'regional',
          operating_region_id: regionId,
        },
      ],
    ]),
    bindings: new Map(),
    approvals: new Map(),
    images: new Map(),
    polls: new Map(),
    formations: new Map(),
    listings: new Map(),
    options: new Map(),
    creators: new Map(),
    now,
    budget: new SnapshotReadBudget(),
    dependencies: {
      contentIds: [postId, rootId, replyId],
      spaceIds: [spaceId],
      namedAccountIds: [],
    },
  };
  const membership: LikedCandidate = {
    kind: 'reply',
    target_id: replyId,
    post_id: postId,
    root_comment_id: rootId,
    like_id: randomUUID(),
    liked_at: null,
  };
  let current: { like_id: string; liked_at: Date | null } | null = {
    like_id: membership.like_id,
    liked_at: null,
  };
  const blocked = new Set<string>(),
    unknownSafety = new Set<string>(),
    safetyInputs: string[][] = [];
  let regionActive = true;
  function bind(kind: ContentKind) {
    const node = kind === 'post' ? post : kind === 'comment' ? root : reply;
    const env: EffectiveContentEnvelope = canonicalEnvelope({
      version: 1,
      accountId: node.account_id,
      purpose: operationForKind(kind),
      spaceId,
      category: post.category,
      authorMode: node.author_mode,
      commentsPolicy: 'open',
      postId: kind === 'post' ? null : postId,
      rootCommentId: kind === 'reply' ? rootId : null,
      targetReplyId: kind === 'reply' ? reply.target_reply_id : null,
      text: node.text,
      images: [],
      component: { kind: 'none' },
      trading: null,
      scope: {
        originalSpaceId: spaceId,
        originalRegionId: regionId,
        authorOriginRegionId: regionId,
        identityRegionId: regionId,
        topologySnapshotId: randomUUID(),
        sync: 'none',
      },
    });
    const row: ApprovalRow = {
      id: randomUUID(),
      account_id: node.account_id,
      operation: env.purpose,
      envelope_version: 1,
      digest: approvalDigest(env),
      envelope: env,
      policy_revision_id: randomUUID(),
      result: 'allow',
      coverage: 'complete',
      provenance: 'accepted',
      issuer: 'fixture',
      provenance_ref: 'fixture',
      evaluated_at: new Date(now - 5000),
      consume_until: new Date(now - 4000),
      visibility_model: 'durable',
      visibility_until: null,
      policy_key: 'local-explicit-v1',
      policy_version: 1,
      policy_coverage: 'complete',
      policy_provenance: 'accepted',
      policy_issuer: 'fixture',
      policy_provenance_ref: 'fixture',
      policy_valid_from: new Date(now - 6000),
      policy_valid_until: null,
      state: 'allow',
      event_at: new Date(now - 5000),
      event_coverage: 'complete',
      event_provenance: 'accepted',
      event_issuer: 'fixture',
      event_provenance_ref: 'fixture',
    };
    const binding: ApprovalBinding = {
      content_kind: kind,
      content_id: node.id,
      content_version: 1,
      decision_id: row.id,
      account_id: node.account_id,
      operation: env.purpose,
      envelope_version: 1,
      digest: row.digest,
      envelope: env,
      scope: env.scope,
    };
    snapshot.bindings.set(contentKey(kind, node.id), binding);
    snapshot.approvals.set(row.id, row);
    return row;
  }
  for (const kind of ['post', 'comment', 'reply'] as const) bind(kind);
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      const one = (value: unknown) => ({ rows: value ? [value] : [] });
      if (sql.includes('clock_timestamp')) return one({ now: new Date(now) });
      if (sql.includes('pg_advisory')) return { rows: [] };
      if (sql.includes('whaleu_identity.accounts')) return one({ id: args[0] });
      if (sql.includes('content_approval_bindings'))
        return one(
          snapshot.bindings.get(
            contentKey(args[0] as ContentKind, args[1] as string),
          ),
        );
      if (sql.includes('content_approval_decisions'))
        return one(snapshot.approvals.get(args[0] as string));
      if (sql.includes('whaleu_community.posts'))
        return one(snapshot.posts.get(args[0] as string));
      if (sql.includes('whaleu_community.spaces')) {
        const row = snapshot.spaces.get(args[0] as string);
        return one(
          row
            ? {
                ...row,
                isActive: row.is_active,
                operatingRegionId: row.operating_region_id,
              }
            : undefined,
        );
      }
      if (sql.includes('root_comments')) {
        const row = snapshot.roots.get(args[0] as string);
        return one(
          row && (args.length < 2 || row.post_id === args[1]) ? row : undefined,
        );
      }
      if (sql.includes('whaleu_community.replies')) {
        const row = snapshot.replies.get(args[0] as string);
        return one(
          row &&
            (args.length < 2 ||
              (row.post_id === args[1] && row.root_comment_id === args[2]))
            ? row
            : undefined,
        );
      }
      for (const kind of ['post', 'comment', 'reply'] as const)
        if (sql.includes(`.${kind}_images`))
          return {
            rows:
              snapshot.images.get(contentKey(kind, args[0] as string)) ?? [],
          };
      if (sql.includes('.poll_options'))
        return { rows: snapshot.options.get(args[0] as string) ?? [] };
      if (sql.includes('.formation_members'))
        return { rows: snapshot.creators.get(args[0] as string) ?? [] };
      if (sql.includes('.polls'))
        return one(snapshot.polls.get(args[0] as string));
      if (sql.includes('.formations'))
        return one(snapshot.formations.get(args[0] as string));
      if (sql.includes('.trading_listings'))
        return one(snapshot.listings.get(args[0] as string));
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  const campus = {
    requireActiveRegion: async () => {
      if (!regionActive)
        throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
      return { id: regionId, isActive: true };
    },
  } as unknown as CampusService;
  const base = new LocalApprovedContentVisibility(
    new ApprovalRepository(),
    new ContentDefinitionRepository(campus),
  );
  const scalarSafety = {
    directions: async (_viewer: string, author: string) =>
      unknownSafety.has(author)
        ? null
        : { outgoing: blocked.has(author), incoming: false },
  } as unknown as SafetyRepository;
  const access = new CommunityAccessService(
    {} as IdentityService,
    {} as CommunityAuthorizationPort,
    new NamedBlockVisibility(base, scalarSafety),
    new CommunityRepository({} as RuntimeConfig, {} as DatabaseService, campus),
  );
  const records = {
    read: async () => snapshot,
    memberships: async () =>
      new Map(current ? [[contentKey('reply', reply.id), current]] : []),
  } as unknown as ContentReviewCountRepository;
  const countCampus = {
    readRegionsBatch: async () => new Map([[regionId, regionActive]]),
  } as unknown as CampusContentScopeFacade;
  const safety = {
    checkBatch: async (_viewer: string | null, authors: string[]) => {
      safetyInputs.push(authors);
      return {
        facts: new Map(
          authors.map((author) => [
            author,
            {
              decision: unknownSafety.has(author)
                ? 'unknown'
                : blocked.has(author)
                  ? 'deny'
                  : 'allow',
              optionalUntil: null,
            },
          ]),
        ),
        namedAccountIds: authors,
      };
    },
  } as unknown as SafetyContentVisibilityFacade;
  const facade = new ContentReviewCountFacade(records, countCampus, safety);
  const scalarPost = async () => {
    try {
      await access.accessiblePost(post.id, viewer, tx);
      return 'allow';
    } catch (error) {
      return error instanceof ApplicationError &&
        error.code === 'POST_NOT_FOUND'
        ? 'deny'
        : 'unknown';
    }
  };
  const scalarLiked = async () => {
    if (!current) return 'deny';
    const parent = await scalarPost();
    if (parent !== 'allow') return parent;
    try {
      if (!(await access.visible(viewer, root, tx, 'direct_post')))
        return 'deny';
      if (!(await access.visible(viewer, reply, tx, 'direct_post')))
        return 'deny';
      return current.like_id === membership.like_id &&
        current.liked_at === membership.liked_at
        ? 'allow'
        : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return {
    viewer,
    post,
    root,
    reply,
    snapshot,
    membership,
    blocked,
    unknownSafety,
    safetyInputs,
    bind,
    facade,
    tx,
    scalarPost,
    scalarLiked,
    setCurrent: (value: typeof current) => {
      current = value;
    },
    setRegion: (value: boolean) => {
      regionActive = value;
    },
  };
}

test('snapshot/scalar post differential preserves all canonical gates and denial ordering', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    () => {},
    (f) => {
      f.post.visibility = 'hidden';
      f.snapshot.bindings.clear();
    },
    (f) => {
      f.post.deleted_at = new Date();
      f.snapshot.bindings.clear();
    },
    (f) => {
      f.snapshot.spaces.clear();
      f.snapshot.bindings.clear();
    },
    (f) => {
      f.setRegion(false);
      f.snapshot.bindings.clear();
    },
    (f) => {
      f.snapshot.bindings.delete(contentKey('post', f.post.id));
    },
    (f) => {
      f.post.text = 'tampered';
    },
    (f) => {
      f.bind('post').state = 'held';
    },
    (f) => {
      const row = f.bind('post');
      row.state = 'held';
      row.policy_valid_until = new Date(f.snapshot.now);
    },
    (f) => {
      const row = f.bind('post');
      row.state = 'held';
      f.snapshot.bindings.get(contentKey('post', f.post.id))!.envelope =
        {} as EffectiveContentEnvelope;
    },
    (f) => {
      f.bind('post').event_provenance = 'unknown';
    },
    (f) => {
      f.blocked.add(f.post.account_id);
    },
    (f) => {
      f.unknownSafety.add(f.post.account_id);
    },
    (f) => {
      f.post.author_mode = 'anonymous';
      f.bind('post');
      f.unknownSafety.add(f.post.account_id);
    },
    (f) => {
      f.post.account_id = f.viewer;
      f.bind('post');
      f.unknownSafety.add(f.viewer);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const actual = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
    assert.equal(actual.facts.get(f.post.id)?.decision, await f.scalarPost());
  }
});

test('liked snapshot/scalar differential covers every named/anonymous chain and exact addressed-reply distinction', async () => {
  for (let mask = 0; mask < 8; mask++)
    for (const blockedIndex of [-1, 0, 1, 2]) {
      const f = fixture(),
        nodes = [f.post, f.root, f.reply];
      nodes.forEach((node, i) => {
        node.author_mode = mask & (1 << i) ? 'anonymous' : 'named';
      });
      for (const kind of ['post', 'comment', 'reply'] as const) f.bind(kind);
      if (blockedIndex >= 0) f.blocked.add(nodes[blockedIndex]!.account_id);
      const result = await f.facade.evaluateLiked(
        [f.membership],
        f.viewer,
        f.tx,
      );
      assert.equal(
        result.facts.get(`reply:${f.membership.like_id}`)?.decision,
        await f.scalarLiked(),
        `mask=${mask},block=${blockedIndex}`,
      );
      const anonymous = new Set(
        nodes
          .filter((node) => node.author_mode === 'anonymous')
          .map((node) => node.account_id),
      );
      assert.ok(
        f.safetyInputs.flat().every((author) => !anonymous.has(author)),
      );
      assert.ok(
        !f.snapshot.replies.has(f.reply.target_reply_id!),
        'addressed reply is intentionally absent',
      );
    }
});

test('parent denial short-circuits unknown child, malformed binding and replacement membership', async () => {
  const f = fixture();
  f.blocked.add(f.post.account_id);
  f.snapshot.bindings.delete(contentKey('reply', f.reply.id));
  f.setCurrent({ like_id: randomUUID(), liked_at: null });
  assert.equal(
    (await f.facade.evaluateLiked([f.membership], f.viewer, f.tx)).facts.get(
      `reply:${f.membership.like_id}`,
    )?.decision,
    'deny',
  );
  f.blocked.clear();
  assert.equal(
    (await f.facade.evaluateLiked([f.membership], f.viewer, f.tx)).facts.get(
      `reply:${f.membership.like_id}`,
    )?.decision,
    'unknown',
  );
});

test('typed cross-kind UUID collisions retain three independent canonical subjects', async () => {
  const f = fixture(true);
  const result = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
  assert.equal(
    result.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'allow',
  );
  f.snapshot.bindings.delete(contentKey('comment', f.root.id));
  assert.equal(
    (await f.facade.evaluateLiked([f.membership], f.viewer, f.tx)).facts.get(
      `reply:${f.membership.like_id}`,
    )?.decision,
    'unknown',
  );
});

test('conditional denial horizons are retained without registering locked transaction deadlines', async () => {
  const f = fixture(),
    until = f.snapshot.now + 1000,
    row = f.bind('post');
  row.state = 'revoked';
  row.policy_valid_until = new Date(until);
  const before = checkpointTransactionDeadlines(f.tx);
  const result = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
  assert.equal(result.optionalUntil, until);
  assert.equal(
    result.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'deny',
  );
  assert.deepEqual(checkpointTransactionDeadlines(f.tx), before);
});

test('snapshot repository uses bounded set-oriented SQL with byte guards and no row locks', async () => {
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('clock_timestamp')
        ? { rows: [{ now: new Date() }] }
        : { rows: [] };
    },
  } as unknown as PoolClient;
  const repo = new ContentReviewCountRepository();
  await repo.read(
    {
      posts: Array.from({ length: 256 }, () => randomUUID()),
      roots: Array.from({ length: 256 }, () => randomUUID()),
      replies: Array.from({ length: 256 }, () => randomUUID()),
    },
    tx,
  );
  assert.equal(queries.length, 9);
  assert.ok(queries.every((sql) => !/FOR (SHARE|UPDATE)/.test(sql)));
  assert.equal(
    queries.filter((sql) => sql.includes('count_snapshot_source')).length,
    8,
  );
  assert.ok(
    queries
      .filter((sql) => sql.includes('count_snapshot_source'))
      .every((sql) => sql.includes('octet_length') && sql.includes('LIMIT')),
  );
});

test('oversized snapshot payload and excessive candidate/node batches fail optional-only', async () => {
  const budget = new SnapshotReadBudget(),
    tx = {
      query: async () => ({ rows: [{ data: null, bytes: '4194305' }] }),
    } as unknown as PoolClient;
  await assert.rejects(budget.rows(tx, 'SELECT 1', [], 1), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  const f = fixture();
  await assert.rejects(
    f.facade.evaluatePosts(
      Array.from({ length: 257 }, () => randomUUID()),
      null,
      f.tx,
    ),
    { code: 'COMMUNITY_UNAVAILABLE' },
  );
  await assert.rejects(
    new ContentReviewCountRepository().read(
      {
        posts: [],
        roots: Array.from({ length: 257 }, () => randomUUID()),
        replies: [],
      },
      tx,
    ),
    { code: 'COMMUNITY_UNAVAILABLE' },
  );
});

test('canonical poll, formation and trading definitions share scalar reconstruction and reject corruption', async () => {
  function accept(
    f: ReturnType<typeof fixture>,
    mutate: (envelope: EffectiveContentEnvelope) => void,
  ) {
    const binding = f.snapshot.bindings.get(contentKey('post', f.post.id))!;
    const input = structuredClone(binding.envelope);
    mutate(input);
    const envelope = canonicalEnvelope(input),
      digest = approvalDigest(envelope);
    binding.envelope = envelope;
    binding.digest = digest;
    const approval = f.snapshot.approvals.get(binding.decision_id)!;
    approval.envelope = envelope;
    approval.digest = digest;
  }
  async function check(
    f: ReturnType<typeof fixture>,
    expected: 'allow' | 'unknown',
  ) {
    assert.equal(
      (await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx)).facts.get(
        f.post.id,
      )?.decision,
      expected,
    );
    assert.equal(await f.scalarPost(), expected);
  }
  const poll = fixture(),
    pollId = randomUUID();
  poll.snapshot.polls.set(poll.post.id, {
    id: pollId,
    post_id: poll.post.id,
    question: 'Pick one',
    selection_mode: 'single',
    deadline: null,
  });
  poll.snapshot.options.set(pollId, [
    { poll_id: pollId, label: 'First', position: 0 },
    { poll_id: pollId, label: 'Second', position: 1 },
  ]);
  accept(poll, (envelope) => {
    envelope.component = {
      kind: 'poll',
      question: 'Pick one',
      selectionMode: 'single',
      options: ['First', 'Second'],
    };
  });
  await check(poll, 'allow');
  poll.snapshot.options.get(pollId)![1]!.position = 3;
  await check(poll, 'unknown');

  const formation = fixture(),
    formationId = randomUUID();
  formation.snapshot.formations.set(formation.post.id, {
    id: formationId,
    post_id: formation.post.id,
    capacity: 3,
    theme: 'Study',
    reconciliation: 'current',
  });
  formation.snapshot.creators.set(formationId, [
    {
      formation_id: formationId,
      account_id: formation.post.account_id,
      wechat: 'hello123',
      qq: '',
      phone: '',
      contact_sharing: 'members_v1',
    },
  ]);
  accept(formation, (envelope) => {
    envelope.component = {
      kind: 'formation',
      capacity: 3,
      theme: 'Study',
      contacts: { wechat: 'hello123', qq: '', phone: '' },
      contactSharing: 'members_v1',
    };
  });
  await check(formation, 'allow');
  formation.snapshot.creators.get(formationId)![0]!.account_id = randomUUID();
  await check(formation, 'unknown');

  const trading = fixture();
  trading.post.category = 'trading';
  trading.snapshot.listings.set(trading.post.id, {
    post_id: trading.post.id,
    subtype: 'shuma',
    price: '10.00',
    urgency: 'urgent',
    location: 'Campus',
    wechat: 'hello123',
    qq: '',
    phone: '',
    legacy_raw_price: null,
    legacy_raw_subtype: null,
    resolution: 'resolved',
  });
  accept(trading, (envelope) => {
    envelope.category = 'trading';
    envelope.trading = {
      subtype: 'shuma',
      price: '10',
      urgency: 'urgent',
      location: 'Campus',
      contacts: { wechat: 'hello123', qq: '', phone: '' },
    };
  });
  await check(trading, 'allow');
  const snapshot = await trading.facade.evaluatePosts(
    [trading.post.id],
    trading.viewer,
    trading.tx,
  );
  assert.deepEqual(snapshot.facts.get(trading.post.id)?.listing, {
    subtype: 'shuma',
    resolution: 'resolved',
  });
  trading.snapshot.listings.get(trading.post.id)!.price = '11.00';
  await check(trading, 'unknown');
});

test('exact supported-media and inherited review checks fail closed even when the child is text-only', async () => {
  const f = fixture(),
    assetId = randomUUID(),
    digest = 'b'.repeat(64);
  const binding = f.snapshot.bindings.get(contentKey('post', f.post.id))!;
  const envelope = canonicalEnvelope({
    ...structuredClone(binding.envelope),
    images: [{ assetId, digest }],
  });
  binding.envelope = envelope;
  binding.digest = approvalDigest(envelope);
  const approval = f.snapshot.approvals.get(binding.decision_id)!;
  approval.envelope = envelope;
  approval.digest = binding.digest;
  f.snapshot.images.set(contentKey('post', f.post.id), [
    { assetId, digest, position: 0, kind: 'post', content_id: f.post.id },
  ]);
  const actual = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
  assert.equal(
    actual.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'unknown',
  );
  assert.equal(await f.scalarLiked(), 'unknown');
});

test('JSON snapshot dates preserve historical timezone offset seconds using the scalar pg parser', async () => {
  const tx = {
    query: async () => ({
      rows: [
        { data: { liked_at: '1799-12-31T16:07:02-07:52:58' }, bytes: '80' },
      ],
    }),
  } as unknown as PoolClient;
  const [row] = await new SnapshotReadBudget().rows<{ liked_at: Date }>(
    tx,
    'SELECT liked_at',
    [],
    1,
    ['liked_at'],
  );
  assert.equal(row!.liked_at.toISOString(), '1800-01-01T00:00:00.000Z');
});

test('standard ISO fast parsing is differential with scalar pg timestamp precision', async () => {
  for (const stamp of [
    '2026-10-08T00:00:00.123456Z',
    '2026-10-07T17:00:00.123456-07:00',
    '1969-12-31T23:59:59.999999Z',
    '0099-01-01T00:00:00.123456+00:00',
    '1799-12-31T16:07:02-07:52:58',
  ]) {
    const tx = {
      query: async () => ({ rows: [{ data: { at: stamp }, bytes: '80' }] }),
    } as unknown as PoolClient;
    const [row] = await new SnapshotReadBudget().rows<{ at: Date }>(
      tx,
      'SELECT at',
      [],
      1,
      ['at'],
    );
    const scalar = types.getTypeParser(
      types.builtins.TIMESTAMPTZ,
      'text',
    )(stamp.replace('T', ' ')) as Date;
    assert.equal(row!.at.getTime(), scalar.getTime(), stamp);
  }
});

test('empty indexed owner key sets require no source SQL or payload allocation', async () => {
  const tx = {
    query: async () => {
      throw new Error('Empty key sets cannot issue a source query');
    },
  } as unknown as PoolClient;
  assert.deepEqual(
    await new SnapshotReadBudget().rows(
      tx,
      'SELECT id WHERE id=ANY($1)',
      [[]],
      0,
    ),
    [],
  );
});
