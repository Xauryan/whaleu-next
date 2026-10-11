import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeRatingCategoryIconRetirementRequest,
  decodeRatingCategoryIconRetirementStatusRequest,
  decodeRatingCategoryIconRetirementStatus,
  decodeRatingCategoryIconRetirementCleanup,
  ratingCategoryIconRetirementCandidates,
  type CategoryIconState,
  type RatingCategoryIconIntent,
  type RatingCategoryIconRetirementStatus,
} from '../src/ratings/category-icon-contract';
import { HttpRatingCategoryIconGateway } from '../src/ratings/category-icon-gateway';
import { CategoryIconCoordinator } from '../src/ratings/category-icon-coordinator';
import {
  RatingCategoryScopedController,
  initialRatingCategoryScopedView,
} from '../src/ratings/category-scoped-controller';
import {
  categoryIconHarness,
  iconCategory,
  iconId,
  iconIntent,
  iconPreparation,
  iconReceipt,
} from './category-icon-helpers';
import {
  managedRoute,
  managementNow,
  flushManagement,
} from './category-scoped-helpers';
import { accountId, wireCredentials } from './identity-helpers';
import { ScriptedTransport, deferred, response } from './helpers';

const oldImage = iconId(710),
  heldImage = iconId(711),
  newImage = iconId(712);
const image = (appearanceId: string): CategoryIconState => ({
  state: 'image',
  appearanceId,
});
const absent: CategoryIconState = { state: 'absent', appearanceId: null };
const inherit: CategoryIconState = { state: 'inherit', appearanceId: null };
const unavailable: CategoryIconState = {
  state: 'unavailable',
  appearanceId: null,
};
function preparation(intent = iconIntent()) {
  return {
    ...iconPreparation(intent),
    changedIconCount: 2,
    iconChanges: [
      {
        categoryId: iconCategory().id,
        kind: 'base' as const,
        campusId: null,
        before: image(oldImage),
        after: absent,
      },
      {
        categoryId: iconCategory().id,
        kind: 'base' as const,
        campusId: null,
        before: image(heldImage),
        after: image(newImage),
      },
    ],
  };
}
function gatewaySetup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const api = new ApiClient('https://ratings.example', transport, sessions, {
    refresh: async () =>
      sessions.rotate(sessions.snapshot(), wireCredentials('b')),
  });
  return {
    sessions,
    transport,
    gateway: new HttpRatingCategoryIconGateway(api, sessions),
  };
}

test('retirement wire strictly separates request-only recovery, bounded exact IDs and pending cleanup', () => {
  const requestId = iconIntent().payload.clientRequestId;
  assert.deepEqual(
    decodeRatingCategoryIconRetirementStatusRequest({ requestId }),
    { requestId },
  );
  assert.deepEqual(
    decodeRatingCategoryIconRetirementRequest({
      requestId,
      appearanceIds: [oldImage],
    }),
    { requestId, appearanceIds: [oldImage] },
  );
  for (const appearanceIds of [
    [],
    [oldImage, oldImage],
    ['invalid'],
    Array.from({ length: 257 }, (_, i) => iconId(1000 + i)),
  ]) {
    assert.throws(() =>
      decodeRatingCategoryIconRetirementRequest({ requestId, appearanceIds }),
    );
    assert.throws(() =>
      decodeRatingCategoryIconRetirementStatusRequest({
        requestId,
        appearanceIds,
      }),
    );
  }
  for (const value of [
    { requestId, appearanceIds: undefined },
    { requestId, protocolVersion: 5 },
    { requestId: 'invalid' },
  ])
    assert.throws(() => decodeRatingCategoryIconRetirementStatusRequest(value));
  assert.throws(() => decodeRatingCategoryIconRetirementRequest({ requestId }));
  assert.deepEqual(decodeRatingCategoryIconRetirementStatus({ items: [] }), {
    items: [],
  });
  assert.equal(
    decodeRatingCategoryIconRetirementStatus({
      items: Array.from({ length: 257 }, (_, i) => ({
        appearanceId: iconId(1000 + i),
        state: 'held',
      })),
    }).items.length,
    257,
  );
  for (const value of [
    { items: [{ appearanceId: oldImage, state: 'erased' }] },
    {
      items: [
        { appearanceId: oldImage, state: 'eligible' },
        { appearanceId: oldImage, state: 'held' },
      ],
    },
    {
      items: [
        {
          appearanceId: oldImage,
          state: 'eligible',
          url: 'https://media.example/private',
        },
      ],
    },
    { items: [], complete: true },
  ])
    assert.throws(() => decodeRatingCategoryIconRetirementStatus(value));
  assert.deepEqual(
    decodeRatingCategoryIconRetirementCleanup({
      state: 'cleanup_pending',
      appearanceIds: [oldImage],
    }),
    { state: 'cleanup_pending', appearanceIds: [oldImage] },
  );
  assert.throws(() =>
    decodeRatingCategoryIconRetirementCleanup({
      state: 'retired',
      appearanceIds: [oldImage],
    }),
  );
  assert.throws(() =>
    decodeRatingCategoryIconRetirementCleanup({
      state: 'cleanup_pending',
      appearanceIds: [oldImage],
      erased: true,
    }),
  );
});

