import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  RatingCategoryManagementController,
  initialRatingCategoryManagementView,
  type RatingCategoryManagementView,
} from '../src/ratings/category-management-controller';
import type {
  RatingCategoryCreationIntent,
  RatingCategoryCreationReceipt,
  RatingCategoryManagementContext,
} from '../src/ratings/category-management-contract';
import type { RatingCategoryManagementGateway } from '../src/ratings/category-management-gateway';
import {
  RatingCatalogChanges,
  type RatingCatalogChange,
} from '../src/ratings/catalog-changes';
import { RatingController, type RatingView } from '../src/ratings/controller';
import { RatingManagementController } from '../src/ratings/management-controller';
import { RatingDeletionController } from '../src/ratings/deletion-controller';
import { RatingThreadController } from '../src/ratings/discussion-controller';
import { RatingTargetOwnerDeletionController } from '../src/ratings/target-owner-deletion-controller';
import { RatingTargetOwnerEditingController } from '../src/ratings/target-owner-editing-controller';
import { deferred } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  harness,
  intent as scoreIntent,
  receipt as scoreReceipt,
  otherId,
  regionId,
  requestId,
} from './ratings-helpers';
import {
  cancelledCategoryReceipt,
  categoryCreationIntent,
  categoryCreationReceipt,
  categoryManagementContext,
  categoryPreparation,
  categoryTestId,
  existingCategoryParentId,
  existingCategoryParentRevision,
} from './category-management-helpers';

const draftName = 'Independent native category';
const draftDescription = 'Independent category description';
const missing = () =>
  new ClientError('http', 'Synthetic missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
const draftIntent = (
  scope: string | null = null,
): RatingCategoryCreationIntent =>
  categoryCreationIntent({
    regionId: scope,
    nodes: [
      {
        key: 'n0',
        parentKey: null,
        name: draftName,
        description: draftDescription,
      },
    ],
  });
function categoryHarness() {
  const s = harness('recovery'),
    calls: string[] = [],
    changes: RatingCatalogChange[] = [];
  const gateway: RatingCategoryManagementGateway = {
    context: async (scope) => {
      calls.push('context');
      return categoryManagementContext(scope);
    },
    prepare: async (intent) => {
      calls.push('prepare');
      return categoryPreparation(intent);
    },
    command: async (intent) => {
      calls.push('command');
      return categoryCreationReceipt(intent);
    },
    cancel: async (intent) => {
      calls.push('cancel');
      return cancelledCategoryReceipt(intent);
    },
    receipt: async () => {
      calls.push('receipt');
      throw missing();
    },
  };
  const ratingCatalogChanges = new RatingCatalogChanges();
  ratingCatalogChanges.subscribe((change) => changes.push(change));
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingCategoryManagement: gateway,
    ratingCatalogChanges,
  };
  const views: RatingCategoryManagementView[] = [];
  const controller = new RatingCategoryManagementController(runtime, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    gateway,
    calls,
    changes,
    controller,
    views,
    view: () => views[views.length - 1]!,
  };
}
async function ready(scope: string | null = null) {
  const s = categoryHarness();
  await s.controller.load(scope === null ? {} : { regionId: scope });
  s.controller.setNodeText('n0', 'name', draftName);
  s.controller.setNodeText('n0', 'description', draftDescription);
  return s;
}
async function unknownCommand(scope: string | null = null) {
  const s = await ready(scope);
  s.gateway.command = async () => {
    s.calls.push('command');
    throw new ClientError('network', 'Lost command response');
  };
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  return s;
}
function originalCategory(s: ReturnType<typeof categoryHarness>) {
  const original = s.pendingRatings.load(s.accountId);
  assert.equal(original?.version, 8);
  if (!original || original.version !== 8)
    throw new Error('Expected pending v8 category fixture');
  return original;
}
const journalKey = (s: ReturnType<typeof categoryHarness>) =>
  `whaleu.ratings.pending.v8:synthetic-ratings:${s.accountId}`;
const unrelatedCatalogChange: RatingCatalogChange = {
  releaseId: categoryTestId(900),
  catalogs: [{ regionId: null, catalogRevision: categoryTestId(901) }],
};
type Stop =
  | 'account'
  | 'same-account'
  | 'hide'
  | 'close'
  | 'scope'
  | 'browse'
  | 'safety'
  | 'catalog'
  | 'dispose';
