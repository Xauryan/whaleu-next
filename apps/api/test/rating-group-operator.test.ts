import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import {
  promotionBrowserBridgeScript,
  RATING_PROMOTION_BROWSER_PROFILE,
  startPromotionBrowser,
} from './support/rating-group-operator-browser.js';
import {
  createRatingGroupPromotionOperator,
  ratingGroupPromotionOperatorModuleSource,
  renderRatingGroupPromotionOperatorShell,
  RATING_GROUP_PROMOTION_OPERATOR_HEADERS,
  RATING_GROUP_PROMOTION_OPERATOR_SCRIPT_PATH,
  type RatingPromotionOperatorBridge,
  type RatingPromotionOperatorJournal,
  type RatingPromotionOperatorState,
  type RatingPromotionOperatorStorage,
} from '../src/ratings/group-promotion/operator.js';

const origin = 'https://operator.example';
const actorId = randomUUID();
const programId = randomUUID();
const revision = randomUUID();
const previewId = randomUUID();
const requestId = randomUUID();
const destinationId = randomUUID();
const campaignId = randomUUID();
const requestHash = 'a'.repeat(64);
const now = Date.parse('2026-10-14T05:00:00.000Z');
const expiry = new Date(now + 900000).toISOString();
const original: RatingPromotionOperatorJournal = {
  origin,
  actorId,
  programId,
  requestId,
  ticketExpiresAt: expiry,
  requestHash,
};
const journalKey = `rating-group-promotion:v1:${encodeURIComponent(origin)}:${actorId}:${programId}`;
const approvedDestination = {
  id: destinationId,
  label: 'Accepted test destination',
};
const metadata = {
  requestId,
  requestHash,
  campaignId,
  admission: 'admitted',
  composition: 'ready',
  delivery: 'pending',
  cancelRequested: false,
  payloadExpired: false,
  counts: { confirmed: 0, unknown: 0, notSent: 0, pending: 3 },
};
const intent = {
  requestId,
  requestHash,
  intentTicket: 'server-signed-opaque-intent',
  expiresAt: expiry,
};
const program = {
  programId,
  revision,
  type: 'course',
  audience: { school: 2, default: 1, test: 1, total: 4 },
  copyModes: ['deterministic', 'assisted'],
  linkModes: ['native', 'shortlink_optional'],
};
const preview = {
  previewId,
  type: 'course',
  mode: 'normal',
  expectedProgramRevision: revision,
  copy: '同学们来给上过的课打个分吧',
  locator: `pages/rating-catalog/rating-catalog?parentId=${randomUUID()}`,
  expiresAt: new Date(now + 300000).toISOString(),
  audience: { school: 2, default: 1, test: 0, total: 3 },
};
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  overrides: {
    initial?: RatingPromotionOperatorJournal;
    clock?: () => number;
    storage?: RatingPromotionOperatorStorage;
    route?: (
      path: string,
      method: string,
      body: Record<string, unknown> | null,
    ) => Response | Promise<Response> | undefined;
  } = {},
) {
  const entries = new Map<string, string>();
  if (overrides.initial)
    entries.set(journalKey, JSON.stringify(overrides.initial));
  const storage: RatingPromotionOperatorStorage = overrides.storage ?? {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let invalidate = () => {};
  let lookup: Record<string, unknown> = { recorded: false };
  let currentOrigin = origin;
  let currentActor: string = actorId;
  const history: RatingPromotionOperatorState[] = [];
  const bridge: RatingPromotionOperatorBridge = {
    version: 'rating-group-promotion-v1',
    origin,
    getIdentity: async () => ({ actorId: currentActor, origin }),
    subscribe: (callback) => {
      invalidate = callback;
      return () => {
        invalidate = () => {};
      };
    },
    request: async (path, init) => {
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'same-origin');
      assert.ok(path.startsWith('/v1/rating-group-promotion/'));
      assert.equal(init.signal.aborted, false);
      const body =
        init.body === undefined
          ? null
          : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ path, method: init.method, body });
      const override = await overrides.route?.(path, init.method, body);
      if (override) return override;
      if (path.includes('/capabilities?'))
        return response({
          enabled: true,
          mode: 'synthetic-only',
          actions: ['preview', 'send', 'test', 'inspect', 'cancel'],
        });
      if (path.endsWith(`/programs/${programId}`)) return response(program);
      if (path.includes('/destinations?'))
        return response({ items: [approvedDestination], nextCursor: null });
      if (path.endsWith('/previews'))
        return response(
          body?.['mode'] === 'test'
            ? {
                ...preview,
                mode: 'test',
                testDestination: approvedDestination,
                audience: { school: 0, default: 0, test: 1, total: 1 },
              }
            : preview,
        );
      if (path.endsWith('/intents')) return response(intent);
      if (path.includes('/requests/') && !path.endsWith('/cancel'))
        return response(lookup);
      if (path.includes('/intents/'))
        return response({ recorded: false, ...intent });
      if (path.endsWith('/campaigns')) {
        lookup = { recorded: true, status: metadata };
        return response(metadata, 202);
      }
      if (path.endsWith('/cancel'))
        return response({
          requestId,
          sealed: true,
          status: { ...metadata, cancelRequested: true },
        });
      if (path.endsWith(`/campaigns/${campaignId}`))
        return response({
          ...metadata,
          payload: { copy: preview.copy, locator: preview.locator },
        });
      throw new Error(`Unexpected fixture route ${path}`);
    },
  };
  const create = () =>
    createRatingGroupPromotionOperator({
      origin,
      programId,
      bridge,
      storage,
      getOrigin: () => currentOrigin,
      now: overrides.clock ?? (() => now),
      randomUUID,
      onChange: (state) => history.push(state),
    });
  const controller = create();
  return {
    controller,
    create,
    calls,
    entries,
    storage,
    history,
    invalidate: () => invalidate(),
    changeOrigin: (value: string) => {
      currentOrigin = value;
    },
    changeActor: (value: string) => {
      currentActor = value;
    },
    record: (value: Record<string, unknown>) => {
      lookup = value;
    },
  };
}
async function prepare(
  f: ReturnType<typeof fixture>,
  mode: 'normal' | 'test' = 'normal',
) {
  await f.controller.connect();
  assert.equal(f.controller.getState().phase, 'ready');
  await f.controller.preview(mode, mode === 'test' ? destinationId : undefined);
  assert.equal(f.controller.getState().phase, 'preview');
}
function confirm(f: ReturnType<typeof fixture>) {
  const current = f.controller.getState();
  return f.controller.confirm({
    previewId: current.preview!.previewId,
    confirmation: current.confirmation!,
    copyMode: 'deterministic',
    linkMode: 'native',
  });
}
function campaigns(f: ReturnType<typeof fixture>) {
  return f.calls.filter((call) => call.path.endsWith('/campaigns'));
}