test('local candidates come only from exact displaced images, never keeps, inherit or fallback state', () => {
  const pairs: readonly (readonly [CategoryIconState, CategoryIconState])[] = [
    [image(oldImage), absent],
    [image(heldImage), image(newImage)],
    [image(oldImage), image(newImage)],
    [image(newImage), image(newImage)],
    [image(iconId(720)), inherit],
    [image(iconId(721)), unavailable],
    [inherit, image(newImage)],
    [absent, image(newImage)],
    [unavailable, absent],
  ];
  const preview = {
    ...iconPreparation(),
    changedIconCount: pairs.length,
    iconChanges: pairs.map(([before, after]) => ({
      categoryId: iconCategory().id,
      kind: 'base' as const,
      campusId: null,
      before,
      after,
    })),
  };
  assert.deepEqual(ratingCategoryIconRetirementCandidates(preview), [
    oldImage,
    heldImage,
  ]);
});

test('HTTP retirement sends exact original identity and validates all returned IDs without claiming deletion', async () => {
  const h = gatewaySetup(),
    cancel = new Cancellation(),
    requestId = iconIntent().payload.clientRequestId;
  h.transport.reply({ items: [{ appearanceId: oldImage, state: 'held' }] });
  await h.gateway.retirementStatus({ requestId }, cancel);
  h.transport.reply({
    items: [
      { appearanceId: heldImage, state: 'retired' },
      { appearanceId: oldImage, state: 'eligible' },
    ],
  });
  await h.gateway.retirementStatus(
    { requestId, appearanceIds: [oldImage, heldImage] },
    cancel,
  );
  h.transport.reply({ state: 'cleanup_pending', appearanceIds: [oldImage] });
  await h.gateway.cleanupRetirement(
    { requestId, appearanceIds: [oldImage] },
    cancel,
  );
  assert.deepEqual(
    h.transport.requests.map((item) => new URL(item.url).pathname),
    [
      '/v5/ratings/category-management/retirement/status',
      '/v5/ratings/category-management/retirement/status',
      '/v5/ratings/category-management/retirement/cleanup',
    ],
  );
  assert.deepEqual(
    h.transport.requests.map((item) => item.body),
    [
      { requestId },
      { requestId, appearanceIds: [oldImage, heldImage] },
      { requestId, appearanceIds: [oldImage] },
    ],
  );
  h.transport.reply({ items: [] });
  await assert.rejects(
    h.gateway.retirementStatus(
      { requestId, appearanceIds: [oldImage] },
      cancel,
    ),
    { kind: 'protocol' },
  );
  h.transport.reply({ items: [{ appearanceId: newImage, state: 'eligible' }] });
  await assert.rejects(
    h.gateway.retirementStatus(
      { requestId, appearanceIds: [oldImage] },
      cancel,
    ),
    { kind: 'protocol' },
  );
  h.transport.reply({ state: 'cleanup_pending', appearanceIds: [heldImage] });
  await assert.rejects(
    h.gateway.cleanupRetirement(
      { requestId, appearanceIds: [oldImage] },
      cancel,
    ),
    { kind: 'protocol' },
  );
});

test('HTTP retirement rejects late responses across a new login epoch', async () => {
  const h = gatewaySetup(),
    pending = deferred<ReturnType<typeof response>>();
  h.transport.steps.push(() => pending.promise);
  const work = h.gateway.retirementStatus(
    { requestId: iconIntent().payload.clientRequestId },
    new Cancellation(),
  );
  await flushManagement();
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials('z'));
  pending.resolve(
    response({ items: [{ appearanceId: oldImage, state: 'eligible' }] }),
  );
  await assert.rejects(work, { kind: 'stale-session' });
});

