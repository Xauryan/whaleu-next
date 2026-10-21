import { decodePostIntent } from '../src/community/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ComposeController,
  type ComposeView,
  type ComposeTarget,
} from '../src/pages/community-compose/controller';
import type { PendingAttempt } from '../src/community/pending-attempt';
import type { PublicationReview } from '../src/community/review-contract';
import {
  DEFAULT_TEXT_SOURCE,
  type TextSourceCapability,
} from '../src/community/text-source-contract';
import { batchPublicationReference } from '../src/media/batch-publication';
import {
  setup,
  spaceId,
  postId,
  commentId,
  otherId,
  requestId,
} from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const target: ComposeTarget = {
  operation: 'publish_post',
  spaceId,
  category: 'discussion',
};
const cap = (
  authorMode: 'named' | 'anonymous',
  available = true,
): TextSourceCapability => ({
  version: 1,
  authorMode,
  availability: available ? 'available' : 'unavailable',
  operations: available
    ? ['publish_post', 'publish_comment', 'publish_reply']
    : [],
  formats: available ? ['plain', 'markdown'] : [],
  readingFormatting: available ? ['auto', 'off'] : [],
  media: 'unavailable',
  markdownReferences: 'unavailable',
  formatter: 'not_configured',
});
function composer(composeTarget: ComposeTarget | null = target) {
  const s = setup(),
    views: ComposeView[] = [],
    submissions: PendingAttempt[] = [];
  let available = true,
    status: PublicationReview['status'] = 'pending';
  Object.assign(s.gateway, {
    textSourceCapabilities: async (
      _space: string,
      _category: string,
      mode: 'named' | 'anonymous',
    ) => cap(mode, available),
    submitReview: async (attempt: PendingAttempt) => {
      submissions.push(attempt);
      return {
        requestId: attempt.payload.clientRequestId,
        operation: attempt.operation,
        status,
      };
    },
    reviewStatus: async (attempt: PendingAttempt) => ({
      requestId: attempt.payload.clientRequestId,
      operation: attempt.operation,
      status,
    }),
  });
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'missing', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const controller = new ComposeController(s.runtime, composeTarget, (view) =>
    views.push(view),
  );
  return {
    ...s,
    controller,
    submissions,
    view: () => views[views.length - 1]!,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setStatus: (value: PublicationReview['status']) => {
      status = value;
    },
  };
}

test('new ordinary composer defaults plain auto, keeps raw editor text and preview never rewrites draft', async () => {
  const s = composer();
  await s.controller.load();
  assert.deepEqual(s.view().textSource, DEFAULT_TEXT_SOURCE);
  const raw = '  原文\r\n**not guessed** 😀 ';
  s.controller.setText(raw);
  s.controller.toggleSourcePreview();
  assert.equal(s.view().sourcePreview, true);
  assert.equal(s.view().text, raw);
  assert.equal(
    s.runtime.drafts.load(s.accountId, `post:${spaceId}:discussion`)?.text,
    raw,
  );
  s.controller.setReadingFormatting(false);
  assert.deepEqual(s.view().textSource, {
    version: 1,
    format: 'plain',
    readingFormatting: 'off',
  });
  await s.controller.submit();
  assert.equal(s.submissions.length, 1);
  assert.equal(s.submissions[0]!.payload.text, raw.replace(/\r\n/g, '\n'));
  assert.deepEqual(s.submissions[0]!.payload.textSource, {
    version: 1,
    format: 'plain',
    readingFormatting: 'off',
  });
  assert.equal(s.view().frozen, true);
  s.controller.setSourceFormat('markdown');
  s.controller.setReadingFormatting(true);
  s.controller.setText('replacement');
  assert.deepEqual(s.runtime.pending.load(s.accountId), s.submissions[0]);
});

