import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { decodePostIntent, decodePost } from '../src/community/contract';
import { PendingRatingLinkStore } from '../src/community/rating-link-pending';
import {
  decodeRatingTargetLinkCard,
  decodeRatingTargetLinkComponent,
  ratingLinkFallback,
  ratingLinkNavigationPath,
  ratingLinkPublicationHash,
  type RatingTargetLinkCapability,
} from '../src/community/rating-link-contract';
import {
  supportsTextReview,
  type PublicationReview,
} from '../src/community/review-contract';
import type { PendingAttempt } from '../src/community/pending-attempt';
import { batchPublicationReference } from '../src/media/batch-publication';
import { mediaPublicationReference } from '../src/media/upload-runtime';
import {
  ComposeController,
  initialComposeView,
  type ComposeTarget,
} from '../src/pages/community-compose/controller';
import { FakeScopedGateway, scopedContext } from './rating-scoped-helpers';
import { target as ratingTarget, targetId, revision } from './ratings-helpers';
import {
  setup,
  intent,
  post,
  spaceId,
  capabilities,
} from './community-helpers';
import { categoryTestId } from './category-management-helpers';
import { deferred, flush } from './helpers';
const capability: RatingTargetLinkCapability = {
  systemKey: 'course',
  targetId,
  selector: { kind: 'global' },
  expectedTargetRevision: revision,
  expectedCategoryRevision: revision,
  expectedSourceRevision: revision,
};
const component = () =>
  decodeRatingTargetLinkComponent({
    kind: 'rating_target_link',
    targetId,
    label: '这门课怎么样？',
    selector: capability.selector,
    expectedTargetRevision: revision,
    expectedCategoryRevision: revision,
    expectedSourceRevision: revision,
  });
