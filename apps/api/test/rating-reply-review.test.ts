import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
  ratingOperation,
} from '../src/community/content-review/rating-contracts.js';
import type {
  RatingContentEnvelope,
  RatingContentKind,
  RatingReplyEnvelope,
} from '../src/community/content-review/rating-contracts.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  ratingBindingMatches,
  validateRatingApprovalRow,
} from '../src/community/content-review/rating-approval-validation.js';
import type {
  RatingApprovalBinding,
  RatingApprovalRow,
} from '../src/community/content-review/rating-approval-validation.js';
import { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import {
  checkTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
const shared = {
  accountId: id(1),
  clientRequestId: id(2),
  targetId: id(3),
  targetRevision: id(4),
  categoryId: id(5),
  categoryRevision: id(6),
  catalogRevision: id(7),
  scope: { regionId: null },
  assetIds: [],
};
function reply(patch: Record<string, unknown> = {}): RatingReplyEnvelope {
  const e = canonicalRatingEnvelope({
    ...shared,
    version: 2,
    purpose: 'publish_rating_reply',
    rootId: id(8),
    rootRevision: id(9),
    replyTo: { replyId: id(10), revision: id(11) },
    authorMode: 'anonymous',
    body: 'Synthetic rating reply',
    ...patch,
  });
  assert.equal(e.purpose, 'publish_rating_reply');
  return e as RatingReplyEnvelope;
}
function row(e: RatingContentEnvelope = reply()): RatingApprovalRow {
  return {
    id: id(12),
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: e.version,
    digest: ratingApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(13),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-reply-review-owner',
    provenance_ref: 'synthetic-reply-review-fact',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 10000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-policy-owner',
    policy_provenance_ref: 'synthetic-policy',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-reply-review-owner',
    event_provenance_ref: 'synthetic-reply-review-event',
  };
}
function binding(
  r = row(),
  subject = id(14),
  kind: RatingContentKind = 'reply',
): RatingApprovalBinding {
  const e = r.envelope as RatingContentEnvelope;
  return {
    kind,
    subject_id: subject,
    content_version: 1,
    decision_id: r.id,
    account_id: r.account_id,
    operation: r.operation,
    envelope_version: r.envelope_version,
    digest: r.digest,
    envelope: e,
    scope: e.scope,
  };
}
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const unavailable = errorIs('CONTENT_REVIEW_UNAVAILABLE');
const bindingKey = (b: RatingApprovalBinding) => `${b.kind}:${b.subject_id}`;

/** Owner unit fixture only: real SQL constraints/clock behavior are exercised by
 * the integration suite, not simulated as a database acceptance here. */
function fixture(
  r: RatingApprovalRow | null = row(),
  existing: RatingApprovalBinding | null = null,
) {
  const state = {
    rows: new Map(r ? [[r.id, r]] : []),
    bindings: new Map(existing ? [[bindingKey(existing), existing]] : []),
    exact: true,
    epoch: '0',
    account: true,
    clock: now,
    finalClock: now,
    lockFailure: false,
  };
  const commands: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') return { rows: [] };
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.lockFailure)
          throw Object.assign(new Error('synthetic conflict'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch: state.epoch }] };
      if (sql.includes('SELECT id FROM whaleu_identity.accounts'))
        return { rows: state.account ? [{ id: values[0] }] : [] };
      if (
        sql.startsWith(
          'SELECT id FROM whaleu_community.rating_approval_decisions',
        )
      ) {
        assert.match(sql, /envelope_version=\$4/);
        const candidates = [...state.rows.values()].filter(
          (candidate) =>
            candidate.account_id === values[0] &&
            candidate.operation === values[1] &&
            candidate.digest === values[2] &&
            candidate.envelope_version === values[3],
        );
        assert.ok(candidates.length <= 1);
        return { rows: candidates.map((candidate) => ({ id: candidate.id })) };
      }
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_heads',
        )
      )
        return {
          rows: state.rows.has(values[0] as string)
            ? [{ decision_id: values[0] }]
            : [],
        };
      if (sql.includes('WITH ORDINALITY r(id,consume,ordinal)'))
        return {
          rows: (values[0] as string[]).map((key, i) => ({
            ordinal: i + 1,
            exact_time: state.rows.has(key) && state.exact,
          })),
        };
      if (sql.includes('WITH ORDINALITY r(kind,id,ordinal)'))
        return {
          rows: (values[0] as string[]).map((kind, i) => {
            const b = state.bindings.get(
              `${kind}:${(values[1] as string[])[i]}`,
            );
            return {
              ordinal: i + 1,
              decision_id: b?.decision_id ?? null,
              digest: b?.digest ?? null,
            };
          }),
        };
      if (sql.includes('SELECT d.*')) {
        const current = state.rows.get(values[0] as string);
        return {
          rows: current
            ? [
                {
                  ...current,
                  now: new Date(state.clock),
                  exact_time: state.exact,
                },
              ]
            : [],
        };
      }
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_bindings',
        )
      )
        return {
          rows: [...state.bindings.values()]
            .filter((b) => b.decision_id === values[0])
            .map((b) => ({ decision_id: b.decision_id })),
        };
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_target_definition_bindings',
        )
      )
        return { rows: [] };
      if (
        sql.startsWith(
          'SELECT * FROM whaleu_community.rating_approval_bindings',
        )
      ) {
        const b = state.bindings.get(`${values[0]}:${values[1]}`);
        return { rows: b ? [b] : [] };
      }
      if (
        sql.startsWith('INSERT INTO whaleu_community.rating_approval_bindings')
      ) {
        assert.match(sql, /VALUES\(\$1,\$2,1,\$3,\$4,\$5,\$9,/);
        const b: RatingApprovalBinding = {
          kind: values[0] as RatingContentKind,
          subject_id: values[1] as string,
          content_version: 1,
          decision_id: values[2] as string,
          account_id: values[3] as string,
          operation: values[4] as string,
          envelope_version: values[8] as number,
          digest: values[5] as string,
          envelope: JSON.parse(values[6] as string),
          scope: JSON.parse(values[7] as string),
        };
        state.bindings.set(bindingKey(b), b);
        return { rows: [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.finalClock) }] };
      assert.fail(`Unexpected synthetic reply Review SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, commands };
}
const facade = new RatingContentReviewFacade();

test('v1 target/comment golden digests stay unchanged alongside reply-v2', () => {
  for (const [fields, expected] of [
    [
      {
        purpose: 'publish_rating_comment',
        authorMode: 'anonymous',
        body: 'Synthetic rating comment',
      },
      '7a4f247975bcbcda48401bb90788da78c4f894e68485f21f37017ff57e8ec81d',
    ],
    [
      {
        purpose: 'publish_rating_target',
        name: 'Synthetic target',
        description: '',
      },
      'c5c1bfba3aa37df40fd6e5753ce2eada108f47d47cfa374ea12572f375fad35b',
    ],
  ] as const) {
    const e = canonicalRatingEnvelope({ ...shared, version: 1, ...fields });
    assert.equal(ratingApprovalDigest(e), expected);
    assert.throws(() => canonicalRatingEnvelope({ ...e, version: 2 }));
    assert.throws(() => canonicalRatingEnvelope({ ...e, rootId: id(8) }));
  }
});

test('reply-v2 is a frozen typed root/direct-parent envelope with its own digest domain', () => {
  const e = reply();
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.scope));
  assert.ok(Object.isFrozen(e.assetIds));
  assert.ok(Object.isFrozen(e.replyTo));
  assert.equal(
    ratingApprovalDigest(e),
    createHash('sha256')
      .update(`whaleu-rating-content-approval:v2\n${canonicalJson(e)}`)
      .digest('hex'),
  );
  assert.notEqual(
    ratingApprovalDigest(e),
    createHash('sha256')
      .update(`whaleu-rating-content-approval:v1\n${canonicalJson(e)}`)
      .digest('hex'),
  );
  assert.equal(reply({ replyTo: null }).replyTo, null);
  assert.equal(ratingOperation('reply'), 'publish_rating_reply');
  assert.equal(ratingOperation('comment'), 'publish_rating_comment');
});

test('reply-v2 rejects weak ancestry, unknown input and unsafe author modes', () => {
  const e = reply();
  for (const patch of [
    { version: 1 },
    { version: 3 },
    { purpose: 'publish_rating_comment' },
    { purpose: 'publish_post' },
    { accountId: null },
    { rootId: undefined },
    { rootRevision: undefined },
    { rootId: '10000000-AAAA-4000-8000-000000000008' },
    { targetRevision: null },
    { replyTo: undefined },
    { replyTo: { replyId: id(10) } },
    { replyTo: { replyId: id(10), expectedRevision: id(11) } },
    { replyTo: { replyId: id(10), revision: id(11), accountId: id(30) } },
    { rootAuthor: id(30) },
    { recipient: id(30) },
    { reply_to_user_id: id(30) },
    { authorMode: 'profile' },
    { authorMode: null },
    { authorMode: undefined },
    { personaId: id(30) },
    { name: 'community alias' },
    { assetIds: [id(30)] },
    { scope: { regionId: null, campusId: id(30) } },
  ])
    assert.throws(() => canonicalRatingEnvelope({ ...e, ...patch }));
});

test('reply canonical text keeps R1 Unicode and raw-transport boundaries', () => {
  assert.equal(reply({ body: '  A\r\nB\tC  ' }).body, 'A\nB\tC');
  assert.equal([...reply({ body: '😀'.repeat(500) }).body].length, 500);
  assert.equal(
    reply({ body: ' '.repeat(599) + 'x' + ' '.repeat(500) }).body,
    'x',
  );
  for (const body of [
    '',
    ' ',
    '😀'.repeat(501),
    'x'.repeat(501),
    ' '.repeat(1100) + 'x',
    'x\u0000y',
    'x\u007fy',
    'x\u009fy',
    'x\ud800y',
    'x\udfffy',
    'x\ry',
  ])
    assert.throws(() => reply({ body }));
});

test('every reply actor/request/scope/body/ancestry revision participates in the v2 digest', () => {
  const e = reply();
  for (const key of [
    'accountId',
    'clientRequestId',
    'targetId',
    'targetRevision',
    'rootId',
    'rootRevision',
    'categoryId',
    'categoryRevision',
    'catalogRevision',
  ])
    assert.notEqual(
      ratingApprovalDigest(e),
      ratingApprovalDigest(reply({ [key]: id(30) })),
    );
  for (const patch of [
    { replyTo: null },
    { replyTo: { ...e.replyTo, replyId: id(30) } },
    { replyTo: { ...e.replyTo, revision: id(30) } },
    { scope: { regionId: id(30) } },
    { authorMode: 'named' },
    { body: 'Changed text' },
  ])
    assert.notEqual(
      ratingApprovalDigest(e),
      ratingApprovalDigest(reply(patch)),
    );
});

test('reply decision metadata is exact v2 and never converts unknown coverage to allow', () => {
  const r = row();
  const result = validateRatingApprovalRow(r, true, now).decision;
  assert.equal(result.kind, 'allow');
  if (result.kind === 'allow') assert.equal(result.value.version, 2);
  for (const patch of [
    { envelope_version: 1 },
    { envelope_version: 3 },
    { account_id: id(30) },
    { operation: 'publish_rating_comment' },
    { operation: 'publish_post' },
    { digest: '0'.repeat(64) },
    { policy_key: 'local-explicit-v2' },
    { policy_version: 2 },
    { coverage: 'missing' },
    { provenance: 'unreconciled' },
    { policy_coverage: 'conflicting' },
    { policy_provenance: 'unreconciled' },
    { event_coverage: 'missing' },
    { event_provenance: 'unreconciled' },
    { issuer: '' },
    { event_issuer: '' },
    { policy_issuer: '' },
    { provenance_ref: '' },
    { event_provenance_ref: '' },
    { policy_provenance_ref: '' },
    { result: 'pending' as const },
    { result: 'failed' as const },
    { envelope: { ...reply(), body: '  Synthetic rating reply  ' } },
  ])
    assert.equal(
      validateRatingApprovalRow({ ...r, ...patch }, true, now).decision.kind,
      'unavailable',
    );
});

test('reply binding verifies all immutable definition and version dimensions even for denial', () => {
  const r = row(),
    b = binding(r),
    e = reply();
  assert.equal(ratingBindingMatches(b, 'reply', b.subject_id, e), true);
  for (const patch of [
    { kind: 'comment' as const },
    { kind: 'target' as const },
    { operation: 'publish_rating_comment' },
    { envelope_version: 1 },
    { content_version: 2 },
    { account_id: id(30) },
    { subject_id: id(30) },
    { decision_id: 'unknown' },
    { digest: '0'.repeat(64) },
    { scope: { regionId: id(30) } },
    { envelope: reply({ rootRevision: id(30) }) },
    { envelope: reply({ replyTo: null }) },
  ])
    assert.equal(
      ratingBindingMatches({ ...b, ...patch }, 'reply', b.subject_id, e),
      false,
    );
});

test('typed domain UUID collisions are valid while same-table direct self-reference is rejected', async () => {
  const e = reply({ targetId: id(14), rootId: id(14) }),
    r = row(e),
    b = binding(r);
  assert.equal(ratingBindingMatches(b, 'reply', id(14), e), true);
  const f = fixture(r);
  await facade.bind(await facade.accepted(e, f.tx), 'reply', id(14), e, f.tx);
  assert.equal((await facade.current('reply', id(14), e, f.tx)).kind, 'allow');
  await checkTransactionDeadlines(f.tx);
  const self = reply({ replyTo: { replyId: id(14), revision: id(11) } });
  const sr = row(self),
    sf = fixture(sr);
  assert.equal(ratingBindingMatches(binding(sr), 'reply', id(14), self), false);
  await assert.rejects(
    facade.bind(
      await facade.accepted(self, sf.tx),
      'reply',
      id(14),
      self,
      sf.tx,
    ),
    unavailable,
  );
  assert.equal(
    (await facade.current('reply', id(14), self, sf.tx)).kind,
    'unavailable',
  );
});

test('reply accepted/bind/current uses v2 protocol but content version one and typed final bindings', async () => {
  const e = reply(),
    f = fixture();
  const accepted = await facade.accepted(e, f.tx);
  assert.equal(accepted.version, 2);
  await facade.bind(accepted, 'reply', id(14), e, f.tx);
  assert.equal(f.state.bindings.get(`reply:${id(14)}`)?.envelope_version, 2);
  assert.equal(f.state.bindings.get(`reply:${id(14)}`)?.content_version, 1);
  assert.equal((await facade.current('reply', id(14), e, f.tx)).kind, 'allow');
  await checkTransactionDeadlines(f.tx);
  const finalBindings = f.commands.find((c) =>
    c.sql.includes('WITH ORDINALITY r(kind,id,ordinal)'),
  )!;
  assert.deepEqual(finalBindings.values, [['reply'], [id(14)]]);
  const finalTimes = f.commands.find((c) =>
    c.sql.includes('WITH ORDINALITY r(id,consume,ordinal)'),
  )!;
  assert.deepEqual(finalTimes.values, [
    [id(12), id(12)],
    [true, false],
  ]);
  assert.ok(
    f.commands.every(
      (c) =>
        !/whaleu_ratings\.|content_approval_decisions|pg_advisory_xact_lock\(/.test(
          c.sql,
        ),
    ),
  );
});

test('v2 binding rejects caller-made version, identity, scope and old comment aliases', async () => {
  const e = reply(),
    f = fixture();
  const accepted = await facade.accepted(e, f.tx);
  for (const forged of [
    { ...accepted, version: 1 as const },
    { ...accepted, decisionId: id(30) },
    { ...accepted, digest: '0'.repeat(64) },
    { ...accepted, envelope: reply({ scope: { regionId: id(30) } }) },
  ])
    await assert.rejects(
      facade.bind(forged, 'reply', id(14), e, f.tx),
      unavailable,
    );
  for (const kind of ['target', 'comment'] as const)
    await assert.rejects(
      facade.bind(accepted, kind, id(14), e, f.tx),
      unavailable,
    );
  assert.equal(f.state.bindings.size, 0);
});

test('reply approval missing/pending/failed and absent actor stay unavailable without a fallback issuer', async () => {
  for (const r of [
    null,
    { ...row(), result: 'pending' as const },
    { ...row(), result: 'failed' as const },
  ]) {
    const f = fixture(r);
    await assert.rejects(facade.accepted(reply(), f.tx), unavailable);
    assert.equal(f.state.bindings.size, 0);
  }
  const f = fixture();
  f.state.account = false;
  await assert.rejects(facade.accepted(reply(), f.tx), unavailable);
});

test('already consumed reply decision cannot be rebound under a different subject', async () => {
  const r = row(),
    f = fixture(r, binding(r));
  await assert.rejects(facade.accepted(reply(), f.tx), unavailable);
});

test('wrong-chain rejection metadata is unavailable before a deny can escape', async () => {
  const r = { ...row(), result: 'reject' as const };
  const b = { ...binding(r), envelope: reply({ rootId: id(30) }) };
  const f = fixture(r, b);
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'unavailable',
  );
  await assert.rejects(
    facade.accepted(reply(), fixture(r).tx),
    errorIs('CONTENT_REJECTED'),
  );
});

test('only known current rejection/held/revoked decisions can be safely hidden by a caller', async () => {
  for (const patch of [
    { result: 'reject' as const },
    { state: 'held' as const },
    { state: 'revoked' as const },
  ]) {
    const r = { ...row(), ...patch },
      f = fixture(r, binding(r));
    assert.equal(
      (await facade.current('reply', id(14), reply(), f.tx)).kind,
      'deny',
    );
    await checkTransactionDeadlines(f.tx);
  }
});

test('future exact-time head stays unavailable, and activation cannot validate its previous negative proof', async () => {
  const r = { ...row(), event_at: new Date(now) },
    f = fixture(r, binding(r));
  // A microsecond-future event may be rounded down by the JS driver. SQL owns it.
  assert.equal(validateRatingApprovalRow(r, false, now).decision.kind, 'allow');
  f.state.exact = false;
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'unavailable',
  );
  f.state.exact = true;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  const later = fixture(r, binding(r));
  assert.equal(
    (await facade.current('reply', id(14), reply(), later.tx)).kind,
    'allow',
  );
  await checkTransactionDeadlines(later.tx);
});

test('held-to-future head write changes navigation and leaves its new current body unavailable', async () => {
  const r = { ...row(), state: 'held' as const },
    f = fixture(r, binding(r));
  const heldNavigation = await facade.navigation(f.tx);
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'deny',
  );
  f.state.rows.set(r.id, { ...r, state: 'allow' });
  f.state.epoch = '1';
  f.state.exact = false;
  assert.notEqual(await facade.navigation(f.tx), heldNavigation);
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'unavailable',
  );
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
});

test('same-materialized SQL instant checks microsecond current time and final expiry', async () => {
  const r = row(),
    f = fixture(r, binding(r));
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'allow',
  );
  const read = f.commands.find((c) => c.sql.includes('SELECT d.*'))!;
  assert.match(
    read.sql,
    /WITH instant AS MATERIALIZED \(SELECT clock_timestamp\(\) now\)/,
  );
  assert.match(read.sql, /instant.now,/);
  assert.match(read.sql, /d.evaluated_at<=instant.now/);
  assert.match(read.sql, /e.occurred_at<=instant.now/);
  assert.match(read.sql, /p.valid_until>instant.now/);
  assert.match(read.sql, /d.visibility_until>instant.now/);
  f.state.exact = false;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
});

test('reply durable current visibility outlives consume window but consumption cannot', async () => {
  const r = { ...row(), consume_until: new Date(now - 1) },
    f = fixture(r, binding(r));
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'allow',
  );
  await checkTransactionDeadlines(f.tx);
  await assert.rejects(facade.accepted(reply(), fixture(r).tx), unavailable);
});

test('late final clock retains policy/visibility/consumption deadlines after ordinary owner proofs', async () => {
  for (const patch of [
    { policy_valid_until: new Date(now + 1) },
    { visibility_model: 'until', visibility_until: new Date(now + 1) },
    { consume_until: new Date(now + 1) },
  ]) {
    const f = fixture({ ...row(), ...patch });
    await facade.accepted(reply(), f.tx);
    f.state.finalClock = now + 1;
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  }
});

test('absent or changed typed reply binding invalidates the mandatory final observation', async () => {
  const r = row(),
    f = fixture(r);
  assert.equal(
    (await facade.current('reply', id(14), reply(), f.tx)).kind,
    'unavailable',
  );
  const b = binding(r);
  f.state.bindings.set(bindingKey(b), b);
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  const existing = fixture(r, b);
  assert.equal(
    (await facade.current('reply', id(14), reply(), existing.tx)).kind,
    'allow',
  );
  existing.state.bindings.set(bindingKey(b), { ...b, digest: '0'.repeat(64) });
  await assert.rejects(checkTransactionDeadlines(existing.tx), unavailable);
});

test('50 replies plus 50 distinct quotes and target/root consume exactly 205 unique Review facts', async () => {
  const f = fixture(null);
  for (let i = 0; i < 102; i++) {
    const e =
      i === 0
        ? canonicalRatingEnvelope({
            ...shared,
            version: 1,
            purpose: 'publish_rating_target',
            name: 'Synthetic target',
            description: '',
          })
        : i === 1
          ? canonicalRatingEnvelope({
              ...shared,
              version: 1,
              purpose: 'publish_rating_comment',
              authorMode: 'named',
              body: 'Synthetic root',
            })
          : reply({ clientRequestId: id(1000 + i) });
    const kind = i === 0 ? 'target' : i === 1 ? 'comment' : 'reply';
    const subject = i === 0 ? e.targetId : id(2000 + i);
    const r = { ...row(e), id: id(3000 + i) },
      b = binding(r, subject, kind);
    f.state.rows.set(r.id, r);
    f.state.bindings.set(bindingKey(b), b);
    assert.equal((await facade.current(kind, subject, e, f.tx)).kind, 'allow');
    // Reusing a quote or the root within one page must deduplicate evidence.
    assert.equal((await facade.current(kind, subject, e, f.tx)).kind, 'allow');
  }
  await checkTransactionDeadlines(f.tx);
  const times = f.commands.filter((c) =>
    c.sql.includes('WITH ORDINALITY r(id,consume,ordinal)'),
  );
  const bindings = f.commands.filter((c) =>
    c.sql.includes('WITH ORDINALITY r(kind,id,ordinal)'),
  );
  assert.equal(times.length, 1);
  assert.equal(bindings.length, 1);
  const timeFacts = (times[0]!.values[0] as unknown[]).length;
  const bindingFacts = (bindings[0]!.values[0] as unknown[]).length;
  assert.equal(timeFacts, 102);
  assert.equal(bindingFacts, 102);
  assert.equal(1 + timeFacts + bindingFacts, 205);
});

test('Review existing 520-slot ceiling remains mandatory and never slices into a new registry', async () => {
  const f = fixture(null);
  for (let i = 0; i < 260; i++) {
    const e = reply({ clientRequestId: id(1000 + i) }),
      r = { ...row(e), id: id(2000 + i) };
    const b = binding(r, id(3000 + i));
    f.state.rows.set(r.id, r);
    f.state.bindings.set(bindingKey(b), b);
    const current = facade.current('reply', b.subject_id, e, f.tx);
    if (i === 259) await assert.rejects(current, unavailable);
    else assert.equal((await current).kind, 'allow');
  }
});

test('reply final NOWAIT fence conflict never retries with a blocking owner lock', async () => {
  const r = row(),
    f = fixture(r, binding(r));
  await facade.current('reply', id(14), reply(), f.tx);
  f.state.lockFailure = true;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  const locks = f.commands.filter((c) => c.sql.startsWith('LOCK TABLE'));
  assert.equal(locks.length, 1);
  assert.match(locks[0]!.sql, /IN SHARE MODE NOWAIT$/);
});