test('explicit Markdown freezes distinct no-formatting descriptor and approved retry preserves exact request', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setSourceFormat('markdown');
  s.controller.setText('# 标题\n\n**正文**');
  s.controller.setReadingFormatting(true);
  assert.deepEqual(s.view().textSource, { version: 1, format: 'markdown' });
  await s.controller.submit();
  const original = s.runtime.pending.load(s.accountId);
  assert.ok(original);
  assert.deepEqual(original.payload.textSource, {
    version: 1,
    format: 'markdown',
  });
  s.setStatus('approved');
  await s.controller.recover();
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'publishPost').length,
    0,
  );
  await s.controller.recover(true);
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'publishPost').length,
    1,
  );
  assert.deepEqual(
    s.gateway.calls.find((c) => c.method === 'publishPost')!.args[0],
    original.payload,
  );
  assert.equal(s.runtime.pending.load(s.accountId), null);
});

test('source format and original author are retained for comment and reply publication', async () => {
  for (const destination of [
    { operation: 'publish_comment', postId },
    {
      operation: 'publish_reply',
      postId,
      rootCommentId: commentId,
      targetReplyId: null,
    },
  ] as const) {
    const s = composer(destination);
    await s.controller.load();
    s.controller.setText('原回复');
    s.controller.setSourceFormat('markdown');
    await s.controller.submit();
    assert.equal(s.submissions.length, 1);
    const original = s.submissions[0]!;
    assert.equal(original.operation, destination.operation);
    assert.equal(original.payload.authorMode, 'anonymous');
    assert.deepEqual(original.payload.textSource, {
      version: 1,
      format: 'markdown',
    });
  }
});

test('legacy drafts and unavailable initial capability stay legacy; explicit Markdown never reroutes on unavailable capability', async () => {
  const s = composer();
  s.runtime.drafts.save(s.accountId, `post:${spaceId}:discussion`, {
    version: 1,
    text: '历史原文',
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  await s.controller.load();
  assert.equal(s.view().textSource, null);
  s.setAvailable(false);
  await s.controller.submit();
  assert.equal(s.submissions.length, 1);
  assert.equal(
    s.runtime.pending.load(s.accountId)?.payload.textSource,
    undefined,
  );
  const n = composer();
  n.setAvailable(false);
  await n.controller.load();
  n.controller.setText('新原文');
  assert.equal(n.view().textSource, null);
  n.controller.setSourceFormat('markdown');
  assert.deepEqual(n.view().textSource, { version: 1, format: 'markdown' });
  assert.equal(n.view().canSubmit, false);
  await n.controller.submit();
  assert.equal(n.runtime.pending.load(n.accountId), null);
});

test('Markdown internal references and source-incompatible options block without stripping text or switching format', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setSourceFormat('markdown');
  s.controller.setText('图片 whaleu-asset:x');
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.view().text, '图片 whaleu-asset:x');
  s.controller.setText('普通原文');
  s.controller.setAllowAnonymousDm(true);
  assert.equal(s.view().canSubmit, false);
  assert.deepEqual(s.view().textSource, { version: 1, format: 'markdown' });
  assert.equal(s.view().allowAnonymousDm, true);
});

test('source cancellation binds original new-domain intent, wrong descriptor cannot release pending', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setText('原请求');
  await s.controller.submit();
  const original = s.runtime.pending.load(s.accountId);
  assert.ok(original);
  if (original.operation !== 'publish_post')
    throw new Error('Expected post fixture');
  Object.assign(s.gateway, {
    cancelReview: async () => ({
      requestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: batchPublicationReference({
        ...original,
        payload: {
          ...original.payload,
          textSource: { version: 1, format: 'plain', readingFormatting: 'off' },
        },
      }).intentHash,
    }),
  });
  await s.controller.cancelReview();
  assert.ok(s.runtime.pending.load(s.accountId));
  Object.assign(s.gateway, {
    cancelReview: async () => ({
      requestId,
      operation: original.operation,
      outcome: 'cancelled',
      intentHash: batchPublicationReference(original).intentHash,
    }),
  });
  await s.controller.cancelReview();
  assert.equal(s.runtime.pending.load(s.accountId), null);
});

