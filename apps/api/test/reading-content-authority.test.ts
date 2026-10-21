import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type {
  CommunityRepository,
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ApprovalBinding } from '../src/community/content-review/approval.repository.js';
import type { ApprovalRow } from '../src/community/content-review/approval-validation.js';
import type {
  ContentDefinitionRepository,
  CurrentContent,
} from '../src/community/content-review/content-definition.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../src/community/content-review/contracts.js';
import type { Decision } from '../src/community/community-policy.js';
import type { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { TextSourceReadService } from '../src/community/text-source/read.service.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-01T00:00:00Z');
const before = new Date(now.getTime() - 1000);
const after = new Date(now.getTime() + 1000);
function fixture(kind: 'comment' | 'reply', version: 1 | 4 | 6 = 6) {
  // Actual SELECT * shape: neither child table has a publication version column.
  const comment: StoredComment = {
    id: id(2),
    post_id: id(1),
    account_id: id(8),
    text: '**literal child**',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: now,
  };
  const row: StoredComment | StoredReply =
    kind === 'comment'
      ? comment
      : {
          ...comment,
          id: id(3),
          root_comment_id: comment.id,
          target_reply_id: null,
          sequence: '1',
        };
  const scope = {
    originalSpaceId: id(4),
    originalRegionId: id(5),
    authorOriginRegionId: id(5),
    identityRegionId: id(5),
    topologySnapshotId: null,
    sync: 'none',
    configurationRevisionId: null,
    identityCampusId: null,
    identitySelectionId: null,
    affiliationSnapshotId: null,
    affiliationAssertionId: null,
  };
  const envelope = canonicalEnvelope({
    version,
    accountId: row.account_id,
    purpose: `publish_${kind}`,
    spaceId: id(4),
    category: 'discussion',
    authorMode: row.author_mode,
    commentsPolicy: 'open',
    postId: row.post_id,
    rootCommentId: kind === 'reply' ? comment.id : null,
    targetReplyId: null,
    text: row.text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope:
      version === 4
        ? {
            ...scope,
            sync: 'inherited_related',
            parentDistribution: {
              postId: row.post_id,
              decisionId: id(10),
              digest: 'a'.repeat(64),
            },
          }
        : scope,
    ...(version === 1 ? {} : { allowAnonymousDm: null }),
    ...(version === 6
      ? {
          textSource: reviewedTextSource(
            row.text,
            { version: 1, format: 'markdown' },
            kind,
          ),
        }
      : {}),
  });
  const digest = approvalDigest(envelope);
  const binding: ApprovalBinding = {
    content_kind: kind,
    content_id: row.id,
    content_version: 1,
    decision_id: id(7),
    account_id: row.account_id,
    operation: envelope.purpose,
    envelope_version: version,
    digest,
    envelope,
    scope: envelope.scope,
  };
  const decision: ApprovalRow = {
    id: binding.decision_id,
    account_id: row.account_id,
    operation: envelope.purpose,
    envelope_version: version,
    digest,
    envelope,
    policy_revision_id: id(9),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'owned',
    provenance_ref: 'reference',
    evaluated_at: before,
    consume_until: after,
    visibility_model: 'durable',
    visibility_until: null,
    policy_key:
      version === 6
        ? 'local-text-source-v1'
        : version === 4
          ? 'local-related-v1'
          : 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'owned',
    policy_provenance_ref: 'reference',
    policy_valid_from: before,
    policy_valid_until: null,
    state: 'allow',
    event_at: before,
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'owned',
    event_provenance_ref: 'reference',
  };
  const content: CurrentContent = {
    envelope,
    authorAccountId: row.account_id,
    authorMode: row.author_mode,
    parents: [{ kind: 'post', id: row.post_id }],
    ...(envelope.version === 6
      ? {
          textSource: {
            content_kind: kind,
            content_id: row.id,
            source_revision: 1,
            source_version: 1,
            source_format: 'markdown',
            reading_formatting: null,
            source_hash: envelope.textSource.sourceHash,
            account_id: row.account_id,
            client_request_id: id(11),
            requested_author_mode: row.author_mode,
            original_intent_hash: 'b'.repeat(64),
            decision_id: binding.decision_id,
            approval_digest: digest,
          } as const,
        }
      : {}),
  };
  const state: {
    binding: ApprovalBinding | null;
    decision: ApprovalRow | null;
    definition: Decision<CurrentContent>;
    queries: string[];
    definitionReads: number;
  } = {
    binding,
    decision,
    definition: { kind: 'allow', value: content },
    queries: [],
    definitionReads: 0,
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      state.queries.push(sql);
      if (sql.includes('FROM whaleu_community.content_approval_bindings')) {
        assert.equal(
          sql,
          'SELECT * FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2 AND content_version=1 FOR SHARE',
        );
        assert.deepEqual(values, [kind, row.id]);
        return { rows: state.binding ? [state.binding] : [] };
      }
      if (sql.includes('FROM whaleu_identity.accounts'))
        return { rows: [{ id: row.account_id }] };
      if (sql.includes('FROM whaleu_community.content_approval_decisions d'))
        return { rows: state.decision ? [state.decision] : [] };
      if (sql.includes('clock_timestamp()')) return { rows: [{ now }] };
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
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const sources = new TextSourceReadService(
    {} as CommunityRepository,
    {} as CommunityAccessService,
    // Real binding SQL and real current Review/binding-envelope validation.
    new ApprovalRepository(),
    {
      current: async (
        usedKind: string,
        usedId: string,
        usedScope: unknown,
        used: PoolClient,
      ) => {
        assert.equal(usedKind, kind);
        assert.equal(usedId, row.id);
        assert.deepEqual(usedScope, envelope.scope);
        assert.equal(used, tx);
        state.definitionReads++;
        return state.definition;
      },
    } as unknown as ContentDefinitionRepository,
    {} as TextReviewRuntime,
  );
  return { kind, row, envelope, state, sources, tx };
}
async function read(f: ReturnType<typeof fixture>) {
  startTransactionDeadlines(f.tx);
  try {
    const result = await f.sources.authorizedReading(f.kind, f.row, f.tx);
    await checkTransactionDeadlines(f.tx);
    return result;
  } finally {
    clearTransactionDeadlines(f.tx);
  }
}

test('marker-absent children resolve versions 1/4/6 through exact same-TX binding/current owner', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    for (const version of [1, 4, 6] as const) {
      const f = fixture(kind, version);
      assert.equal(Object.hasOwn(f.row, 'publication_envelope_version'), false);
      const result = await read(f);
      assert.equal(
        f.state.queries.filter((sql) =>
          sql.includes('FROM whaleu_community.content_approval_bindings'),
        ).length,
        1,
        'The same actual held binding reaches source proof',
      );
      if (version !== 6) {
        assert.equal(result, null);
        assert.equal(f.state.definitionReads, 0);
      } else {
        assert.equal(result?.source.classification, 'reviewedSource');
        assert.equal(result?.source.kind, kind);
        assert.equal(result?.source.id, f.row.id);
        assert.equal(result?.source.postId, f.row.post_id);
        assert.equal(result?.source.rootCommentId, id(2));
        assert.equal(result?.source.text, f.row.text);
        assert.equal(f.state.definitionReads, 1);
        assert.ok(
          f.state.queries.includes(
            'LOCK TABLE whaleu_campus.discovery_count_epochs IN SHARE MODE NOWAIT',
          ),
        );
        assert.ok(
          f.state.queries.includes(
            'SELECT pg_try_advisory_xact_lock(1464356101,128) AS locked',
          ),
        );
      }
    }
  }
});
test('missing, unknown, post-only or disagreed child binding versions never become legacy', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    for (const patch of [
      null,
      { content_kind: kind === 'comment' ? 'reply' : 'comment' },
      { content_id: id(99) },
      { content_version: 2 },
      { account_id: id(99) },
      { envelope_version: 0 },
      { envelope_version: 1 },
      { envelope_version: 2 },
      { envelope_version: 3 },
      { envelope_version: 5 },
      { envelope_version: 7 },
      { envelope_version: '6' },
      { digest: '0'.repeat(64) },
      { operation: 'publish_post' },
      { scope: { sync: 'none' } },
    ]) {
      const f = fixture(kind);
      f.state.binding =
        patch === null
          ? null
          : ({ ...f.state.binding, ...patch } as ApprovalBinding);
      await assert.rejects(
        read(f),
        { code: 'COMMUNITY_UNAVAILABLE' },
        JSON.stringify({ kind, patch }),
      );
      assert.equal(f.state.definitionReads, 0);
    }
  }
});
test('actual child owner, text, parent, root and reply target must agree with accepted binding', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    for (const patch of [
      { account_id: id(99) },
      { text: 'different' },
      { post_id: id(99) },
      ...(kind === 'reply'
        ? [{ root_comment_id: id(99) }, { target_reply_id: id(99) }]
        : []),
    ]) {
      const f = fixture(kind);
      Object.assign(f.row, patch);
      await assert.rejects(
        read(f),
        { code: 'COMMUNITY_UNAVAILABLE' },
        JSON.stringify({ kind, patch }),
      );
    }
  }
});
test('v6 child classification retains mandatory current Review and source-definition denial', async () => {
  for (const kind of ['comment', 'reply'] as const) {
    for (const changed of [
      'missingReview',
      'revokedReview',
      'bindingEnvelope',
      'missingDefinition',
      'missingSource',
      'sourceDecision',
      'sourceOwner',
      'canonicalOwner',
    ] as const) {
      const f = fixture(kind);
      if (changed === 'missingReview') f.state.decision = null;
      else if (changed === 'revokedReview') f.state.decision!.state = 'revoked';
      else if (changed === 'bindingEnvelope')
        f.state.binding!.envelope = { ...f.envelope, text: 'different' };
      else if (changed === 'missingDefinition')
        f.state.definition = { kind: 'unavailable' };
      else {
        assert.equal(f.state.definition.kind, 'allow');
        if (f.state.definition.kind !== 'allow') throw new Error();
        const content = f.state.definition.value;
        if (changed === 'missingSource') delete content.textSource;
        else if (changed === 'sourceDecision')
          content.textSource!.decision_id = id(99);
        else if (changed === 'sourceOwner')
          content.textSource!.account_id = id(99);
        else content.authorAccountId = id(99);
      }
      await assert.rejects(
        read(f),
        { code: 'COMMUNITY_UNAVAILABLE' },
        JSON.stringify({ kind, changed }),
      );
    }
    const unmanaged = fixture(kind);
    await assert.rejects(
      unmanaged.sources.authorizedReading(kind, unmanaged.row, unmanaged.tx),
      { code: 'COMMUNITY_UNAVAILABLE' },
    );
  }
});
