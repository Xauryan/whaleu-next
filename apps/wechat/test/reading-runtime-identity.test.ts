import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ApiClient, type Endpoint } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import { readingSourceGateway } from '../src/community/reading-gateway';
import { PendingOwnerPostVisibilityStore } from '../src/owner-post-visibility/pending';
import type { OwnerPostVisibilityGateway } from '../src/owner-post-visibility/gateway';
import type { OwnerVisibilityView } from '../src/owner-post-visibility/controller';
import {
  Cancellation,
  type HttpRequest,
  type HttpResponse,
} from '../src/platform/contracts';
import {
  comment,
  commentId,
  createdAt,
  FakeCommunityGateway,
  post,
  postId,
  reply,
  replyId,
  requestId,
  setup,
} from './community-helpers';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const requireNative = createRequire(__filename);
type NativePage = Record<string, unknown> & {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
};
function invoke(page: NativePage, handler: string, event?: unknown) {
  return (page[handler] as (event?: unknown) => unknown).call(page, event);
}
function mount(
  page: 'community-detail' | 'community-thread',
  runtime: CommunityRuntime,
  api: ApiClient,
) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  const app = {
    community: runtime,
    identity: { api: api as ApiClient | undefined },
  };
  let definition: NativePage | undefined;
  globals.Page = (value: NativePage) => {
    definition = value;
  };
  globals.getApp = () => app;
  globals.wx = {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
  };
  try {
    const target = requireNative.resolve(
      path.join(__dirname, `../src/pages/${page}/${page}.ts`),
    );
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals.Page = previous.Page;
  }
  assert.ok(definition);
  const target: NativePage = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  invoke(target, 'onLoad', {
    postId,
    ...(page === 'community-thread' ? { rootCommentId: commentId } : {}),
  });
  invoke(target, 'onShow');
  return {
    app,
    target,
    close() {
      invoke(target, 'onUnload');
      globals.getApp = previous.getApp;
      globals.wx = previous.wx;
    },
  };
}
const legacy = { classification: 'legacyPlain' };
function sourceResponse(request: HttpRequest): HttpResponse {
  const url = new URL(request.url);
  if (url.pathname === `/v2/community/posts/${postId}`)
    return response({ version: 2, content: post(), body: legacy });
  if (url.pathname === `/v2/community/posts/${postId}/comments`)
    return response({
      version: 2,
      items: [{ content: comment(), body: legacy, replyPreviewBodies: [] }],
      nextCursor: null,
    });
  if (url.pathname === `/v2/community/comments/${commentId}`)
    return response({
      version: 2,
      content: comment(),
      body: legacy,
      replyPreviewBodies: [],
    });
  if (url.pathname === `/v2/community/comments/${commentId}/replies`)
    return response({
      version: 2,
      items: [{ content: reply(), body: legacy }],
      nextCursor: null,
    });
  return response(
    {
      error: {
        code: 'COMMUNITY_UNAVAILABLE',
        message: 'Unavailable in synthetic harness',
      },
    },
    503,
  );
}
async function settled(page: NativePage) {
  for (let i = 0; i < 30 && page.data.busy; i++) await flush();
  assert.equal(page.data.busy, false);
}

for (const mode of ['origin', 'gateway'] as const) {
  test(`actual native detail owner retry observes ${mode} replacement before lookup or dispatch`, async () => {
    const s = setup();
    const store = new PendingOwnerPostVisibilityStore(
      s.storage,
      'https://original-origin.invalid',
    );
    const original = store.freeze({
      version: 1,
      accountId: s.accountId,
      origin: store.origin,
      phase: 'submit',
      command: {
        clientRequestId: requestId,
        postId,
        ownerHidden: true,
        expectedVersion: 0,
      },
    });
    let lookups = 0,
      commands = 0;
    const gateway: OwnerPostVisibilityGateway = {
      management: async () => ({
        postId,
        ownerHidden: false,
        version: 0,
        canChange: true,
      }),
      receipt: async () => {
        lookups++;
        throw new ClientError('http', 'Missing', {
          httpStatus: 404,
          serverCode: 'REQUEST_NOT_FOUND',
        });
      },
      submit: async (command) => {
        commands++;
        return {
          ...command,
          requestId: command.clientRequestId,
          outcome: 'applied',
          version: 1,
          changed: true,
          recordedAt: createdAt,
        };
      },
    };
    Object.assign(s.runtime, {
      pendingOwnerPostVisibility: store,
      ownerPostVisibility: gateway,
    });
    const api = new ApiClient(
      'https://original-origin.invalid',
      { send: async (request) => sourceResponse(request) },
      s.sessions,
      { refresh: async () => s.sessions.snapshot() },
    );
    const h = mount('community-detail', s.runtime, api);
    try {
      await settled(h.target);
      await flush();
      const view = () => h.target.data.ownerVisibility as OwnerVisibilityView;
      assert.equal(view().frozen, true);
      assert.equal(view().pendingRequestId, requestId);
      if (mode === 'origin')
        Object.assign(s.runtime, {
          pendingOwnerPostVisibility: new PendingOwnerPostVisibilityStore(
            s.storage,
            'https://other-origin.invalid',
          ),
        });
      else Object.assign(s.runtime, { ownerPostVisibility: { ...gateway } });
      invoke(h.target, 'onOwnerVisibilityRetry');
      await flush();
      assert.equal(view().busy, false);
      assert.ok(view().error);
      assert.equal(view().frozen, true);
      assert.equal(view().receiptStatus, '');
      assert.equal(lookups, 0);
      assert.equal(commands, 0);
      assert.deepEqual(store.load(s.accountId), original);
    } finally {
      h.close();
    }
  });
}

