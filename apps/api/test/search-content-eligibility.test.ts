import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  evaluateSearchContentCertificate,
  requireSearchContentEligibilityRelation,
} from '../src/community/content-review/search-eligibility.facade.js';
import type {
  SearchContentCertificate,
  SearchContentNode,
} from '../src/community/content-review/search-eligibility.facade.js';
import type { SearchCandidate } from '../src/community/search/repository.js';
const id = randomUUID(),
  spaceId = randomUUID(),
  account = randomUUID(),
  generation = randomUUID(),
  approval = randomUUID(),
  policy = randomUUID(),
  head = randomUUID();
const digest = 'a'.repeat(64),
  profile = 'b'.repeat(64),
  now = Date.now();
const candidate: SearchCandidate = {
  kind: 'post',
  id,
  postId: id,
  rootCommentId: null,
  spaceId,
  at: '2026-01-01T00:00:00.000000Z',
};
const node: SearchContentNode = {
  exact_time_valid: true,
  kind: 'post',
  id,
  post_id: id,
  root_comment_id: null,
  account_id: account,
  author_mode: 'named',
  visibility: 'approved',
  deleted_at: null,
  publication_state: 'published',
  generation,
  digest,
  decision_id: approval,
  event_id: head,
  policy_revision_id: policy,
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
};
const certificate: SearchContentCertificate = {
  index_space_key: profile,
  kind: 'post',
  content_id: id,
  post_id: id,
  root_comment_id: null,
  source_revision: [['post', id, generation, digest, approval, policy, head]],
  body_digest: 'c'.repeat(64),
  has_searchable_text: true,
  space_id: spaceId,
  region_id: null,
  certificate_version: 1,
  valid_until: null,
};
const scope = {
  active: true,
  kind: 'regional',
  regionId: null,
  regionActive: true,
};
const evaluate = (
  change: Partial<SearchContentNode> = {},
  cert: SearchContentCertificate | null = certificate,
) =>
  evaluateSearchContentCertificate(
    candidate,
    cert,
    new Map([[`post:${id}`, { ...node, ...change }]]),
    scope,
    profile,
    now,
  );

test('closed exact evidence allows; expired consumption does not revoke ongoing visibility', () => {
  assert.equal(evaluate().decision, 'allow');
});
test('missing certificate or generation and malformed review remain unknown', () => {
  assert.equal(evaluate({}, null).decision, 'unknown');
  assert.equal(evaluate({ generation: null }).decision, 'unknown');
  assert.equal(evaluate({ event_coverage: 'unknown' }).decision, 'unknown');
  assert.equal(evaluate({ policy_key: 'unsupported' }).decision, 'unknown');
});
test('lifecycle and review ABA cannot resurrect old certificates', () => {
  assert.equal(evaluate({ generation: randomUUID() }).decision, 'unknown');
  assert.equal(evaluate({ event_id: randomUUID() }).decision, 'unknown');
  assert.equal(
    evaluate({ state: 'revoked', event_id: randomUUID() }).decision,
    'deny',
  );
  assert.equal(
    evaluate({ state: 'held', event_id: randomUUID() }).decision,
    'deny',
  );
});
test('authoritative hidden/deleted and inactive scope short circuit missing certificates', () => {
  assert.equal(evaluate({ visibility: 'hidden' }, null).decision, 'deny');
  assert.equal(evaluate({ deleted_at: new Date(now) }, null).decision, 'deny');
  assert.equal(
    evaluateSearchContentCertificate(
      candidate,
      null,
      new Map([[`post:${id}`, node]]),
      { ...scope, active: false },
      profile,
      now,
    ).decision,
    'deny',
  );
});
test('scope/profile mismatch and altered minimum deadline fail closed', () => {
  assert.equal(
    evaluate({}, { ...certificate, space_id: randomUUID() }).decision,
    'unknown',
  );
  assert.equal(
    evaluate({}, { ...certificate, index_space_key: 'd'.repeat(64) }).decision,
    'unknown',
  );
  assert.equal(
    evaluate({ policy_valid_until: new Date(now + 5000) }).decision,
    'unknown',
  );
  const cert = { ...certificate, valid_until: new Date(now + 5000) };
  assert.deepEqual(evaluate({ policy_valid_until: cert.valid_until }, cert), {
    decision: 'allow',
    validUntil: now + 5000,
  });
  assert.equal(
    evaluate(
      { policy_valid_until: new Date(now) },
      { ...cert, valid_until: new Date(now) },
    ).decision,
    'unknown',
  );
});
test('ancestor lifecycle and review evidence bind reply certificates', () => {
  const root = randomUUID(),
    reply = randomUUID(),
    rootGeneration = randomUUID(),
    replyGeneration = randomUUID();
  const replyCandidate: SearchCandidate = {
    ...candidate,
    kind: 'reply',
    id: reply,
    rootCommentId: root,
  };
  const rootNode: SearchContentNode = {
    ...node,
    kind: 'comment',
    id: root,
    root_comment_id: root,
    publication_state: null,
    generation: rootGeneration,
  };
  const replyNode: SearchContentNode = {
    ...rootNode,
    kind: 'reply',
    id: reply,
    generation: replyGeneration,
  };
  const cert: SearchContentCertificate = {
    ...certificate,
    kind: 'reply',
    content_id: reply,
    root_comment_id: root,
    source_revision: [
      ...certificate.source_revision,
      ['comment', root, rootGeneration, digest, approval, policy, head],
      ['reply', reply, replyGeneration, digest, approval, policy, head],
    ],
  };
  const nodes = new Map([
    [`post:${id}`, node],
    [`comment:${root}`, rootNode],
    [`reply:${reply}`, replyNode],
  ]);
  const check = () =>
    evaluateSearchContentCertificate(
      replyCandidate,
      cert,
      nodes,
      scope,
      profile,
      now,
    ).decision;
  assert.equal(check(), 'allow');
  nodes.set(`comment:${root}`, { ...rootNode, generation: randomUUID() });
  assert.equal(check(), 'unknown');
  nodes.set(`comment:${root}`, { ...rootNode, visibility: 'hidden' });
  assert.equal(check(), 'deny');
});
test('an arbitrary ID list or forged SQL handle is not owner authority', () => {
  assert.throws(() =>
    requireSearchContentEligibilityRelation(
      {
        tableName: 'x',
        nodesTableName: 'y',
        validUntil: null,
        assertCurrent() {},
      },
      {} as PoolClient,
    ),
  );
});

test('exact PostgreSQL chronology failure cannot become allow or deny after JS date truncation', () => {
  assert.equal(evaluate({ exact_time_valid: false }).decision, 'unknown');
  assert.equal(
    evaluate({ exact_time_valid: false, state: 'revoked' }).decision,
    'unknown',
  );
});
