/** Actual formatter source owner, canonical reconstruction and retained leaves.
 * Deterministic repository/SQL fixtures, not PostgreSQL publication evidence. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ReadingSourceOwner } from '../src/community/reading-formatting/source-owner.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
  ContentKind,
} from '../src/community/content-review/contracts.js';
import { reconstructDefinition } from '../src/community/content-review/definition-validation.js';
import type {
  DefinitionPayload,
  DefinitionPost,
} from '../src/community/content-review/definition-validation.js';
import type {
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import type {
  ApprovalBinding,
  ApprovalRepository,
} from '../src/community/content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import {
  reviewedTextSource,
  composedSourceOriginalIntentHash,
} from '../src/community/text-source/protocol.js';
import type { TextSourceDescriptor } from '../src/community/text-source/contracts.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityService } from '../src/identity/identity.service.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const longText = ('鲸'.repeat(119) + '。').repeat(3);
const plain = {
  version: 1,
  format: 'plain',
  readingFormatting: 'auto',
} as const;
function fixture(
  kind: ContentKind,
  options: {
    parentSource?: boolean;
    targetSource?: boolean;
    descriptor?: TextSourceDescriptor;
  } = {},
) {
  const parentSource = options.parentSource ?? true,
    targetSource = options.targetSource ?? true;
  const postText = kind === 'post' || parentSource ? longText : '短文';
  const descriptor = options.descriptor ?? plain;
  const requestedIntent = {
    spaceId: id(4),
    category: 'discussion' as const,
    text: postText,
    imageAssetIds: [],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
    ...((kind === 'post' ? targetSource : parentSource)
      ? { textSource: kind === 'post' ? descriptor : plain }
      : {}),
  };
  const scope = {
    originalSpaceId: id(4),
    originalRegionId: id(5),
    authorOriginRegionId: id(5),
    identityRegionId: id(5),
    topologySnapshotId: null,
    sync: 'none' as const,
  };
  const parent = canonicalEnvelope({
    version: 7,
    accountId: id(3),
    purpose: 'publish_post',
    spaceId: id(4),
    category: postText === longText ? 'discussion' : 'water',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: postText,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope,
    allowAnonymousDm: null,
    textSource: requestedIntent.textSource
      ? reviewedTextSource(postText, requestedIntent.textSource, 'post')
      : null,
    home: {
      version: 1,
      admission: {
        id: id(50),
        revision: 1,
        digest: 'a'.repeat(64),
        sourceCommit: LEGACY_HOME_POLICY_COMMIT,
        validUntil: '2030-01-01T00:00:00Z',
      },
      requestedIntent,
      requestedIntentHash: homeOriginalIntentHash(requestedIntent),
      requestedRegionId: id(5),
      legacyChoose: 2,
      targetWaterSpaceId: id(4),
      targetWaterRegionId: id(5),
      auditExempt: false,
      result: postText === longText ? null : 'short_text',
    },
  });
  if (parent.version !== 7) throw new Error();
  const post = {
    id: id(1),
    account_id: id(3),
    space_id: id(4),
    category: parent.category,
    author_mode: 'named',
    comments_policy: 'open',
    allow_anonymous_dm: null,
    text: postText,
    publication_envelope_version: 7,
    publication_state: 'published',
    visibility: 'approved',
    deleted_at: null,
    feedback: null,
  } as unknown as DefinitionPost;
  const entries = new Map<
    string,
    {
      row: DefinitionPost | StoredComment | StoredReply;
      envelope: EffectiveContentEnvelope;
      accepted: AcceptedApproval;
      binding: ApprovalBinding;
      facts: DefinitionPayload;
      parents: { kind: ContentKind; id: string }[];
    }
  >();
  function add(
    nodeKind: ContentKind,
    row: DefinitionPost | StoredComment | StoredReply,
    e: EffectiveContentEnvelope,
    parents: { kind: ContentKind; id: string }[],
  ) {
    const decisionId = id(
      nodeKind === 'post' ? 6 : nodeKind === 'comment' ? 16 : 26,
    );
    const accepted: AcceptedApproval = {
      decisionId,
      version: e.version,
      digest: approvalDigest(e),
      envelope: e,
    };
    const binding: ApprovalBinding = {
      content_kind: nodeKind,
      content_id: row.id,
      content_version: 1,
      envelope_version: e.version,
      decision_id: decisionId,
      account_id: row.account_id,
      operation: e.purpose,
      digest: accepted.digest,
      envelope: e,
      scope: e.scope,
    };
    const facts: DefinitionPayload = {
      images: [],
      options: [],
      creators: [],
      ...(e.version === 7
        ? { home: e.home }
        : e.version === 8
          ? { homeParent: e.homeParent }
          : {}),
    };
    if ((e.version === 7 || e.version === 8) && e.textSource) {
      facts.textSource = {
        content_kind: nodeKind,
        content_id: row.id,
        source_revision: 1,
        source_version: 1,
        source_format: e.textSource.format,
        reading_formatting:
          e.textSource.format === 'plain'
            ? e.textSource.readingFormatting
            : null,
        source_hash: e.textSource.sourceHash,
        account_id: row.account_id,
        client_request_id: id(
          nodeKind === 'post' ? 2 : nodeKind === 'comment' ? 12 : 22,
        ),
        requested_author_mode: 'named',
        original_intent_hash: composedSourceOriginalIntentHash(e, 'named'),
        decision_id: decisionId,
        approval_digest: accepted.digest,
      };
    }
    entries.set(nodeKind, {
      row,
      envelope: e,
      accepted,
      binding,
      facts,
      parents,
    });
  }
  add('post', post, parent, []);
  if (kind !== 'post')
    for (const nodeKind of (kind === 'reply'
      ? ['comment', 'reply']
      : ['comment']) as ('comment' | 'reply')[]) {
      const target = nodeKind === kind;
      const text = target ? longText : 'root';
      const source =
        target && targetSource
          ? reviewedTextSource(text, descriptor, nodeKind)
          : null;
      const { home, ...base } = parent;
      void home;
      const e = canonicalEnvelope({
        ...base,
        version: 8,
        purpose: `publish_${nodeKind}`,
        accountId: id(8),
        text,
        postId: post.id,
        rootCommentId: nodeKind === 'reply' ? id(11) : null,
        textSource: source,
        scope: {
          ...scope,
          authorOriginRegionId: id(99),
          identityRegionId: id(98),
          topologySnapshotId: id(97),
        },
        homeParent: {
          postId: post.id,
          decisionId: id(6),
          digest: approvalDigest(parent),
        },
      });
      const row = {
        id: id(nodeKind === 'comment' ? 11 : 21),
        post_id: post.id,
        account_id: id(8),
        text,
        author_mode: 'named' as const,
        visibility: 'approved' as const,
        deleted_at: null,
        created_at: new Date(),
        ...(nodeKind === 'reply'
          ? { root_comment_id: id(11), target_reply_id: null, sequence: '1' }
          : {}),
      };
      add(
        nodeKind,
        row,
        e,
        nodeKind === 'comment'
          ? [{ kind: 'post', id: post.id }]
          : [
              { kind: 'post', id: post.id },
              { kind: 'comment', id: id(11) },
            ],
      );
    }
  const target = entries.get(kind)!;
  const state = {
    revokedParent: false,
    missingSource: false,
    ownerHidden: false,
    categoryHead: false,
    mediaEpoch: 0,
    mediaBinding: false,
  };
  const sqls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 64,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(sql.includes('whaleu_media.') ? state.mediaEpoch : 0),
          })),
        };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock_shared'))
        return { rows: Array.from({ length: 128 }, () => ({ locked: true })) };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock'))
        return { rows: [{ locked: true }] };
      if (sql.startsWith('SELECT id FROM whaleu_media.bindings'))
        return { rows: state.mediaBinding ? [{ id: id(70) }] : [] };
      if (sql.startsWith('SELECT * FROM whaleu_community.'))
        return { rows: [target.row] };
      if (sql.startsWith('SELECT id,account_id FROM whaleu_community.posts'))
        return { rows: [post] };
      if (
        sql.startsWith(
          'SELECT id,account_id FROM whaleu_community.root_comments',
        )
      )
        return {
          rows: entries.has('comment') ? [entries.get('comment')!.row] : [],
        };
      if (sql.startsWith('SELECT id,status,lifecycle'))
        return {
          rows: [
            ...new Set([...entries.values()].map((e) => e.row.account_id)),
          ].map((account) => ({
            id: account,
            status: 'active',
            lifecycle: 'active',
            lifecycle_generation: '0',
            xmin: '1',
          })),
        };
      if (sql.includes('COALESCE(v.owner_hidden,false)'))
        return {
          rows: [
            {
              postId: post.id,
              ownerHidden: state.ownerHidden,
              version: 0,
              requestId: null,
              xmin: null,
            },
          ],
        };
      if (sql.includes('account_punishment_policy_observation'))
        return {
          rows: [
            {
              fingerprint: 'fixture-current',
              allowed: true,
              suspended: false,
              until: null,
            },
          ],
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (
        sql.startsWith(
          'SELECT post_id FROM whaleu_community.post_category_heads',
        )
      )
        return {
          rows: state.categoryHead ? [{ post_id: post.id }] : [],
          rowCount: state.categoryHead ? 1 : 0,
        };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const approvals = {
    binding: async (k: string) => entries.get(k)!.binding,
    current: async (b: ApprovalBinding) =>
      b.content_kind === 'post' && state.revokedParent
        ? { kind: 'unavailable' }
        : { kind: 'allow', value: entries.get(b.content_kind)!.accepted },
  } as unknown as ApprovalRepository;
  const definitions = {
    current: async (k: ContentKind) => {
      const entry = entries.get(k)!;
      const facts = structuredClone(entry.facts);
      if (state.missingSource && k === kind) delete facts.textSource;
      return reconstructDefinition(
        k,
        post,
        entry.row,
        k === 'reply' ? id(11) : null,
        entry.envelope.scope,
        entry.parents,
        facts,
      );
    },
  } as unknown as ContentDefinitionRepository;
  const identity = new IdentityService(
    {
      exchange: async () => {
        throw new Error('No provider');
      },
    },
    new IdentityRepository({} as DatabaseService),
  );
  const owner = new ReadingSourceOwner(approvals, definitions, identity);
  const expected = {
    kind,
    id: target.row.id,
    sourceRevision: 1 as const,
    sourceHash: target.facts.textSource?.source_hash ?? '0'.repeat(64),
    publicationRequestId: target.facts.textSource?.client_request_id ?? id(2),
  };
  return { owner, expected, tx, state, entries, sqls };
}
async function resolve(f: ReturnType<typeof fixture>) {
  startTransactionDeadlines(f.tx);
  try {
    const result = await f.owner.resolve(f.expected, f.tx);
    await checkTransactionDeadlines(f.tx);
    return result;
  } finally {
    clearTransactionDeadlines(f.tx);
  }
}
test('formatter owner resolves eligible v7/v8 plain sources and preserves child-specific identity scope', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const f = fixture(kind);
    const source = await resolve(f);
    assert.equal(source.kind, kind);
    assert.equal(source.text, longText);
    assert.deepEqual(source.descriptor, plain);
    assert.ok(
      f.sqls.some((sql) =>
        sql.includes('LOCK TABLE whaleu_media.media_owner_states'),
      ),
    );
  }
});
test('reviewed-null v7 parent and v8 root can precede eligible v8 source; null target never formats', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    const f = fixture(kind, { parentSource: false });
    assert.equal((await resolve(f)).kind, kind);
  }
  for (const kind of ['post', 'comment', 'reply'] as const)
    await assert.rejects(resolve(fixture(kind, { targetSource: false })), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
});
test('Markdown and explicit plain-off remain ineligible across all composed source kinds', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const)
    for (const descriptor of [
      { version: 1, format: 'markdown' },
      { version: 1, format: 'plain', readingFormatting: 'off' },
    ] as const)
      await assert.rejects(resolve(fixture(kind, { descriptor })), {
        code: 'COMMUNITY_UNAVAILABLE',
      });
});
test('stale parent, missing source, owner hidden and category movement fail closed', async () => {
  for (const key of [
    'revokedParent',
    'missingSource',
    'ownerHidden',
    'categoryHead',
  ] as const) {
    const f = fixture('reply');
    f.state[key] = true;
    await assert.rejects(resolve(f), { code: 'COMMUNITY_UNAVAILABLE' });
  }
});
test('child cannot swap its parent decision or digest even with self-consistent child Review', async () => {
  for (const key of ['decisionId', 'digest'] as const) {
    const f = fixture('comment');
    const entry = f.entries.get('comment')!;
    assert.equal(entry.envelope.version, 8);
    if (entry.envelope.version !== 8) throw new Error();
    const e = canonicalEnvelope({
      ...entry.envelope,
      homeParent: {
        ...entry.envelope.homeParent,
        [key]: key === 'digest' ? 'f'.repeat(64) : id(90),
      },
    });
    entry.envelope = e;
    entry.accepted = {
      ...entry.accepted,
      envelope: e,
      digest: approvalDigest(e),
    };
    entry.binding = {
      ...entry.binding,
      envelope: e,
      digest: entry.accepted.digest,
    };
    if (e.version !== 8) throw new Error();
    entry.facts.homeParent = e.homeParent;
    entry.facts.textSource!.approval_digest = entry.accepted.digest;
    await assert.rejects(resolve(f), { code: 'COMMUNITY_UNAVAILABLE' });
  }
});
test('composed formatting retains final empty-media and category-head race fences', async () => {
  for (const change of ['media', 'category'] as const) {
    const f = fixture('reply');
    startTransactionDeadlines(f.tx);
    try {
      await f.owner.resolve(f.expected, f.tx);
      if (change === 'media') {
        f.state.mediaBinding = true;
        f.state.mediaEpoch++;
      } else f.state.categoryHead = true;
      await assert.rejects(checkTransactionDeadlines(f.tx));
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
