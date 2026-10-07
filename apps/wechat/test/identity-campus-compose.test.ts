import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { reasonMessage } from '../src/community/controller';
import { PendingIdentityCampusStore } from '../src/identity-campus/pending';
import { IdentityCampusController } from '../src/pages/identity-campus/controller';
import {
  ComposeController,
  initialComposeView,
  type ComposeTarget,
} from '../src/pages/community-compose/controller';
import {
  commentId,
  otherId,
  postId,
  setup,
  spaceId,
} from './community-helpers';
import {
  campusId,
  FakeIdentityCampusGateway,
  receipt,
  requestId,
  state,
} from './identity-campus-helpers';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';

for (const target of [
  { operation: 'publish_post', spaceId, category: 'discussion' },
  { operation: 'publish_comment', postId },
  {
    operation: 'publish_reply',
    postId,
    rootCommentId: commentId,
    targetReplyId: otherId,
  },
] as const satisfies readonly ComposeTarget[]) {
  test(`${target.operation} keeps exact draft and original target through selector success/cancel; neither returning nor selection sends`, async () => {
    const s = setup();
    let view = initialComposeView();
    let compose = new ComposeController(s.runtime, target, (next) => {
      view = next;
    });
    await compose.load();
    compose.setText('  保留草稿\n不自动发送  ');
    assert.equal(view.canOpenIdentityCampus, true);
    const draft = [...s.storage.data].filter(([key]) =>
      key.includes('.draft.'),
    );
    assert.ok(draft.length);
    const browsingBefore = JSON.stringify(s.profiles.current);
    compose.dispose();
    const gateway = new FakeIdentityCampusGateway();
    const selector = new IdentityCampusController(
      {
        sessions: s.sessions,
        gateway,
        pending: new PendingIdentityCampusStore(s.storage, 'synthetic'),
        privateViews: new PrivateViewLifecycle(),
        newRequestId: async () => requestId,
      },
      () => undefined,
    );
    await selector.load();
    selector.choose(campusId);
    selector.requestConfirmation();
    selector.dismissConfirmation();
    await selector.confirm();
    assert.equal(gateway.calls.filter((c) => c.method === 'select').length, 0);
    selector.requestConfirmation();
    gateway.selectImpl = async () => receipt();
    gateway.stateImpl = async () => state();
    await selector.confirm();
    selector.dispose();
    compose = new ComposeController(s.runtime, target, (next) => {
      view = next;
    });
    await compose.load();
    assert.equal(view.text, '  保留草稿\n不自动发送  ');
    assert.deepEqual(
      [...s.storage.data].filter(([key]) => key.includes('.draft.')),
      draft,
    );
    assert.equal(JSON.stringify(s.profiles.current), browsingBefore);
    assert.equal(
      s.gateway.calls.some((c) =>
        ['publishPost', 'publishComment', 'publishReply'].includes(c.method),
      ),
      false,
    );
    assert.equal(
      s.profiles.calls.some((c) => c.method === 'select'),
      false,
    );
    // Only a new user send action can resume publication, using the unchanged original target.
    await compose.submit();
    const send = s.gateway.calls.find((c) =>
      ['publishPost', 'publishComment', 'publishReply'].includes(c.method),
    );
    assert.ok(send);
    if (target.operation === 'publish_post')
      assert.equal((send.args[0] as { spaceId: string }).spaceId, spaceId);
    else if (target.operation === 'publish_comment')
      assert.equal(send.args[0], postId);
    else assert.equal(send.args[0], commentId);
    compose.dispose();
  });
}
test('failed draft persistence suppresses selector navigation; generic unavailable copy is never rewritten as a missing choice', async () => {
  const s = setup();
  let view = initialComposeView();
  const compose = new ComposeController(
    s.runtime,
    { operation: 'publish_post', spaceId, category: 'discussion' },
    (next) => {
      view = next;
    },
  );
  await compose.load();
  s.storage.failWrite = true;
  compose.setText('不能丢失的草稿');
  assert.equal(view.canOpenIdentityCampus, false);
  assert.doesNotMatch(
    reasonMessage('COMMUNITY_UNAVAILABLE'),
    /请选择|身份校区/,
  );
  assert.doesNotMatch(reasonMessage('IDENTITY_CAMPUS_REQUIRED'), /尚未开放/);
  assert.match(reasonMessage('IDENTITY_CAMPUS_REQUIRED'), /身份校区页面/);
  const template = readFileSync(
    path.join(
      __dirname,
      '../src/pages/community-compose/community-compose.wxml',
    ),
    'utf8',
  );
  assert.match(template, /canOpenIdentityCampus/);
  assert.match(template, /返回后需再次点击发送/);
  assert.doesNotMatch(template, /身份校区选择.*尚未开放/);
});