test('cold cleanup recovery reads original receipt first and leaves both command journals unchanged', async () => {
  const h = categoryIconHarness(),
    intent = iconIntent(),
    calls: string[] = [];
  h.controller.dispose();
  const coordinator = new CategoryIconCoordinator(
    {
      ...h.runtime,
      newRequestId: async () => {
        throw Error('Recovery must not mint a request');
      },
    },
    { now: () => managementNow, schedule: () => () => undefined },
    () => undefined,
  );
  h.gateway.receipt = async (requestId) => {
    calls.push('receipt');
    assert.equal(requestId, intent.payload.clientRequestId);
    return iconReceipt(intent);
  };
  h.gateway.retirementStatus = async (request) => {
    calls.push('status');
    assert.deepEqual(request, { requestId: intent.payload.clientRequestId });
    return { items: [{ appearanceId: oldImage, state: 'held' }] };
  };
  const before = [...h.storage.data];
  try {
    const result = await coordinator.inspectRetirement(
      { requestId: intent.payload.clientRequestId },
      new Cancellation(),
    );
    assert.deepEqual(calls, ['receipt', 'status']);
    assert.equal(result.receipt.outcome, 'applied');
    assert.equal(result.status.items[0]!.state, 'held');
    assert.deepEqual([...h.storage.data], before);
    calls.length = 0;
    h.gateway.receipt = async () => {
      calls.push('receipt');
      return iconReceipt(intent, 'closed');
    };
    await assert.rejects(
      coordinator.inspectRetirement(
        { requestId: intent.payload.clientRequestId },
        new Cancellation(),
      ),
      { details: { serverCode: 'CATEGORY_ICON_RETIREMENT_NOT_APPLIED' } },
    );
    assert.deepEqual(calls, ['receipt']);
  } finally {
    coordinator.dispose();
  }
});

test('coordinator rechecks exact eligible IDs and does not send held cleanup or erase the original receipt', async () => {
  const h = categoryIconHarness(),
    intent = iconIntent(),
    calls: string[] = [];
  h.controller.dispose();
  const coordinator = new CategoryIconCoordinator(
    h.runtime,
    { now: () => managementNow, schedule: () => () => undefined },
    () => undefined,
  );
  let state: 'eligible' | 'held' = 'held';
  h.gateway.receipt = async () => {
    calls.push('receipt');
    return iconReceipt(intent);
  };
  h.gateway.retirementStatus = async (request) => {
    calls.push('status');
    assert.deepEqual(request, {
      requestId: intent.payload.clientRequestId,
      appearanceIds: [oldImage],
    });
    return { items: [{ appearanceId: oldImage, state }] };
  };
  h.gateway.cleanupRetirement = async (request) => {
    calls.push('cleanup');
    return { state: 'cleanup_pending', appearanceIds: request.appearanceIds };
  };
  try {
    await assert.rejects(
      coordinator.cleanupRetirement(
        {
          requestId: intent.payload.clientRequestId,
          appearanceIds: [oldImage],
        },
        new Cancellation(),
      ),
      { details: { serverCode: 'CATEGORY_ICON_RETIREMENT_HELD' } },
    );
    assert.deepEqual(calls, ['receipt', 'status']);
    calls.length = 0;
    state = 'eligible';
    assert.deepEqual(
      await coordinator.cleanupRetirement(
        {
          requestId: intent.payload.clientRequestId,
          appearanceIds: [oldImage],
        },
        new Cancellation(),
      ),
      { state: 'cleanup_pending', appearanceIds: [oldImage] },
    );
    assert.deepEqual(calls, ['receipt', 'status', 'cleanup']);
  } finally {
    coordinator.dispose();
  }
});

test('retirement never clears a receipt-bearing v13 command before its existing upload settlement flow', async () => {
  const h = categoryIconHarness();
  await h.controller.load(managedRoute);
  h.controller.selectOperation('edit_category_base_scoped');
  await h.controller.prepare();
  const command = h.store.load(accountId).command!,
    receipt = iconReceipt(command.intent);
  h.store.recordReceipt(command, receipt);
  h.controller.dispose();
  const coordinator = new CategoryIconCoordinator(
    h.runtime,
    { now: () => managementNow, schedule: () => () => undefined },
    () => undefined,
  );
  h.gateway.receipt = async () => receipt;
  h.gateway.retirementStatus = async () => ({
    items: [{ appearanceId: oldImage, state: 'eligible' }],
  });
  h.gateway.cleanupRetirement = async (request) => ({
    state: 'cleanup_pending',
    appearanceIds: request.appearanceIds,
  });
  try {
    const before = [...h.storage.data];
    await coordinator.cleanupRetirement(
      { requestId: receipt.requestId, appearanceIds: [oldImage] },
      new Cancellation(),
    );
    assert.deepEqual([...h.storage.data], before);
    assert.deepEqual(h.store.load(accountId).command!.receipt, receipt);
    assert.deepEqual(await coordinator.recover(new Cancellation()), receipt);
    assert.equal(h.store.load(accountId).command, null);
  } finally {
    coordinator.dispose();
  }
});