test('shell is no-store, same-origin CSP, credential-free, and has only the operational entry', () => {
  const html = renderRatingGroupPromotionOperatorShell();
  assert.match(html, /Operational replacement for the legacy rating link URL/);
  assert.ok(
    html.includes(`src="${RATING_GROUP_PROMOTION_OPERATOR_SCRIPT_PATH}"`),
  );
  assert.doesNotMatch(
    html,
    /<script(?! type="module" src=)|\son[a-z]+\s*=|password|bearer|token|iframe|https?:\/\//i,
  );
  assert.match(html, /id="promotion-confirm"[^>]*disabled/);
  assert.equal(
    RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Cache-Control'],
    'no-store, private, max-age=0',
  );
  assert.match(
    RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Content-Security-Policy'],
    /default-src 'none'/,
  );
  assert.match(
    RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Content-Security-Policy'],
    /script-src 'self'/,
  );
  assert.doesNotMatch(
    RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Content-Security-Policy'],
    /unsafe-inline|unsafe-eval|https?:/,
  );
});

test('browser factories serialize as standalone executable JavaScript without server imports', () => {
  const source = ratingGroupPromotionOperatorModuleSource();
  assert.doesNotMatch(source, /node:|require\(|import\s/);
  // Unit smoke only. Real emitted-module DOM/HTTP/PG browser acceptance is separate.
  const prefix = source.slice(
    0,
    source.lastIndexOf(
      'mountRatingGroupPromotionOperator(createRatingGroupPromotionOperator, window);',
    ),
  );
  const value = vm.runInNewContext(
    `${prefix}\ncreateRatingGroupPromotionOperator({origin: 'https://operator.example', programId: '${programId}', bridge: null, storage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}}).getState().phase + ':' + typeof mountRatingGroupPromotionOperator`,
    { AbortController, structuredClone },
  );
  assert.equal(value, 'blocked:function');
});

test('unsupported bridge and broken journal reads send zero requests', async () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const controller = createRatingGroupPromotionOperator({
    origin,
    programId,
    bridge: null,
    storage,
  });
  await controller.connect();
  assert.equal(controller.getState().error, 'PROMOTION_UNSUPPORTED_BRIDGE');
  const f = fixture({
    storage: {
      ...storage,
      getItem: () => {
        throw new Error('blocked');
      },
    },
  });
  await f.controller.connect();
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getState().error, 'PROMOTION_JOURNAL_UNAVAILABLE');
});

