import { SearchReadContext } from '../src/community/content-review/search-read-context.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  certificateV2Schema,
  evaluateSearchContentCertificate,
  ContentReviewSearchEligibilityFacade,
} from '../src/community/content-review/search-eligibility.facade.js';
import type {
  SearchContentNode,
  SearchContentCertificate,
} from '../src/community/content-review/search-eligibility.facade.js';
import type { SearchCandidate } from '../src/community/search/repository.js';
import type { MediaContentFact } from '../src/media/content-snapshot.facade.js';
import { semanticFingerprint } from '../src/community/search/semantic/contracts.js';
import {
  semanticMediaChainSchema,
  semanticMediaNode,
} from '../src/community/search/semantic/media-certificate.js';
import {
  captureSemanticMediaProof,
  requireSemanticMediaProof,
} from '../src/community/search/semantic/eligibility-proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import type { CampusContentScopeFacade } from '../src/campus/content-scope.facade.js';

const now = Date.now(),
  until = now + 60_000;
const digest = 'a'.repeat(64),
  profile = 'b'.repeat(64);
function fixture() {
  const id = randomUUID(),
    assetId = randomUUID();
  const candidate: SearchCandidate = {
    kind: 'post',
    id,
    postId: id,
    rootCommentId: null,
    spaceId: randomUUID(),
    at: '2026-01-01T00:00:00.000000Z',
  };
  const node: SearchContentNode = {
    kind: 'post',
    id,
    post_id: id,
    root_comment_id: null,
    account_id: randomUUID(),
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    publication_state: 'published',
    generation: randomUUID(),
    digest,
    decision_id: randomUUID(),
    event_id: randomUUID(),
    policy_revision_id: randomUUID(),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'fixture',
    provenance_ref: 'fixture',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now - 500),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'fixture',
    policy_provenance_ref: 'fixture',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'fixture',
    event_provenance_ref: 'fixture',
    exact_time_valid: true,
    images: [{ assetId, digest, position: 0 }],
    expected_images: [{ assetId, digest }],
  };
  const media: MediaContentFact = {
    version: 1,
    parent: {
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: id,
      contentVersion: 1,
    },
    decision: 'allow',
    validUntil: until,
    attachments: [
      {
        ordinal: 0,
        slot: 'images',
        bindingId: randomUUID(),
        assetId,
        manifestDigest: digest,
        policyRevision: 'media-static-v1',
        intentId: randomUUID(),
        intentState: 'ready',
        headRevision: '1',
        eventId: randomUUID(),
      },
    ],
  };
  node.media_fact = media;
  const certificate = certificateV2Schema.parse({
    index_space_key: profile,
    kind: 'post',
    content_id: id,
    post_id: id,
    root_comment_id: null,
    source_revision: [
      [
        'post',
        id,
        node.generation,
        digest,
        node.decision_id,
        node.policy_revision_id,
        node.event_id,
      ],
    ],
    body_digest: 'c'.repeat(64),
    has_searchable_text: true,
    space_id: candidate.spaceId,
    region_id: null,
    certificate_version: 2,
    valid_until: new Date(until),
    media_chain: [semanticMediaNode('post', id, media)],
  });
  return { candidate, node, media, certificate };
}
const scope = {
  active: true,
  kind: 'regional',
  regionId: null,
  regionActive: true,
};
function evaluate(
  f: ReturnType<typeof fixture>,
  certificate: SearchContentCertificate | null = f.certificate,
) {
  return evaluateSearchContentCertificate(
    f.candidate,
    certificate,
    new Map([[`post:${f.node.id}`, f.node]]),
    scope,
    profile,
    now,
  );
}
test('v2 allows complete image evidence without changing the v1 seven-tuple vector revision', () => {
  const f = fixture();
  assert.equal(evaluate(f).decision, 'allow');
  assert.equal(f.certificate.source_revision[0]!.length, 7);
  assert.ok(evaluate(f).eligibilityRevision);
  assert.equal(
    semanticFingerprint(f.certificate.source_revision),
    semanticFingerprint([...f.certificate.source_revision]),
  );
});
test('allow -> deny -> allow ABA never revives a v2 certificate and negative dependencies change', () => {
  const f = fixture();
  f.node.media_fact = {
    ...f.media,
    decision: 'deny',
    attachments: [
      { ...f.media.attachments[0]!, headRevision: '2', eventId: randomUUID() },
    ],
  };
  const denied = evaluate(f);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.validUntil, until);
  f.node.media_fact = {
    ...f.node.media_fact,
    attachments: [
      {
        ...f.node.media_fact.attachments[0]!,
        headRevision: '3',
        eventId: randomUUID(),
      },
    ],
  };
  assert.equal(evaluate(f).decision, 'deny');
  assert.notEqual(
    semanticFingerprint(denied.eligibilityRevision),
    semanticFingerprint(evaluate(f).eligibilityRevision),
  );
  f.node.media_fact = { ...f.node.media_fact, decision: 'allow' };
  assert.equal(evaluate(f).decision, 'unknown');
});
test('unknown, expired, malformed or mismatched Media cannot be filtered as known deny', () => {
  const f = fixture();
  f.node.media_fact = { ...f.media, decision: 'unknown' };
  assert.equal(evaluate(f).decision, 'unknown');
  f.node.media_fact = { ...f.media, decision: 'deny', validUntil: now };
  assert.equal(evaluate(f).decision, 'unknown');
  f.node.media_fact = {
    ...f.media,
    attachments: [{ ...f.media.attachments[0]!, bindingId: randomUUID() }],
  };
  assert.equal(evaluate(f).decision, 'unknown');
  f.node.media_fact = {
    ...f.media,
    decision: 'deny',
    attachments: [{ ...f.media.attachments[0]!, bindingId: randomUUID() }],
  };
  assert.equal(evaluate(f).decision, 'unknown');
  f.node.media_fact = f.media;
  f.node.images = [];
  assert.equal(evaluate(f).decision, 'unknown');
  assert.equal(evaluate(f, null).decision, 'unknown');
});
test('v2 chain requires every ancestor including an explicit empty child and rejects schema inflation', () => {
  const f = fixture(),
    child = randomUUID();
  const node = {
    kind: 'comment' as const,
    id: child,
    decision: 'allow' as const,
    validUntil: null,
    attachments: [],
  };
  assert.equal(
    semanticMediaChainSchema.safeParse([...f.certificate.media_chain, node])
      .success,
    true,
  );
  assert.equal(semanticMediaChainSchema.safeParse([node]).success, false);
  assert.equal(
    certificateV2Schema.safeParse({ ...f.certificate, media_chain: [] })
      .success,
    false,
  );
  assert.equal(
    certificateV2Schema.safeParse({ ...f.certificate, extra: true }).success,
    false,
  );
  assert.equal(
    certificateV2Schema.safeParse({
      ...f.certificate,
      source_revision: [[...f.certificate.source_revision[0]!, 'media']],
    }).success,
    false,
  );
  const deny = {
    kind: 'comment',
    id: child,
    decision: 'review-denied',
    validUntil: null,
    attachments: null,
  };
  assert.equal(
    semanticMediaChainSchema.safeParse([...f.certificate.media_chain, deny])
      .success,
    true,
  );
  assert.equal(
    semanticMediaChainSchema.safeParse([
      ...f.certificate.media_chain,
      { ...deny, attachments: [] },
    ]).success,
    false,
  );
});
test('certificate reconstruction is never a capture/persist authorization', async () => {
  const f = fixture(),
    tx = {} as PoolClient;
  const facade = new ContentReviewSearchEligibilityFacade(
    {} as LocalApprovedContentVisibility,
    {} as CampusContentScopeFacade,
  );
  startTransactionDeadlines(tx);
  try {
    await assert.rejects(facade.persist(f.certificate, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
function proofFixture() {
  let epoch = '0',
    missing = false;
  const log: string[] = [];
  const tx = {
    async query(sql: string) {
      log.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT slot,version,epoch::text FROM whaleu_media')) {
        if (missing) throw new Error('missing Media');
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch,
          })),
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(now) }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return {
    tx,
    log,
    change: () => {
      epoch = '1';
    },
    missing: () => {
      missing = true;
    },
  };
}
test('Media scope proof retains pre-enumeration negative/empty dependencies through finalization', async () => {
  const f = proofFixture();
  startTransactionDeadlines(f.tx);
  try {
    await captureSemanticMediaProof(f.tx);
    requireSemanticMediaProof(f.tx);
    f.change();
    await assert.rejects(checkTransactionDeadlines(f.tx));
    assert.ok(f.log.some((sql) => sql.includes('IN SHARE MODE NOWAIT')));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('unavailable Media capture permits text-only work but cannot become image authority; rollback destroys brands', async () => {
  const f = proofFixture();
  startTransactionDeadlines(f.tx);
  try {
    f.missing();
    await captureSemanticMediaProof(f.tx);
    const read = new SearchReadContext(f.tx);
    assert.equal(
      await read.read(
        {},
        'empty-legacy',
        f.tx,
        async () => 'text-only',
        () => true,
      ),
      'text-only',
    );
    read.assertCurrent(f.tx);
    read.close();
    assert.throws(() => requireSemanticMediaProof(f.tx));
    await checkTransactionDeadlines(f.tx);
    assert.ok(f.log.includes('ROLLBACK TO SAVEPOINT semantic_media_start'));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
  const g = proofFixture();
  startTransactionDeadlines(g.tx);
  try {
    await captureSemanticMediaProof(g.tx);
    const checkpoint = checkpointTransactionDeadlines(g.tx);
    restoreTransactionDeadlines(g.tx, checkpoint);
    assert.throws(() => requireSemanticMediaProof(g.tx));
  } finally {
    clearTransactionDeadlines(g.tx);
  }
});

test('semantic v2 nine-image ordered chain preserves all identities and changes on any attachment revision', () => {
  const f = fixture();
  const first = f.media.attachments[0]!;
  const attachments = Array.from({ length: 9 }, (_, ordinal) => ({
    ...first,
    ordinal,
    assetId: randomUUID(),
    bindingId: randomUUID(),
    intentId: randomUUID(),
    eventId: randomUUID(),
  }));
  const media: MediaContentFact = { ...f.media, attachments };
  const node = semanticMediaNode('post', f.node.id, media)!;
  assert.ok(node);
  assert.equal(node.attachments!.length, 9);
  assert.equal(semanticMediaChainSchema.safeParse([node]).success, true);
  const encoded = JSON.stringify(node);
  const changed = semanticMediaNode('post', f.node.id, {
    ...media,
    attachments: attachments.map((attachment, ordinal) =>
      ordinal === 8
        ? { ...attachment, headRevision: '2', eventId: randomUUID() }
        : attachment,
    ),
  });
  assert.notEqual(JSON.stringify(changed), encoded);
  for (const values of [
    [...attachments, { ...attachments[8]!, ordinal: 9 }],
    attachments.map((attachment, ordinal) =>
      ordinal === 8 ? { ...attachment, ordinal: 7 } : attachment,
    ),
    attachments.map((attachment, ordinal) =>
      ordinal === 8
        ? { ...attachment, assetId: attachments[0]!.assetId }
        : attachment,
    ),
    attachments.map((attachment, ordinal) =>
      ordinal === 8
        ? { ...attachment, bindingId: attachments[0]!.bindingId }
        : attachment,
    ),
  ]) {
    assert.equal(
      semanticMediaChainSchema.safeParse([{ ...node, attachments: values }])
        .success,
      false,
    );
  }
});