test('applied native receipt exposes only prepared old IDs and requires separate status plus explicit eligible cleanup', async () => {
  const h = categoryIconHarness(),
    calls: string[] = [];
  let original: RatingCategoryIconIntent = iconIntent();
  h.gateway.prepare = async (intent) => preparation(intent);
  h.gateway.commit = async (intent) => {
    original = intent;
    return iconReceipt(intent);
  };
  h.gateway.receipt = async (requestId) => {
    calls.push('receipt');
    assert.equal(requestId, original.payload.clientRequestId);
    return iconReceipt(original);
  };
  h.gateway.retirementStatus = async (request) => {
    calls.push('status');
    return {
      items: ('appearanceIds' in request
        ? request.appearanceIds
        : [oldImage, heldImage]
      ).map((appearanceId) => ({
        appearanceId,
        state:
          appearanceId === heldImage
            ? ('held' as const)
            : ('eligible' as const),
      })),
    };
  };
  h.gateway.cleanupRetirement = async (request) => {
    calls.push('cleanup');
    assert.deepEqual(request, {
      requestId: original.payload.clientRequestId,
      appearanceIds: [oldImage],
    });
    return { state: 'cleanup_pending', appearanceIds: request.appearanceIds };
  };
  try {
    await h.controller.load(managedRoute);
    h.controller.selectOperation('edit_category_base_scoped');
    h.controller.chooseIcon(`base:${iconCategory().id}`, 'clear');
    await h.controller.prepare();
    assert.equal(h.view().iconRetirement, null);
    await h.controller.commit();
    assert.deepEqual(calls, []);
    assert.deepEqual(
      h.view().iconRetirement!.items.map((item) => item.appearanceId),
      [oldImage, heldImage],
    );
    assert.ok(h.view().iconRetirement!.items.every((item) => !item.canCleanup));
    assert.equal(h.store.load(accountId).command, null);
    await h.controller.inspectIconRetirement();
    assert.equal(h.view().iconRetirement!.items[0]!.canCleanup, true);
    assert.equal(h.view().iconRetirement!.items[1]!.canCleanup, false);
    await h.controller.cleanupIconRetirement(heldImage);
    assert.deepEqual(calls, ['receipt', 'status']);
    const receiptStatus = h.view().receiptStatus;
    await h.controller.cleanupIconRetirement(oldImage);
    assert.deepEqual(calls, [
      'receipt',
      'status',
      'receipt',
      'status',
      'cleanup',
    ]);
    assert.equal(h.view().receiptStatus, receiptStatus);
    assert.equal(h.view().iconRetirement!.items[0]!.canCleanup, false);
    assert.match(h.view().iconRetirement!.items[0]!.label, /排队/);
    assert.match(h.view().iconRetirement!.status, /尚未确认文件已物理删除/);
    assert.equal(h.store.load(accountId).command, null);
  } finally {
    h.controller.dispose();
  }
});