for (const page of ['community-detail', 'community-thread'] as const) {
  test(`actual native ${page} owners retain exact runtime and deletes retain original transport`, async () => {
    const s = setup();
    const requests: HttpRequest[] = [];
    const api = new ApiClient(
      'https://original-origin.invalid',
      {
        send: async (request) => {
          requests.push(request);
          return sourceResponse(request);
        },
      },
      s.sessions,
      { refresh: async () => s.sessions.snapshot() },
    );
    const h = mount(page, s.runtime, api);
    try {
      await settled(h.target);
      assert.equal(h.target.data.loaded, true);
      const owners = Object.entries(h.target).filter(
        ([, value]) => value && typeof value === 'object' && 'runtime' in value,
      );
      assert.ok(owners.length >= (page === 'community-detail' ? 10 : 4));
      for (const [name, owner] of owners)
        assert.equal(
          (owner as { runtime: CommunityRuntime }).runtime,
          s.runtime,
          name,
        );
      assert.equal(s.runtime.gateway, s.gateway);
      if (page === 'community-detail') {
        const controller = h.target.controller as {
          requestDelete(kind: 'post', id: string): void;
          confirmDelete(): Promise<void>;
        };
        controller.requestDelete('post', postId);
        await controller.confirmDelete();
        assert.equal(
          s.gateway.calls.filter((call) => call.method === 'deletePost').length,
          1,
        );
      } else {
        const controller = h.target.controller as {
          requestDelete(id: string): void;
          confirmDelete(): Promise<void>;
        };
        controller.requestDelete(replyId);
        await controller.confirmDelete();
        assert.equal(
          s.gateway.calls.filter((call) => call.method === 'deleteReply')
            .length,
          1,
        );
      }
      assert.equal(
        requests.some((request) => request.method === 'DELETE'),
        false,
      );
    } finally {
      h.close();
    }
  });
  for (const mode of [
    'gateway',
    'api',
    'revoke-api',
    'sessions',
    'safety',
    'hide',
  ] as const) {
    test(`actual native ${page} discards pending source after ${mode} change without fallback`, async () => {
      const s = setup();
      Object.assign(s.runtime, {
        safetyChanges: new SafetyChanges(s.runtime.privateViews),
      });
      const requests: HttpRequest[] = [],
        late = deferred<HttpResponse>();
      let hold = false;
      const api = new ApiClient(
        'https://original-origin.invalid',
        {
          send: async (request) => {
            requests.push(request);
            return hold && new URL(request.url).pathname.startsWith('/v2/')
              ? late.promise
              : sourceResponse(request);
          },
        },
        s.sessions,
        { refresh: async () => s.sessions.snapshot() },
      );
      const h = mount(page, s.runtime, api);
      try {
        await settled(h.target);
        assert.equal(h.target.data.loaded, true);
        hold = true;
        const controller = h.target.controller as { load(): Promise<void> };
        const work = controller.load();
        await flush();
        const count = requests.length;
        const replacement = new FakeCommunityGateway();
        if (mode === 'gateway')
          Object.assign(s.runtime, { gateway: replacement });
        if (mode === 'api')
          h.app.identity.api = new ApiClient(
            'https://other-origin.invalid',
            {
              send: async () => {
                throw new Error('Replacement origin must not be contacted');
              },
            },
            s.sessions,
            { refresh: async () => s.sessions.snapshot() },
          );
        if (mode === 'revoke-api') h.app.identity.api = undefined;
        if (mode === 'sessions')
          Object.assign(s.runtime, { sessions: setup().sessions });
        if (mode === 'safety')
          Object.assign(s.runtime, {
            safetyChanges: new SafetyChanges(s.runtime.privateViews),
          });
        if (mode === 'hide') s.runtime.privateViews!.clear();
        late.resolve(response({ version: 2, content: post(), body: legacy }));
        await work;
        assert.equal(h.target.data.post, null);
        assert.equal(h.target.data.loaded, false);
        assert.equal(requests.length, count);
        assert.equal(replacement.calls.length, 0);
        if (mode !== 'hide') assert.ok(h.target.data.error);
      } finally {
        h.close();
      }
    });
  }
}