test('normal confirmation names exact school/default snapshot; double click sends one immutable opaque command', async () => {
  const f = fixture();
  await prepare(f);
  assert.equal(
    f.controller.getState().confirmation,
    'Send to enrolled groups (3 groups: 2 school, 1 default)',
  );
  assert.equal(campaigns(f).length, 0);
  await Promise.all([confirm(f), confirm(f)]);
  assert.equal(campaigns(f).length, 1);
  assert.deepEqual(campaigns(f)[0]?.body, {
    requestId,
    intentTicket: intent.intentTicket,
    requestHash,
  });
  assert.deepEqual(JSON.parse(f.entries.get(journalKey)!), original);
  assert.equal(f.controller.getState().phase, 'recorded');
  assert.equal(f.controller.getState().payload, null);
  const campaignIndex = f.calls.findIndex((call) =>
    call.path.endsWith('/campaigns'),
  );
  assert.ok(
    f.calls
      .slice(0, campaignIndex)
      .some((call) => call.path.endsWith(`/intents/${requestId}`)),
  );
  assert.doesNotMatch(
    f.entries.get(journalKey)!,
    /copy|locator|intentTicket|server-signed|receiver|destination|bearer/i,
  );
});

test('test confirmation names exactly one approved test destination and contains no normal audience', async () => {
  const f = fixture();
  await prepare(f, 'test');
  assert.equal(
    f.controller.getState().confirmation,
    'Send only to test destination “Accepted test destination” (1 group)',
  );
  assert.deepEqual(f.controller.getState().preview?.audience, {
    school: 0,
    default: 0,
    test: 1,
    total: 1,
  });
  await confirm(f);
  assert.equal(campaigns(f).length, 1);
  assert.deepEqual(
    f.calls.find((call) => call.path.endsWith('/previews'))?.body,
    {
      type: 'course',
      mode: 'test',
      testDestinationId: destinationId,
      expectedProgramRevision: revision,
    },
  );
});

test('wrong confirmation, unknown destination, and changed selection cannot send', async () => {
  const f = fixture();
  await prepare(f);
  await f.controller.confirm({
    previewId,
    confirmation: 'Send',
    copyMode: 'deterministic',
    linkMode: 'native',
  });
  assert.equal(campaigns(f).length, 0);
  assert.equal(f.controller.getState().error, 'PROMOTION_INVALID_REQUEST');
  const changed = fixture();
  await prepare(changed);
  changed.controller.clearPreview();
  await changed.controller.confirm({
    previewId,
    confirmation: 'Send to enrolled groups (3 groups: 2 school, 1 default)',
    copyMode: 'deterministic',
    linkMode: 'native',
  });
  assert.equal(campaigns(changed).length, 0);
  const unknown = fixture();
  await unknown.controller.connect();
  await unknown.controller.preview('test', randomUUID());
  assert.equal(
    unknown.calls.filter((call) => call.path.endsWith('/previews')).length,
    0,
  );
});

