import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RatingScopedContentReviewFacade } from '../src/community/content-review/rating-scoped-content-review.facade.js';
import { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { AnyRatingTargetDefinitionDescriptor } from '../src/community/content-review/rating-target-definition-contracts.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../src/community/content-review/rating-contracts.js';
import {
  canonicalAnyRatingTargetDefinition,
  canonicalRatingTargetDefinition,
} from '../src/community/content-review/rating-target-definition-contracts.js';
import {
  canonicalRatingScopedEnvelope,
  canonicalRatingScopedTargetDefinition,
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
} from '../src/community/content-review/rating-scoped-contracts.js';
import type {
  RatingScopedTargetEnvelope,
  RatingScopedContentEnvelope,
  RatingScopedCategoryEnvelope,
} from '../src/community/content-review/rating-scoped-contracts.js';
import {
  ratingScopedContentBindingMatches,
  ratingScopedTargetDefinitionBindingMatches,
  ratingScopedCategorySourceBindingMatches,
  validateRatingScopedApprovalRow,
} from '../src/community/content-review/rating-scoped-approval-validation.js';
import type { RatingApprovalRow } from '../src/community/content-review/rating-approval-validation.js';
const id = (n: number) =>
  `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hex = 'a'.repeat(64);
const scope = () => ({
  selector: { kind: 'campus', campusId: id(20) },
  scopeKey: `campus:${id(20)}`,
  catalogRevision: id(21),
  headRevision: id(22),
  scopeRevision: hex,
  contextId: id(23),
  contextDigest: hex,
  protocolGeneration: id(24),
  sourceDigest: hex,
  topologySnapshotId: id(25),
});
function target(
  patch: Record<string, unknown> = {},
): RatingScopedTargetEnvelope {
  const result = canonicalRatingScopedEnvelope({
    version: 5,
    purpose: 'publish_rating_target_scoped',
    accountId: id(1),
    clientRequestId: id(2),
    targetId: id(3),
    targetRevision: id(4),
    definitionRevision: id(4),
    contentVersion: 1,
    categoryId: id(5),
    categoryRevision: id(6),
    scope: scope(),
    targetOrigin: { regionId: id(30), originCampusId: id(31) },
    assetIds: [],
    name: 'Reviewed target',
    description: '',
    ...patch,
  });
  if (
    result.purpose !== 'publish_rating_target_scoped' &&
    result.purpose !== 'edit_rating_target_scoped'
  )
    assert.fail();
  return result;
}
function content(reply = false): RatingScopedContentEnvelope {
  const t = target();
  const {
    definitionRevision: _,
    contentVersion: __,
    name: ___,
    description: ____,
    ...shared
  } = t;
  void _;
  void __;
  void ___;
  void ____;
  const result = canonicalRatingScopedEnvelope({
    ...shared,
    purpose: reply
      ? 'publish_rating_reply_scoped'
      : 'publish_rating_comment_scoped',
    subjectId: id(40),
    subjectRevision: id(41),
    targetDefinitionRevision: id(4),
    targetContentVersion: 1,
    authorMode: 'named',
    body: 'Exact body',
    ...(reply
      ? {
          rootId: id(42),
          rootRevision: id(43),
          replyTo: { replyId: id(44), revision: id(45) },
        }
      : {}),
  });
  if (
    result.purpose !== 'publish_rating_comment_scoped' &&
    result.purpose !== 'publish_rating_reply_scoped'
  )
    assert.fail();
  return result;
}
function category(override = false): RatingScopedCategoryEnvelope {
  const result = canonicalRatingScopedEnvelope({
    version: 5,
    purpose: override
      ? 'publish_rating_category_override_scoped'
      : 'publish_rating_category_base_scoped',
    accountId: id(1),
    sourceId: id(60),
    sourceRevision: id(61),
    categoryId: id(5),
    identityId: id(62),
    issuanceId: id(60),
    issuanceDigest: hex,
    placement: { kind: 'campuses', campusIds: [id(20)] },
    assetIds: [],
    body: override
      ? { name: 'Local name', description: '' }
      : {
          parentId: null,
          level: 1,
          kind: 'general',
          systemKey: null,
          name: 'Base name',
          description: '',
        },
    ...(override
      ? {
          baseSourceId: id(63),
          baseSourceRevision: id(64),
          scope: { kind: 'campus', campusId: id(20) },
        }
      : {}),
  });
  if (
    result.purpose !== 'publish_rating_category_base_scoped' &&
    result.purpose !== 'publish_rating_category_override_scoped'
  )
    assert.fail();
  return result;
}
function row(
  e: ReturnType<typeof canonicalRatingScopedEnvelope>,
): RatingApprovalRow {
  const now = Date.UTC(2026, 9, 9);
  return {
    id: id(80),
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: 5,
    digest: ratingScopedApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(81),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-only',
    provenance_ref: 'unit-test',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 1000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-only',
    policy_provenance_ref: 'unit-test',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-only',
    event_provenance_ref: 'unit-test',
  };
}
function common(e: ReturnType<typeof canonicalRatingScopedEnvelope>) {
  const r = row(e);
  return {
    decision_id: r.id,
    account_id: r.account_id,
    operation: r.operation,
    envelope_version: 5,
    digest: r.digest,
    envelope: e,
  };
}
test('Review5 six exact purposes preserve independent view and original target origin', () => {
  const initial = target(),
    edit = target({
      purpose: 'edit_rating_target_scoped',
      contentVersion: 2,
      previousTargetRevision: id(4),
      targetRevision: id(7),
      previousDefinitionRevision: id(4),
      definitionRevision: id(8),
    });
  for (const e of [
    initial,
    edit,
    content(),
    content(true),
    category(),
    category(true),
  ]) {
    assert.equal(
      ratingScopedApprovalDigest(e),
      createHash('sha256')
        .update(`whaleu-rating-content-approval:v5\n${canonicalJson(e)}`)
        .digest('hex'),
    );
    assert(Object.isFrozen(e));
    assert.throws(() => canonicalRatingEnvelope(e));
  }
  assert.notEqual(
    initial.targetOrigin.originCampusId,
    initial.scope.selector.kind === 'campus'
      ? initial.scope.selector.campusId
      : null,
  );
  assert.throws(() => target({ scope: { ...scope(), scopeKey: 'global' } }));
  assert.throws(() => target({ scope: { ...scope(), regionId: id(30) } }));
  assert.throws(() =>
    target({ scope: { ...scope(), topologySnapshotId: null } }),
  );
  assert.throws(() => target({ name: '  silently normalized  ' }));
  assert.throws(() => target({ definitionRevision: id(99) }));
  assert.throws(() =>
    canonicalRatingScopedEnvelope({ ...content(true), subjectId: id(44) }),
  );
});
test('scoped target descriptor is exact, legacy parser never accepts it', () => {
  const e = target();
  const d = canonicalRatingScopedTargetDefinition({
    targetId: e.targetId,
    contentVersion: 1,
    definitionRevision: e.definitionRevision,
    appliedTargetRevision: e.targetRevision,
    envelope: e,
  });
  assert.deepEqual(canonicalAnyRatingTargetDefinition(d), d);
  assert.throws(() => canonicalRatingTargetDefinition(d));
  for (const patch of [
    { contentVersion: 2 },
    { definitionRevision: id(90) },
    { appliedTargetRevision: id(90) },
    { targetId: id(90) },
    { extra: true },
  ])
    assert.throws(() =>
      canonicalRatingScopedTargetDefinition({ ...d, ...patch }),
    );
  const b = {
    ...common(e),
    target_id: e.targetId,
    content_version: 1,
    definition_revision: e.definitionRevision,
    applied_target_revision: e.targetRevision,
    scope: e.scope,
  };
  assert(ratingScopedTargetDefinitionBindingMatches(b, d));
  for (const patch of [
    { envelope_version: 1 },
    { operation: 'publish_rating_target' },
    { definition_revision: id(99) },
    { content_version: 2 },
    { scope: { regionId: id(30) } },
  ])
    assert.equal(
      ratingScopedTargetDefinitionBindingMatches({ ...b, ...patch }, d),
      false,
    );
});
test('new content bindings cannot impersonate old bindings or another exact parent', () => {
  for (const reply of [false, true]) {
    const e = content(reply);
    const kind = reply ? ('reply' as const) : ('comment' as const);
    const b = {
      ...common(e),
      kind,
      subject_id: e.subjectId,
      subject_revision: e.subjectRevision,
      content_version: 1,
      scope: e.scope,
    };
    assert(ratingScopedContentBindingMatches(b, kind, e.subjectId, e));
    for (const patch of [
      { envelope_version: reply ? 2 : 1 },
      { subject_revision: id(90) },
      { content_version: 2 },
      { kind: reply ? ('comment' as const) : ('reply' as const) },
    ])
      assert.equal(
        ratingScopedContentBindingMatches(
          { ...b, ...patch },
          kind,
          e.subjectId,
          e,
        ),
        false,
      );
    assert.equal(ratingScopedContentBindingMatches(b, kind, id(90), e), false);
  }
});
test('source Review is exact issuer-only base or one-campus override, no request key', () => {
  for (const override of [false, true]) {
    const e = category(override);
    const d = canonicalRatingScopedCategorySource({
      sourceId: e.sourceId,
      sourceRevision: e.sourceRevision,
      categoryId: e.categoryId,
      envelope: e,
    });
    const b = {
      ...common(e),
      source_id: e.sourceId,
      source_revision: e.sourceRevision,
      category_id: e.categoryId,
      issuance_id: e.issuanceId,
      issuance_digest: e.issuanceDigest,
    };
    assert(ratingScopedCategorySourceBindingMatches(b, d));
    assert.equal(
      ratingScopedCategorySourceBindingMatches(
        { ...b, source_revision: id(90) },
        d,
      ),
      false,
    );
    assert.throws(() =>
      canonicalRatingScopedEnvelope({ ...e, clientRequestId: id(2) }),
    );
    assert.throws(() =>
      canonicalRatingScopedEnvelope({ ...e, issuanceId: id(91) }),
    );
  }
  assert.throws(() =>
    canonicalRatingScopedEnvelope({
      ...category(true),
      placement: { kind: 'global' },
    }),
  );
  assert.throws(() =>
    canonicalRatingScopedEnvelope({
      ...category(true),
      placement: { kind: 'campuses', campusIds: [id(20), id(21)] },
    }),
  );
});
test('v5 metadata validates exact denial, revocation and consumption independently', () => {
  const r = row(target()),
    now = Date.UTC(2026, 9, 9);
  assert.equal(
    validateRatingScopedApprovalRow(r, true, now).decision.kind,
    'allow',
  );
  assert.equal(
    validateRatingScopedApprovalRow({ ...r, result: 'reject' }, false, now)
      .decision.kind,
    'deny',
  );
  assert.equal(
    validateRatingScopedApprovalRow({ ...r, state: 'revoked' }, false, now)
      .decision.kind,
    'deny',
  );
  assert.equal(
    validateRatingScopedApprovalRow(
      { ...r, result: 'reject', envelope_version: 1 },
      false,
      now,
    ).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateRatingScopedApprovalRow(r, true, now + 1001).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateRatingScopedApprovalRow(r, false, now + 1001).decision.kind,
    'allow',
  );
  assert.equal(
    validateRatingScopedApprovalRow(
      { ...r, policy_valid_until: new Date(now) },
      false,
      now,
    ).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateRatingScopedApprovalRow(
      { ...r, envelope: { ...(r.envelope as object), extra: true } },
      false,
      now,
    ).decision.kind,
    'unavailable',
  );
});

test('over 520 mixed legacy/scoped definitions use chunked exact binding dispatch and one final owner proof', async () => {
  const definitions: AnyRatingTargetDefinitionDescriptor[] = [];
  const records = new Map<
    string,
    {
      definition: AnyRatingTargetDefinitionDescriptor;
      approval: RatingApprovalRow;
      binding: object;
    }
  >();
  for (let index = 0; index < 600; index++) {
    let envelope: AnyRatingTargetDefinitionDescriptor['envelope'];
    const targetId = id(1000 + index),
      revision = id(2000 + index);
    if (index % 3 === 2)
      envelope = target({
        targetId,
        targetRevision: revision,
        definitionRevision: revision,
      });
    else {
      const e = canonicalRatingEnvelope({
        version: index % 3 === 0 ? 1 : 3,
        purpose:
          index % 3 === 0 ? 'publish_rating_target' : 'edit_rating_target',
        accountId: id(1),
        clientRequestId: id(2),
        targetId,
        targetRevision: revision,
        categoryId: id(5),
        categoryRevision: id(6),
        catalogRevision: id(21),
        scope: { regionId: id(30) },
        assetIds: [],
        name: 'Legacy reviewed target',
        description: '',
        ...(index % 3 === 1
          ? {
              previousTargetRevision: id(3000 + index),
              previousDefinitionRevision: id(4000 + index),
              definitionRevision: id(5000 + index),
              contentVersion: 2,
            }
          : {}),
      });
      if (
        e.purpose !== 'publish_rating_target' &&
        e.purpose !== 'edit_rating_target'
      )
        assert.fail();
      envelope = e;
    }
    const contentVersion =
      envelope.purpose === 'edit_rating_target'
        ? envelope.contentVersion
        : envelope.version === 5
          ? envelope.contentVersion
          : 1;
    const definitionRevision =
      envelope.purpose === 'edit_rating_target'
        ? envelope.definitionRevision
        : envelope.version === 5
          ? envelope.definitionRevision
          : envelope.targetRevision;
    const definition = canonicalAnyRatingTargetDefinition({
      targetId,
      contentVersion,
      definitionRevision,
      appliedTargetRevision: revision,
      envelope,
    });
    const digest =
      envelope.version === 5
        ? ratingScopedApprovalDigest(envelope)
        : ratingApprovalDigest(envelope);
    const approval = {
      ...row(target()),
      id: id(6000 + index),
      operation: envelope.purpose,
      envelope_version: envelope.version,
      digest,
      envelope,
    };
    const common = {
      decision_id: approval.id,
      account_id: envelope.accountId,
      operation: envelope.purpose,
      envelope_version: envelope.version,
      digest,
      envelope,
      scope: envelope.scope,
    };
    const binding =
      envelope.version === 5
        ? {
            ...common,
            target_id: targetId,
            content_version: contentVersion,
            definition_revision: definitionRevision,
            applied_target_revision: revision,
          }
        : contentVersion === 1
          ? {
              ...common,
              kind: 'target',
              subject_id: targetId,
              content_version: 1,
            }
          : {
              ...common,
              target_id: targetId,
              content_version: contentVersion,
              definition_revision: definitionRevision,
            };
    definitions.push(definition);
    records.set(targetId, { definition, approval, binding });
  }
  let epoch = '1',
    locks = 0;
  const clock = new Date(Date.UTC(2026, 9, 9));
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config') || sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        locks++;
        assert(sql.endsWith('NOWAIT'));
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch }] };
      if (
        sql.includes(
          'WITH ORDINALITY w(id,content_version,revision,review_version',
        )
      )
        return {
          rows: (values![0] as string[]).map((key, index) => {
            const record = records.get(key)!;
            return {
              ...record.approval,
              ordinal: index + 1,
              binding: record.binding,
              account_exists: true,
              bound_time: true,
              now: clock,
              exact_time: true,
            };
          }),
        };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: clock }] };
      assert.fail(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const owner = new RatingContentReviewFacade();
  for (let offset = 0; offset < definitions.length; offset += 128) {
    const results = await owner.currentDefinitionBatch(
      definitions.slice(offset, offset + 128),
      tx,
    );
    assert(results.every((result) => result.kind === 'allow'));
  }
  await checkTransactionDeadlines(tx);
  assert.equal(locks, 1);
  epoch = '2';
  await assert.rejects(() => checkTransactionDeadlines(tx));
  await assert.rejects(() =>
    new RatingScopedContentReviewFacade().currentTargetDefinitions(
      definitions.slice(0, 129),
      tx,
    ),
  );
});

function scopedBatchFixture() {
  let epoch = '1',
    clock = new Date(Date.UTC(2026, 9, 9)),
    blocked = false;
  let rows: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config') || sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        assert(sql.endsWith('NOWAIT'));
        if (blocked) throw Error('in-flight writer');
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch }] };
      if (sql.includes('WITH ORDINALITY w(kind,id,revision,content_version'))
        return { rows };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: clock }] };
      assert.fail(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    calls,
    owner: new RatingScopedContentReviewFacade(),
    setRows: (value: Record<string, unknown>[]) => {
      rows = value;
    },
    revoke: () => {
      epoch = '2';
    },
    block: () => {
      blocked = true;
    },
    advance: () => {
      clock = new Date(clock.getTime() + 2000);
    },
  };
}
function boundContentRow(envelope = content()) {
  return {
    ...row(envelope),
    ordinal: 1,
    account_exists: true,
    bound_time: true,
    exact_time: true,
    now: new Date(Date.UTC(2026, 9, 9)),
    binding: {
      ...common(envelope),
      kind:
        envelope.purpose === 'publish_rating_comment_scoped'
          ? 'comment'
          : 'reply',
      subject_id: envelope.subjectId,
      subject_revision: envelope.subjectRevision,
      content_version: 1,
      scope: envelope.scope,
    },
  };
}
test('scoped owner rejects unknown or extra descriptor keys before inspecting bindings', async () => {
  const e = content();
  for (const descriptor of [
    { kind: 'unknown', subjectId: e.subjectId, envelope: e },
    {
      kind: 'comment',
      subjectId: e.subjectId,
      envelope: e,
      source: { sourceId: id(60) },
    },
    { kind: 'reply', subjectId: e.subjectId, envelope: e },
    { kind: 'comment', subjectId: id(99), envelope: e },
  ]) {
    const f = scopedBatchFixture();
    assert.equal(
      (await f.owner.currentBatch([descriptor as never], f.tx))[0]?.kind,
      'unavailable',
    );
    assert(!f.calls.some((sql) => sql.includes('WITH ORDINALITY')));
  }
});
test('a current denial is trusted only after exact scope, subject, decision and binding validation', async () => {
  const envelope = content();
  for (const [patch, expected] of [
    [{}, 'allow'],
    [{ state: 'revoked' }, 'deny'],
    [{ state: 'held' }, 'deny'],
    [{ state: 'revoked', binding: null }, 'unavailable'],
    [{ state: 'revoked', ordinal: 2 }, 'unavailable'],
    [{ account_exists: false }, 'unavailable'],
    [{ bound_time: false }, 'unavailable'],
    [{ exact_time: false }, 'unavailable'],
    [{ id: id(90) }, 'unavailable'],
    [{ digest: 'b'.repeat(64) }, 'unavailable'],
    [
      {
        envelope: {
          ...envelope,
          scope: { ...envelope.scope, headRevision: id(90) },
        },
      },
      'unavailable',
    ],
  ] as const) {
    const f = scopedBatchFixture();
    f.setRows([{ ...boundContentRow(envelope), ...patch }]);
    assert.equal(
      (
        await f.owner.currentContent(
          'comment',
          envelope.subjectId,
          envelope,
          f.tx,
        )
      ).kind,
      expected,
    );
  }
  const f = scopedBatchFixture();
  const exact = boundContentRow(envelope);
  f.setRows([
    {
      ...exact,
      binding: {
        ...exact.binding,
        scope: { ...envelope.scope, sourceDigest: 'b'.repeat(64) },
      },
    },
  ]);
  assert.equal(
    (
      await f.owner.currentContent(
        'comment',
        envelope.subjectId,
        envelope,
        f.tx,
      )
    ).kind,
    'unavailable',
  );
});
test('scoped Review final proof rejects revocation, pending writers and elapsed visibility', async () => {
  for (const action of ['revoke', 'block', 'advance'] as const) {
    const f = scopedBatchFixture(),
      envelope = content();
    f.setRows([
      {
        ...boundContentRow(envelope),
        visibility_model: 'until',
        visibility_until: new Date(Date.UTC(2026, 9, 9) + 1000),
      },
    ]);
    assert.equal(
      (
        await f.owner.currentContent(
          'comment',
          envelope.subjectId,
          envelope,
          f.tx,
        )
      ).kind,
      'allow',
    );
    f[action]();
    await assert.rejects(() => checkTransactionDeadlines(f.tx));
  }
});
test('scoped batch treats missing, extra or duplicate result rows as unavailable infrastructure', async () => {
  const envelope = content();
  for (const rows of [
    [],
    [boundContentRow(envelope), boundContentRow(envelope)],
  ]) {
    const f = scopedBatchFixture();
    f.setRows(rows);
    await assert.rejects(() =>
      f.owner.currentContent('comment', envelope.subjectId, envelope, f.tx),
    );
  }
});
test('base and override retain independent exact source reviews in a single batch', async () => {
  const base = category(),
    override = canonicalRatingScopedEnvelope({
      ...category(true),
      sourceId: id(65),
      sourceRevision: id(66),
      issuanceId: id(65),
      baseSourceId: base.sourceId,
      baseSourceRevision: base.sourceRevision,
    });
  if (override.purpose !== 'publish_rating_category_override_scoped')
    assert.fail();
  const sources = [base, override].map((envelope) =>
    canonicalRatingScopedCategorySource({
      sourceId: envelope.sourceId,
      sourceRevision: envelope.sourceRevision,
      categoryId: envelope.categoryId,
      envelope,
    }),
  );
  const rows = sources.map((source, index) => ({
    ...row(source.envelope),
    ordinal: index + 1,
    account_exists: true,
    bound_time: true,
    exact_time: true,
    now: new Date(Date.UTC(2026, 9, 9)),
    state: index === 0 ? 'revoked' : 'allow',
    binding: {
      ...common(source.envelope),
      source_id: source.sourceId,
      source_revision: source.sourceRevision,
      category_id: source.categoryId,
      issuance_id: source.envelope.issuanceId,
      issuance_digest: source.envelope.issuanceDigest,
    },
  }));
  const f = scopedBatchFixture();
  f.setRows(rows);
  assert.deepEqual(
    (
      await f.owner.currentBatch(
        sources.map((source) => ({ kind: 'category' as const, source })),
        f.tx,
      )
    ).map((result) => result.kind),
    ['deny', 'allow'],
  );
  const bad = scopedBatchFixture();
  bad.setRows([{ ...rows[0]!, binding: rows[1]!.binding }, rows[1]!]);
  assert.deepEqual(
    (
      await bad.owner.currentBatch(
        sources.map((source) => ({ kind: 'category' as const, source })),
        bad.tx,
      )
    ).map((result) => result.kind),
    ['unavailable', 'allow'],
  );
});
test('scoped decisions and bindings reject noncanonical decision UUIDs', () => {
  const envelope = content(),
    record = row(envelope),
    decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  assert.equal(
    validateRatingScopedApprovalRow(
      { ...record, id: decisionId },
      false,
      Date.UTC(2026, 9, 9),
    ).decision.kind,
    'unavailable',
  );
  const binding = {
    ...boundContentRow(envelope).binding,
    kind: 'comment' as const,
    decision_id: decisionId,
  };
  assert.equal(
    ratingScopedContentBindingMatches(
      binding,
      'comment',
      envelope.subjectId,
      envelope,
    ),
    false,
  );
});
