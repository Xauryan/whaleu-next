import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import {
  approvalPolicyKey,
  validateApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import type { ApprovalRow } from '../src/community/content-review/approval-validation.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
  EffectiveContentEnvelopeV7,
  EffectiveContentEnvelopeV8,
} from '../src/community/content-review/contracts.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import type { HomeReviewAdmissionGuard } from '../src/community/text-review/runtime.js';
import type { TextReviewRequest } from '../src/community/text-review/contracts.js';
import { TextReviewOperator } from '../src/community/text-review/operator.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const environment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://db.example.test/whaleu',
  COMMUNITY_TEXT_REVIEW: 'local_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: id(2),
  COMMUNITY_TEXT_REVIEW_REGION_ID: id(3),
  COMMUNITY_TEXT_REVIEW_POLICY_ID: id(4),
  COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: id(5),
  COMMUNITY_RELATED_REVIEW_POLICY_ID: id(6),
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:review-host:reviewer',
};
const admitted: HomeReviewAdmissionGuard = { requireEnvelope: async () => {} };
function runtime(
  production = false,
  guard: HomeReviewAdmissionGuard | undefined = admitted,
) {
  return new TextReviewRuntime(
    loadConfig({
      ...environment,
      ...(production
        ? {
            NODE_ENV: 'production',
            COMMUNITY_TEXT_REVIEW: 'source_manual',
            COMMUNITY_RELATED_REVIEW_POLICY_ID: undefined,
            COMMUNITY_TEXT_REVIEW_POLICY_ID: undefined,
          }
        : {}),
    }),
    new ApprovalRepository(),
    undefined,
    undefined,
    guard,
  );
}
function post(source = true): EffectiveContentEnvelopeV7 {
  const text = '三个字';
  const requestedIntent = {
    spaceId: id(2),
    category: 'discussion' as const,
    text,
    imageAssetIds: [],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
    ...(source
      ? { textSource: { version: 1 as const, format: 'markdown' as const } }
      : {}),
  };
  return canonicalEnvelope({
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
    text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope: {
      originalSpaceId: id(2),
      originalRegionId: id(3),
      authorOriginRegionId: id(3),
      identityRegionId: id(3),
      topologySnapshotId: null,
      sync: 'none',
    },
    allowAnonymousDm: null,
    textSource: source
      ? reviewedTextSource(text, { version: 1, format: 'markdown' }, 'post')
      : null,
    home: {
      version: 1,
      admission: {
        id: id(8),
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
  }) as EffectiveContentEnvelopeV7;
}
function child(
  source = true,
  purpose: 'publish_comment' | 'publish_reply' = 'publish_comment',
): EffectiveContentEnvelopeV8 {
  const parent = Object.fromEntries(
    Object.entries(post(source)).filter(([key]) => key !== 'home'),
  );
  const text = 'child text';
  return canonicalEnvelope({
    ...parent,
    version: 8,
    purpose,
    text,
    postId: id(20),
    rootCommentId: purpose === 'publish_reply' ? id(21) : null,
    homeParent: {
      postId: id(20),
      decisionId: id(22),
      digest: approvalDigest(post(true)),
    },
    textSource: source
      ? reviewedTextSource(
          text,
          { version: 1, format: 'markdown' },
          purpose === 'publish_comment' ? 'comment' : 'reply',
        )
      : null,
  }) as EffectiveContentEnvelopeV8;
}
const allEnvelopes = () =>
  [false, true].flatMap((source) => [
    post(source),
    child(source),
    child(source, 'publish_reply'),
  ]);
function client(
  query: (sql: string, params: unknown[]) => unknown[] = () => [
    { valid_until: null },
  ],
): PoolClient {
  return {
    query: async (sql: string, params: unknown[] = []) => ({
      rows: query(sql, params),
    }),
  } as unknown as PoolClient;
}
const noQuery = () =>
  client(() => {
    throw new Error('Unexpected query');
  });
function request(
  envelope: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8,
): TextReviewRequest {
  return {
    account_id: envelope.accountId,
    client_request_id: id(30),
    operation: envelope.purpose,
    intent_hash:
      envelope.version === 7
        ? envelope.home.requestedIntentHash
        : 'b'.repeat(64),
    envelope,
    digest: approvalDigest(envelope),
    decision_id: id(31),
    expires_at: new Date('2030-01-01'),
  };
}
function context(row: TextReviewRequest) {
  return {
    clientRequestId: row.client_request_id,
    operation: row.operation,
    intentHash: row.intent_hash,
  };
}
function accepted(row: TextReviewRequest): AcceptedApproval {
  return {
    envelope: row.envelope,
    digest: row.digest,
    decisionId: row.decision_id!,
    version: row.envelope.version,
  };
}
function requestClient(
  row: TextReviewRequest | null,
  latest = row?.decision_id,
): PoolClient {
  return client((sql) => {
    if (sql.includes('content_approval_policies'))
      return [{ valid_until: null }];
    if (sql.includes('SELECT * FROM whaleu_community.text_review_requests'))
      return row ? [row] : [];
    if (sql.includes('content_approval_decisions'))
      return latest ? [{ id: latest }] : [];
    if (sql.includes('expires_at>clock_timestamp()')) return [{ exists: true }];
    return [];
  });
}
function approvalRow(envelope: EffectiveContentEnvelope): ApprovalRow {
  return {
    id: id(31),
    account_id: envelope.accountId,
    operation: envelope.purpose,
    envelope_version: envelope.version,
    digest: approvalDigest(envelope),
    envelope,
    policy_revision_id: id(5),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'reviewer',
    provenance_ref: 'reviewed',
    evaluated_at: new Date('2026-01-01'),
    consume_until: new Date('2030-01-01'),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: approvalPolicyKey(envelope)!,
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'reviewer',
    policy_provenance_ref: 'accepted',
    policy_valid_from: new Date('2025-01-01'),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date('2026-01-01'),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'reviewer',
    event_provenance_ref: 'reviewed',
  };
}

test('V7/V8 policy IDs and canonical validation select exact source or ordinary owner', async () => {
  for (const envelope of allEnvelopes()) {
    const source = envelope.textSource !== null;
    const expected = source ? 'local-text-source-v1' : 'local-explicit-v1';
    assert.equal(approvalPolicyKey(envelope), expected);
    assert.equal(runtime().policyId(envelope), source ? id(5) : id(4));
    const row = approvalRow(envelope);
    const now = Date.parse('2026-10-22');
    assert.equal(validateApprovalRow(row, true, now).decision.kind, 'allow');
    for (const wrong of [
      'local-home-v1',
      'local-related-v1',
      source ? 'local-explicit-v1' : 'local-text-source-v1',
    ])
      assert.equal(
        validateApprovalRow({ ...row, policy_key: wrong }, true, now).decision
          .kind,
        'unavailable',
      );
    assert.equal(
      validateApprovalRow({ ...row, state: 'revoked' }, true, now).decision
        .kind,
      'deny',
    );
    assert.equal(
      validateApprovalRow({ ...row, state: 'held' }, false, now).decision.kind,
      'deny',
    );
    await runtime().requireEnvelope(
      envelope,
      client((sql, params) => {
        assert.ok(sql.includes(`policy_key='${expected}'`));
        assert.equal(params[0], source ? id(5) : id(4));
        return [{ valid_until: null }];
      }),
    );
  }
});
test('historical policy owners remain unchanged and unknown versions cannot fall through', async () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const envelope = { ...post(), version } as EffectiveContentEnvelope;
    assert.equal(
      approvalPolicyKey(envelope),
      version === 6
        ? 'local-text-source-v1'
        : version === 4
          ? 'local-related-v1'
          : 'local-explicit-v1',
    );
  }
  const envelope = {
    ...post(),
    version: 9,
  } as unknown as EffectiveContentEnvelope;
  const service = runtime();
  assert.equal(service.policyId(envelope), undefined);
  assert.equal(approvalPolicyKey(envelope), null);
  await assert.rejects(service.requireEnvelope(envelope, noQuery()));
  await assert.rejects(
    service.requireRequest(envelope, context(request(post())), noQuery()),
  );
  await assert.rejects(
    service.requireBinding(
      envelope,
      context(request(post())),
      undefined,
      noQuery(),
    ),
  );
  assert.equal(
    validateApprovalRow(
      { ...approvalRow(post()), envelope, envelope_version: 9 },
      true,
      Date.now(),
    ).decision.kind,
    'unavailable',
  );
});
test('production source_manual admits source-bearing composition only, with mandatory current Home guard', async () => {
  const seen: number[] = [];
  const guard: HomeReviewAdmissionGuard = {
    requireEnvelope: async (envelope) => {
      seen.push(envelope.version);
    },
  };
  for (const envelope of allEnvelopes()) {
    if (envelope.textSource !== null)
      await runtime(true, guard).requireEnvelope(envelope, client());
    else
      await assert.rejects(
        runtime(true, guard).requireEnvelope(envelope, noQuery()),
      );
  }
  assert.deepEqual(seen, [7, 8, 8]);
  const missing = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
  );
  for (const envelope of allEnvelopes()) {
    await assert.rejects(missing.requireEnvelope(envelope, noQuery()));
    await assert.rejects(
      runtime(false, {
        requireEnvelope: async () => {
          throw new Error('Current admission or parent withdrawn');
        },
      }).requireEnvelope(envelope, client()),
      /withdrawn/,
    );
    await assert.rejects(
      runtime().requireEnvelope(
        envelope,
        client(() => []),
      ),
    );
  }
});
test('composed manual runtime cannot widen source profiles or accept noncanonical source evidence', async () => {
  for (const original of allEnvelopes()) {
    for (const mutate of [
      (value: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8) => {
        value.images = [{ assetId: id(50), digest: 'c'.repeat(64) }];
      },
      (value: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8) => {
        value.commentsPolicy = 'restricted';
      },
      (value: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8) => {
        Object.assign(value, { extra: true });
      },
      (value: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8) => {
        value.scope.originalSpaceId = id(50);
      },
      (value: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8) => {
        value.allowAnonymousDm = true;
      },
    ]) {
      const envelope = structuredClone(original);
      mutate(envelope);
      await assert.rejects(runtime().requireEnvelope(envelope, noQuery()));
    }
    const envelope = structuredClone(original);
    if (envelope.textSource) envelope.textSource.sourceHash = 'c'.repeat(64);
    else envelope.authorMode = 'anonymous';
    await assert.rejects(runtime().requireEnvelope(envelope, noQuery()));
  }
});
test('V7/V8 never consume a missing or stale Review request even with a standalone approval', async () => {
  for (const envelope of allEnvelopes()) {
    const row = request(envelope);
    const service = runtime();
    await assert.rejects(
      service.requireRequest(envelope, context(row), requestClient(null)),
    );
    await assert.rejects(
      service.requireBinding(
        envelope,
        context(row),
        accepted(row),
        requestClient(null),
      ),
    );
    await assert.rejects(
      service.requireRequest(
        envelope,
        context(row),
        requestClient(row, id(99)),
      ),
    );
    await assert.rejects(
      service.requireBinding(
        envelope,
        context(row),
        accepted(row),
        requestClient(row, id(99)),
      ),
    );
    await service.requireRequest(envelope, context(row), requestClient(row));
    await service.requireBinding(
      envelope,
      context(row),
      accepted(row),
      requestClient(row),
    );
  }
});
test('V7/V8 request consumption rechecks row identity, purpose, digest, source and request ID', async () => {
  for (const envelope of allEnvelopes()) {
    const row = request(envelope);
    for (const mutate of [
      (value: TextReviewRequest) => {
        value.account_id = id(99);
      },
      (value: TextReviewRequest) => {
        value.client_request_id = id(99);
      },
      (value: TextReviewRequest) => {
        value.operation =
          value.operation === 'publish_post'
            ? 'publish_comment'
            : 'publish_post';
      },
      (value: TextReviewRequest) => {
        value.intent_hash = 'c'.repeat(64);
      },
      (value: TextReviewRequest) => {
        value.digest = 'c'.repeat(64);
      },
      (value: TextReviewRequest) => {
        value.envelope.text += 'changed';
      },
    ]) {
      const changed = structuredClone(row);
      mutate(changed);
      await assert.rejects(
        runtime().requireRequest(
          envelope,
          context(row),
          requestClient(changed),
        ),
      );
      await assert.rejects(
        runtime().requireBinding(
          envelope,
          context(row),
          accepted(row),
          requestClient(changed),
        ),
      );
    }
    for (const changed of [
      { ...accepted(row), digest: 'c'.repeat(64) },
      { ...accepted(row), version: 1 as const },
      {
        ...accepted(row),
        envelope: post(
          !('textSource' in envelope) || envelope.textSource === null,
        ),
      },
    ])
      await assert.rejects(
        runtime().requireBinding(
          envelope,
          context(row),
          changed,
          requestClient(row),
        ),
      );
  }
});
test('V7 retains original request hash and every composed lane rejects operation substitution before SQL', async () => {
  for (const envelope of allEnvelopes()) {
    const row = request(envelope);
    const operation =
      envelope.purpose === 'publish_post' ? 'publish_comment' : 'publish_post';
    const changed = { ...context(row), operation } as ReturnType<
      typeof context
    >;
    await assert.rejects(runtime().submit(envelope, changed, noQuery()));
    await assert.rejects(
      runtime().requireRequest(envelope, changed, noQuery()),
    );
    await assert.rejects(
      runtime().requireBinding(envelope, changed, accepted(row), noQuery()),
    );
    if (envelope.version === 7) {
      const wrongHash = { ...context(row), intentHash: 'c'.repeat(64) };
      await assert.rejects(runtime().submit(envelope, wrongHash, noQuery()));
      await assert.rejects(
        runtime().requireRequest(envelope, wrongHash, noQuery()),
      );
    }
  }
});
test('composed pending status requires exact canonical request row and current Home admission', async () => {
  for (const envelope of allEnvelopes()) {
    const row = { ...request(envelope), decision_id: null };
    assert.equal(
      (await runtime().status(row, requestClient(row))).status,
      'pending',
    );
    assert.equal(
      (
        await runtime(false, {
          requireEnvelope: async () => {
            throw new Error('Stale parent');
          },
        }).status(row, requestClient(row))
      ).status,
      'unavailable',
    );
    for (const changed of [
      { ...row, account_id: id(99) },
      { ...row, digest: 'c'.repeat(64) },
      { ...row, operation: 'publish_reply' as const },
    ]) {
      if (
        changed.operation === row.operation &&
        changed.digest === row.digest &&
        changed.account_id === row.account_id
      )
        continue;
      assert.equal(
        (await runtime().status(changed, noQuery())).status,
        'unavailable',
      );
    }
  }
});
test('composed source policy and original request expiry remain final-transaction deadlines', async () => {
  for (const source of [false, true]) {
    const envelope = post(source),
      row = request(envelope);
    const tx = client((sql) => {
      if (sql.includes('content_approval_policies'))
        return [{ valid_until: new Date('2029-01-01') }];
      if (sql.includes('SELECT * FROM whaleu_community.text_review_requests'))
        return [row];
      if (sql.includes('content_approval_decisions'))
        return [{ id: row.decision_id }];
      if (sql.includes('expires_at>clock_timestamp()'))
        return [{ exists: true }];
      if (sql.includes('SELECT clock_timestamp() AS now'))
        return [{ now: new Date(source ? '2029-02-01' : '2031-01-01') }];
      return [];
    });
    startTransactionDeadlines(tx);
    try {
      await runtime().requireBinding(envelope, context(row), accepted(row), tx);
      await assert.rejects(checkTransactionDeadlines(tx));
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
test('composed source remains source-owned for explicit plain text and anonymous author mode', async () => {
  for (const envelope of [post(), child(), child(true, 'publish_reply')]) {
    const input = structuredClone(envelope);
    input.authorMode = 'anonymous';
    input.textSource = reviewedTextSource(
      input.text,
      { version: 1, format: 'plain', readingFormatting: 'off' },
      input.purpose === 'publish_post'
        ? 'post'
        : input.purpose === 'publish_comment'
          ? 'comment'
          : 'reply',
    );
    if (input.version === 7) {
      input.home.requestedIntent.authorMode = 'anonymous';
      input.home.requestedIntent.textSource = {
        version: 1,
        format: 'plain',
        readingFormatting: 'off',
      };
      input.home.requestedIntentHash = homeOriginalIntentHash(
        input.home.requestedIntent,
      );
    }
    const parsed = canonicalEnvelope(input);
    assert.equal(approvalPolicyKey(parsed), 'local-text-source-v1');
    await runtime(true).requireEnvelope(parsed, client());
  }
});
test('source-only operator listings and expiration narrow composed candidates to explicit source objects', async () => {
  for (const command of [
    { command: 'list' as const },
    { command: 'expire' as const, limit: 1 },
  ]) {
    await new TextReviewOperator(
      runtime(true),
      environment.COMMUNITY_TEXT_REVIEW_OPERATOR,
    ).run(
      command,
      client((sql) => {
        if (sql.includes('current_user')) return [{ actor: 'reviewer' }];
        if (sql.includes('pg_advisory')) return [];
        assert.match(sql, /q\.envelope->>'version' IN \('7','8'\)/);
        assert.match(sql, /jsonb_typeof\(q\.envelope->'textSource'\)='object'/);
        assert.match(sql, /publication_cancel_fences/);
        assert.ok(!sql.includes('SELECT q.envelope'));
        return [];
      }),
    );
  }
});
function operatorClient(
  row: TextReviewRequest,
  inserts: unknown[][],
): PoolClient {
  return client((sql, params) => {
    if (sql.includes('current_user')) return [{ actor: 'reviewer' }];
    if (sql.includes('whaleu_identity.accounts'))
      return [{ id: row.account_id }];
    if (sql.includes('pg_advisory')) return [];
    if (sql.includes('SELECT * FROM whaleu_community.text_review_requests'))
      return [row];
    if (sql.includes('content_approval_policies'))
      return [{ valid_until: null }];
    if (sql.includes('expires_at>clock_timestamp()')) return [{ exists: true }];
    if (sql.includes('publication_cancel_fences')) return [];
    if (sql.includes('SELECT payload_hash,operation,receipt'))
      return [
        {
          payload_hash: row.intent_hash,
          operation: row.operation,
          receipt: null,
        },
      ];
    if (
      sql.includes('INSERT INTO whaleu_community.content_approval_decisions')
    ) {
      inserts.push(params);
      return [];
    }
    if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE')) return [];
    throw new Error(`Unexpected operator SQL: ${sql}`);
  });
}
test('source-only human operator issues V7/V8 under source policy, never null-source authority', async () => {
  for (const envelope of allEnvelopes()) {
    const row = { ...request(envelope), decision_id: null };
    const inserts: unknown[][] = [];
    const operator = new TextReviewOperator(
      runtime(true),
      environment.COMMUNITY_TEXT_REVIEW_OPERATOR,
    );
    const command = {
      command: 'decide' as const,
      accountId: row.account_id,
      requestId: row.client_request_id,
      digest: row.digest,
      decision: 'allow' as const,
      basis: 'Explicit review of exact source and Home evidence',
    };
    if (envelope.textSource === null) {
      await assert.rejects(
        operator.run(command, operatorClient(row, inserts)),
        /exact source envelope/,
      );
      assert.equal(inserts.length, 0);
    } else {
      await operator.run(command, operatorClient(row, inserts));
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0]![3], envelope.version);
      assert.equal(inserts[0]![6], id(5));
    }
  }
});
test('composed human operator rejects mismatched envelope owner or original hash before issuance', async () => {
  for (const changed of [
    { ...request(post()), account_id: id(99), decision_id: null },
    { ...request(post()), intent_hash: 'c'.repeat(64), decision_id: null },
  ]) {
    const inserts: unknown[][] = [];
    await assert.rejects(
      new TextReviewOperator(
        runtime(true),
        environment.COMMUNITY_TEXT_REVIEW_OPERATOR,
      ).run(
        {
          command: 'show',
          accountId: changed.account_id,
          requestId: changed.client_request_id,
        },
        operatorClient(changed, inserts),
      ),
      /snapshot invalid/,
    );
    assert.equal(inserts.length, 0);
  }
});