test('account switch synchronously clears source preview/descriptor/author but retains original private recovery', async () => {
  const s = composer(),
    late = deferred<PublicationReview>();
  Object.assign(s.gateway, { submitReview: () => late.promise });
  await s.controller.load();
  s.controller.setSourceFormat('markdown');
  s.controller.setText('私密原文');
  s.controller.toggleSourcePreview();
  const submitting = s.controller.submit();
  await flush();
  assert.ok(s.runtime.pending.load(s.accountId));
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().text, '');
  assert.equal(s.view().textSource, null);
  assert.equal(s.view().sourcePreview, false);
  assert.equal(s.view().effectiveIdentity, '');
  late.resolve({ requestId, operation: 'publish_post', status: 'approved' });
  await submitting;
  assert.equal(s.view().text, '');
  assert.equal(s.runtime.pending.load(otherId), null);
  assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload.textSource, {
    version: 1,
    format: 'markdown',
  });
});

test('late capability and root hide cannot restore a private source preview', async () => {
  const s = composer(),
    late = deferred<TextSourceCapability>();
  Object.assign(s.gateway, { textSourceCapabilities: () => late.promise });
  const loading = s.controller.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  late.resolve(cap('named'));
  await loading;
  assert.equal(s.view().textSource, null);
  assert.equal(s.view().canChooseTextSource, false);
  const shown = composer();
  await shown.controller.load();
  shown.controller.setText('私密预览');
  shown.controller.toggleSourcePreview();
  shown.runtime.privateViews!.clear();
  assert.equal(shown.view().text, '');
  assert.equal(shown.view().sourcePreview, false);
  assert.equal(shown.view().textSource, null);
  shown.controller.toggleSourcePreview();
  assert.equal(shown.view().sourcePreview, false);
});

test('ordinary plain plus poll publishes through the existing path without extra mode action or data loss', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setText('正文不丢失');
  s.controller.setPollEnabled(true);
  s.controller.setPollQuestion('原问题');
  s.controller.setPollOption(0, '甲');
  s.controller.setPollOption(1, '乙');
  assert.deepEqual(s.view().textSource, DEFAULT_TEXT_SOURCE);
  assert.equal(s.view().canSubmit, true);
  const poll = s.view().pollDraft;
  await s.controller.submit();
  assert.equal(
    s.submissions.length,
    0,
    'legacy poll keeps its existing review/publication path',
  );
  const call = s.gateway.calls.find((entry) => entry.method === 'publishPost');
  assert.ok(call);
  const payload = decodePostIntent(call.args[0]);
  assert.equal(payload.textSource, undefined);
  assert.equal(payload.text, '正文不丢失');
  assert.equal(payload.component?.kind, 'poll');
  assert.deepEqual(poll.options, ['甲', '乙']);
  assert.equal(s.view().receiptStatus, '发布已确认');
  s.controller.dispose();
});
test('explicit Markdown plus poll never reroutes and preserves the draft', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setSourceFormat('markdown');
  s.controller.setText('# 原文');
  s.controller.setPollEnabled(true);
  s.controller.setPollQuestion('问题');
  s.controller.setPollOption(0, '甲');
  s.controller.setPollOption(1, '乙');
  assert.equal(s.view().canSubmit, false);
  await s.controller.submit();
  assert.deepEqual(s.view().textSource, { version: 1, format: 'markdown' });
  assert.equal(s.view().text, '# 原文');
  assert.equal(s.view().pollDraft.enabled, true);
  assert.equal(s.submissions.length, 0);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  s.controller.dispose();
});
test('existing anonymous-DM preference is not discarded or silently source-upgraded', async () => {
  const s = composer();
  s.profiles.current = {
    ...s.profiles.current,
    preferences: {
      ...s.profiles.current.preferences,
      defaultAllowAnonymousDm: true,
    },
  };
  await s.controller.load();
  assert.equal(s.view().textSource, null);
  assert.equal(s.view().allowAnonymousDm, true);
  s.controller.setText('保留偏好');
  assert.equal(s.view().canSubmit, true);
  s.controller.setSourceFormat('markdown');
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.view().allowAnonymousDm, true);
  s.controller.dispose();
});
