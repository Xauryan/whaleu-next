import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  otherId,
  post,
  postId,
  receipt,
  requestId,
  spaceId,
  tradingContacts,
  tradingIntent,
  tradingPost,
  tradingReceipt,
  tradingView,
} from './community-helpers';

function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
const feed = (items = [tradingPost()]) => ({
  items,
  nextCursor: null,
  continuation: 'end',
});

test('trading routes use isolated authenticated contacts, desired-state POST and owner-only recovery', async () => {
  const s = setup();
  s.transport.reply({ postId, contacts: tradingContacts() });
  await s.gateway.tradingContacts(postId, new Cancellation());
  s.transport.reply(tradingReceipt(), 201);
  await s.gateway.setTradingResolution(
    postId,
    'resolved',
    requestId,
    new Cancellation(),
  );
  s.transport.reply(tradingReceipt());
  await s.gateway.tradingReceipt(requestId, new Cancellation());
  assert.deepEqual(
    s.transport.requests.map(({ method, url }) => [method, url]),
    [
      [
        'GET',
        `https://api.example/v1/community/posts/${postId}/trading/contacts`,
      ],
      [
        'POST',
        `https://api.example/v1/community/posts/${postId}/trading/resolution`,
      ],
      [
        'GET',
        `https://api.example/v1/me/community/trading-requests/${requestId}`,
      ],
    ],
  );
  assert.deepEqual(s.transport.requests[1]!.body, {
    clientRequestId: requestId,
    resolution: 'resolved',
  });
  assert.ok(
    s.transport.requests.every((request) => request.headers.Authorization),
  );
  assert.equal(s.transport.requests[0]!.body, undefined);
  assert.equal(s.transport.requests[2]!.body, undefined);
  const guest = setup(false);
  await assert.rejects(
    guest.gateway.tradingContacts(postId, new Cancellation()),
    { kind: 'auth-required' },
  );
  await assert.rejects(
    guest.gateway.setTradingResolution(
      postId,
      'resolved',
      requestId,
      new Cancellation(),
    ),
    { kind: 'auth-required' },
  );
  await assert.rejects(
    guest.gateway.tradingReceipt(requestId, new Cancellation()),
    { kind: 'auth-required' },
  );
  assert.equal(guest.transport.requests.length, 0);
});