const endpoint: Endpoint<string> = {
  path: '/read',
  method: 'GET',
  authentication: 'required',
  authReplay: 'once',
  decode: (value) => String(value),
  successStatus: 200,
};
for (const mode of [
  'default',
  'guarded',
  'changed',
  'cancelled',
  'relogin',
] as const) {
  test(`request-local reading guard preserves ${mode} authentication refresh behavior`, async () => {
    const s = setup(),
      transport = new ScriptedTransport(),
      refreshed = deferred<ReturnType<typeof s.sessions.snapshot>>();
    let current = true,
      refreshes = 0;
    const api = new ApiClient(
      'https://original-origin.invalid',
      transport,
      s.sessions,
      {
        refresh: () => {
          refreshes++;
          return refreshed.promise;
        },
      },
    );
    transport.reply(
      { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } },
      401,
    );
    transport.reply('fresh');
    const cancellation = new Cancellation();
    const work = api.request(endpoint, {
      cancellation,
      ...(mode === 'default'
        ? {}
        : {
            assertEnvironment: () => {
              if (!current)
                throw new ClientError(
                  'configuration',
                  'Reading environment changed',
                );
            },
          }),
    });
    await flush();
    assert.equal(refreshes, 1);
    assert.equal(transport.requests.length, 1);
    if (mode === 'changed') current = false;
    if (mode === 'cancelled') cancellation.cancel();
    if (mode === 'relogin')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    else s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    refreshed.resolve(s.sessions.snapshot());
    if (mode === 'default' || mode === 'guarded') {
      assert.equal(await work, 'fresh');
      assert.equal(transport.requests.length, 2);
      assert.equal(
        transport.requests[1]!.headers.Authorization,
        `Bearer ${wireCredentials('b').accessToken}`,
      );
    } else {
      await assert.rejects(work);
      assert.equal(transport.requests.length, 1);
    }
  });
}

test('reading API guard checks the transport microtask boundary and is never retained on the shared client', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const api = new ApiClient(
    'https://original-origin.invalid',
    transport,
    s.sessions,
    { refresh: async () => s.sessions.snapshot() },
  );
  let currentApi: ApiClient | undefined = api;
  const reads = readingSourceGateway(s.runtime, () => currentApi)!;
  const work = reads.post(postId, new Cancellation());
  currentApi = undefined;
  await assert.rejects(work, /Reading environment changed/);
  assert.equal(transport.requests.length, 0);
  transport.reply('unaffected');
  assert.equal(await api.request(endpoint), 'unaffected');
  assert.equal(transport.requests.length, 1);
});

test('all six source read routes reject a changed live API before dispatch and before decoding a late response', async () => {
  for (const route of [
    'post',
    'comments',
    'comment',
    'reply',
    'replies',
    'discussionContext',
  ] as const) {
    for (const timing of ['dispatch', 'response'] as const) {
      const s = setup(),
        transport = new ScriptedTransport(),
        late = deferred<HttpResponse>();
      const api = new ApiClient(
        'https://original-origin.invalid',
        transport,
        s.sessions,
        { refresh: async () => s.sessions.snapshot() },
      );
      let current: ApiClient | undefined = api;
      const gateway = readingSourceGateway(s.runtime, () => current)!,
        cancel = new Cancellation();
      transport.steps.push(() => late.promise);
      const work =
        route === 'post'
          ? gateway.post(postId, cancel)
          : route === 'comments'
            ? gateway.comments(postId, null, cancel)
            : route === 'comment'
              ? gateway.comment(commentId, cancel)
              : route === 'reply'
                ? gateway.reply(replyId, cancel)
                : route === 'replies'
                  ? gateway.replies(commentId, null, cancel)
                  : gateway.discussionContext(postId, { replyId }, cancel);
      if (timing === 'response') await flush();
      current = undefined;
      late.resolve(response({ deliberately: 'not a valid source DTO' }));
      await assert.rejects(
        work,
        { kind: 'configuration' },
        `${route}/${timing}`,
      );
      assert.equal(
        transport.requests.length,
        timing === 'dispatch' ? 0 : 1,
        `${route}/${timing}`,
      );
    }
  }
});