test('journal write and readback failures send zero campaign POSTs', async () => {
  for (const failure of ['write', 'readback']) {
    let written = false;
    const f = fixture({
      storage: {
        getItem: () => (written ? null : null),
        setItem: () => {
          written = true;
          if (failure === 'write') throw new Error('quota');
        },
        removeItem: () => {},
      },
    });
    await prepare(f);
    await confirm(f);
    assert.equal(campaigns(f).length, 0, failure);
    assert.equal(
      f.controller.getState().error,
      'PROMOTION_JOURNAL_UNAVAILABLE',
    );
  }
});

test('reload after journal readback before POST recovers exact server intent without preview or new key', async () => {
  const f = fixture({ initial: original });
  await f.controller.connect();
  assert.equal(f.controller.getState().phase, 'recorded');
  assert.equal(campaigns(f).length, 1);
  assert.deepEqual(campaigns(f)[0]?.body, {
    requestId,
    intentTicket: intent.intentTicket,
    requestHash,
  });
  assert.equal(
    f.calls.some((call) => /\/previews$|\/intents$/.test(call.path)),
    false,
  );
});

test('lost durable admission response then expired reload returns same metadata without ticket or payload', async () => {
  const f = fixture({ initial: original, clock: () => now + 900001 });
  f.record({
    recorded: true,
    status: { ...metadata, payload: { copy: 'secret', locator: 'secret' } },
  });
  await f.controller.connect();
  assert.equal(f.calls.length, 1);
  assert.equal(campaigns(f).length, 0);
  assert.equal(f.controller.getState().metadata?.campaignId, campaignId);
  assert.equal(f.controller.getState().payload, null);
  assert.equal(
    JSON.stringify(f.controller.getState()).includes('secret'),
    false,
  );
});

test('unrecorded stale preview never silently refreshes or allocates a new key', async () => {
  const f = fixture({
    initial: original,
    route: (path) =>
      path.endsWith('/campaigns')
        ? response({ code: 'PROMOTION_PREVIEW_STALE' }, 409)
        : undefined,
  });
  await f.controller.connect();
  assert.equal(f.controller.getState().error, 'PROMOTION_PREVIEW_STALE');
  assert.equal(campaigns(f).length, 1);
  assert.equal(
    f.calls.some((call) => /\/previews$|\/intents$/.test(call.path)),
    false,
  );
  assert.deepEqual(JSON.parse(f.entries.get(journalKey)!), original);
  await f.controller.preview('normal');
  assert.equal(f.controller.getState().error, 'PROMOTION_REQUEST_PENDING');
});

test('expired unrecorded intent and conflicting original hashes cannot POST', async () => {
  const expired = fixture({ initial: original, clock: () => now + 900001 });
  await expired.controller.connect();
  assert.equal(expired.controller.getState().error, 'PROMOTION_INTENT_EXPIRED');
  assert.equal(campaigns(expired).length, 0);
  const changed = fixture({
    initial: original,
    route: (path) =>
      path.includes('/intents/')
        ? response({ ...intent, requestHash: 'b'.repeat(64) })
        : undefined,
  });
  await changed.controller.connect();
  assert.equal(
    changed.controller.getState().error,
    'PROMOTION_REQUEST_CONFLICT',
  );
  assert.equal(campaigns(changed).length, 0);
});

