import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalEqual,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  ContentKind,
  EffectiveContentEnvelope,
} from '../src/community/content-review/contracts.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ApprovalBinding } from '../src/community/content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import { LocalContentPublicationGate } from '../src/community/content-review/local-content-publication-gate.js';
import type {
  ContentPublicationGate,
  VisibilitySubject,
} from '../src/community/community-policy.js';
const accountId = randomUUID(),
  spaceId = randomUUID(),
  regionId = randomUUID();
const raw = (): EffectiveContentEnvelope => ({
  version: 1,
  accountId,
  purpose: 'publish_post',
  spaceId,
  category: 'discussion',
  authorMode: 'named',
  commentsPolicy: 'open',
  postId: null,
  rootCommentId: null,
  targetReplyId: null,
  text: 'Reviewed exact text',
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
const copy = (value: EffectiveContentEnvelope) => structuredClone(value);
const accepted = (envelope: EffectiveContentEnvelope): AcceptedApproval => ({
  decisionId: randomUUID(),
  version: 1,
  digest: approvalDigest(envelope),
  envelope: canonicalEnvelope(envelope),
});

test('exact approval V1 binds actor, effective scope, ancestry, ordered assets and every component definition', () => {
  const envelope = canonicalEnvelope(raw()),
    digest = approvalDigest(envelope);
  const mutations: ((value: EffectiveContentEnvelope) => void)[] = [
    (value) => {
      value.accountId = randomUUID();
    },
    (value) => {
      value.spaceId = randomUUID();
      value.scope.originalSpaceId = value.spaceId;
    },
    (value) => {
      value.category = 'confession';
    },
    (value) => {
      value.authorMode = 'anonymous';
    },
    (value) => {
      value.commentsPolicy = 'restricted';
    },
    (value) => {
      value.text += '!';
    },
    (value) => {
      value.scope.originalRegionId = randomUUID();
    },
    (value) => {
      value.scope.authorOriginRegionId = randomUUID();
    },
    (value) => {
      value.scope.identityRegionId = randomUUID();
    },
    (value) => {
      value.scope.topologySnapshotId = randomUUID();
    },
    ...(
      [
        'configurationRevisionId',
        'identityCampusId',
        'identitySelectionId',
        'affiliationSnapshotId',
        'affiliationAssertionId',
      ] as const
    ).map((key) => (value: EffectiveContentEnvelope) => {
      value.scope[key] = randomUUID();
    }),
  ];
  for (const mutate of mutations) {
    const changed = copy(envelope);
    mutate(changed);
    assert.notEqual(approvalDigest(changed), digest);
  }
  const images = copy(envelope);
  images.images = [
    { assetId: randomUUID(), digest: 'a'.repeat(64) },
    { assetId: randomUUID(), digest: 'b'.repeat(64) },
  ];
  const imageDigest = approvalDigest(images);
  images.images.reverse();
  assert.notEqual(approvalDigest(images), imageDigest);
  const comment = {
    ...copy(envelope),
    purpose: 'publish_comment' as const,
    postId: randomUUID(),
  };
  assert.notEqual(approvalDigest(comment), digest);
  const otherParent = copy(comment);
  otherParent.postId = randomUUID();
  assert.notEqual(approvalDigest(otherParent), approvalDigest(comment));
  const reply = {
    ...copy(comment),
    purpose: 'publish_reply' as const,
    rootCommentId: randomUUID(),
    targetReplyId: randomUUID(),
  };
  for (const key of ['postId', 'rootCommentId', 'targetReplyId'] as const) {
    const changed = copy(reply);
    changed[key] = randomUUID();
    assert.notEqual(approvalDigest(changed), approvalDigest(reply));
  }
  const poll = copy(envelope);
  poll.component = {
    kind: 'poll',
    question: 'Which?',
    selectionMode: 'single',
    options: ['One', 'Two'],
  };
  const pollDigest = approvalDigest(poll);
  poll.component.options.reverse();
  assert.notEqual(approvalDigest(poll), pollDigest);
  for (const field of ['question', 'selectionMode'] as const) {
    const changed = copy(poll);
    if (changed.component.kind !== 'poll') throw new Error('poll');
    if (field === 'question') changed.component.question = 'Why?';
    else changed.component.selectionMode = 'multiple';
    assert.notEqual(approvalDigest(changed), approvalDigest(poll));
  }
  const trading = copy(envelope);
  trading.category = 'trading';
  trading.trading = {
    subtype: 'shuma',
    price: '5',
    urgency: 'urgent',
    location: 'Library',
    contacts: { wechat: 'chat', qq: 'qq', phone: 'phone' },
  };
  for (const key of [
    'price',
    'location',
    'wechat',
    'qq',
    'phone',
    'subtype',
    'urgency',
  ] as const) {
    const changed = copy(trading);
    assert.ok(changed.trading);
    if (['wechat', 'qq', 'phone'].includes(key))
      changed.trading.contacts[key as 'wechat' | 'qq' | 'phone'] += 'changed';
    else if (key === 'price') changed.trading.price = '6';
    else if (key === 'location') changed.trading.location += 'changed';
    else if (key === 'subtype') changed.trading.subtype = 'yifu';
    else changed.trading.urgency = 'normal';
    assert.notEqual(approvalDigest(changed), approvalDigest(trading));
  }
  const formation = copy(envelope);
  formation.component = {
    kind: 'formation',
    theme: 'Study',
    capacity: 4,
    contacts: { wechat: 'chat', qq: 'qq', phone: '123' },
    contactSharing: 'members_v1',
  };
  for (const key of ['theme', 'capacity', 'wechat', 'qq', 'phone'] as const) {
    const changed = copy(formation);
    assert.equal(changed.component.kind, 'formation');
    if (changed.component.kind !== 'formation') throw new Error('formation');
    if (key === 'theme') changed.component.theme = 'Sports';
    else if (key === 'capacity') changed.component.capacity = 5;
    else changed.component.contacts[key] += 'changed';
    assert.notEqual(approvalDigest(changed), approvalDigest(formation));
  }
});

test('canonical envelopes are strict, normalized, detached and recursively immutable', () => {
  const value = raw();
  value.text = 'A\r\nB';
  const normalized = canonicalEnvelope(value);
  assert.equal(normalized.text, 'A\nB');
  value.text = 'Changed';
  assert.equal(normalized.text, 'A\nB');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.scope));
  assert.equal(normalized.scope.configurationRevisionId, null);
  assert.equal(canonicalJson({ b: [2, 1], a: 'x' }), '{"a":"x","b":[2,1]}');
  assert.throws(() =>
    canonicalEnvelope({ ...raw(), accidentalAuthority: true }),
  );
  assert.throws(() =>
    canonicalEnvelope({ ...raw(), scope: { ...raw().scope, sync: 'related' } }),
  );
  assert.throws(() =>
    canonicalEnvelope({ ...raw(), purpose: 'publish_reply' }),
  );
});

