import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  officialOperatorHeaders,
  officialOperatorShell,
  officialOperatorScript,
} from '../src/official-account-operations/operator/assets.js';
interface BrowserContracts {
  decodeCapabilities(v: unknown): unknown;
  decodeConfig(v: unknown): unknown;
  decodePreview(v: unknown): unknown;
  decodeConfirmation(v: unknown): unknown;
  decodeResult(v: unknown): unknown;
  decodeRecovery(v: unknown): unknown;
  decodeIntent(operation: string, v: unknown): unknown;
  statusLabel(v: { state: string }): string;
}
const contracts = (await import(
  'data:text/javascript;base64,' +
    Buffer.from(officialOperatorScript).toString('base64')
)) as BrowserContracts;
const id = '11111111-1111-4111-8111-111111111111',
  h = 'a'.repeat(64),
  at = '2026-10-14T01:00:00.000Z';
const confirmation = {
  confirmationId: id,
  revision: h,
  draftRef: id,
  programId: id,
  accountRef: id,
  accountLabel: '合成学校',
  manifestHash: h,
  title: '文章',
  postCount: 1,
  mode: 'synthetic',
  expiresAt: at,
  action: 'publish_exact_synthetic_article',
};
const result = {
  receipt: {
    requestId: id,
    intentHash: h,
    operation: 'manual_draft',
    programId: id,
    accountRef: id,
    acceptedAt: at,
    outcome: 'admitted',
    configRevision: null,
  },
  status: {
    state: 'draft_confirmed',
    cancelRequested: false,
    acceptedMaterialCount: 0,
    draftRef: id,
    withdrawal: 'none',
    nextAction: 'none',
    updatedAt: at,
  },
};
test('operator shell is public and fail-closed, external-script-only CSP', () => {
  assert.match(officialOperatorShell, /运营登录暂不可用/);
  assert.match(
    officialOperatorShell,
    /<script type="module" src="\/operator\/official-articles\/app.js"><\/script>/,
  );
  assert.doesNotMatch(
    officialOperatorShell,
    /on(?:click|load)=|type="password"|[?&](?:token|bearer)=|<script>(?!<\/script>)/i,
  );
  assert.equal(officialOperatorHeaders['Cache-Control'], 'no-store');
  assert.equal(officialOperatorHeaders['X-Content-Type-Options'], 'nosniff');
  assert.match(
    officialOperatorHeaders['Content-Security-Policy'],
    /frame-ancestors 'none'/,
  );
  assert.doesNotMatch(
    officialOperatorHeaders['Content-Security-Policy'],
    /unsafe-inline|unsafe-eval/,
  );
  assert.match(officialOperatorScript, /credentials:'omit'/);
  assert.match(
    officialOperatorScript,
    /if\(typeof document!=='undefined'\)mountOfficialOperator\(\)/,
  );
  assert.doesNotMatch(
    officialOperatorScript,
    /innerHTML|document\.cookie|sessionStorage|serviceWorker|eval\(/,
  );
});
test('operator requires exact fresh confirmation and rejects arbitrary provider identifiers', () => {
  assert.deepEqual(contracts.decodeConfirmation(confirmation), confirmation);
  for (const mutation of [
    { ...confirmation, providerMediaId: 'foreign' },
    { ...confirmation, postCount: 11 },
    { ...confirmation, mode: 'live' },
    { ...confirmation, title: '\ud800' },
    { ...confirmation, expiresAt: '2026-10-14' },
  ])
    assert.throws(() => contracts.decodeConfirmation(mutation));
  assert.throws(() =>
    contracts.decodeIntent('manual_publish', {
      requestId: id,
      draftRef: 'provider-media-id',
      confirmationId: id,
      confirmationRevision: h,
      manifestHash: h,
      acknowledgement: 'publish_exact_synthetic_article',
    }),
  );
});
test('draft, submission, unknown and independently confirmed publication remain distinct', () => {
  assert.deepEqual(contracts.decodeResult(result), result);
  assert.equal(
    contracts.statusLabel({ state: 'draft_confirmed' }),
    '草稿已生成，未发布',
  );
  assert.equal(
    contracts.statusLabel({ state: 'publish_submitted' }),
    '已提交发布，等待结果',
  );
  assert.equal(
    contracts.statusLabel({ state: 'dispatch_unknown' }),
    '结果未确认，请恢复原请求',
  );
  assert.equal(
    contracts.statusLabel({ state: 'published_confirmed' }),
    '发布已确认',
  );
  assert.throws(() =>
    contracts.decodeResult({
      ...result,
      status: { ...result.status, rawProviderId: 'private' },
    }),
  );
  assert.throws(() =>
    contracts.decodeResult({
      ...result,
      status: { ...result.status, state: 'success' },
    }),
  );
});
test('metadata recovery cannot hydrate private body and not-recorded is exact', () => {
  assert.deepEqual(contracts.decodeRecovery({ state: 'not_recorded' }), {
    state: 'not_recorded',
  });
  assert.throws(() =>
    contracts.decodeRecovery({ state: 'not_recorded', body: 'private' }),
  );
  assert.throws(() =>
    contracts.decodeRecovery({
      state: 'recorded',
      ...result,
      article: { title: 'private' },
    }),
  );
});
test('preview is manual newest only with bounded public fields and non-sliding lifetime', () => {
  const preview = {
    previewId: id,
    programId: id,
    accountRef: id,
    accountLabel: '合成学校',
    kind: 'manual_newest',
    selectionAt: at,
    expiresAt: '2026-10-14T01:05:00.000Z',
    configRevision: h,
    manifestHash: h,
    eligibleCount: 1,
    mode: 'synthetic',
    article: {
      title: '文章',
      author: '作者',
      items: [
        {
          excerpt: '内容',
          publishedAt: at,
          publicCounts: { likes: '0', comments: '0', subscriptions: '0' },
          locator: `pages/community-detail/community-detail?postId=${id}`,
          mediaAppearanceRefs: [],
        },
      ],
      coverAppearanceId: null,
      titleAppearanceId: null,
    },
    actions: { createDraft: true },
    sourceState: 'complete',
  };
  assert.deepEqual(contracts.decodePreview(preview), preview);
  assert.throws(() => contracts.decodePreview({ ...preview, kind: 'test' }));
  assert.throws(() =>
    contracts.decodePreview({
      ...preview,
      expiresAt: '2026-10-14T01:05:01.000Z',
    }),
  );
  assert.throws(() =>
    contracts.decodePreview({
      ...preview,
      article: {
        ...preview.article,
        items: [{ ...preview.article.items[0], openid: 'private' }],
      },
    }),
  );
});
test('operator original intent schema contains no article body, cookie or bearer', () => {
  const intent = {
    requestId: id,
    programId: id,
    previewId: id,
    manifestHash: h,
    expectedConfigRevision: h,
    acknowledgement: 'synthetic_draft_only',
  };
  assert.deepEqual(contracts.decodeIntent('manual_draft', intent), intent);
  assert.throws(() =>
    contracts.decodeIntent('manual_draft', { ...intent, bearer: 'secret' }),
  );
  assert.throws(() =>
    contracts.decodeIntent('manual_draft', { ...intent, article: 'body' }),
  );
  assert.match(
    officialOperatorScript,
    /localStorage\.setItem\(key\(\),JSON\.stringify\(value\)\)/,
  );
  assert.match(
    officialOperatorScript,
    /JSON\.stringify\(actual\)!==JSON\.stringify\(value\)/,
  );
  assert.match(
    officialOperatorScript,
    /await store\('manual_publish',intent,current\)/,
  );
});

test('operator recovery strictly decodes minimal pre-admission cancellation tombstones', () => {
  const tombstone = {
    state: 'cancelled_before_admission',
    requestId: id,
    intentHash: h,
  };
  assert.deepEqual(contracts.decodeRecovery(tombstone), tombstone);
  assert.throws(() =>
    contracts.decodeRecovery({ ...tombstone, accountRef: id }),
  );
  assert.throws(() =>
    contracts.decodeRecovery({ ...tombstone, intentHash: 'changed' }),
  );
});
