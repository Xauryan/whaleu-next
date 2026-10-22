import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelopeV7,
  EffectiveContentEnvelopeV8,
} from '../src/community/content-review/contracts.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
import { requireCurrentHomeParent } from '../src/community/home-feed-policy/parent-proof.js';
import {
  reviewedTextSource,
  composedSourceOriginalIntentHash,
  textSourceIntentHash,
} from '../src/community/text-source/protocol.js';
import { withReviewedTextSource } from '../src/community/text-source/publication.js';
import { insertTextSource } from '../src/community/text-source/repository.js';
import type { StoredTextSource } from '../src/community/text-source/repository.js';
import {
  reconstructDefinition,
  definitionMatchesApproval,
} from '../src/community/content-review/definition-validation.js';
import type {
  DefinitionPost,
  DefinitionPayload,
} from '../src/community/content-review/definition-validation.js';
import type {
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import { TextSourceReadService } from '../src/community/text-source/read.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import type { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const descriptor = { version: 1, format: 'markdown' } as const;
function fixture(explicit = true) {
  const requestedIntent = {
    spaceId: id(2),
    category: 'discussion' as const,
    text: '三个字',
    imageAssetIds: [],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
    ...(explicit ? { textSource: descriptor } : {}),
  };
  const scope = {
    originalSpaceId: id(2),
    originalRegionId: id(3),
    authorOriginRegionId: id(3),
    identityRegionId: id(3),
    topologySnapshotId: null,
    sync: 'none' as const,
  };
  const envelope = canonicalEnvelope({
    version: 7,
    accountId: id(1),
    purpose: 'publish_post',
    spaceId: id(2),
    category: 'water',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: requestedIntent.text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope,
    allowAnonymousDm: null,
    textSource: explicit
      ? reviewedTextSource(requestedIntent.text, descriptor, 'post')
      : null,
    home: {
      version: 1,
      admission: {
        id: id(4),
        revision: 1,
        digest: 'a'.repeat(64),
        sourceCommit: LEGACY_HOME_POLICY_COMMIT,
        validUntil: '2030-01-01T00:00:00Z',
      },
      requestedIntent,
      requestedIntentHash: homeOriginalIntentHash(requestedIntent),
      requestedRegionId: id(3),
      legacyChoose: 2,
      targetWaterSpaceId: id(2),
      targetWaterRegionId: id(3),
      auditExempt: false,
      result: 'short_text',
    },
  });
  assert.equal(envelope.version, 7);
  if (envelope.version !== 7) throw new Error();
  const approval: AcceptedApproval = {
    version: 7,
    envelope,
    digest: approvalDigest(envelope),
    decisionId: id(7),
  };
  const post = {
    id: id(10),
    account_id: id(1),
    space_id: id(2),
    category: 'water',
    author_mode: 'named',
    comments_policy: 'open',
    allow_anonymous_dm: null,
    text: envelope.text,
    publication_envelope_version: 7,
    publication_state: 'published',
    visibility: 'approved',
    deleted_at: null,
    feedback: null,
  } as unknown as DefinitionPost;
  const source = sourceRow(envelope, approval, 'post', post.id);
  const facts: DefinitionPayload = {
    images: [],
    options: [],
    creators: [],
    home: envelope.home,
    ...(source ? { textSource: source } : {}),
  };
  return { envelope, approval, post, facts };
}
function sourceRow(
  envelope: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8,
  approval: AcceptedApproval,
  kind: 'post' | 'comment' | 'reply',
  contentId: string,
): StoredTextSource | undefined {
  if (!envelope.textSource) return undefined;
  return {
    content_kind: kind,
    content_id: contentId,
    source_revision: 1,
    source_version: 1,
    source_format: 'markdown',
    reading_formatting: null,
    source_hash: envelope.textSource.sourceHash,
    account_id: envelope.accountId,
    client_request_id: id(8),
    requested_author_mode: 'named',
    original_intent_hash: composedSourceOriginalIntentHash(envelope, 'named'),
    decision_id: approval.decisionId,
    approval_digest: approval.digest,
  };
}
function discussion(
  f: ReturnType<typeof fixture>,
  kind: 'comment' | 'reply',
  explicit = true,
) {
  const { home, ...base } = f.envelope;
  void home;
  const text = 'child text';
  const row = {
    id: id(kind === 'comment' ? 20 : 21),
    post_id: f.post.id,
    account_id: id(1),
    text,
    author_mode: 'named' as const,
    visibility: 'approved' as const,
    deleted_at: null,
    created_at: new Date(),
    ...(kind === 'reply'
      ? { root_comment_id: id(20), target_reply_id: null, sequence: '1' }
      : {}),
  };
  const envelope = canonicalEnvelope({
    ...base,
    version: 8,
    purpose: `publish_${kind}`,
    postId: f.post.id,
    rootCommentId: kind === 'reply' ? id(20) : null,
    text,
    textSource: explicit ? reviewedTextSource(text, descriptor, kind) : null,
    homeParent: {
      postId: f.post.id,
      decisionId: f.approval.decisionId,
      digest: f.approval.digest,
    },
  });
  if (envelope.version !== 8) throw new Error();
  const approval: AcceptedApproval = {
    version: 8,
    envelope,
    digest: approvalDigest(envelope),
    decisionId: id(30),
  };
  const source = sourceRow(envelope, approval, kind, row.id);
  const facts: DefinitionPayload = {
    images: [],
    options: [],
    creators: [],
    homeParent: envelope.homeParent,
    ...(source ? { textSource: source } : {}),
  };
  return { envelope, approval, row, facts };
}
test('composed source intent preserves original requested placement and child historical hash domains', () => {
  const f = fixture();
  assert.equal(
    composedSourceOriginalIntentHash(f.envelope, 'named'),
    f.envelope.home.requestedIntentHash,
  );
  for (const kind of ['comment', 'reply'] as const) {
    const d = discussion(f, kind);
    const intent =
      kind === 'comment'
        ? {
            postId: f.post.id,
            text: d.row.text,
            imageAssetIds: [],
            authorMode: 'named',
          }
        : {
            rootCommentId: id(20),
            targetReplyId: null,
            text: d.row.text,
            imageAssetIds: [],
            authorMode: 'named',
          };
    assert.equal(
      composedSourceOriginalIntentHash(d.envelope, 'named'),
      textSourceIntentHash(`publish_${kind}`, {
        ...intent,
        textSource: descriptor,
      }),
    );
  }
});
test('source composition preserves v7/v8 and never drops explicit evidence', () => {
  const f = fixture();
  assert.equal(withReviewedTextSource(f.envelope, descriptor).version, 7);
  assert.throws(() => withReviewedTextSource(f.envelope, undefined));
  assert.throws(() =>
    withReviewedTextSource(f.envelope, {
      version: 1,
      format: 'plain',
      readingFormatting: 'off',
    }),
  );
  const d = discussion(f, 'reply');
  assert.equal(withReviewedTextSource(d.envelope, descriptor).version, 8);
  assert.equal(
    withReviewedTextSource(fixture(false).envelope, undefined).version,
    7,
  );
});
test('actual reconstruction accepts composed post and children with exact source rows', () => {
  for (const explicit of [false, true]) {
    const f = fixture(explicit);
    const reconstructed = reconstructDefinition(
      'post',
      f.post,
      f.post,
      null,
      f.envelope.scope,
      [],
      f.facts,
    );
    assert.equal(reconstructed.kind, 'allow');
    if (reconstructed.kind === 'allow')
      assert.equal(
        definitionMatchesApproval(reconstructed.value, f.approval),
        true,
      );
    for (const kind of ['comment', 'reply'] as const) {
      const d = discussion(f, kind, explicit);
      const current = reconstructDefinition(
        kind,
        f.post,
        d.row as StoredComment | StoredReply,
        kind === 'reply' ? id(20) : null,
        d.envelope.scope,
        [{ kind: 'post', id: f.post.id }],
        d.facts,
      );
      assert.equal(current.kind, 'allow');
      if (current.kind === 'allow')
        assert.equal(
          definitionMatchesApproval(current.value, d.approval),
          true,
        );
    }
  }
});
test('missing or wrong immutable Home/source evidence fails reconstructed approval equality', () => {
  for (const mutate of [
    (v: DefinitionPayload) => delete v.home,
    (v: DefinitionPayload) => delete v.textSource,
    (v: DefinitionPayload) =>
      (v.textSource!.original_intent_hash = '0'.repeat(64)),
    (v: DefinitionPayload) => (v.textSource!.decision_id = id(99)),
    (v: DefinitionPayload) => (v.textSource!.approval_digest = '0'.repeat(64)),
  ]) {
    const f = fixture();
    const facts = structuredClone(f.facts);
    mutate(facts);
    const current = reconstructDefinition(
      'post',
      f.post,
      f.post,
      null,
      f.envelope.scope,
      [],
      facts,
    );
    assert.equal(
      current.kind === 'allow' &&
        definitionMatchesApproval(current.value, f.approval),
      false,
    );
  }
});
test('insert owner checks composed exact source, original request and approval before writing', async () => {
  const f = fixture();
  const writes: unknown[][] = [];
  const tx = {
    query: async (_sql: string, args: unknown[]) => {
      writes.push(args);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const input = {
    kind: 'post' as const,
    id: f.post.id,
    accountId: f.post.account_id,
    requestId: id(8),
    requestedAuthorMode: 'named' as const,
    originalIntentHash: f.envelope.home.requestedIntentHash,
    text: f.post.text,
    source: descriptor,
    approval: f.approval,
  };
  await insertTextSource(input, tx);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![4], f.envelope.textSource!.sourceHash);
  for (const patch of [
    { originalIntentHash: '0'.repeat(64) },
    { source: undefined },
    { accountId: id(99) },
    { approval: { ...f.approval, digest: '0'.repeat(64) } },
  ])
    await assert.rejects(insertTextSource({ ...input, ...patch }, tx));
  assert.equal(writes.length, 1);
});
test('parent helper verifies actual current v7 definition and refuses forged or stale reference', async () => {
  const f = fixture();
  const current = reconstructDefinition(
    'post',
    f.post,
    f.post,
    null,
    f.envelope.scope,
    [],
    f.facts,
  );
  assert.equal(current.kind, 'allow');
  const binding = {
    content_kind: 'post' as const,
    content_id: f.post.id,
    content_version: 1,
    envelope_version: 7,
    decision_id: f.approval.decisionId,
    digest: f.approval.digest,
    account_id: f.post.account_id,
    operation: 'publish_post' as const,
    envelope: f.envelope,
    scope: f.envelope.scope,
  };
  const approvals = {
    binding: async () => binding,
    current: async () => ({ kind: 'allow' as const, value: f.approval }),
  };
  const definitions = { current: async () => current };
  const tx = {} as PoolClient;
  const proof = await requireCurrentHomeParent(
    f.post.id,
    tx,
    approvals,
    definitions,
  );
  assert.equal(proof.envelope.version, 7);
  await assert.rejects(
    requireCurrentHomeParent(f.post.id, tx, approvals, definitions, {
      ...proof.reference,
      digest: '0'.repeat(64),
    }),
  );
  await assert.rejects(
    requireCurrentHomeParent(f.post.id, tx, approvals, {
      current: async () => ({ kind: 'unavailable' as const }),
    }),
  );
  await assert.rejects(
    requireCurrentHomeParent(
      f.post.id,
      tx,
      { ...approvals, current: async () => ({ kind: 'unavailable' as const }) },
      definitions,
    ),
  );
});
function readFixture(kind: 'post' | 'comment' | 'reply', explicit: boolean) {
  const f = fixture(explicit);
  const d = kind === 'post' ? null : discussion(f, kind, explicit);
  const row = d?.row ?? f.post;
  const envelope = d?.envelope ?? f.envelope;
  const accepted = d?.approval ?? f.approval;
  const state = {
    parentCurrent: true,
    missingSource: false,
    unknownVersion: false,
    definitionReads: 0,
  };
  const binding = (post: boolean) => {
    const approval = post ? f.approval : accepted;
    return {
      content_kind: post ? 'post' : kind,
      content_id: post ? f.post.id : row.id,
      content_version: 1,
      envelope_version: state.unknownVersion ? 99 : approval.version,
      decision_id: approval.decisionId,
      digest: approval.digest,
      account_id: approval.envelope.accountId,
      operation: approval.envelope.purpose,
      envelope: approval.envelope,
      scope: approval.envelope.scope,
    };
  };
  const approvals = {
    binding: async (k: string) => binding(k === 'post'),
    current: async (b: { content_kind: string }) =>
      b.content_kind === 'post' && !state.parentCurrent
        ? { kind: 'unavailable' }
        : {
            kind: 'allow',
            value: b.content_kind === 'post' ? f.approval : accepted,
          },
  } as unknown as ApprovalRepository;
  const definitions = {
    current: async (k: string) => {
      state.definitionReads++;
      const isPost = k === 'post';
      const facts = structuredClone(isPost ? f.facts : d!.facts);
      if (state.missingSource) delete facts.textSource;
      return reconstructDefinition(
        isPost ? 'post' : kind,
        f.post,
        isPost ? f.post : row,
        isPost || kind === 'comment' ? null : id(20),
        isPost ? f.envelope.scope : envelope.scope,
        isPost ? [] : [{ kind: 'post', id: f.post.id }],
        facts,
      );
    },
  } as unknown as ContentDefinitionRepository;
  const tx = {
    query: async (sql: string) => {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 64,
              statement_timeout: '1s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('discovery_count_epochs ORDER BY slot'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: Array.from({ length: 128 }, () => ({ locked: true })) };
      if (sql.includes('pg_try_advisory_xact_lock('))
        return { rows: [{ locked: true }] };
      if (
        sql.startsWith('SET CONSTRAINTS') ||
        sql.startsWith('LOCK TABLE') ||
        sql.includes('set_config(')
      )
        return { rows: [] };
      throw new Error(`Unexpected read SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const service = new TextSourceReadService(
    {} as CommunityRepository,
    {} as CommunityAccessService,
    approvals,
    definitions,
    {} as TextReviewRuntime,
  );
  const read = async () => {
    startTransactionDeadlines(tx);
    try {
      return await service.authorizedReading(kind, row, tx);
    } finally {
      clearTransactionDeadlines(tx);
    }
  };
  return { state, row, read };
}
test('real source read service classifies composed source only after independent definition and current parent proof', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const)
    for (const explicit of [false, true]) {
      const f = readFixture(kind, explicit);
      const result = await f.read();
      assert.ok(f.state.definitionReads > 0);
      if (explicit) {
        assert.equal(result?.source.classification, 'reviewedSource');
        assert.equal(result?.source.kind, kind);
        assert.equal(result?.presentation.status, 'source');
      } else assert.equal(result, null);
    }
});
test('composed reader never turns missing sources, stale parents or unknown markers into legacy plain', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const missing = readFixture(kind, true);
    missing.state.missingSource = true;
    await assert.rejects(missing.read(), { code: 'COMMUNITY_UNAVAILABLE' });
    const unknown = readFixture(kind, true);
    if (kind === 'post')
      Object.assign(unknown.row, { publication_envelope_version: 99 });
    else unknown.state.unknownVersion = true;
    await assert.rejects(unknown.read(), { code: 'COMMUNITY_UNAVAILABLE' });
    if (kind !== 'post') {
      for (const explicit of [true, false]) {
        const stale = readFixture(kind, explicit);
        stale.state.parentCurrent = false;
        await assert.rejects(stale.read(), { code: 'COMMUNITY_UNAVAILABLE' });
      }
    }
  }
});