function approvalFixture(overrides: Record<string, unknown> = {}) {
  const envelope = canonicalEnvelope(raw()),
    decision = accepted(envelope),
    now = new Date('2026-10-07T12:00:00Z');
  const before = new Date(now.getTime() - 1000),
    after = new Date(now.getTime() + 1000);
  const row = {
    id: decision.decisionId,
    account_id: accountId,
    operation: envelope.purpose,
    envelope_version: 1,
    digest: decision.digest,
    envelope,
    policy_revision_id: randomUUID(),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'owned',
    provenance_ref: 'reference',
    evaluated_at: before,
    consume_until: after,
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
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
    ...overrides,
  };
  let consumed = false,
    missing = false;
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('clock_timestamp')) return { rows: [{ now }] };
      if (sql.includes('FROM whaleu_identity.accounts'))
        return { rows: [{ id: accountId }] };
      if (
        sql.includes(
          'SELECT id FROM whaleu_community.content_approval_decisions',
        )
      )
        return { rows: missing ? [] : [{ id: decision.decisionId }] };
      if (sql.includes('JOIN whaleu_community.content_approval_policies'))
        return { rows: missing ? [] : [row] };
      if (
        sql.includes(
          'SELECT decision_id FROM whaleu_community.content_approval_bindings',
        )
      )
        return { rows: consumed ? [{ decision_id: decision.decisionId }] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const binding: ApprovalBinding = {
    content_kind: 'post',
    content_id: randomUUID(),
    content_version: 1,
    decision_id: decision.decisionId,
    account_id: accountId,
    operation: envelope.purpose,
    envelope_version: 1,
    digest: decision.digest,
    envelope,
    scope: envelope.scope,
  };
  return {
    repo: new ApprovalRepository(),
    tx,
    row,
    decision,
    binding,
    envelope,
    now,
    setConsumed: () => {
      consumed = true;
    },
    setMissing: () => {
      missing = true;
    },
  };
}
test('consumption expiry does not expire durable visibility; consumed grants cannot publish twice', async () => {
  const fixture = approvalFixture();
  assert.equal(
    (await fixture.repo.accepted(fixture.envelope, fixture.tx)).kind,
    'allow',
  );
  fixture.row.consume_until = new Date(fixture.now.getTime() - 500);
  assert.equal(
    (await fixture.repo.accepted(fixture.envelope, fixture.tx)).kind,
    'unavailable',
  );
  assert.equal(
    (await fixture.repo.current(fixture.binding, fixture.tx)).kind,
    'allow',
  );
  fixture.row.consume_until = new Date(fixture.now.getTime() + 1000);
  fixture.setConsumed();
  assert.equal(
    (await fixture.repo.accepted(fixture.envelope, fixture.tx)).kind,
    'unavailable',
  );
});
test('missing, pending, malformed/provenance, held, revoked and explicit rejection fail closed distinctly', async () => {
  for (const overrides of [
    { result: 'pending' },
    { provenance: 'unreconciled' },
    { coverage: 'missing' },
    { policy_provenance: 'rejected' },
    { digest: 'a'.repeat(64) },
    { state: 'held' },
    {
      visibility_model: 'until',
      visibility_until: new Date('2026-10-07T11:59:59Z'),
    },
  ]) {
    const fixture = approvalFixture(overrides);
    assert.equal(
      (await fixture.repo.accepted(fixture.envelope, fixture.tx)).kind,
      'unavailable',
    );
  }
  for (const overrides of [{ result: 'reject' }, { state: 'revoked' }]) {
    const fixture = approvalFixture(overrides);
    assert.deepEqual(
      await fixture.repo.accepted(fixture.envelope, fixture.tx),
      { kind: 'deny', reason: 'CONTENT_REJECTED' },
    );
  }
  const fixture = approvalFixture();
  fixture.setMissing();
  assert.equal(
    (await fixture.repo.accepted(fixture.envelope, fixture.tx)).kind,
    'unavailable',
  );
});
test('bindings validate exact actor, operation, typed kind, scope and current envelope', async () => {
  for (const field of [
    'account_id',
    'operation',
    'content_kind',
    'digest',
    'scope',
    'envelope',
  ] as const) {
    const fixture = approvalFixture();
    const binding = { ...fixture.binding };
    if (field === 'account_id') binding.account_id = randomUUID();
    if (field === 'operation') binding.operation = 'publish_comment';
    if (field === 'content_kind') binding.content_kind = 'reply';
    if (field === 'digest') binding.digest = 'c'.repeat(64);
    if (field === 'scope')
      binding.scope = { ...binding.scope, identityRegionId: randomUUID() };
    if (field === 'envelope')
      binding.envelope = { ...binding.envelope, text: 'Changed' };
    assert.equal(
      (await fixture.repo.current(binding, fixture.tx)).kind,
      'unavailable',
    );
  }
});

