import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { CampusContentScopeFacade } from '../src/campus/content-scope.facade.js';
import type { SafetyContentVisibilityFacade } from '../src/safety/content-visibility.facade.js';
import type {
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
  operationForKind,
} from '../src/community/content-review/contracts.js';
import type { ContentKind } from '../src/community/content-review/contracts.js';
import {
  validateApprovalBinding,
  validateApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import type {
  ApprovalBinding,
  ApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import { ContentReviewCountFacade } from '../src/community/content-review/count-snapshot.facade.js';
import {
  ContentReviewCountRepository,
  COUNT_SNAPSHOT_BATCH,
  COUNT_SNAPSHOT_BYTES,
  contentKey,
} from '../src/community/content-review/count-snapshot.repository.js';
import {
  definitionMatchesApproval,
  reconstructDefinition,
} from '../src/community/content-review/definition-validation.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import { readHomeDefinitionEvidence } from '../src/community/home-feed-policy/definition-evidence.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import type { HomeReviewEvidence } from '../src/community/home-feed-policy/review-evidence.js';
import {
  composedSourceOriginalIntentHash,
  reviewedTextSource,
} from '../src/community/text-source/protocol.js';
import type { StoredTextSource } from '../src/community/text-source/repository.js';
import {
  untouchedCategoryChildRows,
  untouchedCategoryRows,
} from './support/category-read-facts.js';

function fixture(explicit: readonly ContentKind[] = [], collision = false) {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const postId = randomUUID(),
    spaceId = randomUUID(),
    regionId = randomUUID();
  const rootId = collision ? postId : randomUUID();
  const replyId = collision ? postId : randomUUID();
  const descriptor = {
    version: 1,
    format: 'plain',
    readingFormatting: 'auto',
  } as const;
  const post: DefinitionPost = {
    id: postId,
    space_id: spaceId,
    account_id: randomUUID(),
    category: 'water',
    text: '三个字',
    author_mode: 'named',
    comments_policy: 'open',
    publication_envelope_version: 7,
    allow_anonymous_dm: null,
    owner_hidden: false,
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
    ...root,
    id: replyId,
    account_id: randomUUID(),
    text: 'Reviewed reply',
    root_comment_id: rootId,
    target_reply_id: randomUUID(),
    sequence: '1',
  };
  const requestedIntent = {
    spaceId,
    category: 'discussion' as const,
    text: post.text,
    imageAssetIds: [],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
    ...(explicit.includes('post') ? { textSource: descriptor } : {}),
  };
  const home: HomeReviewEvidence = {
    version: 1,
    admission: {
      id: randomUUID(),
      revision: 1,
      digest: 'a'.repeat(64),
      sourceCommit: LEGACY_HOME_POLICY_COMMIT,
      validUntil: '2030-01-01T00:00:00Z',
    },
    requestedIntent,
    requestedIntentHash: homeOriginalIntentHash(requestedIntent),
    requestedRegionId: regionId,
    legacyChoose: 2,
    targetWaterSpaceId: spaceId,
    targetWaterRegionId: regionId,
    auditExempt: false,
    result: 'short_text',
  };
  const posts = new Map([[postId, post]]);
  const roots = new Map([[rootId, root]]);
  const replies = new Map([[replyId, reply]]);
  const dispositions = new Map<string, HomeReviewEvidence>([[postId, home]]);
  const parents = new Map<
    string,
    { postId: string; decisionId: string; digest: string }
  >();
  const sources = new Map<string, StoredTextSource>();
  const bindings = new Map<string, ApprovalBinding>();
  const approvals = new Map<string, ApprovalRow>();
  for (const [kind, node] of [
    ['post', post],
    ['comment', root],
    ['reply', reply],
  ] as const) {
    const postBinding = bindings.get(contentKey('post', postId));
    const parent = postBinding
      ? {
          postId,
          decisionId: postBinding.decision_id,
          digest: postBinding.digest,
        }
      : undefined;
    const envelope = canonicalEnvelope({
      version: kind === 'post' ? 7 : 8,
      accountId: node.account_id,
      purpose: operationForKind(kind),
      spaceId,
      category: post.category,
      authorMode: node.author_mode,
      commentsPolicy: post.comments_policy,
      postId: kind === 'post' ? null : postId,
      rootCommentId: kind === 'reply' ? rootId : null,
      targetReplyId: kind === 'reply' ? reply.target_reply_id : null,
      text: node.text,
      images: [],
      component: { kind: 'none' },
      trading: null,
      allowAnonymousDm: null,
      textSource: explicit.includes(kind)
        ? reviewedTextSource(node.text, descriptor, kind)
        : null,
      scope: {
        originalSpaceId: spaceId,
        originalRegionId: regionId,
        authorOriginRegionId: regionId,
        identityRegionId: regionId,
        topologySnapshotId: null,
        sync: 'none',
      },
      ...(kind === 'post' ? { home } : { homeParent: parent }),
    });
    const decisionId = randomUUID(),
      digest = approvalDigest(envelope);
    const row: ApprovalRow = {
      id: decisionId,
      account_id: node.account_id,
      operation: envelope.purpose,
      envelope_version: envelope.version,
      envelope,
      digest,
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
      policy_key: explicit.includes(kind)
        ? 'local-text-source-v1'
        : 'local-explicit-v1',
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
    const key = contentKey(kind, node.id);
    bindings.set(key, {
      content_kind: kind,
      content_id: node.id,
      content_version: 1,
      decision_id: decisionId,
      account_id: node.account_id,
      operation: envelope.purpose,
      envelope_version: envelope.version,
      digest,
      envelope,
      scope: envelope.scope,
    });
    approvals.set(decisionId, row);
    if (parent) parents.set(key, parent);
    if (
      (envelope.version === 7 || envelope.version === 8) &&
      envelope.textSource
    ) {
      sources.set(key, {
        content_kind: kind,
        content_id: node.id,
        source_revision: 1,
        source_version: 1,
        source_format: 'plain',
        reading_formatting: 'auto',
        source_hash: envelope.textSource.sourceHash,
        account_id: node.account_id,
        client_request_id: randomUUID(),
        requested_author_mode: node.author_mode,
        original_intent_hash: composedSourceOriginalIntentHash(
          envelope,
          node.author_mode,
        ),
        decision_id: decisionId,
        approval_digest: digest,
      });
    }
  }
  const references = { posts: [postId], roots: [rootId], replies: [replyId] };
  const logs: {
    sql: string;
    args: unknown[];
    cap: number;
    remaining: number;
  }[] = [];
  const controls: {
    alter?: (owner: 'post' | 'child', rows: unknown[]) => unknown[];
    fail?: 'post' | 'child';
  } = {};
  const membership = {
    kind: 'reply' as const,
    target_id: replyId,
    post_id: postId,
    root_comment_id: rootId,
    like_id: randomUUID(),
    liked_at: null,
  };
  function select(sql: string, args: unknown[]): unknown[] {
    const selected = <T>(map: Map<string, T>) =>
      (args[0] as string[]).flatMap((id) =>
        map.has(id) ? [map.get(id)!] : [],
      );
    const byKinds = <T>(map: Map<string, T>) =>
      (args[0] as ContentKind[]).flatMap((kind, i) => {
        const row = map.get(contentKey(kind, (args[1] as string[])[i]!));
        return row ? [row] : [];
      });
    if (sql.includes('home_post_dispositions')) {
      if (controls.fail === 'post') throw new Error('Home owner unavailable');
      const rows = (args[0] as string[]).flatMap((postId) =>
        dispositions.has(postId)
          ? [{ postId, evidence: dispositions.get(postId) }]
          : [],
      );
      return controls.alter?.('post', rows) ?? rows;
    }
    if (sql.includes('home_discussion_parent_bindings')) {
      if (controls.fail === 'child') throw new Error('Home owner unavailable');
      const rows = (args[0] as ContentKind[]).flatMap((kind, i) => {
        const id = (args[1] as string[])[i]!,
          parent = parents.get(contentKey(kind, id));
        return parent && parent.postId === (args[2] as string[])[i]
          ? [{ kind, id, ...parent }]
          : [];
      });
      return controls.alter?.('child', rows) ?? rows;
    }
    if (sql.includes('JOIN whaleu_community.community_text_sources s'))
      return byKinds(sources);
    if (
      sql.includes('post_distribution_bindings') ||
      sql.includes('post_rating_target_links')
    )
      return [];
    if (sql.includes('content_approval_bindings')) return byKinds(bindings);
    if (sql.includes('content_approval_decisions')) return selected(approvals);
    if (sql.includes('FROM whaleu_community.posts WHERE'))
      return selected(posts);
    if (sql.includes('FROM whaleu_community.root_comments WHERE'))
      return selected(roots);
    if (sql.includes('FROM whaleu_community.replies WHERE'))
      return selected(replies);
    if (sql.includes('FROM whaleu_community.spaces WHERE'))
      return [
        {
          id: spaceId,
          is_active: true,
          kind: 'regional',
          operating_region_id: regionId,
        },
      ];
    if (sql.includes('FROM whaleu_community.post_likes'))
      return [{ ...membership, liked_at: null }];
    if (
      /FROM whaleu_community\.(post_images|polls|formations|trading_listings)/.test(
        sql,
      )
    )
      return [];
    throw new Error(`Unexpected bounded query: ${sql}`);
  }
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      const wrapped =
        /^WITH count_snapshot_source AS MATERIALIZED \(([\s\S]*?) LIMIT (\d+)\),/.exec(
          sql,
        );
      if (wrapped) {
        const cap = Number(wrapped[2]) - 1;
        const remaining = Number(
          /WHEN pg_column_size\(s\)>(\d+)/.exec(sql)![1],
        );
        logs.push({ sql, args, cap, remaining });
        const rows = select(wrapped[1]!, args);
        const encoded = rows.map((row) => JSON.stringify(row));
        const bytes = encoded.reduce(
          (sum, value) => sum + Buffer.byteLength(value),
          0,
        );
        return {
          rows: encoded.map((value) => ({
            data:
              rows.length > cap || bytes > remaining ? null : JSON.parse(value),
            bytes: String(bytes),
          })),
        };
      }
      if (sql.startsWith('SELECT requested.post_id'))
        return { rows: untouchedCategoryRows(args[0] as string[], posts) };
      if (sql.startsWith('SELECT q.kind,q.id,q.post_id'))
        return {
          rows: untouchedCategoryChildRows(
            args[0] as string,
            new Set(posts.keys()),
          ),
        };
      if (sql.startsWith('SELECT clock_timestamp()'))
        return { rows: [{ now: new Date(now) }] };
      if (
        sql.startsWith(
          'SELECT evidence FROM whaleu_community.home_post_dispositions',
        )
      ) {
        const evidence = dispositions.get(args[0] as string);
        return { rows: evidence ? [{ evidence }] : [] };
      }
      if (
        sql.includes(
          'FROM whaleu_community.home_discussion_parent_bindings WHERE',
        )
      ) {
        const parent = parents.get(
          contentKey(args[0] as ContentKind, args[1] as string),
        );
        return { rows: parent && parent.postId === args[2] ? [parent] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const repository = new ContentReviewCountRepository();
  const facade = new ContentReviewCountFacade(
    repository,
    {
      readRegionsBatch: async () => new Map([[regionId, true]]),
    } as unknown as CampusContentScopeFacade,
    {
      checkBatch: async (_viewer: string | null, authors: string[]) => ({
        facts: new Map(
          authors.map((id) => [id, { decision: 'allow', optionalUntil: null }]),
        ),
        namedAccountIds: authors,
      }),
    } as unknown as SafetyContentVisibilityFacade,
  );
  const candidates = [
    { kind: 'comment' as const, id: rootId, postId, rootId },
    { kind: 'reply' as const, id: replyId, postId, rootId },
  ];
  async function scalar(kind: ContentKind) {
    const node = kind === 'post' ? post : kind === 'comment' ? root : reply;
    const key = contentKey(kind, node.id),
      binding = bindings.get(key)!;
    const accepted = validateApprovalBinding(
      binding,
      validateApprovalRow(approvals.get(binding.decision_id)!, false, now)
        .decision,
    );
    if (accepted.kind !== 'allow') return accepted.kind;
    const evidence = await readHomeDefinitionEvidence(
      kind,
      node.id,
      postId,
      tx,
    );
    if (!evidence) return 'unknown';
    const source = sources.get(key);
    const stored = reconstructDefinition(
      kind,
      post,
      node,
      kind === 'post' ? null : rootId,
      binding.scope,
      kind === 'post' ? [] : [{ kind: 'post', id: postId }],
      {
        ...evidence,
        ...(source ? { textSource: source } : {}),
        images: [],
        options: [],
        creators: [],
      },
    );
    return stored.kind === 'allow' &&
      definitionMatchesApproval(stored.value, accepted.value)
      ? 'allow'
      : 'unknown';
  }
  return {
    post,
    root,
    reply,
    posts,
    roots,
    replies,
    dispositions,
    parents,
    sources,
    bindings,
    approvals,
    tx,
    repository,
    facade,
    references,
    logs,
    controls,
    candidates,
    membership,
    scalar,
  };
}

test('bounded Home post and discussion counts match scalar evidence for null, independent and composed exact sources', async () => {
  for (const explicit of [
    [],
    ['post'],
    ['comment'],
    ['reply'],
    ['post', 'comment', 'reply'],
  ] as ContentKind[][]) {
    for (const collision of [false, true]) {
      const f = fixture(explicit, collision);
      const post = await f.facade.evaluatePosts([f.post.id], null, f.tx);
      const children = await f.facade.evaluateDiscussion(
        f.candidates,
        null,
        'list_projection',
        f.tx,
      );
      const liked = await f.facade.evaluateLiked(
        [f.membership],
        randomUUID(),
        f.tx,
      );
      assert.equal(post.facts.get(f.post.id)?.decision, await f.scalar('post'));
      assert.equal(post.facts.get(f.post.id)?.decision, 'allow');
      for (const kind of ['comment', 'reply'] as const) {
        const node = kind === 'comment' ? f.root : f.reply;
        assert.equal(
          children.facts.get(contentKey(kind, node.id))?.decision,
          await f.scalar(kind),
        );
        assert.equal(
          children.facts.get(contentKey(kind, node.id))?.decision,
          'allow',
        );
      }
      assert.equal(
        liked.facts.get(`reply:${f.membership.like_id}`)?.decision,
        'allow',
      );
      assert.deepEqual(children.dependencies.contentIds, [
        ...new Set([f.post.id, f.root.id, f.reply.id]),
      ]);
      assert.equal(children.optionalUntil, null);
      assert.equal(children.mediaRequired, false);
    }
  }
});

test('missing or mismatched immutable Home evidence never inherits an accepted envelope', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    for (const defect of ['missing', 'changed'] as const) {
      const f = fixture();
      const node =
        kind === 'post' ? f.post : kind === 'comment' ? f.root : f.reply;
      if (kind === 'post') {
        if (defect === 'missing') f.dispositions.clear();
        else f.dispositions.get(f.post.id)!.admission.digest = 'b'.repeat(64);
      } else {
        const key = contentKey(kind, node.id);
        if (defect === 'missing') f.parents.delete(key);
        else f.parents.get(key)!.decisionId = randomUUID();
      }
      assert.equal(await f.scalar(kind), 'unknown');
      const result = await f.facade.evaluateDiscussion(
        f.candidates,
        null,
        'list_projection',
        f.tx,
      );
      assert.equal(
        result.facts.get(contentKey('reply', f.reply.id))?.decision,
        'unknown',
        `${kind}/${defect}`,
      );
    }
  }
});

test('v7/v8 source metadata retains exact content, author, decision, digest and original intent identity', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    for (const defect of [
      'missing',
      'content',
      'author',
      'decision',
      'digest',
      'intent',
      'hash',
      'format',
    ] as const) {
      const f = fixture(['post', 'comment', 'reply']);
      const node =
        kind === 'post' ? f.post : kind === 'comment' ? f.root : f.reply;
      const key = contentKey(kind, node.id),
        source = f.sources.get(key)!;
      if (defect === 'missing') f.sources.delete(key);
      if (defect === 'content') source.content_id = randomUUID();
      if (defect === 'author') source.account_id = randomUUID();
      if (defect === 'decision') source.decision_id = randomUUID();
      if (defect === 'digest') source.approval_digest = 'b'.repeat(64);
      if (defect === 'intent') source.original_intent_hash = 'b'.repeat(64);
      if (defect === 'hash') source.source_hash = 'b'.repeat(64);
      if (defect === 'format') source.reading_formatting = 'off';
      assert.equal(await f.scalar(kind), 'unknown');
      const result = await f.facade.evaluateDiscussion(
        f.candidates,
        null,
        'list_projection',
        f.tx,
      );
      assert.equal(
        result.facts.get(contentKey('reply', f.reply.id))?.decision,
        'unknown',
        `${kind}/${defect}`,
      );
    }
  }
});

test('Home evidence reads reject malformed, duplicate and foreign identities rather than dropping or overwriting them', async () => {
  for (const owner of ['post', 'child'] as const) {
    for (const defect of [
      'malformed',
      'duplicate',
      'foreign',
      'parent',
    ] as const) {
      const f = fixture();
      f.controls.alter = (current, rows) => {
        if (current !== owner) return rows;
        const row = structuredClone(rows[0]) as Record<string, unknown>;
        if (defect === 'malformed') {
          if (owner === 'post') row['evidence'] = {};
          else row['digest'] = 'broken';
        }
        if (defect === 'foreign')
          row[owner === 'post' ? 'postId' : 'id'] = randomUUID();
        if (defect === 'parent') row['postId'] = randomUUID();
        if (defect === 'duplicate') return [row, row];
        return [row, ...rows.slice(1)];
      };
      await assert.rejects(
        f.repository.read(f.references, f.tx),
        { code: 'COMMUNITY_UNAVAILABLE' },
        `${owner}/${defect}`,
      );
    }
  }
});

test('Home owner failure remains unavailable, never a legacy empty-evidence fallback', async () => {
  for (const owner of ['post', 'child'] as const) {
    const f = fixture();
    f.controls.fail = owner;
    await assert.rejects(
      f.repository.read(f.references, f.tx),
      /Home owner unavailable/,
    );
  }
});

test('versions 1 through 6 add no Home owner queries or Home evidence', async () => {
  for (const version of [1, 2, 3, 4, 5, 6] as const) {
    // v4/v5 already have their independent bounded dependency owners. Keep this
    // check at the Home selector rather than manufacturing their other facts.
    const f = fixture();
    f.post.publication_envelope_version = version;
    const result = await f.repository.read(f.references, f.tx);
    assert.equal(result.homeDefinitions, undefined);
    assert.equal(
      f.logs.filter((row) =>
        /home_(post_dispositions|discussion_parent_bindings)/.test(row.sql),
      ).length,
      0,
    );
  }
});

test('Home evidence stays in two bounded bulk reads at the maximum batch and consumes the shared byte budget', async () => {
  const f = fixture();
  for (let i = 1; i < COUNT_SNAPSHOT_BATCH; i++) {
    const postId = randomUUID(),
      rootId = randomUUID(),
      replyId = randomUUID();
    f.posts.set(postId, { ...f.post, id: postId });
    f.roots.set(rootId, { ...f.root, id: rootId, post_id: postId });
    f.replies.set(replyId, {
      ...f.reply,
      id: replyId,
      post_id: postId,
      root_comment_id: rootId,
    });
    f.dispositions.set(postId, structuredClone(f.dispositions.get(f.post.id)!));
    for (const [kind, id] of [
      ['comment', rootId],
      ['reply', replyId],
    ] as const)
      f.parents.set(contentKey(kind, id), {
        ...f.parents.get(contentKey('comment', f.root.id))!,
        postId,
      });
  }
  const result = await f.repository.read(
    {
      posts: [...f.posts.keys()],
      roots: [...f.roots.keys()],
      replies: [...f.replies.keys()],
    },
    f.tx,
  );
  const homeReads = f.logs.filter((row) =>
    /home_(post_dispositions|discussion_parent_bindings)/.test(row.sql),
  );
  assert.equal(homeReads.length, 2);
  assert.equal(homeReads[0]!.cap, COUNT_SNAPSHOT_BATCH);
  assert.equal(homeReads[1]!.cap, 2 * COUNT_SNAPSHOT_BATCH);
  assert.ok(homeReads[0]!.remaining < COUNT_SNAPSHOT_BYTES);
  assert.ok(homeReads[1]!.remaining < homeReads[0]!.remaining);
  assert.ok(result.budget.remainingBytes() < homeReads[1]!.remaining);
  assert.equal(result.homeDefinitions?.size, 3 * COUNT_SNAPSHOT_BATCH);
  assert.equal(result.dependencies.contentIds.length, 3 * COUNT_SNAPSHOT_BATCH);
  assert.ok(
    homeReads.every(
      (row) =>
        !/FOR SHARE|FOR UPDATE|home_policy|home_distribution/.test(row.sql),
    ),
  );
});

test('Home payload overflow and oversized key sets fail before returning partial facts', async () => {
  const f = fixture();
  f.controls.alter = (owner, rows) =>
    owner === 'post'
      ? [{ postId: f.post.id, evidence: 'x'.repeat(COUNT_SNAPSHOT_BYTES) }]
      : rows;
  await assert.rejects(f.repository.read(f.references, f.tx), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  const oversized = fixture();
  await assert.rejects(
    oversized.repository.read(
      {
        posts: Array.from({ length: COUNT_SNAPSHOT_BATCH + 1 }, () =>
          randomUUID(),
        ),
        roots: [],
        replies: [],
      },
      oversized.tx,
    ),
    { code: 'COMMUNITY_UNAVAILABLE' },
  );
  assert.equal(oversized.logs.length, 0);
});
