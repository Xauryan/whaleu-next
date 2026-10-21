import { withReviewedTextSource } from '../src/community/text-source/publication.js';
import { sourceOriginalIntentHash } from '../src/community/text-source/protocol.js';
import { readTextSources } from '../src/community/text-source/repository.js';
import type { StoredTextSource } from '../src/community/text-source/repository.js';
import { unpunishedAccountPolicyObservation } from './support/unpunished-account-policy-observation.js';
import {
  untouchedCategoryRows,
  untouchedCategoryChildRows,
} from './support/category-read-facts.js';
import type { CommunityExperienceSourceCapture } from '../src/community/experience-source/capture.js';
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
import {
  checkpointTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { mediaContentKey } from '../src/media/content-snapshot.facade.js';
import type {
  MediaContentSnapshotFacade,
  MediaContentReference,
} from '../src/media/content-snapshot.facade.js';
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
  canonicalEqual,
} from '../src/community/content-review/contracts.js';
import type {
  ContentKind,
  EffectiveContentEnvelope,
} from '../src/community/content-review/contracts.js';
import { CurrentRatingLinkDependency } from '../src/community/rating-target-link/dependency.js';
import { ContentReviewCountFacade } from '../src/community/content-review/count-snapshot.facade.js';
import {
  ContentReviewCountRepository,
  SnapshotReadBudget,
  contentKey,
} from '../src/community/content-review/count-snapshot.repository.js';
import type { CountReviewSnapshot } from '../src/community/content-review/count-snapshot.repository.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import { definitionMatchesApproval } from '../src/community/content-review/definition-validation.js';
import type { CurrentContent } from '../src/community/content-review/definition-validation.js';
import { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import type { LikedCandidate } from '../src/community/liked/repository.js';

function fixture(collision = false) {
  const viewer = randomUUID(),
    postId = randomUUID(),
    rootId = collision ? postId : randomUUID(),
    replyId = collision ? postId : randomUUID(),
    spaceId = randomUUID(),
    regionId = randomUUID(),
    categoryEventId = randomUUID();
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
    owner_hidden: false,
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
    categorySnapshot: {
      get categories() {
        return new Map([[postId, post.category]]);
      },
      validUntil: null,
      exactValidUntil: null,
    },
    childContext: {
      exactValidUntil: null,
      allowed: new Map([
        [contentKey('comment', rootId), true],
        [contentKey('reply', replyId), true],
      ]),
      validUntil: null,
    },
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
      images: (snapshot.images.get(contentKey(kind, node.id)) ?? []).map(
        ({ assetId, digest }) => ({ assetId, digest }),
      ),
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
    const row: ApprovalRow & { envelope: EffectiveContentEnvelope } = {
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
      const policy = unpunishedAccountPolicyObservation(sql, args);
      if (policy) return policy;
      const one = (value: unknown) => ({ rows: value ? [value] : [] });
      if (sql.startsWith('SELECT q.kind,q.id,q.post_id'))
        return {
          rows: untouchedCategoryChildRows(
            args[0] as string,
            new Set(snapshot.posts.keys()),
          ),
        };
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: untouchedCategoryRows(args[0] as string[], snapshot.posts).map(
            (row) =>
              snapshot.categorySnapshot.categories.get(row.postId) === null
                ? {
                    ...row,
                    headPostId: row.postId,
                    headCategory: 'scenery',
                    revision: 1,
                    eventId: categoryEventId,
                    headXmin: '100',
                  }
                : row,
          ),
        };
      if (sql.startsWith('WITH category_read_live AS MATERIALIZED'))
        return {
          rows: (args[0] as string[]).map((id) => ({
            postId: id,
            livePostId: null,
            liveCategory: null,
            liveRevision: null,
            liveEventId: null,
            policyId: null,
            reviewId: null,
            validUntil: null,
            batchValidUntil: null,
            batchValidUntilMs: null,
            batchValidUntilMicros: null,
          })),
        };
      if (/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) /.test(sql))
        return { rows: [] };
      if (sql.includes('clock_timestamp')) return one({ now: new Date(now) });
      if (sql.includes('pg_advisory')) return { rows: [] };
      if (sql.includes('whaleu_identity.accounts')) return one({ id: args[0] });
      // Exact new source-domain query. An absent map is a proven empty legacy
      // source relation; do not make the fallback accept other unknown SQL.
      if (
        sql.startsWith(
          'SELECT s.content_kind,s.content_id,s.source_revision,',
        ) &&
        sql.includes('JOIN whaleu_community.community_text_sources s')
      ) {
        const kinds = args[0] as ContentKind[],
          ids = args[1] as string[];
        return {
          rows: kinds.flatMap((kind, index) => {
            const row = snapshot.textSources?.get(
              contentKey(kind, ids[index]!),
            );
            return row ? [row] : [];
          }),
        };
      }
      if (sql.includes('content_approval_bindings'))
        return one(
          snapshot.bindings.get(
            contentKey(args[0] as ContentKind, args[1] as string),
          ),
        );
      if (sql.includes('content_approval_decisions'))
        return one(snapshot.approvals.get(args[0] as string));
      if (sql.includes('LEFT JOIN whaleu_community.post_owner_visibility')) {
        const row = snapshot.posts.get(args[0] as string);
        return one(
          row
            ? {
                postId: row.id,
                ownerHidden: row.owner_hidden === true,
                version: row.owner_hidden ? 1 : 0,
                requestId: row.owner_hidden
                  ? '10000000-0000-4000-8000-000000000099'
                  : null,
                xmin: row.owner_hidden ? '100' : null,
              }
            : undefined,
        );
      }
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
  // Scalar canonical reads now carry the mandatory owner overlay final proof.
  // Weak transaction registries remain scoped to this isolated fixture client.
  startTransactionDeadlines(tx);
  const campus = {
    requireActiveRegion: async () => {
      if (!regionActive)
        throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
      return { id: regionId, isActive: true };
    },
  } as unknown as CampusService;
  const mediaState = {
    decision: 'unknown' as 'allow' | 'deny' | 'unknown',
    until: null as number | null,
    inputs: [] as (readonly MediaContentReference[])[],
    failure: null as Error | null,
  };
  const base = new LocalApprovedContentVisibility(
    new ApprovalRepository(),
    new ContentDefinitionRepository(campus),
    {
      current: async (kind, _id, images) => {
        if (
          kind !== 'post' ||
          images.length !== 1 ||
          mediaState.decision === 'unknown'
        )
          return { kind: 'unavailable' };
        return mediaState.decision === 'allow'
          ? { kind: 'allow', value: undefined }
          : { kind: 'deny', reason: 'POST_NOT_FOUND' };
      },
    },
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
    new CommunityRepository(
      {} as RuntimeConfig,
      {} as DatabaseService,
      campus,
      {} as CommunityExperienceSourceCapture,
    ),
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
  const media: MediaContentSnapshotFacade = {
    readBatch: async (references, _tx, budget) => {
      assert.equal(budget, snapshot.budget);
      mediaState.inputs.push(references);
      if (mediaState.failure) throw mediaState.failure;
      return new Map(
        references.map(({ parent, expected }) => [
          mediaContentKey(parent),
          {
            version: 1 as const,
            parent,
            decision:
              parent.resourceKind === 'post' && expected.length === 1
                ? mediaState.decision
                : 'unknown',
            validUntil: mediaState.until,
            attachments: [],
          },
        ]),
      );
    },
  };
  const targetLinks = new CurrentRatingLinkDependency();
  const currentLinks = targetLinks.currentBatch.bind(targetLinks);
  let linkDependencyCalls = 0;
  targetLinks.currentBatch = (...args) => {
    linkDependencyCalls++;
    return currentLinks(...args);
  };
  const facade = new ContentReviewCountFacade(
    records,
    countCampus,
    safety,
    media,
    targetLinks,
  );
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
    linkDependencyCalls: () => linkDependencyCalls,
    viewer,
    post,
    root,
    reply,
    snapshot,
    membership,
    blocked,
    unknownSafety,
    safetyInputs,
    mediaState,
    bind,
    facade,
    tx,
    scalarPost,
    scalarLiked,
    access,
    base,
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
      f.post.owner_hidden = true;
    },
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

test('owner-hidden canonical parents deny public post and liked-descendant counts even for their author', async () => {
  for (const authorMode of ['named', 'anonymous'] as const) {
    const f = fixture();
    f.post.author_mode = authorMode;
    f.post.owner_hidden = true;
    f.bind('post');
    for (const viewer of [f.viewer, f.post.account_id]) {
      const posts = await f.facade.evaluatePosts([f.post.id], viewer, f.tx);
      assert.equal(posts.facts.get(f.post.id)?.decision, 'deny');
      const liked = await f.facade.evaluateLiked([f.membership], viewer, f.tx);
      assert.equal(
        liked.facts.get(`reply:${f.membership.like_id}`)?.decision,
        'deny',
      );
    }
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
  let sourceValues: unknown[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes('JOIN whaleu_community.community_text_sources s'))
        sourceValues = values;
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: untouchedCategoryRows(values[0] as string[], new Map()),
        };
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
  assert.equal(queries.length, 11);
  assert.equal(
    queries.filter((sql) => sql.startsWith('SELECT requested.post_id')).length,
    1,
  );
  assert.ok(queries.every((sql) => !/FOR (SHARE|UPDATE)/.test(sql)));
  assert.equal(
    queries.filter((sql) => sql.includes('count_snapshot_source')).length,
    9,
  );
  assert.ok(
    queries
      .filter((sql) => sql.includes('count_snapshot_source'))
      .every((sql) => sql.includes('octet_length') && sql.includes('LIMIT')),
  );
  const sourceQueries = queries.filter((sql) =>
    sql.includes('JOIN whaleu_community.community_text_sources s'),
  );
  assert.equal(
    sourceQueries.length,
    1,
    'one bounded source query, never per-node N+1',
  );
  assert.match(sourceQueries[0]!, /FROM unnest\(\$1::text\[\],\$2::uuid\[\]\)/);
  assert.match(sourceQueries[0]!, /LIMIT 769/);
  assert.equal((sourceValues[0] as string[]).length, 768);
  assert.equal((sourceValues[1] as string[]).length, 768);
  assert.deepEqual(
    [...new Set(sourceValues[0] as string[])],
    ['post', 'comment', 'reply'],
  );
  const bindingQuery = queries.find((sql) =>
    sql.includes('JOIN whaleu_community.content_approval_bindings b'),
  )!;
  assert.deepEqual(
    bindingQuery
      .match(/SELECT (b\.content_kind[\s\S]*?)\s+FROM unnest/)![1]!
      .replace(/\s+/g, '')
      .split(','),
    [
      'b.content_kind',
      'b.content_id',
      'b.content_version',
      'b.decision_id',
      'b.account_id',
      'b.operation',
      'b.envelope_version',
      'b.digest',
      'b.envelope',
      'b.scope',
    ],
  );
  assert.doesNotMatch(bindingQuery, /b\.\*|bound_at|related_actor_/);
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

function attachImage(
  f: ReturnType<typeof fixture>,
  kind: ContentKind = 'post',
) {
  const id =
    kind === 'post' ? f.post.id : kind === 'comment' ? f.root.id : f.reply.id;
  f.snapshot.images.set(contentKey(kind, id), [
    {
      assetId: randomUUID(),
      digest: 'd'.repeat(64),
      position: 0,
      kind,
      content_id: id,
    },
  ]);
  f.bind(kind);
}

test('single-image post and its text-only liked reply match current scalar Media decisions with one batch', async () => {
  for (const decision of ['allow', 'deny', 'unknown'] as const) {
    const f = fixture();
    attachImage(f);
    f.mediaState.decision = decision;
    f.mediaState.until = f.snapshot.now + 1000;
    const before = checkpointTransactionDeadlines(f.tx);
    const posts = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
    assert.equal(posts.facts.get(f.post.id)?.decision, await f.scalarPost());
    assert.equal(posts.mediaRequired, true);
    const liked = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
    assert.equal(
      liked.facts.get(`reply:${f.membership.like_id}`)?.decision,
      await f.scalarLiked(),
    );
    assert.equal(liked.mediaRequired, true);
    assert.equal(liked.optionalUntil, f.mediaState.until);
    assert.deepEqual(checkpointTransactionDeadlines(f.tx), before);
    assert.equal(f.mediaState.inputs.length, 2);
    assert.ok(
      f.mediaState.inputs.every(
        (refs) => refs.length === 1 && refs[0]!.parent.resourceKind === 'post',
      ),
    );
  }
});

test('earlier review denial avoids Media dependencies; Media denial precedes later unknown ancestry and Safety', async () => {
  const prior = fixture();
  attachImage(prior);
  prior.bind('post').state = 'held';
  const denied = await prior.facade.evaluateLiked(
    [prior.membership],
    prior.viewer,
    prior.tx,
  );
  assert.equal(
    denied.facts.get(`reply:${prior.membership.like_id}`)?.decision,
    'deny',
  );
  assert.equal(denied.mediaRequired, false);
  assert.deepEqual(prior.mediaState.inputs, []);

  const media = fixture();
  attachImage(media);
  media.mediaState.decision = 'deny';
  media.mediaState.until = media.snapshot.now + 1000;
  media.snapshot.bindings.delete(contentKey('reply', media.reply.id));
  media.unknownSafety.add(media.post.account_id);
  const result = await media.facade.evaluateLiked(
    [media.membership],
    media.viewer,
    media.tx,
  );
  assert.equal(
    result.facts.get(`reply:${media.membership.like_id}`)?.decision,
    'deny',
  );
  assert.equal(result.mediaRequired, true);
  assert.equal(result.optionalUntil, media.mediaState.until);
});

test('Media unknown is not erased by a later Safety denial and unsupported comment attachments stay unknown', async () => {
  const unknown = fixture();
  attachImage(unknown);
  unknown.blocked.add(unknown.post.account_id);
  const result = await unknown.facade.evaluatePosts(
    [unknown.post.id],
    unknown.viewer,
    unknown.tx,
  );
  assert.equal(result.facts.get(unknown.post.id)?.decision, 'unknown');
  assert.equal(result.mediaRequired, true);

  const comment = fixture();
  attachImage(comment, 'comment');
  comment.mediaState.decision = 'allow';
  const liked = await comment.facade.evaluateLiked(
    [comment.membership],
    comment.viewer,
    comment.tx,
  );
  assert.equal(
    liked.facts.get(`reply:${comment.membership.like_id}`)?.decision,
    'unknown',
  );
});

test('text and single-image post counts while unchanged exact approval remains mandatory after Media allow', async () => {
  const f = fixture();
  attachImage(f);
  f.mediaState.decision = 'allow';
  const allowed = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
  assert.equal(allowed.facts.get(f.post.id)?.decision, 'allow');
  f.post.text = 'Changed after approval';
  const stale = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
  assert.equal(stale.facts.get(f.post.id)?.decision, 'unknown');
});

test('image-only post remains rejected by the existing canonical publication contract', () => {
  const f = fixture();
  attachImage(f);
  const binding = f.snapshot.bindings.get(contentKey('post', f.post.id))!;
  for (const text of ['', '   '])
    assert.throws(
      () => canonicalEnvelope({ ...structuredClone(binding.envelope), text }),
      /Empty post/,
    );
});

test('failed Media prefetch is consumed only after current liked membership, with managed savepoint recovery', async () => {
  const f = fixture();
  attachImage(f);
  f.mediaState.failure = Object.assign(new Error('Media table unavailable'), {
    code: '42P01',
  });
  f.setCurrent(null);
  const removed = await f.facade.evaluateLiked(
    [f.membership],
    f.viewer,
    f.tx,
    f.tx,
  );
  assert.equal(
    removed.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'deny',
  );
  assert.equal(removed.mediaRequired, false);
  f.setCurrent({
    like_id: f.membership.like_id,
    liked_at: f.membership.liked_at,
  });
  const current = await f.facade.evaluateLiked(
    [f.membership],
    f.viewer,
    f.tx,
    f.tx,
  );
  assert.equal(
    current.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'unknown',
  );
  assert.equal(current.mediaRequired, true);
});

test('exact count snapshot reports current category while canonical approval stays original', async () => {
  const f = fixture();
  const original = f.post.category;
  f.snapshot.categorySnapshot = {
    categories: new Map([[f.post.id, 'scenery']]),
    validUntil: f.snapshot.now + 1000,
    exactValidUntil: null,
  };
  const result = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
  assert.equal(result.facts.get(f.post.id)?.decision, 'allow');
  assert.equal(result.facts.get(f.post.id)?.post?.category, 'scenery');
  assert.equal(result.optionalUntil, f.snapshot.now + 1000);
  assert.equal(f.post.category, original);
});

test('invalid classification and child context never inherit original count approval', async () => {
  const f = fixture();
  f.snapshot.categorySnapshot = {
    categories: new Map([[f.post.id, null]]),
    validUntil: null,
    exactValidUntil: null,
  };
  const post = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
  assert.equal(post.facts.get(f.post.id)?.decision, 'deny');
  assert.equal(post.facts.get(f.post.id)?.post, null);
  f.snapshot.categorySnapshot = {
    categories: new Map([[f.post.id, f.post.category]]),
    validUntil: null,
    exactValidUntil: null,
  };
  f.snapshot.childContext = {
    allowed: new Map(),
    validUntil: null,
    exactValidUntil: null,
  };
  const child = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
  assert.equal(
    child.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'deny',
  );
});

test('moved classification denial cannot mask unknown original post or child ancestry Review', async () => {
  for (const defect of ['missing', 'unknown', 'definition'] as const) {
    const f = fixture();
    f.snapshot.categorySnapshot = {
      categories: new Map([[f.post.id, null]]),
      validUntil: null,
      exactValidUntil: null,
    };
    const binding = f.snapshot.bindings.get(contentKey('post', f.post.id))!;
    if (defect === 'missing') f.snapshot.approvals.delete(binding.decision_id);
    else if (defect === 'unknown')
      f.snapshot.approvals.get(binding.decision_id)!.event_coverage = 'unknown';
    else f.post.text = 'Changed outside the original approval';
    assert.equal(await f.scalarPost(), 'unknown', defect);
    for (const [kind, content] of [
      ['comment', f.root],
      ['reply', f.reply],
    ] as const) {
      const subject = {
        contentKind: kind,
        contentId: content.id,
        contentVersion: 1 as const,
        authorMode: 'named' as const,
        namedAccountId: content.account_id,
      };
      assert.equal(
        (await f.base.check(f.viewer, subject, f.tx, 'list_projection')).kind,
        'unavailable',
        `${defect}:${kind}`,
      );
      await assert.rejects(
        f.access.visibilityDecision(f.viewer, content, f.tx, 'list_projection'),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'COMMUNITY_UNAVAILABLE',
      );
    }
    const post = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
    assert.equal(post.facts.get(f.post.id)?.decision, 'unknown', defect);
    const liked = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
    assert.equal(
      liked.facts.get(`reply:${f.membership.like_id}`)?.decision,
      'unknown',
      defect,
    );
  }
});

test('known revoked category policy denies only after complete original approval', async () => {
  const f = fixture();
  f.snapshot.categorySnapshot = {
    categories: new Map([[f.post.id, null]]),
    validUntil: null,
    exactValidUntil: null,
  };
  assert.equal(await f.scalarPost(), 'deny');
  assert.equal(await f.scalarLiked(), 'deny');
  const posts = await f.facade.evaluatePosts([f.post.id], f.viewer, f.tx);
  assert.equal(posts.facts.get(f.post.id)?.decision, 'deny');
  const liked = await f.facade.evaluateLiked([f.membership], f.viewer, f.tx);
  assert.equal(
    liked.facts.get(`reply:${f.membership.like_id}`)?.decision,
    'deny',
  );
});

test('exact definition equality reuses accepted digest without relaxing any canonical field or Media proof', () => {
  const f = fixture();
  const binding = f.snapshot.bindings.get(contentKey('post', f.post.id))!;
  const stored: CurrentContent = {
    envelope: canonicalEnvelope(binding.envelope),
    authorAccountId: f.post.account_id,
    authorMode: f.post.author_mode,
    parents: [],
  };
  const accepted = {
    envelope: stored.envelope,
    digest: approvalDigest(stored.envelope),
  };
  const original = (value: typeof accepted, media = false) =>
    approvalDigest(stored.envelope) === value.digest &&
    canonicalEqual(stored.envelope, value.envelope) &&
    (!stored.envelope.images.length || media);
  const reordered = Object.fromEntries(
    Object.entries(structuredClone(accepted.envelope)).reverse(),
  ) as unknown as EffectiveContentEnvelope;
  assert.equal(
    definitionMatchesApproval(stored, { ...accepted, envelope: reordered }),
    true,
  );
  for (const mutate of [
    (value: Record<string, unknown>) => {
      value['version'] = 4;
    },
    (value: Record<string, unknown>) => {
      value['text'] = 'Different canonical text';
    },
    (value: Record<string, unknown>) => {
      value['postId'] = randomUUID();
    },
    (value: Record<string, unknown>) => {
      value['rootCommentId'] = randomUUID();
    },
    (value: Record<string, unknown>) => {
      value['targetReplyId'] = randomUUID();
    },
    (value: Record<string, unknown>) => {
      value['images'] = [{ assetId: randomUUID(), digest: 'a'.repeat(64) }];
    },
    (value: Record<string, unknown>) => {
      value['allowAnonymousDm'] = false;
    },
    (value: Record<string, unknown>) => {
      value['scope'] = {
        ...(value['scope'] as object),
        identityRegionId: randomUUID(),
      };
    },
    (value: Record<string, unknown>) => {
      value['extra'] = null;
    },
  ]) {
    const envelope = structuredClone(accepted.envelope);
    mutate(envelope as unknown as Record<string, unknown>);
    const changed = { ...accepted, envelope };
    assert.equal(definitionMatchesApproval(stored, changed), original(changed));
    assert.equal(definitionMatchesApproval(stored, changed), false);
  }
  assert.equal(
    definitionMatchesApproval(stored, { ...accepted, digest: '0'.repeat(64) }),
    false,
  );
  const imageEnvelope = canonicalEnvelope({
    ...structuredClone(stored.envelope),
    images: [{ assetId: randomUUID(), digest: 'b'.repeat(64) }],
  });
  const imageStored = { ...stored, envelope: imageEnvelope };
  const imageAccepted = {
    envelope: imageEnvelope,
    digest: approvalDigest(imageEnvelope),
  };
  assert.equal(definitionMatchesApproval(imageStored, imageAccepted), false);
  assert.equal(
    definitionMatchesApproval(imageStored, imageAccepted, true),
    true,
  );
});

test('discussion child snapshots match scalar list/detail ancestry and never borrow target identity', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    () => {},
    (f) => {
      f.root.visibility = 'hidden';
    },
    (f) => {
      f.root.deleted_at = new Date();
    },
    (f) => {
      f.post.visibility = 'hidden';
    },
    (f) => {
      f.blocked.add(f.root.account_id);
    },
    (f) => {
      f.blocked.add(f.reply.account_id);
    },
    (f) => {
      f.unknownSafety.add(f.reply.account_id);
    },
    (f) => {
      f.snapshot.bindings.delete(contentKey('comment', f.root.id));
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const candidate = {
      kind: 'reply' as const,
      id: f.reply.id,
      postId: f.post.id,
      rootId: f.root.id,
    };
    let expected = 'allow';
    try {
      for (const content of [f.post, f.root, f.reply]) {
        if (
          !(await f.access.visible(f.viewer, content, f.tx, 'list_projection'))
        ) {
          expected = 'deny';
          break;
        }
      }
    } catch {
      expected = 'unknown';
    }
    const batch = await f.facade.evaluateDiscussion(
      [candidate],
      f.viewer,
      'list_projection',
      f.tx,
    );
    assert.equal(
      batch.facts.get(contentKey('reply', f.reply.id))?.decision,
      expected,
    );
  }
});
test('discussion private hidden detail permits only owner while public/liked defaults stay denied', async () => {
  const f = fixture();
  f.post.owner_hidden = true;
  const candidate = {
    kind: 'reply' as const,
    id: f.reply.id,
    postId: f.post.id,
    rootId: f.root.id,
  };
  assert.equal(
    (
      await f.facade.evaluateDiscussion(
        [candidate],
        f.post.account_id,
        'detail_projection',
        f.tx,
      )
    ).facts.get(contentKey('reply', f.reply.id))?.decision,
    'allow',
  );
  for (const [viewer, purpose] of [
    [f.post.account_id, 'list_projection'],
    [f.viewer, 'detail_projection'],
  ] as const)
    assert.equal(
      (
        await f.facade.evaluateDiscussion([candidate], viewer, purpose, f.tx)
      ).facts.get(contentKey('reply', f.reply.id))?.decision,
      'deny',
    );
  assert.equal(
    (
      await f.facade.evaluatePosts([f.post.id], f.post.account_id, f.tx)
    ).facts.get(f.post.id)?.decision,
    'deny',
  );
});

test('discussion count requires exact current root classification before reply', async () => {
  const f = fixture();
  (f.snapshot.childContext.allowed as Map<string, boolean>).set(
    contentKey('comment', f.root.id),
    false,
  );
  const result = await f.facade.evaluateDiscussion(
    [{ kind: 'reply', id: f.reply.id, postId: f.post.id, rootId: f.root.id }],
    f.viewer,
    'list_projection',
    f.tx,
  );
  assert.equal(
    result.facts.get(contentKey('reply', f.reply.id))?.decision,
    'deny',
  );
});

test('v5 discussion optional counts do not enter a dependency that lacks the shared monotonic budget', async () => {
  const f = fixture();
  // An opaque nonempty dependency marker is sufficient: its binding must never
  // be inspected by the optional discussion path, let alone sent to its owner.
  f.snapshot.ratingTargetLinks = new Map([
    [
      f.post.id,
      {
        get binding() {
          throw new Error('Unbounded dependency entered');
        },
      },
    ],
  ]) as unknown as NonNullable<CountReviewSnapshot['ratingTargetLinks']>;
  const result = await f.facade.evaluateDiscussion(
    [{ kind: 'reply', id: f.reply.id, postId: f.post.id, rootId: f.root.id }],
    f.viewer,
    'list_projection',
    f.tx,
  );
  assert.equal(
    result.facts.get(contentKey('reply', f.reply.id))?.decision,
    'unknown',
  );
  assert.equal(f.linkDependencyCalls(), 0);
  assert.deepEqual(f.mediaState.inputs, []);
  assert.deepEqual(f.safetyInputs, []);
  assert.equal(result.optionalUntil, null);
});

function bindExplicitSource(f: ReturnType<typeof fixture>, kind: ContentKind) {
  const node = kind === 'post' ? f.post : kind === 'comment' ? f.root : f.reply;
  // Actual migrated owner rows always carry their explicit version marker.
  f.post.publication_envelope_version ??= 1;
  const prior = f.bind(kind);
  const envelope = canonicalEnvelope({
    ...withReviewedTextSource(prior.envelope, {
      version: 1,
      format: 'plain',
      readingFormatting: 'auto',
    }),
    images: [],
  });
  assert.equal(envelope.version, 6);
  if (envelope.version !== 6) throw new Error('source fixture');
  const digest = approvalDigest(envelope);
  Object.assign(prior, {
    envelope,
    envelope_version: 6,
    digest,
    policy_key: 'local-text-source-v1',
  });
  Object.assign(f.snapshot.bindings.get(contentKey(kind, node.id))!, {
    envelope,
    envelope_version: 6,
    digest,
  });
  const row: StoredTextSource = {
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
    original_intent_hash: sourceOriginalIntentHash(envelope, node.author_mode),
    decision_id: prior.id,
    approval_digest: digest,
  };
  f.snapshot.textSources ??= new Map();
  f.snapshot.textSources.set(contentKey(kind, node.id), row);
  if (kind === 'post') f.post.publication_envelope_version = 6;
  return row;
}
test('v6 source snapshot and scalar agree across independently classified post/root/reply and fail closed on metadata loss or transplants', async () => {
  for (const kinds of [
    ['post'],
    ['comment'],
    ['reply'],
    ['post', 'comment', 'reply'],
  ] as ContentKind[][]) {
    for (const defect of [
      'none',
      'missing',
      'hash',
      'intent',
      'decision',
      'target',
      'account',
      'format',
      'policy',
    ]) {
      const f = fixture();
      for (const kind of kinds) bindExplicitSource(f, kind);
      const kind = kinds.at(-1)!;
      const node =
        kind === 'post' ? f.post : kind === 'comment' ? f.root : f.reply;
      const key = contentKey(kind, node.id),
        row = f.snapshot.textSources!.get(key)!;
      if (defect === 'missing') f.snapshot.textSources!.delete(key);
      if (defect === 'hash') row.source_hash = '0'.repeat(64);
      if (defect === 'intent') row.original_intent_hash = '0'.repeat(64);
      if (defect === 'decision') row.decision_id = randomUUID();
      if (defect === 'target') row.content_id = randomUUID();
      if (defect === 'account') row.account_id = randomUUID();
      if (defect === 'format')
        Object.assign(row, {
          source_format: 'markdown',
          reading_formatting: null,
        });
      if (defect === 'policy') row.reading_formatting = 'off';
      const actual = (
        await f.facade.evaluateLiked([f.membership], f.viewer, f.tx)
      ).facts.get(`reply:${f.membership.like_id}`)?.decision;
      assert.equal(
        actual,
        await f.scalarLiked(),
        `${kinds.join(',')}/${defect}`,
      );
      assert.equal(
        actual,
        defect === 'none' ? 'allow' : 'unknown',
        `${kinds.join(',')}/${defect}`,
      );
    }
  }
});
test('source query failure and duplicate source facts never become empty-domain permission', async () => {
  const f = fixture();
  bindExplicitSource(f, 'post');
  const original = f.tx.query.bind(f.tx);
  f.tx.query = ((sql: string, ...args: unknown[]) => {
    if (sql.includes('JOIN whaleu_community.community_text_sources s'))
      return Promise.reject(new Error('source query unavailable'));
    return original(sql, ...(args as []));
  }) as typeof f.tx.query;
  assert.equal(await f.scalarPost(), 'unknown');
  const row = f.snapshot.textSources!.get(contentKey('post', f.post.id))!;
  const duplicate = {
    query: async () => ({ rows: [row, row] }),
  } as unknown as PoolClient;
  await assert.rejects(readTextSources(['post'], [f.post.id], duplicate));
});