test('live gate rejects legacy bare inputs and exact mismatch before ledger lookup', async () => {
  let called = 0;
  const gate = new LocalContentPublicationGate(
    {
      accepted: async () => {
        called++;
        return { kind: 'unavailable' };
      },
    } as unknown as ApprovalRepository,
    {} as ContentDefinitionRepository,
  );
  const input = {
    accountId,
    purpose: 'publish_post' as const,
    text: 'text',
    images: [],
  };
  assert.equal((await gate.check(input, {} as PoolClient)).kind, 'unavailable');
  assert.equal(
    (await gate.check({ ...input, envelope: raw() }, {} as PoolClient)).kind,
    'unavailable',
  );
  assert.equal(called, 0);
});
test('base visibility requires explicit kind/version, exact author/payload, parents and text-only assets', async () => {
  const envelope = canonicalEnvelope(raw()),
    decision = accepted(envelope),
    id = randomUUID();
  let altered = envelope,
    missingParent = false;
  const approvals = {
    binding: async (kind: ContentKind, target: string) =>
      target === id && kind === 'post'
        ? {
            ...approvalFixture().binding,
            account_id: accountId,
            envelope,
            scope: envelope.scope,
          }
        : null,
    current: async () => ({ kind: 'allow', value: decision }),
  } as unknown as ApprovalRepository;
  const definitions = {
    current: async () => ({
      kind: 'allow',
      value: {
        envelope: altered,
        authorAccountId: accountId,
        authorMode: 'named',
        parents: missingParent ? [{ kind: 'post', id: randomUUID() }] : [],
      },
    }),
  } as unknown as ContentDefinitionRepository;
  const base = new LocalApprovedContentVisibility(approvals, definitions),
    tx = {} as PoolClient;
  const subject: VisibilitySubject = {
    contentId: id,
    contentKind: 'post',
    contentVersion: 1,
    authorMode: 'named',
    namedAccountId: accountId,
  };
  assert.equal(
    (await base.check(null, subject, tx, 'direct_post')).kind,
    'allow',
  );
  assert.equal(
    (
      await base.check(
        null,
        {
          ...subject,
          contentVersion: undefined,
        } as unknown as VisibilitySubject,
        tx,
        'direct_post',
      )
    ).kind,
    'unavailable',
  );
  assert.equal(
    (
      await base.check(
        null,
        { ...subject, contentKind: 'reply' },
        tx,
        'direct_post',
      )
    ).kind,
    'unavailable',
  );
  assert.equal(
    (
      await base.check(
        null,
        { ...subject, namedAccountId: randomUUID() },
        tx,
        'direct_post',
      )
    ).kind,
    'unavailable',
  );
  altered = { ...envelope, text: 'Mutated' };
  assert.equal(
    (await base.check(null, subject, tx, 'direct_post')).kind,
    'unavailable',
  );
  altered = envelope;
  missingParent = true;
  assert.equal(
    (await base.check(null, subject, tx, 'direct_post')).kind,
    'unavailable',
  );
  missingParent = false;
  const mediaEnvelope = canonicalEnvelope({
    ...envelope,
    images: [{ assetId: randomUUID(), digest: 'a'.repeat(64) }],
  });
  altered = mediaEnvelope;
  Object.assign(decision, {
    envelope: mediaEnvelope,
    digest: approvalDigest(mediaEnvelope),
  });
  assert.equal(
    (await base.check(null, subject, tx, 'direct_post')).kind,
    'unavailable',
  );
});

