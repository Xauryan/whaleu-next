import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { PendingAttemptStore } from '../src/community/pending-attempt';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  otherId,
  postId,
  receipt,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
function composer(
  target: ComposeTarget = {
    operation: 'publish_post',
    spaceId,
    category: 'discussion',
  },
) {
  const s = setup(),
    views: ComposeView[] = [];
  const controller = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  return { ...s, controller, view: () => views[views.length - 1]! };
}
async function ready() {
  const s = composer();
  await s.controller.load();
  s.controller.setText('正文必须保留');
  s.controller.setPollEnabled(true);
  s.controller.setPollQuestion('独立问题');
  s.controller.setPollOption(0, '甲');
  s.controller.setPollOption(1, '乙');
  return s;
}
test('poll composer defaults optional final on with two ordinary options; all variants require post body and question', async () => {
  const s = composer();
  await s.controller.load();
  assert.equal(s.view().pollDraft.enabled, false);
  assert.equal(s.view().pollDraft.finalOption, true);
  assert.deepEqual(s.view().pollDraft.options, ['', '']);
  s.controller.setPollEnabled(true);
  s.controller.setPollQuestion('问题');
  s.controller.setPollOption(0, '甲');
  s.controller.setPollOption(1, '乙');
  assert.equal(s.view().canSubmit, false);
  s.controller.setText('正文');
  assert.equal(s.view().canSubmit, true);
  s.controller.setPollQuestion(' ');
  assert.equal(s.view().canSubmit, false);
  s.controller.setPollQuestion('🐳'.repeat(255));
  assert.equal(s.view().canSubmit, true);
  s.controller.setPollQuestion('🐳'.repeat(256));
  assert.equal(s.view().canSubmit, false);
  s.controller.setPollQuestion('问题');
  s.controller.setPollOption(1, ' 甲 ');
  assert.equal(s.view().canSubmit, false);
  s.controller.setPollOption(1, '乙');
  s.controller.removePollOption(0);
  assert.equal(s.view().pollDraft.options.length, 2);
});
test('final option consumes a total slot, cannot silently displace a fifth ordinary option or create sixth', async () => {
  const s = await ready();
  s.controller.addPollOption();
  s.controller.addPollOption();
  s.controller.addPollOption();
  assert.equal(s.view().pollDraft.options.length, 4);
  assert.equal(s.view().pollDraft.finalOption, true);
  assert.match(s.view().error, /五个/);
  s.controller.setPollFinal(false);
  s.controller.addPollOption();
  assert.equal(s.view().pollDraft.options.length, 5);
  s.controller.setPollFinal(true);
  assert.equal(s.view().pollDraft.finalOption, false);
  assert.match(s.view().error, /先删除/);
  s.controller.removePollOption(4);
  s.controller.setPollFinal(true);
  assert.equal(s.view().pollDraft.finalOption, true);
  assert.equal(s.view().pollDraft.options.length, 4);
});
test('incomplete poll draft persists by account/target and restores mode/question/ordered labels/final preference', async () => {
  const s = await ready();
  s.controller.setPollMode('multiple');
  s.controller.setPollQuestion(' 原问题\r\n🐳 ');
  s.controller.setPollFinal(false);
  s.controller.setPollOption(1, '');
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(
    s.runtime,
    { operation: 'publish_post', spaceId, category: 'discussion' },
    (view) => views.push(view),
  );
  await reopened.load();
  assert.deepEqual(views[views.length - 1]!.pollDraft, {
    enabled: true,
    question: ' 原问题\r\n🐳 ',
    selectionMode: 'multiple',
    options: ['甲', ''],
    finalOption: false,
  });
  assert.equal(views[views.length - 1]!.canSubmit, false);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(views[views.length - 1]!.pollDraft.enabled, false);
  assert.deepEqual(views[views.length - 1]!.pollDraft.options, ['', '']);
});
test('poll publication freezes complete normalized structure; timeout/reopen/retry never rewrite labels or request', async () => {
  const s = await ready();
  s.controller.setPollQuestion(' 问题\r\n🐳 ');
  s.controller.setPollMode('multiple');
  s.controller.setPollOption(0, ' 甲\r\n ');
  s.gateway.publishPostImpl = async (payload) => {
    assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload, payload);
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  s.controller.setPollQuestion('changed');
  s.controller.setPollMode('single');
  s.controller.setPollEnabled(false);
  s.controller.setPollFinal(false);
  s.controller.setPollOption(0, 'changed');
  s.controller.addPollOption();
  s.controller.removePollOption(0);
  const saved = s.runtime.pending.load(s.accountId)!;
  assert.equal(saved.operation, 'publish_post');
  if (saved.operation !== 'publish_post') throw new Error('fixture');
  assert.deepEqual(saved.payload.component, {
    kind: 'poll',
    question: ' 问题\n🐳 ',
    selectionMode: 'multiple',
    options: [' 甲\n ', '乙', '吃瓜🍉'],
  });
  const reread = new PendingAttemptStore(s.storage, 'synthetic').load(
    s.accountId,
  );
  assert.deepEqual(reread, saved);
  s.controller.dispose();
  const views: ComposeView[] = [];
  const recovery = new ComposeController(s.runtime, null, (view) =>
    views.push(view),
  );
  await recovery.load();
  assert.equal(views[views.length - 1]!.pollDraft.enabled, true);
  assert.equal(views[views.length - 1]!.frozen, true);
  s.gateway.publishPostImpl = async () => receipt();
  await recovery.recover(true);
  const sends = s.gateway.calls.filter((call) => call.method === 'publishPost');
  assert.deepEqual(sends[0]!.args[0], sends[1]!.args[0]);
  assert.equal(s.runtime.pending.load(s.accountId), null);
});
test('turning off poll before dispatch produces unchanged C1 intent; comments never accept a poll component', async () => {
  const s = await ready();
  s.controller.setPollEnabled(false);
  await s.controller.submit();
  const sent = s.gateway.calls.find((call) => call.method === 'publishPost')!
    .args[0] as object;
  assert.equal(Object.prototype.hasOwnProperty.call(sent, 'component'), false);
  const comment = composer({ operation: 'publish_comment', postId });
  await comment.controller.load();
  comment.controller.setPollEnabled(true);
  comment.controller.setPollQuestion('forbidden');
  comment.controller.setText('根评论');
  await comment.controller.submit();
  assert.equal(comment.view().canAddPoll, false);
  const payload = comment.gateway.calls.find(
    (call) => call.method === 'publishComment',
  )!.args[1] as object;
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, 'component'),
    false,
  );
});
test('pending plain C1 receipt survives new composer without adding default structured fields', async () => {
  const s = composer();
  const old = intent();
  s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: old,
  });
  await s.controller.load();
  assert.equal(s.view().pollDraft.enabled, false);
  await s.controller.recover(true);
  const sent = s.gateway.calls.find((call) => call.method === 'publishPost')!
    .args[0];
  assert.deepEqual(sent, old);
});
test('secure ID delay, cancellation and account replacement never freeze or dispatch another account poll', async () => {
  const s = await ready(),
    id = deferred<string>();
  Object.assign(s.runtime, { newRequestId: () => id.promise });
  const first = s.controller.submit();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  id.resolve(requestId);
  await first;
  await flush();
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  assert.equal(s.view().pollDraft.enabled, false);
});