function invalidate(s: ReturnType<typeof categoryHarness>, stop: Stop): void {
  if (stop === 'account' || stop === 'same-account')
    s.sessions.completeLogin(
      s.sessions.beginLogin(),
      stop === 'account'
        ? { ...wireCredentials('b'), accountId: otherId }
        : { ...wireCredentials('b'), sessionId: otherId },
    );
  else if (stop === 'hide') s.runtime.privateViews!.clear();
  else if (stop === 'close') s.controller.cancel();
  else if (stop === 'scope') s.directoryScopeChanges.clear(s.accountId);
  else if (stop === 'browse') s.browsingScopeChanges.clear(s.accountId);
  else if (stop === 'safety') s.safetyChanges.invalidate(s.accountId);
  else if (stop === 'catalog')
    s.runtime.ratingCatalogChanges!.publish(unrelatedCatalogChange);
  else s.controller.dispose();
}
const fences: readonly Stop[] = [
  'account',
  'same-account',
  'hide',
  'close',
  'scope',
  'browse',
  'safety',
  'catalog',
  'dispose',
];

test('the actual cold category form has no loaded fiction, draft, campus grant or parent authority', async () => {
  const initial = initialRatingCategoryManagementView();
  assert.equal(initial.ready, false);
  assert.equal(initial.creationConfirmation, false);
  assert.equal(initial.canCancelCategoryCreation, false);
  assert.deepEqual(initial.nodes, []);
  assert.deepEqual(initial.campusIds, []);
  assert.deepEqual(initial.parents, []);
  assert.equal('loaded' in initial, false);
  assert.equal('returnToCatalog' in initial, false);
  const s = categoryHarness();
  s.controller.setNodeText('n0', 'name', 'No authority');
  s.controller.selectParent(existingCategoryParentId);
  s.controller.addChild('n0');
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.deepEqual(s.view().nodes, []);
  assert.equal(s.ids.count, 0);
  assert.deepEqual(s.calls, []);
  await s.controller.load({});
  assert.equal(s.view().ready, true);
  assert.deepEqual(s.view().nodes, [
    { key: 'n0', parentKey: null, name: '', description: '', level: 1 },
  ]);
  assert.deepEqual(s.view().campusIds, categoryManagementContext().campusIds);
  assert.deepEqual(s.view().parents, categoryManagementContext().parents);
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.ratings.calls.length, 0);
  assert.equal(
    JSON.stringify(s.view()).includes('expectedScopeRevision'),
    false,
  );
  assert.equal(JSON.stringify(s.view()).includes('creatorId'), false);
});

test('only authoritative context determines explicit global or regional scope and every affected campus', async () => {
  for (const scope of [null, regionId]) {
    const s = categoryHarness();
    const context = {
      ...categoryManagementContext(scope),
      scopeRevision: 'z'.repeat(43),
      campusIds: [categoryTestId(31), categoryTestId(32), categoryTestId(33)],
      catalogRevision: categoryTestId(41),
    };
    s.gateway.context = async (requestedScope) => {
      s.calls.push('context');
      assert.equal(requestedScope, scope);
      return context;
    };
    await s.controller.load(scope === null ? {} : { regionId: scope });
    assert.equal(s.view().regionId, scope);
    assert.deepEqual(s.view().campusIds, context.campusIds);
    s.controller.setNodeText('n0', 'name', draftName);
    s.controller.setNodeText('n0', 'description', draftDescription);
    let sent: unknown;
    s.gateway.command = async (intent) => {
      sent = intent;
      throw new ClientError('network', 'uncertain');
    };
    s.controller.requestCreate();
    await s.controller.confirmCreate();
    assert.deepEqual(
      sent,
      categoryCreationIntent({
        ...draftIntent(scope).payload,
        expectedScopeRevision: context.scopeRevision,
        expectedCatalogRevision: context.catalogRevision,
      }),
    );
    assert.deepEqual(s.view().campusIds, []);
    assert.equal(s.view().regionId, null);
    assert.equal(JSON.stringify(sent).includes('campusIds'), false);
  }
});

test('canonical optional parent selection shifts the editor tree and binds its exact current revision', async () => {
  const s = await ready(regionId);
  s.controller.selectParent(otherId);
  assert.equal(s.view().parentId, null);
  s.controller.selectParent(existingCategoryParentId);
  assert.equal(s.view().parentId, existingCategoryParentId);
  assert.equal(s.view().parentLevel, 1);
  assert.equal(s.view().parentName, 'Existing root');
  assert.equal(s.view().nodes[0]!.level, 2);
  s.controller.addChild('n0');
  assert.equal(s.view().nodes[1]!.level, 3);
  s.controller.addChild('n1');
  assert.equal(s.view().nodes.length, 2);
  s.controller.setNodeText('n1', 'name', 'Leaf');
  s.controller.selectParent(categoryTestId(3));
  assert.equal(s.view().parentId, existingCategoryParentId);
  assert.match(s.view().error, /三级/);
  s.controller.selectParent(null);
  assert.deepEqual(
    s.view().nodes.map((node) => node.level),
    [1, 2],
  );
  s.controller.selectParent(existingCategoryParentId);
  s.gateway.command = async (intent) => {
    assert.equal(intent.payload.parentId, existingCategoryParentId);
    assert.equal(
      intent.payload.expectedParentRevision,
      existingCategoryParentRevision,
    );
    assert.equal(intent.payload.regionId, regionId);
    assert.deepEqual(
      intent.payload.nodes.map((node) => [node.key, node.parentKey]),
      [
        ['n0', null],
        ['n1', 'n0'],
      ],
    );
    return categoryCreationReceipt(intent);
  };
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().parentName, '');
  assert.deepEqual(s.view().nodes, []);
  const t = await ready();
  t.controller.selectParent(categoryTestId(3));
  assert.equal(t.view().nodes[0]!.level, 3);
  t.controller.addChild('n0');
  assert.equal(t.view().nodes.length, 1);
});

