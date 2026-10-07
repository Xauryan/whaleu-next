import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  TradingMutationController,
  TradingContactsController,
  type TradingMutationView,
  type TradingContactsView,
} from '../src/community/trading-controller';
import { PendingTradingStore } from '../src/community/trading-pending';
import type {
  TradingContactView,
  TradingReceipt,
} from '../src/community/trading-contract';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  otherId,
  postId,
  requestId,
  setup,
  spaceId,
  tradingContacts,
  tradingPost,
  tradingReceipt,
  tradingView,
  receipt,
  commentId,
} from './community-helpers';
function mutation() {
  const s = setup(),
    views: TradingMutationView[] = [];
  let settled = 0;
  const controller = new TradingMutationController(
    s.runtime,
    (view) => views.push(view),
    () => settled++,
  );
  return {
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    settled: () => settled,
  };
}
function contacts() {
  const s = setup(),
    views: TradingContactsView[] = [],
    copied: string[] = [];
  const controller = new TradingContactsController(
    s.runtime,
    (view) => views.push(view),
    async (text) => {
      copied.push(text);
    },
  );
  return { ...s, controller, copied, view: () => views[views.length - 1]! };
}
async function compose() {
  const s = setup(),
    views: ComposeView[] = [];
  const controller = new ComposeController(
    s.runtime,
    { operation: 'publish_post', spaceId, category: 'trading' },
    (view) => views.push(view),
  );
  await controller.load();
  return { ...s, controller, view: () => views[views.length - 1]! };
}
function fill(c: ComposeController) {
  c.setText(' 原交易正文\r\n第二行 ');
  c.setTradingField('price', '00012.34000500');
  c.setTradingField('location', ' 北门 ');
  c.setTradingField('wechat', ' chosen-user ');
  c.setContactConsent(true);
}
test('trading composer forces named independently of saved anonymous default and excludes poll/group/link components', async () => {
  const s = await compose();
  assert.equal(s.view().authorMode, 'named');
  assert.equal(s.view().identityForced, true);
  assert.equal(s.view().canAddPoll, false);
  assert.equal(s.view().tradingDraft.urgency, 'urgent');
  assert.equal(s.view().tradingDraft.location, '');
  assert.equal(s.view().tradingDraft.phone, '');
  s.controller.setPollEnabled(true);
  s.controller.setAuthorMode('anonymous');
  assert.equal(s.view().pollDraft.enabled, false);
  assert.equal(s.view().authorMode, 'named');
  fill(s.controller);
  s.controller.setContactConsent(false);
  assert.equal(s.view().canSubmit, false);
  assert.match(s.view().blocker, /公开/);
  s.controller.setContactConsent(true);
  assert.equal(s.view().canSubmit, true);
  s.controller.setTradingSubtype('qiugou');
  s.controller.setTradingUrgency('urgent');
  assert.equal(s.view().tradingDraft.urgency, 'normal');
  s.controller.setTradingSubtype('shujia');
  assert.equal(s.view().tradingDraft.urgency, 'urgent');
  s.controller.setTradingField('price', '0');
  assert.equal(s.view().canSubmit, false);
  s.controller.setTradingField('price', '99999.00000000001');
  assert.equal(s.view().canSubmit, false);
  s.controller.setTradingField('price', '99999');
  assert.equal(s.view().canSubmit, true);
});
test('complete listing publication freezes exact decimal, contacts, scope and identity before sending; restart cannot edit unknown intent', async () => {
  const s = await compose();
  fill(s.controller);
  s.gateway.publishPostImpl = async (payload) => {
    assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload, payload);
    assert.equal(payload.trading?.price, '12.340005');
    assert.equal(payload.trading?.contacts.wechat, ' chosen-user ');
    assert.equal(payload.component, undefined);
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.submit();
  const saved = s.runtime.pending.load(s.accountId)!;
  assert.equal(saved.payload.text, ' 原交易正文\n第二行 ');
  assert.equal(s.view().frozen, true);
  s.controller.setTradingField('wechat', 'replacement');
  s.controller.setTradingSubtype('qiugou');
  assert.deepEqual(s.runtime.pending.load(s.accountId), saved);
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(s.runtime, null, (view) =>
    views.push(view),
  );
  await reopened.load();
  assert.equal(views[views.length - 1]!.isTrading, true);
  assert.equal(views[views.length - 1]!.tradingDraft.wechat, ' chosen-user ');
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await reopened.recover();
  assert.deepEqual(s.runtime.pending.load(s.accountId), saved);
  s.gateway.publishPostImpl = async (payload) => {
    assert.deepEqual(payload, saved.payload);
    return receipt();
  };
  await reopened.recover(true);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.tradingDraft.wechat, '');
});
test('incomplete listing draft remains account/origin isolated; old C1/C2A intent bytes are unchanged', async () => {
  const s = await compose();
  fill(s.controller);
  s.controller.setTradingField('price', '');
  s.controller.setTradingField('qq', 'draft-only');
  await s.controller.load();
  assert.equal(s.view().tradingDraft.qq, 'draft-only');
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.runtime.drafts.load(otherId, `post:${spaceId}:trading`), null);
  const old = {
    version: 1 as const,
    accountId: s.accountId,
    operation: 'publish_post' as const,
    payload: intent(),
  };
  s.runtime.pending.freeze(old);
  assert.equal(
    JSON.stringify(s.runtime.pending.load(s.accountId)),
    JSON.stringify(old),
  );
  assert.equal(
    'trading' in s.runtime.pending.load(s.accountId)!.payload,
    false,
  );
});
test('status journal is isolated from C1 publication, C2A ballot and C2B interaction; exact original resolution alone can settle', async () => {
  const s = mutation();
  s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: intent(),
  });
  s.runtime.pendingBallots.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    payload: { clientRequestId: requestId, optionIds: [otherId] },
  });
  s.runtime.pendingDiscussion.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'set_comment_like',
    postId,
    rootCommentId: commentId,
    targetId: commentId,
    desired: true,
    clientRequestId: requestId,
  });
  s.gateway.setTradingResolutionImpl = async () => {
    assert.equal(
      s.runtime.pendingTrading.load(s.accountId)?.resolution,
      'resolved',
    );
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.apply(tradingPost(), 'resolved');
  const saved = s.runtime.pendingTrading.load(s.accountId)!;
  assert.equal(
    new PendingTradingStore(s.storage, 'other-origin').load(s.accountId),
    null,
  );
  assert.equal(s.runtime.pendingTrading.load(otherId), null);
  assert.deepEqual(
    new PendingTradingStore(s.storage, 'synthetic').load(s.accountId),
    saved,
  );
  await s.controller.apply(
    tradingPost({ trading: tradingView({ resolution: 'resolved' }) }),
    'open',
  );
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'setTradingResolution')
      .length,
    1,
  );
  s.gateway.tradingReceiptImpl = async () =>
    tradingReceipt({ resolution: 'open' });
  await s.controller.recover();
  assert.deepEqual(s.runtime.pendingTrading.load(s.accountId), saved);
  s.gateway.tradingReceiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.recover();
  assert.deepEqual(s.runtime.pendingTrading.load(s.accountId), saved);
  s.gateway.tradingReceiptImpl = async () => tradingReceipt();
  await s.controller.recover();
  assert.equal(s.runtime.pendingTrading.load(s.accountId), null);
  assert.equal(s.settled(), 1);
  assert.ok(s.runtime.pending.load(s.accountId));
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  assert.ok(s.runtime.pendingDiscussion.load(s.accountId));
});
test('status storage failures and corruption fail closed; rejected terminal receipt releases only its original journal', async () => {
  const s = mutation();
  s.storage.failWrite = true;
  await s.controller.apply(tradingPost(), 'resolved');
  assert.equal(s.gateway.calls.length, 0);
  s.storage.failWrite = false;
  s.gateway.setTradingResolutionImpl = async () => {
    s.storage.failRemove = true;
    return tradingReceipt();
  };
  await s.controller.apply(tradingPost(), 'resolved');
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingTrading.load(s.accountId));
  s.storage.failRemove = false;
  s.gateway.tradingReceiptImpl = async () => ({
    requestId,
    operation: 'set_trading_resolution',
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  await s.controller.recover();
  assert.equal(s.runtime.pendingTrading.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  s.storage.set(
    `whaleu.community.trading.pending.v1:synthetic:${s.accountId}`,
    { resolution: 'open' },
  );
  s.controller.load();
  assert.equal(s.view().frozen, true);
});
for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account',
  'switch-account',
] as const) {
  test(`listing status ${lifecycle} ignores late success and preserves unresolved original intent`, async () => {
    const s = mutation(),
      pending = deferred<TradingReceipt>();
    s.gateway.setTradingResolutionImpl = async () => pending.promise;
    const running = s.controller.apply(tradingPost(), 'resolved');
    await flush();
    assert.ok(s.runtime.pendingTrading.load(s.accountId));
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    pending.resolve(tradingReceipt());
    await running;
    assert.ok(s.runtime.pendingTrading.load(s.accountId));
    assert.equal(s.settled(), 0);
  });
  test(`contact ${lifecycle} clears private render and prevents late clipboard disclosure`, async () => {
    const s = contacts(),
      pending = deferred<TradingContactView>();
    s.controller.load(tradingPost());
    await s.controller.reveal();
    assert.ok(s.view().contacts);
    s.gateway.tradingContactsImpl = async () => pending.promise;
    const running = s.controller.copy('phone');
    await flush();
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    pending.resolve({
      postId,
      contacts: tradingContacts({ phone: 'private-late-contact' }),
    });
    await running;
    assert.equal(s.view().contacts, null);
    assert.deepEqual(s.copied, []);
    assert.equal(
      JSON.stringify([...s.storage.data.values()]).includes(
        'private-late-contact',
      ),
      false,
    );
  });
}
test('contact display is explicit; each copy reauthorizes and preserves literal data with no inferred phone or URL action', async () => {
  const s = contacts();
  s.controller.load(tradingPost());
  assert.equal(s.gateway.calls.length, 0);
  const original = ' https://example.invalid/raw?x=1\n电话不是认证 ';
  s.gateway.tradingContactsImpl = async () => ({
    postId,
    contacts: tradingContacts({ wechat: original }),
  });
  await s.controller.reveal();
  assert.equal(s.view().contacts?.wechat, original);
  await s.controller.copy('wechat');
  assert.deepEqual(s.copied, [original]);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'tradingContacts').length,
    2,
  );
  s.gateway.tradingContactsImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.copy('wechat');
  assert.equal(s.view().contacts, null);
  assert.deepEqual(s.copied, [original]);
  s.controller.load(null);
  await s.controller.reveal();
  assert.equal(s.gateway.calls.length, 3);
});
test('same-tick cancellation prevents status persistence and dispatch; repeated taps never launch another request', async () => {
  const s = mutation();
  const running = s.controller.apply(tradingPost(), 'resolved');
  s.controller.cancel();
  await running;
  assert.equal(s.runtime.pendingTrading.load(s.accountId), null);
  assert.equal(s.gateway.calls.length, 0);
  const pending = deferred<TradingReceipt>();
  s.gateway.setTradingResolutionImpl = async () => pending.promise;
  const next = s.controller.apply(tradingPost(), 'resolved');
  await s.controller.apply(tradingPost(), 'resolved');
  await flush();
  assert.equal(s.gateway.calls.length, 1);
  pending.resolve(tradingReceipt());
  await next;
});

test('confirmed publication remembers only the chosen complete contact set and manual location; fresh listing requires consent again', async () => {
  const s = await compose();
  fill(s.controller);
  s.controller.setTradingField('qq', 'first-qq');
  await s.controller.submit();
  assert.deepEqual(s.runtime.drafts.loadTradingPreferences(s.accountId), {
    version: 1,
    location: ' 北门 ',
    contacts: { wechat: ' chosen-user ', qq: 'first-qq', phone: '' },
  });
  assert.equal(s.runtime.drafts.loadTradingPreferences(otherId), null);
  await s.controller.load();
  assert.equal(s.view().tradingDraft.wechat, ' chosen-user ');
  assert.equal(s.view().tradingDraft.contactConsent, false);
  s.controller.setText('next listing');
  s.controller.setTradingField('price', '23');
  s.controller.setTradingField('qq', '');
  s.controller.setContactConsent(true);
  await s.controller.submit();
  assert.equal(
    s.runtime.drafts.loadTradingPreferences(s.accountId)?.contacts.qq,
    '',
  );
});