test('binding uniqueness is a transient review failure', async () => {
  const envelope = canonicalEnvelope(raw()),
    decision = accepted(envelope);
  const gate = new LocalContentPublicationGate(
    {
      bind: async () => {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      },
    } as unknown as ApprovalRepository,
    {
      current: async () => ({ kind: 'allow', value: { envelope } }),
    } as unknown as ContentDefinitionRepository,
  );
  await assert.rejects(
    () => gate.bind(decision, 'post', randomUUID(), {} as PoolClient),
    (error: unknown) =>
      (error as { code?: string }).code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
  const legacy: Parameters<ContentPublicationGate['check']>[0] = {
    accountId,
    purpose: 'publish_post',
    text: 'legacy',
    images: [],
  };
  assert.equal(legacy.envelope, undefined);
});

test('canonical weak caches recognize only internally validated roots and never cache mutable inputs', () => {
  const input = raw(),
    parsed = canonicalEnvelope(input);
  assert.equal(canonicalEnvelope(parsed), parsed);
  const before = approvalDigest(input);
  input.text += ' changed';
  assert.notEqual(approvalDigest(input), before);
  assert.notEqual(canonicalJson(input), canonicalJson(parsed));
  assert.equal(approvalDigest(parsed), before);
  assert.equal(approvalDigest(parsed), before);
  const external = Object.freeze(structuredClone(parsed));
  const checked = canonicalEnvelope(external);
  assert.notEqual(checked, external);
  assert.ok(Object.isFrozen(checked.scope));
  external.scope.authorOriginRegionId = randomUUID();
  assert.notEqual(approvalDigest(external), approvalDigest(checked));
  assert.throws(() =>
    canonicalEnvelope(Object.freeze({ ...parsed, unexpected: true })),
  );
  assert.throws(() =>
    canonicalEnvelope(Object.freeze({ ...parsed, version: 2 })),
  );
});

test('canonical structural equality matches serialization for supported values without dropping keys or array order', () => {
  const pairs: [unknown, unknown][] = [
    [
      { a: 1, b: [true, null, { x: '雪', y: -0 }] },
      { b: [true, null, { y: 0, x: '雪' }], a: 1 },
    ],
    [{ a: 1 }, { a: 1, b: null }],
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: [1] }, { a: [1, 2] }],
    ['same', 'same'],
    ['same', 'different'],
    [false, false],
    [null, null],
    [{ a: null }, { a: {} }],
    [{ a: { b: 2 } }, { a: { b: 3 } }],
    [1, 1.0],
    [1, 2],
    [canonicalEnvelope(raw()), canonicalEnvelope(raw())],
  ];
  for (const [left, right] of pairs)
    assert.equal(
      canonicalEqual(left, right),
      canonicalJson(left) === canonicalJson(right),
    );
  assert.equal(canonicalEqual({ a: undefined }, { a: undefined }), false);
  assert.equal(canonicalEqual(NaN, NaN), false);
  assert.equal(canonicalEqual(Infinity, Infinity), false);
  assert.equal(canonicalEqual(new Array(1), [null]), false);
});

test('cached canonical text retains the original V1 digest bytes', () => {
  const id = '00000000-0000-4000-8000-000000000001',
    space = '00000000-0000-4000-8000-000000000002',
    region = '00000000-0000-4000-8000-000000000003';
  const input = {
    ...raw(),
    accountId: id,
    spaceId: space,
    text: 'Reviewed canonical example text',
    scope: {
      originalSpaceId: space,
      originalRegionId: region,
      authorOriginRegionId: region,
      identityRegionId: region,
      topologySnapshotId: null,
      sync: 'none' as const,
    },
  };
  const expected =
    'ec0d15f6900d34d327cb5c9b4d534f7d0ba00d9fa5eb4184dbb24de1189dce7f';
  const parsed = canonicalEnvelope(input);
  assert.equal(approvalDigest(input), expected);
  assert.equal(approvalDigest(parsed), expected);
  assert.equal(approvalDigest(canonicalEnvelope(parsed)), expected);
});