test('the editor keeps one root, ordered descendants, maximum depth three and at most thirty-two nodes', async () => {
  const s = await ready();
  s.controller.removeNode('n0');
  assert.equal(s.view().nodes.length, 1);
  s.controller.addChild('missing');
  assert.equal(s.view().nodes.length, 1);
  s.controller.addChild('n0');
  s.controller.addChild('n1');
  s.controller.addChild('n2');
  assert.deepEqual(
    s.view().nodes.map((node) => [node.key, node.parentKey, node.level]),
    [
      ['n0', null, 1],
      ['n1', 'n0', 2],
      ['n2', 'n1', 3],
    ],
  );
  s.controller.addChild('n0');
  s.controller.removeNode('n1');
  assert.deepEqual(
    s.view().nodes.map((node) => node.key),
    ['n0', 'n3'],
  );
  for (let i = 0; i < 40; i++) s.controller.addChild('n0');
  assert.equal(s.view().nodes.length, 32);
  assert.equal(new Set(s.view().nodes.map((node) => node.key)).size, 32);
  assert.equal(
    s.view().nodes.filter((node) => node.parentKey === null).length,
    1,
  );
  assert.equal(
    s
      .view()
      .nodes.slice(1)
      .every((node) => node.parentKey === 'n0' && node.level === 2),
    true,
  );
  for (const node of s.view().nodes)
    s.controller.setNodeText(node.key, 'name', `Node ${node.key}`);
  let sentCount = 0;
  s.gateway.command = async (intent) => {
    sentCount = intent.payload.nodes.length;
    return categoryCreationReceipt(intent);
  };
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.equal(sentCount, 32);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});

test('confirmation canonicalizes and freezes exact original bytes before dispatch and duplicate clicks allocate once', async () => {
  const s = await ready(),
    result = deferred<RatingCategoryCreationReceipt>(),
    dispatched = deferred<void>();
  await s.controller.confirmCreate();
  assert.equal(s.ids.count, 0);
  s.controller.setNodeText('n0', 'name', ` ${draftName} `);
  s.controller.setNodeText('n0', 'description', ` ${draftDescription}\r\n `);
  s.controller.requestCreate();
  assert.equal(s.view().creationConfirmation, true);
  assert.equal(s.view().nodes[0]!.name, draftName);
  assert.equal(s.view().nodes[0]!.description, draftDescription);
  s.controller.setNodeText('n0', 'name', 'Cannot alter confirmation');
  s.controller.addChild('n0');
  s.controller.selectParent(existingCategoryParentId);
  assert.equal(s.view().nodes.length, 1);
  assert.equal(s.view().parentId, null);
  let commandCount = 0;
  s.gateway.command = async (intent) => {
    commandCount++;
    assert.deepEqual(intent, draftIntent());
    assert.equal(
      JSON.stringify(s.storage.get(journalKey(s))),
      JSON.stringify({ version: 8, accountId: s.accountId, intent }),
    );
    assert.deepEqual(s.pendingRatings.load(s.accountId), {
      version: 8,
      accountId: s.accountId,
      intent,
    });
    dispatched.resolve();
    return result.promise;
  };
  const first = s.controller.confirmCreate(),
    second = s.controller.confirmCreate();
  await dispatched.promise;
  assert.equal(commandCount, 1);
  assert.equal(s.ids.count, 1);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().canCancelCategoryCreation, true);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.view().parents, []);
  s.controller.setNodeText('n0', 'name', 'Cannot replace pending text');
  s.controller.requestCreate();
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.changes, []);
  result.resolve(categoryCreationReceipt(draftIntent()));
  await Promise.all([first, second]);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().needsRefresh, true);
  assert.match(s.view().receiptStatus, /历史操作/);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.changes, [
    {
      releaseId: categoryCreationReceipt().releaseId,
      catalogs: categoryCreationReceipt().catalogs,
    },
  ]);
});