test('refresh stays blocked until durable seal, and a refreshed campaign needs separate confirmation', async () => {
  const gate = deferred<Response>();
  const f = fixture({
    initial: original,
    route: (path) => (path.endsWith('/cancel') ? gate.promise : undefined),
  });
  f.record({ recorded: true, status: metadata });
  await f.controller.connect();
  const sealing = f.controller.sealOriginal();
  await Promise.resolve();
  await f.controller.preview('normal');
  assert.equal(
    f.calls.filter((call) => call.path.endsWith('/previews')).length,
    0,
  );
  assert.ok(f.entries.has(journalKey));
  gate.resolve(
    response({
      requestId,
      sealed: true,
      status: { ...metadata, cancelRequested: true },
    }),
  );
  await sealing;
  assert.equal(f.entries.has(journalKey), false);
  await f.controller.preview('normal');
  assert.equal(f.controller.getState().phase, 'preview');
  assert.equal(campaigns(f).length, 0);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith('/intents')).length,
    0,
  );
});

test('cancel acknowledgement without durable seal never clears original journal', async () => {
  const f = fixture({
    initial: original,
    route: (path) =>
      path.endsWith('/cancel')
        ? response({ requestId, cancelled: true })
        : undefined,
  });
  f.record({ recorded: true, status: metadata });
  await f.controller.connect();
  await f.controller.sealOriginal();
  assert.ok(f.entries.has(journalKey));
  assert.equal(f.controller.getState().error, 'PROMOTION_INVALID_RESPONSE');
});

test('hide, sign-out and stale callbacks erase current payload and cannot revive the view', async () => {
  for (const invalidate of ['hide', 'signout', 'navigate']) {
    const gate = deferred<Response>();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const f = fixture({
      initial: original,
      route: (path) =>
        path.endsWith(`/campaigns/${campaignId}`)
          ? (reached(), gate.promise)
          : undefined,
    });
    f.record({ recorded: true, status: metadata });
    await f.controller.connect();
    const reading = f.controller.inspectPayload();
    await started;
    if (invalidate === 'hide') f.controller.suspend();
    else if (invalidate === 'signout') f.invalidate();
    else {
      f.changeOrigin('https://other.example');
      f.controller.suspend();
    }
    assert.equal(f.controller.getState().metadata, null);
    assert.equal(f.controller.getState().payload, null);
    gate.resolve(
      response({
        ...metadata,
        payload: { copy: preview.copy, locator: preview.locator },
      }),
    );
    await reading;
    assert.equal(f.controller.getState().phase, 'hidden');
    assert.equal(f.controller.getState().payload, null);
    assert.ok(f.entries.has(journalKey));
  }
});

test('late intent after navigation cannot persist journal or send a campaign', async () => {
  const gate = deferred<Response>();
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const f = fixture({
    route: (path) =>
      path.endsWith('/intents') ? (reached(), gate.promise) : undefined,
  });
  await prepare(f);
  const sending = confirm(f);
  await started;
  f.controller.suspend();
  gate.resolve(response(intent));
  await sending;
  assert.equal(campaigns(f).length, 0);
  assert.equal(f.entries.size, 0);
  assert.equal(f.controller.getState().phase, 'hidden');
});

test('account/program/origin scope never recovers another journal', async () => {
  const f = fixture({ initial: original });
  f.changeActor(randomUUID());
  await f.controller.connect();
  assert.equal(
    f.calls.some(
      (call) =>
        call.path.includes('/requests/') || call.path.includes('/intents/'),
    ),
    false,
  );
  const other = fixture({ initial: original });
  await other.controller.navigate(randomUUID());
  assert.equal(
    other.calls.some(
      (call) =>
        call.path.includes('/requests/') || call.path.includes('/intents/'),
    ),
    false,
  );
  const foreign = fixture({ initial: original });
  foreign.changeOrigin('https://foreign.example');
  await foreign.controller.connect();
  assert.equal(foreign.calls.length, 0);
});

test('malformed or secret-bearing journal is rejected rather than repaired into a new request', async () => {
  const f = fixture();
  f.entries.set(
    journalKey,
    JSON.stringify({ ...original, intentTicket: 'must-not-be-stored' }),
  );
  await f.controller.connect();
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getState().error, 'PROMOTION_JOURNAL_INVALID');
});