test('resolution success binds request, post and exact requested resolution; receipts reject mutable snapshots', async () => {
  for (const body of [
    tradingReceipt({ requestId: otherId }),
    tradingReceipt({ resourceId: otherId }),
    tradingReceipt({ resolution: 'open' }),
    { ...tradingReceipt(), operation: 'set_comment_like' },
    { ...tradingReceipt(), contacts: tradingContacts() },
    { ...tradingReceipt(), trading: tradingView() },
    { ...tradingReceipt(), currentResolution: 'open' },
  ]) {
    const s = setup();
    s.transport.reply(body, 201);
    await assert.rejects(
      s.gateway.setTradingResolution(
        postId,
        'resolved',
        requestId,
        new Cancellation(),
      ),
      { kind: 'protocol' },
    );
  }
  for (const status of [200, 202, 204]) {
    const s = setup();
    s.transport.reply(tradingReceipt(), status);
    await assert.rejects(
      s.gateway.setTradingResolution(
        postId,
        'resolved',
        requestId,
        new Cancellation(),
      ),
      { kind: 'protocol' },
    );
  }
  const s = setup();
  s.transport.reply(tradingReceipt({ requestId: otherId }));
  await assert.rejects(
    s.gateway.tradingReceipt(requestId, new Cancellation()),
    { kind: 'protocol' },
  );
  s.transport.reply({
    requestId,
    operation: 'set_trading_resolution',
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  assert.equal(
    (await s.gateway.tradingReceipt(requestId, new Cancellation())).outcome,
    'rejected',
  );
  s.transport.reply({ error: { code: 'REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.tradingReceipt(requestId, new Cancellation()));
  s.transport.reply(tradingReceipt({ resolution: 'open' }), 201);
  assert.equal(
    (
      await s.gateway.setTradingResolution(
        postId,
        'open',
        requestId,
        new Cancellation(),
      )
    ).outcome,
    'applied',
  );
});

test('trading contacts reject wrong parent, unexpected status and nested private fields', async () => {
  const s = setup();
  for (const body of [
    { postId: otherId, contacts: tradingContacts() },
    { postId, contacts: { ...tradingContacts(), accountId: otherId } },
    {
      postId,
      contacts: { ...tradingContacts(), phone: { number: 'private' } },
    },
    { postId, contacts: tradingContacts(), text: 'hidden listing' },
  ]) {
    s.transport.reply(body);
    await assert.rejects(
      s.gateway.tradingContacts(postId, new Cancellation()),
      { kind: 'protocol' },
    );
  }
  s.transport.reply({ postId, contacts: tradingContacts() }, 201);
  await assert.rejects(s.gateway.tradingContacts(postId, new Cancellation()), {
    kind: 'protocol',
  });
});

test('trading subtype feed query is encoded and enforces result category, scope and tagged subtype', async () => {
  const s = setup();
  s.transport.reply(feed());
  await s.gateway.feed(
    {
      spaceId,
      category: 'trading',
      tradingSubtype: 'shuma',
      cursor: 'opaque_-cursor',
    },
    new Cancellation(),
  );
  const url = new URL(s.transport.requests[0]!.url);
  assert.equal(url.pathname, '/v1/community/posts');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    spaceId,
    limit: '10',
    cursor: 'opaque_-cursor',
    category: 'trading',
    tradingSubtype: 'shuma',
  });
  for (const item of [
    post(),
    tradingPost({ space: { id: otherId, kind: 'regional', name: 'other' } }),
    tradingPost({
      trading: tradingView({
        subtype: { kind: 'known', key: 'qiugou', legacyText: null },
      }),
    }),
    tradingPost({
      trading: tradingView({ subtype: { kind: 'legacy', text: 'shuma' } }),
    }),
  ]) {
    s.transport.reply(feed([item]));
    await assert.rejects(
      s.gateway.feed(
        { spaceId, category: 'trading', tradingSubtype: 'shuma' },
        new Cancellation(),
      ),
      { kind: 'protocol' },
    );
  }
  const guest = setup(false);
  guest.transport.reply(feed());
  await guest.gateway.feed(
    { spaceId, category: 'trading' },
    new Cancellation(),
  );
  assert.equal(guest.transport.requests[0]!.headers.Authorization, undefined);
});

test('unfiltered campus feed rejects urgent trading while category feed accepts it without contacts', async () => {
  const s = setup(),
    urgent = tradingPost({ trading: tradingView({ urgency: 'urgent' }) });
  s.transport.reply(feed([urgent]));
  await assert.rejects(s.gateway.feed({ spaceId }, new Cancellation()), {
    kind: 'protocol',
  });
  s.transport.reply(feed([urgent]));
  const result = await s.gateway.feed(
    { spaceId, category: 'trading' },
    new Cancellation(),
  );
  assert.equal(result.items[0]!.trading?.urgency, 'urgent');
  assert.equal(JSON.stringify(result).includes('synthetic-wechat'), false);
  assert.equal(s.transport.requests.length, 2);
});

test('invalid trading targets, request keys and filter inputs fail before network dispatch', async () => {
  const s = setup();
  await assert.rejects(
    s.gateway.tradingContacts('not-an-id', new Cancellation()),
  );
  await assert.rejects(
    s.gateway.tradingReceipt(
      '77777777-7777-1777-8777-777777777777',
      new Cancellation(),
    ),
  );
  await assert.rejects(
    s.gateway.setTradingResolution(
      postId,
      'resolved',
      'not-an-id',
      new Cancellation(),
    ),
  );
  await assert.rejects(
    s.gateway.setTradingResolution(
      postId,
      'bad' as 'open',
      requestId,
      new Cancellation(),
    ),
  );
  await assert.rejects(
    s.gateway.feed({ spaceId, tradingSubtype: 'shuma' }, new Cancellation()),
  );
  await assert.rejects(
    s.gateway.feed(
      { spaceId, category: 'discussion', tradingSubtype: 'shuma' },
      new Cancellation(),
    ),
  );
  await assert.rejects(
    s.gateway.feed(
      {
        spaceId,
        category: 'trading',
        tradingSubtype: 'shuma&limit=100' as 'shuma',
      },
      new Cancellation(),
    ),
  );
  assert.equal(s.transport.requests.length, 0);
});

test('trading auth replay retains exact frozen status and contacts; timeout and cancellation never replay', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(tradingReceipt(), 201);
  await s.gateway.setTradingResolution(
    postId,
    'resolved',
    requestId,
    new Cancellation(),
  );
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  const payload = intent({
    category: 'trading',
    authorMode: 'named',
    trading: tradingIntent({ price: '00012.345678900' }),
  });
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt(), 201);
  await s.gateway.publishPost(payload, new Cancellation());
  assert.deepEqual(
    s.transport.requests[2]!.body,
    s.transport.requests[3]!.body,
  );
  assert.deepEqual(
    (s.transport.requests[3]!.body as { trading: unknown }).trading,
    { ...payload.trading, price: '12.3456789' },
  );
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'safe');
  });
  await assert.rejects(
    s.gateway.setTradingResolution(
      postId,
      'resolved',
      requestId,
      new Cancellation(),
    ),
    { kind: 'timeout' },
  );
  assert.equal(s.transport.requests.length, 5);
  const cancelled = new Cancellation();
  cancelled.cancel();
  await assert.rejects(s.gateway.tradingContacts(postId, cancelled));
  await assert.rejects(
    s.gateway.setTradingResolution(postId, 'open', requestId, cancelled),
  );
  assert.equal(s.transport.requests.length, 5);
});