test('dismissed confirmation returns to editing and invalid node text never allocates or freezes a request', async () => {
  const s = await ready();
  s.controller.requestCreate();
  s.controller.dismissCreate();
  await s.controller.confirmCreate();
  assert.equal(s.ids.count, 0);
  s.controller.setNodeText('n0', 'name', 'Changed editable draft');
  assert.equal(s.view().nodes[0]!.name, 'Changed editable draft');
  for (const [field, text] of [
    ['name', ''],
    ['name', ' \t '],
    ['name', '\ud800'],
    ['name', '🌊'.repeat(101)],
    ['name', 'bad\u0000name'],
    ['description', '🌊'.repeat(501)],
    ['description', '\u007f'],
  ] as const) {
    const t = await ready();
    t.controller.setNodeText('n0', field, text);
    t.controller.requestCreate();
    await t.controller.confirmCreate();
    assert.equal(t.view().creationConfirmation, false);
    assert.equal(t.ids.count, 0);
    assert.deepEqual(t.calls, ['context']);
    assert.equal(t.pendingRatings.load(t.accountId), null);
    assert.deepEqual(t.changes, []);
  }
  const t = await ready();
  t.controller.addChild('n0');
  t.controller.requestCreate();
  await t.controller.confirmCreate();
  assert.equal(t.ids.count, 0);
  assert.equal(t.view().creationConfirmation, false);
});

test('unavailable Review, mapping, authorization or final proof and missing GET keep original v8 frozen', async () => {
  for (const code of [
    'CONTENT_REVIEW_UNAVAILABLE',
    'RATING_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'AUTHORIZATION_UNAVAILABLE',
    'TOPOLOGY_UNAVAILABLE',
    'RATING_NOT_FOUND',
    'RATING_CATEGORY_CONTEXT_CHANGED',
    'INTERNAL_ERROR',
  ]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('http', 'Uncertain', {
        httpStatus: 503,
        serverCode: code,
      });
    };
    s.controller.requestCreate();
    await s.controller.confirmCreate();
    const original = originalCategory(s),
      bytes = JSON.stringify(s.storage.get(journalKey(s)));
    assert.equal(s.view().frozen, true);
    assert.deepEqual(s.view().nodes, []);
    await s.controller.recover();
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(JSON.stringify(s.storage.get(journalKey(s))), bytes);
    assert.equal(s.view().receiptStatus, '');
    assert.equal(s.ids.count, 1);
    assert.deepEqual(s.changes, []);
  }
  const s = await ready();
  s.gateway.command = async (intent) => ({
    ...cancelledCategoryReceipt(intent),
    code: 'RATING_CATEGORY_CONTEXT_CHANGED',
  });
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().needsRefresh, true);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.changes, []);
});

test('unknown creation survives close, reopen, changed or invalid route without displaying old category text', async () => {
  const s = await unknownCommand(),
    original = originalCategory(s);
  await s.controller.reload();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.controller.cancel();
  s.controller.dispose();
  for (const route of [
    null,
    { regionId: otherId },
    { regionId: 'invalid' },
    { regionId, parentId: otherId },
  ]) {
    const views: RatingCategoryManagementView[] = [];
    const reopened = new RatingCategoryManagementController(s.runtime, (view) =>
      views.push(view),
    );
    await reopened.load(route);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(views[views.length - 1]!.frozen, true);
    assert.deepEqual(views[views.length - 1]!.nodes, []);
    assert.equal(JSON.stringify(views).includes(draftName), false);
    assert.equal(JSON.stringify(views).includes(draftDescription), false);
    reopened.dispose();
  }
  assert.equal(s.calls.filter((call) => call === 'context').length, 1);
  const views: RatingCategoryManagementView[] = [];
  const reopened = new RatingCategoryManagementController(s.runtime, (view) =>
    views.push(view),
  );
  await reopened.load({ regionId: otherId });
  s.gateway.command = async (intent) => {
    assert.equal(JSON.stringify(intent), JSON.stringify(original.intent));
    return categoryCreationReceipt(intent);
  };
  await reopened.recover(true);
  assert.equal(s.ids.count, 1);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(views[views.length - 1]!.nodes, []);
  reopened.dispose();
});