test('payload inspection is separate and current-authority rejection clears previous private view', async () => {
  let revoked = false;
  const f = fixture({
    initial: original,
    route: (path) =>
      revoked && path.endsWith(`/campaigns/${campaignId}`)
        ? response({ code: 'PROMOTION_FORBIDDEN' }, 403)
        : undefined,
  });
  f.record({
    recorded: true,
    status: {
      ...metadata,
      counts: { confirmed: 1, unknown: 1, notSent: 1, pending: 0 },
      cancelRequested: true,
    },
  });
  await f.controller.connect();
  assert.equal(f.controller.getState().metadata?.counts.unknown, 1);
  assert.equal(f.controller.getState().metadata?.remoteMessageMayRemain, true);
  await f.controller.inspectPayload();
  assert.equal(f.controller.getState().payload?.copy, preview.copy);
  revoked = true;
  await f.controller.inspectPayload();
  assert.equal(f.controller.getState().payload, null);
  assert.equal(f.controller.getState().metadata, null);
  assert.equal(f.controller.getState().program, null);
});

test('server payload pollution, unsafe copy and mixed test audiences fail closed', async () => {
  for (const patch of [
    { copy: '<script>alert(1)</script>' },
    { locator: 'https://foreign.example/path' },
    { audience: { school: 1, default: 0, test: 1, total: 2 } },
  ]) {
    const f = fixture({
      route: (path) =>
        path.endsWith('/previews')
          ? response({
              ...preview,
              mode: 'test',
              testDestination: approvedDestination,
              audience: { school: 0, default: 0, test: 1, total: 1 },
              ...patch,
            })
          : undefined,
    });
    await f.controller.connect();
    await f.controller.preview('test', destinationId);
    assert.equal(f.controller.getState().preview, null);
    assert.equal(campaigns(f).length, 0);
  }
});

test('real-browser support is explicitly pinned and importing it starts no browser', () => {
  assert.equal(RATING_PROMOTION_BROWSER_PROFILE, 'playwright-core-1.58.2');
  assert.equal(typeof startPromotionBrowser, 'function');
  const source = promotionBrowserBridgeScript({
    actorId,
    token: 'fixture-only-token',
  });
  assert.match(source, /fetch\(path/);
  assert.match(source, /Authorization/);
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|document\.write|innerHTML/,
  );
  new vm.Script(source);
});

test('stage counts preserve unknown optional composition alongside confirmed deliveries', async () => {
  const f = fixture({ initial: original });
  f.record({
    recorded: true,
    status: {
      ...metadata,
      composition: 'frozen',
      delivery: 'unknown',
      counts: { confirmed: 3, unknown: 0, notSent: 0, pending: 0 },
      stages: {
        generation: { confirmed: 0, unknown: 1, notSent: 0, pending: 0 },
        shortlink: { confirmed: 0, unknown: 0, notSent: 0, pending: 0 },
        delivery: { confirmed: 3, unknown: 0, notSent: 0, pending: 0 },
      },
    },
  });
  await f.controller.connect();
  assert.equal(f.controller.getState().metadata?.stages?.generation.unknown, 1);
  assert.equal(f.controller.getState().metadata?.counts.confirmed, 3);
  assert.equal(f.controller.getState().metadata?.delivery, 'unknown');
});

test('qualified synthetic shortlink can be inspected as text without allowing arbitrary provider URLs', async () => {
  const f = fixture({
    initial: original,
    route: (path) =>
      path.endsWith(`/campaigns/${campaignId}`)
        ? response({
            ...metadata,
            payload: {
              copy: preview.copy,
              locator: 'synthetic://rating-promotion/accepted-fixture',
            },
          })
        : undefined,
  });
  f.record({ recorded: true, status: metadata });
  await f.controller.connect();
  await f.controller.inspectPayload();
  assert.equal(
    f.controller.getState().payload?.locator,
    'synthetic://rating-promotion/accepted-fixture',
  );
});
