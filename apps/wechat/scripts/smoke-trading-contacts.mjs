import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Actual emitted page handlers and controllers, synthetic platform/network only.
// This is not device acceptance or ordinary-runtime policy evidence.
export async function smokeTradingContacts({
  app,
  dist,
  mountPage,
  flush,
  postWire,
}) {
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const original = {
    gateway: app.community.gateway,
    identityPrivacy: app.community.identityPrivacy,
    reports: app.community.reports,
    newRequestId: app.community.newRequestId,
    clipboard: globalThis.wx.setClipboardData,
  };
  const accountId = app.identity.sessions.snapshot().credentials.accountId;
  const pages = [],
    copied = [];
  let sequence = 1,
    reads = 0,
    sends = 0,
    state = 'open';
  let contactGate, commentsGate, postGate, mutationGate, lastReceipt;
  const chosen = {
    wechat: 'chosen-public-only',
    qq: '',
    phone: 'literal-phone',
  };
  const listing = () => ({
    ...postWire(),
    category: 'trading',
    component: { kind: 'none' },
    author: {
      kind: 'named',
      profileId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      displayName: 'Synthetic seller',
      avatar: null,
    },
    viewer: { ...postWire().viewer, isSelf: true },
    trading: {
      subtype: { kind: 'known', key: 'shuma', legacyText: null },
      price: { kind: 'exact', amount: '12.5', legacyText: null },
      urgency: 'urgent',
      location: 'Synthetic location',
      resolution: state,
      viewer: { canSetResolution: true },
    },
  });
  const id = listing().id;
  app.community.newRequestId = async () =>
    `cccccccc-cccc-4ccc-8ccc-${String(sequence++).padStart(12, '0')}`;
  app.community.identityPrivacy = undefined;
  app.community.reports = undefined;
  globalThis.wx.setClipboardData = ({ data, success }) => {
    copied.push(data);
    success();
  };
  app.community.gateway = {
    post: async () => {
      const snapshot = listing(),
        gate = postGate;
      postGate = undefined;
      return gate ? gate.promise : snapshot;
    },
    comments: async () => {
      const gate = commentsGate;
      commentsGate = undefined;
      return gate ? gate.promise : { items: [], nextCursor: null };
    },
    like: async (intent) => ({ ...intent, outcome: 'applied' }),
    tradingContacts: async () => {
      reads++;
      const gate = contactGate;
      contactGate = undefined;
      return gate ? gate.promise : { postId: id, contacts: chosen };
    },
    setTradingResolution: async (_id, resolution, requestId) => {
      sends++;
      lastReceipt = {
        requestId,
        operation: 'set_trading_resolution',
        outcome: 'applied',
        resourceId: id,
        resolution,
      };
      const gate = mutationGate;
      mutationGate = undefined;
      if (gate) return gate.promise;
      state = resolution;
      return lastReceipt;
    },
    tradingReceipt: async () => lastReceipt,
  };
  const mount = () => {
    const page = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: id },
    );
    pages.push(page);
    return page;
  };
  const disabled = (page) => {
    assert.equal(page.data.tradingContacts.enabled, false);
    assert.equal(page.data.tradingContacts.contacts, null);
    const before = reads;
    page.onTradingContacts();
    for (const field of ['wechat', 'qq', 'phone'])
      page.onCopyTradingContact({ currentTarget: { dataset: { field } } });
    assert.equal(
      reads,
      before,
      'Direct handlers must not dispatch while invalidated',
    );
  };
  try {
    const page = mount();
    await flush();
    page.onTradingContacts();
    await flush();
    assert.deepEqual(page.data.tradingContacts.contacts, chosen);
    const lateCopy = deferred();
    contactGate = lateCopy;
    page.onCopyTradingContact({
      currentTarget: { dataset: { field: 'phone' } },
    });
    await flush();
    const lostMutation = deferred();
    mutationGate = lostMutation;
    page.onTradingResolution();
    disabled(page); // Synchronous, before request ID generation or network work.
    await flush();
    page.onTradingResolution();
    assert.equal(sends, 1);
    lateCopy.resolve({ postId: id, contacts: chosen });
    await flush();
    assert.deepEqual(copied, []);
    // An unrelated detail render used to re-enable the old open post.
    page.controller.dismissDelete();
    await flush();
    disabled(page);
    lostMutation.reject(new ClientError('network', 'Synthetic response lost'));
    await flush();
    assert.ok(app.community.pendingTrading.load(accountId));
    disabled(page);
    page.onReload();
    await flush();
    disabled(page); // Still unknown, even if GET says open.
    page.onTradingCancel();
    disabled(page);
    const recoveredPost = deferred();
    postGate = recoveredPost;
    page.onTradingReceipt();
    await flush();
    assert.equal(app.community.pendingTrading.load(accountId), null);
    disabled(page); // Receipt is historical, and current detail is still pending.
    recoveredPost.resolve(listing());
    await flush();
    assert.equal(page.data.tradingContacts.enabled, true);
    assert.equal(page.data.tradingContacts.contacts, null);

    // A post GET begun before a resolution remains stale even if comments finish later.
    const oldComments = deferred();
    commentsGate = oldComments;
    const oldRead = page.controller.load();
    await flush();
    const priorReadGeneration = page.controller.readGeneration;
    const pending = deferred();
    mutationGate = pending;
    const mutation = page.tradingMutations.apply(listing(), 'resolved');
    await flush();
    oldComments.resolve({ items: [], nextCursor: null });
    await oldRead;
    assert.equal(page.controller.readGeneration, priorReadGeneration);
    disabled(page);
    const freshPost = deferred();
    postGate = freshPost;
    state = 'resolved';
    pending.resolve(lastReceipt);
    await mutation;
    await flush();
    assert.ok(page.controller.readGeneration > priorReadGeneration);
    disabled(page);
    freshPost.resolve(listing());
    await flush();
    disabled(page);
    page.controller.dismissDelete();
    await flush();
    disabled(page);
    page.onTradingResolution();
    await flush(); // Actual new reopen intent.
    assert.equal(state, 'open');
    assert.equal(page.data.tradingContacts.enabled, true);
    assert.equal(page.data.tradingContacts.contacts, null);
    page.onTradingContacts();
    await flush();
    assert.deepEqual(page.data.tradingContacts.contacts, chosen);

    // Also release the old callback after settlement starts its replacement read.
    const staleComments = deferred();
    commentsGate = staleComments;
    const staleRead = page.controller.load();
    await flush();
    const nextMutation = deferred();
    mutationGate = nextMutation;
    const resolving = page.tradingMutations.apply(listing(), 'resolved');
    await flush();
    const currentPost = deferred();
    postGate = currentPost;
    state = 'resolved';
    nextMutation.resolve(lastReceipt);
    await resolving;
    await flush();
    staleComments.resolve({ items: [], nextCursor: null });
    await staleRead;
    await flush();
    disabled(page);
    assert.equal(
      page.data.post,
      null,
      'Old post read cannot replace settlement reload',
    );
    currentPost.resolve(listing());
    await flush();
    disabled(page);
    page.onTradingResolution();
    await flush();
    assert.equal(state, 'open');
    assert.equal(page.data.tradingContacts.enabled, true);

    // Denial must latch too: an unrelated detail/finally render is not a parent refresh.
    const denied = deferred();
    contactGate = denied;
    page.onTradingContacts();
    await flush();
    denied.reject(
      new ClientError('http', 'Safe unavailable', {
        serverCode: 'POST_NOT_FOUND',
        httpStatus: 404,
      }),
    );
    await flush();
    disabled(page);
    page.controller.dismissDelete();
    await flush();
    disabled(page);
    page.onReload();
    await flush();
    assert.equal(page.data.tradingContacts.enabled, true);
    assert.equal(page.data.tradingContacts.contacts, null);
    page.onHide();
    disabled(page);
    page.onShow();
    await flush();
    assert.equal(page.data.tradingContacts.enabled, true);
    assert.equal(page.data.tradingContacts.contacts, null);
  } finally {
    for (const page of pages) page.onUnload();
    app.community.gateway = original.gateway;
    app.community.identityPrivacy = original.identityPrivacy;
    app.community.reports = original.reports;
    app.community.newRequestId = original.newRequestId;
    globalThis.wx.setClipboardData = original.clipboard;
  }
}