test('every recovery-capable rating page settles v8 before route or visibility reads without painting old text', async () => {
  for (const outcome of ['applied', 'rejected'] as const)
    for (const make of [
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingController(s.runtime, 'recovery', render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingController(s.runtime, 'detail', render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingController(s.runtime, 'catalog', render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingManagementController(s.runtime, render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingDeletionController(s.runtime, render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingThreadController(s.runtime, render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingTargetOwnerDeletionController(s.runtime, render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingTargetOwnerEditingController(s.runtime, render),
      (
        s: ReturnType<typeof categoryHarness>,
        render: (view: unknown) => void,
      ) => new RatingCategoryManagementController(s.runtime, render),
    ]) {
      const s = categoryHarness(),
        views: unknown[] = [];
      const runtime = s.runtime as {
        ratingManagement?: unknown;
        ratingDeletion?: unknown;
        ratingDiscussion?: unknown;
        ratingTargetOwnerDeletion?: unknown;
        ratingTargetOwnerEditing?: unknown;
      };
      runtime.ratingManagement = {};
      runtime.ratingDeletion = {};
      runtime.ratingDiscussion = {};
      runtime.ratingTargetOwnerDeletion = {};
      runtime.ratingTargetOwnerEditing = {};
      s.pendingRatings.freeze({
        version: 8,
        accountId: s.accountId,
        intent: draftIntent(),
      });
      s.gateway.receipt = async (id) => {
        s.calls.push('receipt');
        assert.equal(id, requestId);
        return outcome === 'applied'
          ? categoryCreationReceipt(draftIntent())
          : cancelledCategoryReceipt(draftIntent());
      };
      const page = make(s, (view) => views.push(view));
      await page.load(null);
      assert.equal(s.pendingRatings.load(s.accountId), null);
      assert.deepEqual(s.calls, ['receipt']);
      assert.equal(s.ratings.calls.length, 0);
      assert.equal(s.ids.count, 0);
      assert.equal(JSON.stringify(views).includes(draftName), false);
      assert.equal(JSON.stringify(views).includes(draftDescription), false);
      assert.equal(s.changes.length, outcome === 'applied' ? 1 : 0);
      page.dispose();
      s.controller.dispose();
    }
});

test('the category page honors older pending work and cannot expose category cancellation or create a new key', async () => {
  const s = categoryHarness();
  const original = {
    version: 1 as const,
    accountId: s.accountId,
    intent: scoreIntent(),
  };
  s.pendingRatings.freeze(original);
  await s.controller.load({ regionId: 'invalid' });
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().canCancelCategoryCreation, false);
  assert.deepEqual(s.view().nodes, []);
  s.controller.requestCancelCategoryCreation();
  await s.controller.confirmCancelCategoryCreation();
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.equal(s.ids.count, 0);
  assert.deepEqual(s.calls, []);
  s.ratings.receiptImpl = async () => scoreReceipt();
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(s.changes, []);
});

test('invalid scope, missing campus mapping and malformed context fail closed while ordinary catalog still works', async () => {
  for (const raw of [
    null,
    { regionId: 'invalid' },
    { campusId: otherId },
    { regionId, parentId: otherId },
    { regionId, accepted: true },
  ]) {
    const s = categoryHarness();
    await s.controller.load(raw);
    assert.equal(s.view().ready, false);
    assert.deepEqual(s.view().nodes, []);
    assert.deepEqual(s.calls, []);
    assert.equal(s.ids.count, 0);
  }
  for (const patch of [
    { regionId: otherId },
    { campusIds: [] },
    { campusIds: [otherId, otherId] },
    { campusIds: [categoryTestId(22), categoryTestId(21)] },
    { scopeRevision: 'bad' },
    { maximumDepth: 4 },
    { authorized: true },
    {
      parents: [
        { ...categoryManagementContext().parents[0], name: ' noncanonical ' },
      ],
    },
  ]) {
    const s = categoryHarness();
    s.gateway.context = async () =>
      ({
        ...categoryManagementContext(regionId),
        ...patch,
      }) as unknown as RatingCategoryManagementContext;
    await s.controller.load({ regionId });
    s.controller.requestCreate();
    await s.controller.confirmCreate();
    assert.equal(s.view().ready, false);
    assert.deepEqual(s.view().nodes, []);
    assert.deepEqual(s.view().campusIds, []);
    assert.deepEqual(s.view().parents, []);
    assert.equal(s.ids.count, 0);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    const views: RatingView[] = [];
    const catalog = new RatingController(s.runtime, 'catalog', (view) =>
      views.push(view),
    );
    await catalog.load({});
    assert.equal(views[views.length - 1]!.loaded, true);
    assert.ok(views[views.length - 1]!.categories.length > 0);
    catalog.dispose();
  }
});

test('late context results cannot repopulate a private form after any session, hide, scope, Safety or catalog fence', async () => {
  for (const stop of fences) {
    const s = categoryHarness(),
      response = deferred<RatingCategoryManagementContext>(),
      started = deferred<void>();
    s.gateway.context = async () => {
      started.resolve();
      return response.promise;
    };
    const work = s.controller.load({});
    await started.promise;
    invalidate(s, stop);
    response.resolve(categoryManagementContext());
    await work;
    assert.equal(s.view().ready, false);
    assert.deepEqual(s.view().nodes, []);
    assert.deepEqual(s.view().campusIds, []);
    assert.deepEqual(s.view().parents, []);
    assert.equal(s.ids.count, 0);
    assert.equal(s.pendingRatings.load(s.accountId), null);
  }
});

test('invalidation before confirmation or while awaiting UUID cannot persist or dispatch a category command', async () => {
  for (const stop of fences) {
    const before = await ready();
    before.controller.requestCreate();
    invalidate(before, stop);
    await before.controller.confirmCreate();
    assert.equal(before.ids.count, 0);
    assert.equal(before.pendingRatings.load(before.accountId), null);
    assert.deepEqual(before.calls, ['context']);
    const s = await ready(),
      id = deferred<string>(),
      waiting = deferred<void>();
    s.ids.next = () => {
      waiting.resolve();
      return id.promise;
    };
    s.controller.requestCreate();
    const work = s.controller.confirmCreate();
    await waiting.promise;
    invalidate(s, stop);
    id.resolve(requestId);
    await work;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.deepEqual(s.calls, ['context']);
    assert.deepEqual(s.view().nodes, []);
    assert.equal(s.view().receiptStatus, '');
  }
  const s = await ready(),
    id = deferred<string>(),
    waiting = deferred<void>();
  s.ids.next = () => {
    waiting.resolve();
    return id.promise;
  };
  s.controller.requestCreate();
  const work = s.controller.confirmCreate();
  await waiting.promise;
  s.controller.dismissCreate();
  id.resolve(requestId);
  await work;
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.view().creationConfirmation, false);
});

test('late applied or rejected callbacks after dispatch cannot settle, emit or refill text beyond any invalidation fence', async () => {
  for (const outcome of ['applied', 'rejected'] as const)
    for (const stop of fences) {
      const s = await ready(),
        response = deferred<RatingCategoryCreationReceipt>(),
        dispatched = deferred<void>();
      s.gateway.command = async () => {
        dispatched.resolve();
        return response.promise;
      };
      s.controller.requestCreate();
      const work = s.controller.confirmCreate();
      await dispatched.promise;
      const original = originalCategory(s),
        bytes = JSON.stringify(s.storage.get(journalKey(s)));
      invalidate(s, stop);
      const changeCount = s.changes.length;
      response.resolve(
        outcome === 'applied'
          ? categoryCreationReceipt(original.intent)
          : cancelledCategoryReceipt(original.intent),
      );
      await work;
      assert.deepEqual(s.pendingRatings.load(s.accountId), original);
      assert.equal(JSON.stringify(s.storage.get(journalKey(s))), bytes);
      assert.deepEqual(s.view().nodes, []);
      assert.deepEqual(s.view().parents, []);
      assert.deepEqual(s.view().campusIds, []);
      assert.equal(s.view().receiptStatus, '');
      assert.equal(s.changes.length, changeCount);
    }
});

test('only the original account can query, retry or explicitly cancel its uncertain category request', async () => {
  const s = await unknownCommand(),
    original = originalCategory(s),
    count = s.calls.length;
  invalidate(s, 'account');
  assert.equal(s.view().canCancelCategoryCreation, false);
  assert.equal(s.view().recoveryOperation, '');
  assert.deepEqual(s.view().nodes, []);
  assert.equal(s.pendingRatings.load(otherId), null);
  s.controller.requestCancelCategoryCreation();
  await s.controller.confirmCancelCategoryCreation();
  await s.controller.recover(true);
  assert.equal(s.calls.length, count);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  s.calls.length = 0;
  const views: RatingCategoryManagementView[] = [];
  const reopened = new RatingCategoryManagementController(s.runtime, (view) =>
    views.push(view),
  );
  await reopened.load({ regionId: otherId });
  assert.deepEqual(s.calls, ['receipt']);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.deepEqual(views[views.length - 1]!.nodes, []);
  s.gateway.command = async (intent) => {
    s.calls.push('command');
    assert.deepEqual(intent, original.intent);
    return categoryCreationReceipt(intent);
  };
  await reopened.recover(true);
  assert.deepEqual(s.calls, ['receipt', 'command']);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.ids.count, 1);
  reopened.dispose();
});

test('explicit cancellation needs its own confirmation and exact original input; a prior applied receipt wins', async () => {
  for (const outcome of ['rejected', 'applied'] as const) {
    const s = await unknownCommand(),
      original = originalCategory(s);
    await s.controller.confirmCancelCategoryCreation();
    assert.equal(s.calls.includes('cancel'), false);
    let calls = 0;
    s.gateway.cancel = async (intent) => {
      calls++;
      assert.equal(JSON.stringify(intent), JSON.stringify(original.intent));
      assert.equal(
        JSON.stringify(s.storage.get(journalKey(s))),
        JSON.stringify(original),
      );
      return outcome === 'applied'
        ? categoryCreationReceipt(intent)
        : cancelledCategoryReceipt(intent);
    };
    s.controller.requestCancelCategoryCreation();
    assert.equal(s.view().cancelCategoryCreationConfirmation, true);
    s.controller.dismissCancelCategoryCreation();
    await s.controller.confirmCancelCategoryCreation();
    assert.equal(calls, 0);
    s.controller.requestCancelCategoryCreation();
    await s.controller.confirmCancelCategoryCreation();
    assert.equal(calls, 1);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().canCancelCategoryCreation, false);
    assert.equal(s.view().needsRefresh, true);
    assert.deepEqual(s.view().nodes, []);
    assert.equal(s.changes.length, outcome === 'applied' ? 1 : 0);
  }
});

test('lost cancellation, mismatched receipt and late cancellation keep the original pending request', async () => {
  const s = await unknownCommand(),
    original = originalCategory(s);
  s.gateway.cancel = async () => {
    throw new ClientError('network', 'Lost cancellation');
  };
  s.controller.requestCancelCategoryCreation();
  await s.controller.confirmCancelCategoryCreation();
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.deepEqual(s.changes, []);
  s.gateway.cancel = async () => ({
    ...cancelledCategoryReceipt(original.intent),
    requestId: otherId,
  });
  s.controller.requestCancelCategoryCreation();
  await s.controller.confirmCancelCategoryCreation();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.view().receiptStatus, '');
  for (const stop of [
    'account',
    'same-account',
    'hide',
    'scope',
    'safety',
    'catalog',
  ] as const) {
    const t = await unknownCommand(),
      frozen = originalCategory(t);
    const response = deferred<RatingCategoryCreationReceipt>(),
      dispatched = deferred<void>();
    t.gateway.cancel = async () => {
      dispatched.resolve();
      return response.promise;
    };
    t.controller.requestCancelCategoryCreation();
    const work = t.controller.confirmCancelCategoryCreation();
    await dispatched.promise;
    invalidate(t, stop);
    const changes = t.changes.length;
    response.resolve(categoryCreationReceipt(frozen.intent));
    await work;
    assert.deepEqual(t.pendingRatings.load(t.accountId), frozen);
    assert.equal(t.view().receiptStatus, '');
    assert.equal(t.changes.length, changes);
  }
});

test('corrupt journal and freeze write failure block command dispatch and clear editable draft authority', async () => {
  const s = await ready();
  s.storage.failWrite = true;
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().ready, false);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.changes, []);
  for (const malformed of [
    {
      version: 8,
      accountId: s.accountId,
      intent: {
        ...draftIntent(),
        payload: {
          ...draftIntent().payload,
          nodes: [
            {
              key: 'n0',
              parentKey: null,
              name: ' noncanonical ',
              description: '',
            },
          ],
        },
      },
    },
    { version: 8, accountId: otherId, intent: draftIntent() },
    {
      version: 8,
      accountId: s.accountId,
      intent: draftIntent(),
      contextRevision: 'c'.repeat(43),
    },
    { broken: true },
  ]) {
    const t = categoryHarness();
    t.storage.set(journalKey(t), malformed);
    const bytes = JSON.stringify(t.storage.get(journalKey(t)));
    await t.controller.load({});
    t.controller.requestCreate();
    await t.controller.confirmCreate();
    assert.deepEqual(t.calls, []);
    assert.equal(t.ids.count, 0);
    assert.equal(t.view().frozen, true);
    assert.deepEqual(t.view().nodes, []);
    assert.equal(JSON.stringify(t.storage.get(journalKey(t))), bytes);
    assert.deepEqual(t.changes, []);
  }
});