test('late contact and status results cannot cross an account or login epoch', async () => {
  for (const operation of ['contacts', 'status', 'receipt']) {
    const s = setup();
    s.transport.steps.push(async () => {
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
      return {
        status: operation === 'status' ? 201 : 200,
        headers: {},
        body:
          operation === 'contacts'
            ? { postId, contacts: tradingContacts() }
            : tradingReceipt(),
      };
    });
    const request =
      operation === 'contacts'
        ? s.gateway.tradingContacts(postId, new Cancellation())
        : operation === 'status'
          ? s.gateway.setTradingResolution(
              postId,
              'resolved',
              requestId,
              new Cancellation(),
            )
          : s.gateway.tradingReceipt(requestId, new Cancellation());
    await assert.rejects(request, { kind: 'stale-session' });
  }
});

test('own trading is an authenticated subtype-filtered list with strict self/category and cursor semantics', async () => {
  const s = setup();
  s.transport.reply({ items: [tradingPost()], nextCursor: 'more_opaque' });
  const result = await s.gateway.ownTrading(
    'start_opaque',
    new Cancellation(),
    'shuma',
  );
  assert.equal(result.nextCursor, 'more_opaque');
  const url = new URL(s.transport.requests[0]!.url);
  assert.equal(url.pathname, '/v1/me/community/trading');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    limit: '10',
    cursor: 'start_opaque',
    tradingSubtype: 'shuma',
  });
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  for (const item of [
    post(),
    tradingPost({
      viewer: {
        isSelf: false,
        isLiked: false,
        canDelete: false,
        canComment: true,
        isSaved: false,
        canSave: true,
        canSetUpdatePreference: true,
      },
      trading: tradingView({ viewer: { canSetResolution: false } }),
    }),
    tradingPost({
      trading: tradingView({
        subtype: { kind: 'known', key: 'shujia', legacyText: null },
      }),
    }),
    tradingPost({
      trading: tradingView({ subtype: { kind: 'legacy', text: 'shuma' } }),
    }),
  ]) {
    s.transport.reply({ items: [item], nextCursor: null });
    await assert.rejects(
      s.gateway.ownTrading(null, new Cancellation(), 'shuma'),
      { kind: 'protocol' },
    );
  }
  for (const body of [
    { items: [tradingPost(), tradingPost()], nextCursor: null },
    { items: [], nextCursor: 'bad&cursor' },
    { items: [], nextCursor: null, contacts: tradingContacts() },
    { items: [], nextCursor: null, continuation: 'end' },
  ]) {
    s.transport.reply(body);
    await assert.rejects(s.gateway.ownTrading(null, new Cancellation()), {
      kind: 'protocol',
    });
  }
  const before = s.transport.requests.length;
  await assert.rejects(s.gateway.ownTrading('bad&cursor', new Cancellation()));
  await assert.rejects(
    s.gateway.ownTrading(null, new Cancellation(), 'unknown' as 'shuma'),
  );
  assert.equal(s.transport.requests.length, before);
  const guest = setup(false);
  await assert.rejects(guest.gateway.ownTrading(null, new Cancellation()), {
    kind: 'auth-required',
  });
  assert.equal(guest.transport.requests.length, 0);
});
