import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  DEFAULT_TEXT_SOURCE,
  type TextSourceDescriptor,
  type TextSourceCapability,
} from '../src/community/text-source-contract';
import {
  batchHarness,
  created,
  history,
  ids,
} from './support/media-batch-fixtures';
import { setup } from './community-helpers';
function fixture(descriptor: TextSourceDescriptor | null) {
  const h = batchHarness(),
    s = setup(),
    views: ComposeView[] = [];
  s.profiles.current = { ...s.profiles.current, accountId: ids.actor };
  Object.assign(s.gateway, {
    textSourceCapabilities: async (
      _space: string,
      _category: string,
      authorMode: 'named' | 'anonymous',
    ): Promise<TextSourceCapability> => ({
      version: 1,
      authorMode,
      availability: 'available',
      operations: ['publish_post'],
      formats: ['plain', 'markdown'],
      readingFormatting: ['auto', 'off'],
      media: 'unavailable',
      markdownReferences: 'unavailable',
      formatter: 'not_configured',
    }),
    submitReview: async () => {
      throw new Error(
        'Image publication must retain existing media review flow',
      );
    },
    reviewStatus: async () => {
      throw new Error('No source Review expected');
    },
  });
  if (descriptor)
    s.runtime.drafts.save(ids.actor, `post:${ids.space}:discussion`, {
      version: 1,
      text: '原正文😀',
      authorMode: 'named',
      commentsPolicy: 'open',
      textSource: descriptor,
    });
  const runtime = {
    ...s.runtime,
    sessions: h.sessions,
    pending: h.publicationPending,
    mediaBatch: h.runtime,
    newRequestId: async () => ids.publication,
  };
  s.gateway.publishPostImpl = async (payload) => {
    assert.equal(payload.imageAssetIds.length, 3);
    assert.equal(payload.textSource, undefined);
    const state = h.current();
    if (state.status !== 'publication_pending')
      throw new Error('Missing genuine batch seal');
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'publish_post',
          intent: {
            spaceId: payload.spaceId,
            category: payload.category,
            text: payload.text,
            imageAssetIds: payload.imageAssetIds,
            authorMode: payload.authorMode,
            commentsPolicy: payload.commentsPolicy,
            ...(payload.allowAnonymousDm === undefined
              ? {}
              : { allowAnonymousDm: payload.allowAnonymousDm }),
          },
        }),
      )
      .digest('hex');
    assert.equal(
      state.publication.intentHash,
      expected,
      'exact existing media request hash, no source domain',
    );
    h.setState(history(state));
    h.setReceipt(created());
    return created();
  };
  const controller = new ComposeController(
    runtime,
    { operation: 'publish_post', spaceId: ids.space, category: 'discussion' },
    (v) => views.push(v),
  );
  return {
    ...h,
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    dispose() {
      controller.dispose();
      h.controller.dispose();
    },
  };
}
test('ordinary saved plain-auto preference plus selected images publishes normally with exact old media hash and no mode action', async () => {
  const h = fixture(DEFAULT_TEXT_SOURCE);
  await h.controller.load();
  await h.controller.recoverImage();
  assert.deepEqual(h.view().textSource, DEFAULT_TEXT_SOURCE);
  assert.equal(h.view().mediaReady, 3);
  assert.equal(h.view().canSubmit, true);
  assert.equal(h.view().text, '原正文😀');
  await h.controller.submit();
  assert.equal(h.view().receiptStatus, '发布已确认');
  assert.equal(h.publicationPending.load(ids.actor), null);
  assert.equal(h.pending.load(ids.actor), null);
  h.dispose();
});
test('explicit Markdown plus selected images stays selected, blocks publication and preserves every image journal entry', async () => {
  const h = fixture({ version: 1, format: 'markdown' });
  await h.controller.load();
  await h.controller.recoverImage();
  const original = h.pending.load(ids.actor);
  assert.ok(original);
  assert.equal(h.view().mediaReady, 3);
  assert.equal(h.view().canSubmit, false);
  assert.match(h.view().blocker, /Markdown/);
  await h.controller.submit();
  assert.deepEqual(h.pending.load(ids.actor), original);
  assert.equal(h.publicationPending.load(ids.actor), null);
  assert.equal(h.view().text, '原正文😀');
  assert.deepEqual(h.view().textSource, { version: 1, format: 'markdown' });
  assert.equal(
    h.gateway.calls.some((entry) => entry.method === 'publishPost'),
    false,
  );
  h.dispose();
});
test('existing image journal without a text draft is never initialized as a source request', async () => {
  const h = fixture(null);
  await h.controller.load();
  await h.controller.recoverImage();
  assert.equal(h.view().textSource, null);
  h.controller.setText('保留历史图片');
  assert.equal(h.view().canSubmit, true);
  await h.controller.submit();
  assert.equal(h.view().receiptStatus, '发布已确认');
  h.dispose();
});