test('failed freeze readback preserves v8 recovery but never dispatches the unacknowledged original', async () => {
  const s = await ready(),
    originalSet = s.storage.set.bind(s.storage),
    originalGet = s.storage.get.bind(s.storage);
  let failNextRead = false;
  s.storage.set = (key, value) => {
    originalSet(key, value);
    if (key.startsWith('whaleu.ratings.pending.v8:')) failNextRead = true;
  };
  s.storage.get = (key) => {
    if (failNextRead) {
      failNextRead = false;
      throw new Error('Original journal readback failed');
    }
    return originalGet(key);
  };
  s.controller.requestCreate();
  await s.controller.confirmCreate();
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(originalCategory(s), {
    version: 8,
    accountId: s.accountId,
    intent: draftIntent(),
  });
  await s.controller.recover();
  assert.deepEqual(s.calls, ['context', 'receipt']);
  assert.equal(s.pendingRatings.load(s.accountId)?.version, 8);
  assert.deepEqual(s.changes, []);
});

test('settlement remove or readback failure restores v8 and emits no catalog event until durable local completion', async () => {
  for (const failure of ['remove', 'readback'] as const) {
    const s = await ready();
    if (failure === 'remove') s.storage.failRemove = true;
    else {
      const remove = s.storage.remove.bind(s.storage),
        get = s.storage.get.bind(s.storage);
      let failNextRead = false;
      s.storage.remove = (key) => {
        remove(key);
        if (key.startsWith('whaleu.ratings.pending.v8:')) failNextRead = true;
      };
      s.storage.get = (key) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('Settlement readback failed');
        }
        return get(key);
      };
    }
    s.controller.requestCreate();
    await s.controller.confirmCreate();
    const original = originalCategory(s);
    assert.equal(s.view().frozen, true);
    assert.equal(s.view().receiptStatus, '');
    assert.deepEqual(s.view().nodes, []);
    assert.deepEqual(s.changes, []);
    if (failure === 'remove') {
      s.storage.failRemove = false;
      s.gateway.receipt = async () => categoryCreationReceipt(original.intent);
      await s.controller.recover();
      assert.equal(s.pendingRatings.load(s.accountId), null);
      assert.equal(s.changes.length, 1);
    }
  }
});