test('lost cleanup response preserves receipt and server queue is recoverable by original request after restart', async () => {
  const h = categoryIconHarness(),
    original = iconIntent(),
    calls: string[] = [];
  let serverState: 'eligible' | 'retired' = 'eligible',
    queued = false;
  h.gateway.receipt = async () => {
    calls.push('receipt');
    return iconReceipt(original);
  };
  h.gateway.retirementStatus = async (request) => {
    calls.push('status');
    assert.equal(request.requestId, original.payload.clientRequestId);
    return { items: [{ appearanceId: oldImage, state: serverState }] };
  };
  h.gateway.cleanupRetirement = async () => {
    calls.push('cleanup');
    queued = true;
    throw new ClientError(
      'network',
      'Lost response after durable server enqueue',
    );
  };
  try {
    await h.controller.load(managedRoute);
    h.controller.setIconRetirementRecoveryRequestId(
      original.payload.clientRequestId,
    );
    await h.controller.recoverIconRetirement();
    const receiptStatus = h.view().receiptStatus,
      before = [...h.storage.data];
    await h.controller.cleanupIconRetirement(oldImage);
    assert.equal(queued, true);
    assert.equal(h.view().receiptStatus, receiptStatus);
    assert.equal(h.view().iconRetirement!.items[0]!.canCleanup, false);
    assert.match(h.view().iconRetirement!.status, /结果暂不能确认/);
    assert.deepEqual([...h.storage.data], before);
    h.controller.dispose();
    calls.length = 0;
    serverState = 'retired';
    let view = initialRatingCategoryScopedView();
    const recovered = new RatingCategoryScopedController(
      h.runtime,
      (value) => {
        view = value;
      },
      true,
      { now: () => managementNow, schedule: () => () => undefined },
    );
    try {
      await recovered.recoverIconRetirement(original.payload.clientRequestId);
      assert.deepEqual(calls, ['receipt', 'status']);
      assert.equal(
        view.iconRetirement!.requestId,
        original.payload.clientRequestId,
      );
      assert.match(
        view.iconRetirement!.items[0]!.label,
        /不代表文件已物理删除/,
      );
      assert.equal(view.iconRetirement!.items[0]!.canCleanup, false);
      assert.equal(h.store.load(accountId).command, null);
      assert.deepEqual([...h.storage.data], before);
    } finally {
      recovered.dispose();
    }
  } finally {
    h.controller.dispose();
  }
});

test('native cold status is bounded in page data and only a visible eligible row can be cleaned', async () => {
  const h = categoryIconHarness(),
    original = iconIntent();
  const items: RatingCategoryIconRetirementStatus['items'] = Array.from(
    { length: 45 },
    (_, i) => ({ appearanceId: iconId(2000 + i), state: 'eligible' }),
  );
  h.gateway.receipt = async () => iconReceipt(original);
  h.gateway.retirementStatus = async (request) => ({
    items:
      'appearanceIds' in request
        ? items.filter((item) =>
            request.appearanceIds.includes(item.appearanceId),
          )
        : items,
  });
  let cleanup = 0;
  h.gateway.cleanupRetirement = async (request) => {
    cleanup++;
    return { state: 'cleanup_pending', appearanceIds: request.appearanceIds };
  };
  try {
    await h.controller.recoverIconRetirement(original.payload.clientRequestId);
    assert.equal(h.view().iconRetirement!.count, 45);
    assert.equal(h.view().iconRetirement!.items.length, 20);
    await h.controller.cleanupIconRetirement(items[44]!.appearanceId);
    assert.equal(cleanup, 0);
    h.controller.pageIconRetirement(1);
    h.controller.pageIconRetirement(1);
    assert.equal(h.view().iconRetirement!.from, 41);
    assert.equal(h.view().iconRetirement!.items.length, 5);
    await h.controller.cleanupIconRetirement(items[44]!.appearanceId);
    assert.equal(cleanup, 1);
  } finally {
    h.controller.dispose();
  }
});

test('cold recovery keeps an applied original receipt visible when current retirement authorization fails', async () => {
  const h = categoryIconHarness(),
    original = iconIntent();
  h.gateway.receipt = async () => iconReceipt(original);
  h.gateway.retirementStatus = async () => {
    throw new ClientError(
      'business',
      'Current all-scope authorization unavailable',
      { serverCode: 'RATING_SCOPE_UNAVAILABLE' },
    );
  };
  try {
    await h.controller.recoverIconRetirement(original.payload.clientRequestId);
    assert.match(h.view().receiptStatus, /分类变更已应用/);
    assert.match(h.view().iconRetirement!.status, /暂不能确认/);
    assert.equal(h.view().iconRetirement!.items.length, 0);
    assert.equal(h.store.load(accountId).command, null);
  } finally {
    h.controller.dispose();
  }
});

test('new session or hide cannot publish a late retirement list into native data', async () => {
  const h = categoryIconHarness(),
    original = iconIntent(),
    pending = deferred<RatingCategoryIconRetirementStatus>();
  h.gateway.receipt = async () => iconReceipt(original);
  h.gateway.retirementStatus = async () => pending.promise;
  try {
    const work = h.controller.recoverIconRetirement(
      original.payload.clientRequestId,
    );
    await flushManagement();
    h.runtime.sessions.completeLogin(
      h.runtime.sessions.beginLogin(),
      wireCredentials('replacement'),
    );
    pending.resolve({ items: [{ appearanceId: oldImage, state: 'eligible' }] });
    await work;
    assert.equal(h.view().iconRetirement, null);
    assert.equal(JSON.stringify(h.view()).includes(oldImage), false);
  } finally {
    h.controller.dispose();
  }
});