const missing = () =>
  new ClientError('http', 'not found', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
function composer() {
  const s = setup(),
    scoped = new FakeScopedGateway(),
    pendingRatingLinks = new PendingRatingLinkStore(s.storage, 'native-link'),
    reviews: PendingAttempt[] = [];
  let view = initialComposeView(),
    reviewStatus: PublicationReview['status'] = 'pending';
  scoped.context = async (request) => scopedContext(request, Date.now());
  scoped.detail = async () =>
    ratingTarget({ name: '🐳'.repeat(13), ratingTargetLink: capability });
  Object.assign(s.gateway, {
    submitReview: async (attempt: PendingAttempt) => {
      reviews.push(attempt);
      return {
        requestId: attempt.payload.clientRequestId,
        operation: 'publish_post',
        status: reviewStatus,
      };
    },
    reviewStatus: async (attempt: PendingAttempt) => ({
      requestId: attempt.payload.clientRequestId,
      operation: 'publish_post',
      status: reviewStatus,
    }),
  });
  s.gateway.capabilitiesImpl = async () =>
    capabilities({
      ratingTargetLink: {
        availability: 'allowed',
        reason: null,
        authorModes: ['named', 'anonymous'],
      },
    });
  s.gateway.receiptImpl = async () => {
    throw missing();
  };
  const runtime = { ...s.runtime, ratingScoped: scoped, pendingRatingLinks },
    handoff: ComposeTarget = {
      operation: 'publish_post',
      spaceId,
      category: 'discussion',
      ratingLink: {
        actorId: s.accountId,
        targetId,
        selector: capability.selector,
        destinationCampusId: categoryTestId(7200),
      },
    };
  const controller = new ComposeController(runtime, handoff, (value) => {
    view = value;
  });
  return {
    ...s,
    runtime,
    scoped,
    pendingRatingLinks,
    controller,
    reviews,
    handoff,
    view: () => view,
    setReview: (status: PublicationReview['status']) => {
      reviewStatus = status;
    },
  };
}
test('literal scalar fallback and nested current card projection are strict and navigate by IDs only', () => {
  assert.equal(ratingLinkFallback('🐳'.repeat(13)), '🐳'.repeat(12));
  assert.equal(ratingLinkFallback(''), '去评分');
  for (const name of [
    '课程\t体验',
    '课程\n体验',
    '课程\u2028体验',
    '课程\u2029体验',
    '课程\u202e体验',
  ]) {
    assert.equal(ratingLinkFallback(name), '去评分');
    const current = decodeRatingTargetLinkCard({
      kind: 'rating_target_link',
      label: '原始标签',
      target: {
        id: targetId,
        name,
        locator: { targetId, selector: { kind: 'global' } },
      },
    });
    assert.equal(current.target.name, name);
    assert.equal(
      decodePost(post({ component: current })).component.kind,
      'rating_target_link',
    );
  }
  assert.equal(ratingLinkFallback('12345678901 name'), '去评分');

  const card = decodeRatingTargetLinkCard({
    kind: 'rating_target_link',
    label: '采用后的原标签',
    target: {
      id: targetId,
      name: '后来审核通过的新名称',
      locator: { targetId, selector: { kind: 'global' } },
    },
  });
  const path = ratingLinkNavigationPath(card);
  assert.ok(path.includes(targetId));
  assert.ok(!path.includes(card.label));
  assert.ok(!path.includes(card.target.name));
  assert.equal(
    decodePost(post({ component: card })).component.kind,
    'rating_target_link',
  );
  assert.throws(() =>
    decodeRatingTargetLinkCard({ ...card, url: 'https://untrusted.invalid' }),
  );
  assert.throws(() =>
    decodeRatingTargetLinkComponent({ ...component(), name: 'untrusted' }),
  );
});
test('new card domain/journal cannot be inserted into old attempts; old none hashes and bytes remain unchanged', () => {
  const s = setup(),
    payload = decodePostIntent(intent({ component: component() }));
  const attempt = {
    kind: 'community_rating_target_link_v5' as const,
    version: 5 as const,
    accountId: s.accountId,
    operation: 'publish_post' as const,
    payload,
  };
  assert.throws(() =>
    s.runtime.pending.freeze({
      version: 1,
      accountId: s.accountId,
      operation: 'publish_post',
      payload,
    }),
  );
  const store = new PendingRatingLinkStore(s.storage, 'separate');
  store.freeze(attempt);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(supportsTextReview(attempt), true);
  assert.equal(
    batchPublicationReference(attempt).intentHash,
    ratingLinkPublicationHash(payload),
  );
  const plain = {
      version: 1 as const,
      accountId: s.accountId,
      operation: 'publish_post' as const,
      payload: intent(),
    },
    explicitNone = {
      ...plain,
      payload: intent({ component: { kind: 'none' } }),
    };
  assert.equal(
    mediaPublicationReference(plain).intentHash,
    mediaPublicationReference(explicitNone).intentHash,
  );
  const exactIntent = {
    spaceId,
    category: 'discussion',
    text: payload.text,
    imageAssetIds: [],
    authorMode: payload.authorMode,
    commentsPolicy: payload.commentsPolicy,
    component: {
      kind: 'rating_target_link',
      targetId,
      label: component().label,
      selector: capability.selector,
      expectedTargetRevision: revision,
      expectedCategoryRevision: revision,
      expectedSourceRevision: revision,
    },
  };
  assert.equal(
    ratingLinkPublicationHash(payload),
    createHash('sha256')
      .update(
        `whaleu-community-rating-target-link:v1\n${JSON.stringify({ operation: 'publish_post', intent: exactIntent })}`,
      )
      .digest('hex'),
  );
});
test('card rejects media, related-campus sync, anonymous DM, trading, feedback and arbitrary locator additions', () => {
  for (const patch of [
    { imageAssetIds: [categoryTestId(8000)] },
    { syncToRelatedCampuses: true },
    { authorMode: 'named', allowAnonymousDm: false },
    { category: 'trading' },
    { category: 'feedback' },
    { component: { ...component(), categoryId: categoryTestId(8001) } },
  ])
    assert.throws(() =>
      decodePostIntent({ ...intent({ component: component() }), ...patch }),
    );
});
test('manual rating card completes actual composer Review and exact original publication without AI or text substitution', async () => {
  const s = composer();
  await s.controller.load();
  assert.equal(s.view().hasRatingLink, true);
  assert.equal(s.view().ratingLinkLabel, '🐳'.repeat(12));
  assert.equal(s.view().text, '');
  assert.equal(s.view().canSelectImage, false);
  assert.equal(s.view().canAddPoll, false);
  s.controller.setRatingLinkLabel('手动标签');
  s.controller.setText('完全独立的普通帖子正文');
  s.controller.setAuthorMode('anonymous');
  await s.controller.submit();
  assert.equal(s.reviews.length, 1);
  assert.equal(s.view().frozen, true);
  const pending = s.pendingRatingLinks.load(s.accountId)!;
  assert.equal(pending.version, 5);
  assert.equal(pending.payload.text, '完全独立的普通帖子正文');
  assert.equal(pending.payload.component?.kind, 'rating_target_link');
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'publishPost').length,
    0,
  );
  s.controller.setRatingLinkLabel('不得覆盖');
  assert.deepEqual(
    s.pendingRatingLinks.load(s.accountId)?.payload,
    pending.payload,
  );
  s.setReview('approved');
  await s.controller.recover(true);
  assert.equal(s.pendingRatingLinks.load(s.accountId), null);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'publishPost').length,
    1,
  );
  s.controller.dispose();
});
test('actor-bound handoff, revoked current source and late load cannot restore private target metadata', async () => {
  const s = composer();
  assert.equal(s.handoff.operation, 'publish_post');
  if (s.handoff.operation !== 'publish_post') throw new Error('Expected post');
  const wrong = new ComposeController(
    s.runtime,
    {
      ...s.handoff,
      ratingLink: { ...s.handoff.ratingLink!, actorId: categoryTestId(8300) },
    },
    () => undefined,
  );
  await wrong.load();
  assert.equal(s.scoped.calls.length, 0);
  wrong.dispose();
  const held = deferred<ReturnType<typeof ratingTarget>>();
  s.scoped.detail = async () => held.promise;
  const loading = s.controller.load();
  await flush();
  s.controller.dispose();
  held.resolve(ratingTarget({ ratingTargetLink: capability }));
  await loading;
  assert.equal(s.view().ratingLinkName, '');
  assert.equal(s.view().ratingLinkLabel, '');
});
test('v5 response loss survives rebuild and same-key cancellation; no new name is restored from journal', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setText('正文');
  await s.controller.submit();
  const pending = s.pendingRatingLinks.load(s.accountId)!;
  const originalBytes = JSON.stringify(pending);
  s.controller.dispose();
  let view = initialComposeView();
  Object.assign(s.gateway, {
    cancelReview: async (attempt: PendingAttempt) => ({
      requestId: attempt.payload.clientRequestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: batchPublicationReference(attempt).intentHash,
    }),
  });
  s.scoped.detail = async () => {
    throw new ClientError('business', 'Target revoked');
  };
  const recovery = new ComposeController(s.runtime, null, (value) => {
    view = value;
  });
  await recovery.load();
  assert.equal(view.ratingLinkName, '');
  assert.equal(view.ratingLinkLabel, '');
  assert.equal(view.text, '');
  assert.equal(view.frozen, true);
  assert.equal(
    JSON.stringify(s.pendingRatingLinks.load(s.accountId)),
    originalBytes,
  );
  await recovery.cancelReview();
  assert.equal(s.pendingRatingLinks.load(s.accountId), null);
  recovery.dispose();
});
test('absent target capability cannot be spoofed by a course name or handoff query', async () => {
  const s = composer();
  s.scoped.detail = async () => ratingTarget({ name: 'course' });
  await s.controller.load();
  assert.equal(s.view().hasRatingLink, false);
  assert.equal(s.view().ratingLinkName, '');
  assert.equal(s.view().canSubmit, false);
  s.controller.dispose();
});
test('absent v5 Review capability blocks only card publication; no anonymous-to-named switch', async () => {
  const s = composer();
  s.gateway.capabilitiesImpl = async () =>
    capabilities({ authorModes: ['named'] });
  await s.controller.load();
  s.controller.setAuthorMode('anonymous');
  s.controller.setText('独立正文');
  await s.controller.submit();
  assert.equal(s.view().authorMode, 'anonymous');
  assert.equal(s.reviews.length, 0);
  assert.equal(s.pendingRatingLinks.load(s.accountId), null);
  s.controller.dispose();
});
test('a card cannot overwrite the ordinary draft, and an old pending command wins over the new handoff', async () => {
  const s = composer(),
    key = `post:${spaceId}:discussion`;
  s.runtime.drafts.save(s.accountId, key, {
    version: 1,
    text: '已有普通草稿',
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  const oldDraft = JSON.stringify(s.runtime.drafts.load(s.accountId, key));
  await s.controller.load();
  s.controller.removeRatingLink();
  assert.equal(s.view().hasRatingLink, true);
  assert.equal(
    JSON.stringify(s.runtime.drafts.load(s.accountId, key)),
    oldDraft,
  );
  s.controller.dispose();
  const legacy = {
    version: 1 as const,
    accountId: s.accountId,
    operation: 'publish_post' as const,
    payload: intent({ text: '原来的待确认命令' }),
  };
  s.runtime.pending.freeze(legacy);
  const oldBytes = JSON.stringify(s.runtime.pending.load(s.accountId));
  let view = initialComposeView();
  s.scoped.detail = async () => {
    throw new ClientError('business', 'No fresh target');
  };
  const recovery = new ComposeController(s.runtime, s.handoff, (next) => {
    view = next;
  });
  await recovery.load();
  assert.equal(view.text, legacy.payload.text);
  assert.equal(view.frozen, true);
  assert.equal(JSON.stringify(s.runtime.pending.load(s.accountId)), oldBytes);
  assert.equal(s.pendingRatingLinks.load(s.accountId), null);
  recovery.dispose();
});