test('changed original storage and malformed historical receipts cannot release v8 or publish catalog invalidation', async () => {
  const s = await ready(),
    response = deferred<RatingCategoryCreationReceipt>(),
    dispatched = deferred<void>();
  s.gateway.command = async () => {
    dispatched.resolve();
    return response.promise;
  };
  s.controller.requestCreate();
  const work = s.controller.confirmCreate();
  await dispatched.promise;
  const changed = {
    version: 8,
    accountId: s.accountId,
    intent: categoryCreationIntent({
      ...draftIntent().payload,
      clientRequestId: otherId,
    }),
  };
  s.storage.set(journalKey(s), changed);
  response.resolve(categoryCreationReceipt(draftIntent()));
  await work;
  assert.deepEqual(s.storage.get(journalKey(s)), changed);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().receiptStatus, '');
  assert.deepEqual(s.changes, []);
  for (const patch of [
    { requestId: otherId },
    { categories: [] },
    { catalogs: [] },
    { name: 'private' },
    { catalogs: [{ regionId: otherId, catalogRevision: categoryTestId(470) }] },
    {
      categories: [
        {
          ...categoryCreationReceipt(draftIntent()).categories[0],
          parentId: otherId,
        },
      ],
    },
  ]) {
    const t = await unknownCommand(),
      original = originalCategory(t);
    t.gateway.receipt = async () =>
      ({
        ...categoryCreationReceipt(original.intent),
        ...patch,
      }) as RatingCategoryCreationReceipt;
    await t.controller.recover();
    assert.deepEqual(t.pendingRatings.load(t.accountId), original);
    assert.equal(t.view().receiptStatus, '');
    assert.deepEqual(t.changes, []);
  }
});

test('only a durable applied receipt emits minimal catalog change and history never refills a current form', async () => {
  for (const outcome of ['applied', 'rejected'] as const) {
    const s = await unknownCommand(),
      original = originalCategory(s);
    const receipt =
      outcome === 'applied'
        ? categoryCreationReceipt(original.intent)
        : cancelledCategoryReceipt(original.intent);
    s.gateway.receipt = async () => receipt;
    await s.controller.recover();
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.deepEqual(
      s.changes,
      outcome === 'applied'
        ? [
            {
              releaseId: categoryCreationReceipt().releaseId,
              catalogs: categoryCreationReceipt().catalogs,
            },
          ]
        : [],
    );
    assert.deepEqual(s.view().nodes, []);
    assert.deepEqual(s.view().parents, []);
    assert.equal(s.view().ready, false);
    assert.equal(s.view().needsRefresh, true);
    s.gateway.context = async () => {
      throw new ClientError('http', 'No current grant', {
        httpStatus: 403,
        serverCode: 'AUTHORIZATION_REQUIRED',
      });
    };
    await s.controller.reload();
    assert.equal(s.view().ready, false);
    assert.deepEqual(s.view().nodes, []);
    assert.equal(s.pendingRatings.load(s.accountId), null);
  }
});

test('unrelated account scope events cannot revoke the active form but matching events clear all current authority', async () => {
  const s = await ready();
  s.directoryScopeChanges.clear(otherId);
  s.browsingScopeChanges.clear(otherId);
  s.safetyChanges.invalidate(otherId);
  assert.equal(s.view().ready, true);
  assert.equal(s.view().nodes[0]!.name, draftName);
  s.directoryScopeChanges.clear(s.accountId);
  assert.equal(s.view().ready, false);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.view().parents, []);
  assert.deepEqual(s.view().campusIds, []);
  assert.equal(s.view().needsRefresh, true);
});

test('missing configuration or login never opens the editor or sends management reads', async () => {
  const s = categoryHarness(),
    views: RatingCategoryManagementView[] = [];
  const runtime = { ...s.runtime };
  delete runtime.ratingCategoryManagement;
  const unconfigured = new RatingCategoryManagementController(runtime, (view) =>
    views.push(view),
  );
  await unconfigured.load({});
  assert.equal(views[views.length - 1]!.ready, false);
  assert.equal(views[views.length - 1]!.configured, false);
  assert.deepEqual(s.calls, []);
  unconfigured.dispose();
  s.sessions.logout();
  await s.controller.load({});
  assert.equal(s.view().hasSession, false);
  assert.equal(s.view().ready, false);
  assert.deepEqual(s.view().nodes, []);
  assert.deepEqual(s.calls, []);
});
