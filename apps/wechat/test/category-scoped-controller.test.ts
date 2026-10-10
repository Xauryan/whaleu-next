import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { RatingCategoryScopedController } from '../src/ratings/category-scoped-controller';
import {
  ratingCategoryScopedOperations,
  type RatingCategoryScopedPrepared,
} from '../src/ratings/category-scoped-contract';
import { deferred } from './helpers';
import { accountId, wireCredentials } from './identity-helpers';
import { categoryTestId } from './category-management-helpers';
import {
  categoryScopedHarness,
  flushManagement,
  managedArchivedChild,
  managedCampus,
  managedCampusB,
  managedChild,
  managedId,
  managedOtherRoot,
  managedRoute,
  managedCategory,
  managementIntent,
  managementPreparation,
  managementReceipt,
} from './category-scoped-helpers';

async function editor() {
  const s = categoryScopedHarness();
  await s.controller.load(managedRoute);
  assert.equal(s.view().loaded, true);
  return s;
}
test('all nine native editor operations prepare separately, require explicit commit, and issue one immutable request', async () => {
  for (const operation of ratingCategoryScopedOperations) {
    const s = categoryScopedHarness();
    await s.controller.load(
      operation === 'create_system_category_scoped' ||
        operation === 'create_categories_scoped'
        ? { scope: 'campus', campusId: managedCampus }
        : managedRoute,
    );
    s.controller.selectOperation(operation);
    if (operation === 'create_categories_scoped')
      s.controller.setNodeText('n0', 'name', '新普通分类');
    if (operation === 'edit_category_base_scoped')
      s.controller.setText('name', '新的共享基础');
    if (operation === 'set_category_override_scoped') {
      s.controller.choose('nameMode', 'inherit');
      s.controller.choose('descriptionMode', 'set');
      s.controller.setText('description', '');
    }
    if (operation === 'set_category_visibility_scoped')
      s.controller.choose('visibility', 'hidden');
    if (operation === 'reorder_categories_scoped')
      s.controller.move(managedOtherRoot, 'up');
    if (operation === 'set_category_scope_scoped')
      s.controller.choose('propagation', 'subtree');
    if (operation === 'batch_update_subcategories_scoped') {
      s.controller.batchAction(managedChild, 'disable');
      s.controller.batchAction(managedArchivedChild, 'restore');
      s.controller.addNode();
      s.controller.setNodeText('n1', 'name', '新直接子项');
      s.controller.move('n1', 'up');
    }
    if (operation === 'create_system_category_scoped') {
      s.controller.selectSystemKey('synthetic_general');
      s.controller.setText('name', '注册系统根');
      s.controller.choose('levelCount', '3');
    }
    await s.controller.prepare();
    assert.equal(s.prepared.length, 1, `${operation}: ${s.view().error}`);
    assert.equal(s.prepared[0]!.operation, operation);
    assert.equal(s.committed.length, 0);
    assert.equal(s.pending()?.version, 10);
    assert.ok(s.view().preview);
    assert.equal(JSON.stringify(s.view()).includes('tokenDigest'), false);
    assert.equal(JSON.stringify(s.view()).includes('contextRevision'), false);
    const bytes = JSON.stringify(s.pending());
    s.controller.setText('name', 'ignored while frozen');
    await s.controller.prepare();
    assert.equal(JSON.stringify(s.pending()), bytes);
    assert.equal(s.prepared.length, 1);
    await s.controller.commit();
    assert.equal(s.committed.length, 1);
    assert.equal(s.pending(), null);
    assert.equal(s.view().needsRefresh, true);
    s.controller.dispose();
  }
});
test('closing preview, hide, source invalidation and account changes clear private state but preserve v10 journal', async () => {
  for (const kind of [
    'close',
    'hide',
    'catalog',
    'scope',
    'account',
  ] as const) {
    const s = await editor();
    s.controller.selectOperation('set_category_override_scoped');
    s.controller.setText('name', 'private draft');
    await s.controller.prepare();
    const bytes = JSON.stringify(s.pending());
    assert.ok(s.view().preview);
    if (kind === 'close') s.controller.closePreview();
    else if (kind === 'hide') s.runtime.privateViews!.clear();
    else if (kind === 'catalog')
      s.runtime.ratingCatalogChanges!.publish({
        releaseId: categoryTestId(999),
        catalogs: [],
      });
    else if (kind === 'scope') s.runtime.browsingScopeChanges!.clear(accountId);
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: managedCampus,
      });
    await s.controller.commit();
    assert.equal(s.committed.length, 0);
    assert.equal(s.view().preview, null);
    assert.equal(s.view().name, '');
    assert.equal(
      JSON.stringify(s.runtime.pendingRatings!.load(accountId)),
      bytes,
    );
    s.controller.dispose();
  }
});
test('late preparation and repeated clicks never auto-commit or replace a journal after dismissal', async () => {
  const s = await editor(),
    wait = deferred<RatingCategoryScopedPrepared>();
  s.gateway.prepare = async (intent) => {
    s.prepared.push(intent);
    return wait.promise;
  };
  s.controller.selectOperation('edit_category_base_scoped');
  s.controller.setText('name', 'original');
  const first = s.controller.prepare();
  await flushManagement();
  assert.equal(s.view().busy, true);
  await s.controller.prepare();
  assert.equal(s.prepared.length, 1);
  const attempt = s.pending()!;
  s.controller.cancel();
  wait.resolve(managementPreparation(s.prepared[0]!));
  await first;
  assert.equal(s.view().preview, null);
  assert.equal(s.committed.length, 0);
  assert.deepEqual(s.pending(), attempt);
  await s.controller.reload();
  assert.equal(s.calls[s.calls.length - 1], 'receipt');
  assert.equal(s.view().frozen, true);
  s.controller.dispose();
});
test('recovery precedes invalid route/current provider reads, remains receipt-only, and preserves uncertain cancellation', async () => {
  const s = categoryScopedHarness(),
    intent = managementIntent();
  s.runtime.pendingRatings!.freeze({ version: 10, accountId, intent });
  s.gateway.context = async () => {
    throw new Error('Current provider must not be consulted');
  };
  await s.controller.load({ invalidRoute: true });
  assert.deepEqual(s.calls, ['receipt']);
  assert.equal(s.view().frozen, true);
  await s.controller.preparePending();
  assert.equal(s.prepared.length, 1);
  assert.equal(s.committed.length, 0);
  const before = JSON.stringify(s.pending());
  s.gateway.cancel = async () => {
    throw new ClientError('network', 'Unknown cancellation');
  };
  s.controller.requestCancel();
  await s.controller.confirmCancel();
  assert.equal(JSON.stringify(s.pending()), before);
  s.gateway.cancel = async (original) => managementReceipt(original, 'applied');
  s.controller.requestCancel();
  await s.controller.confirmCancel();
  assert.equal(s.pending(), null);
  assert.match(s.view().receiptStatus, /回执已确认/);
  s.controller.dispose();
});
test('a new same-account session can recover a published original without replacing its context or body', async () => {
  const s = await editor();
  s.controller.selectOperation('edit_category_base_scoped');
  s.controller.setText('name', 'shared original');
  await s.controller.prepare();
  const original = s.prepared[0]!;
  s.gateway.commit = async () => {
    throw new ClientError('network', 'Lost response');
  };
  await s.controller.commit();
  assert.ok(s.pending());
  s.controller.dispose();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('next'));
  s.gateway.receipt = async () => managementReceipt(original);
  let confirmed = false;
  const next = new RatingCategoryScopedController(s.runtime, (view) => {
    if (view.receiptStatus) confirmed = true;
  });
  await next.load({ invalid: true });
  assert.equal(confirmed, true);
  assert.equal(s.pending(), null);
  next.dispose();
});
test('unavailable body is never reflected from base/override caches; no request is sent without a new required name', async () => {
  const s = categoryScopedHarness();
  s.current.rows = [
    managedCategory({
      blockedReason: 'CONTENT_REVIEW_UNAVAILABLE',
      name: null,
      description: null,
    }),
  ];
  await s.controller.load(managedRoute);
  assert.equal(s.view().baseName, '正文暂不可用');
  assert.equal(s.view().overrideDescription, '正文暂不可用');
  s.controller.selectOperation('edit_category_base_scoped');
  assert.equal(s.view().name, '');
  await s.controller.prepare();
  assert.equal(s.prepared.length, 0);
  assert.equal(s.pending(), null);
  s.controller.setText('name', '全新修正正文');
  await s.controller.prepare();
  assert.equal(s.prepared.length, 1);
  s.controller.dispose();
});
test('full siblings including hidden/disabled/archived are retained beyond rendered windows and batch discard is local', async () => {
  const s = categoryScopedHarness();
  s.current.rows = [
    managedCategory(),
    ...Array.from({ length: 530 }, (_, index) =>
      managedCategory({
        id: categoryTestId(2000 + index),
        parentId: managedId,
        level: 2,
        ordinal: String(index + 10),
        businessState: index % 2 ? 'archived' : 'disabled',
        hidden: true,
      }),
    ),
  ];
  await s.controller.load(managedRoute);
  s.controller.selectOperation('batch_update_subcategories_scoped');
  assert.equal(s.view().orderCount, 530);
  assert.equal(s.view().order.length, 50);
  s.controller.addNode();
  s.controller.setNodeText('n1', 'name', 'One new child');
  await s.controller.prepare();
  const intent = s.prepared[0]!;
  assert.equal(intent.operation, 'batch_update_subcategories_scoped');
  if (intent.operation === 'batch_update_subcategories_scoped')
    assert.equal(intent.payload.orderedChildren.length, 531);
  s.controller.dispose();
  const clean = await editor();
  clean.controller.selectOperation('batch_update_subcategories_scoped');
  clean.controller.batchAction(managedChild, 'disable');
  clean.controller.addNode();
  clean.controller.discardDraft();
  assert.equal(clean.pending(), null);
  assert.equal(clean.view().nodes.length, 0);
  assert.equal(clean.calls.includes('prepare'), false);
  clean.controller.dispose();
});
test('expiry blocks confirmation and failed terminal receipt matching cannot release the journal', async () => {
  const s = await editor();
  s.controller.selectOperation('set_category_visibility_scoped');
  await s.controller.prepare();
  s.current.now += 180001;
  await s.controller.commit();
  assert.equal(s.committed.length, 0);
  assert.equal(s.view().preview, null);
  assert.ok(s.pending());
  s.gateway.receipt = async () => ({
    ...managementReceipt(s.prepared[0]!),
    intentHash: 'f'.repeat(64),
  });
  await s.controller.recover();
  assert.ok(s.pending());
  s.controller.dispose();
});

test('base preview separates shared and per-view effective text, explicit empty overrides and dormant views across bounded pages', async () => {
  const s = await editor(),
    dormant = categoryTestId(923);
  const body = (
    name: string,
    description: string,
    mode: 'inherit' | 'set',
    applicable = true,
  ) =>
    JSON.stringify({
      name,
      description,
      modes: { name: { mode }, description: { mode } },
      applicable,
      hidden: false,
    });
  s.gateway.prepare = async (intent) => {
    s.prepared.push(intent);
    return {
      ...managementPreparation(intent, s.current.now),
      affectedScopeKeys: [
        `campus:${managedCampus}`,
        `campus:${managedCampusB}`,
        `campus:${dormant}`,
      ],
      changes: [
        {
          categoryId: managedId,
          scopeKeys: [`campus:${managedCampus}`, `campus:${managedCampusB}`],
          field: 'base_body',
          beforeStatus: 'available',
          afterStatus: 'available',
          before: body('旧基础', '旧简介', 'inherit'),
          after: body('新基础', '新简介', 'inherit'),
        },
        {
          categoryId: managedId,
          scopeKeys: [`campus:${managedCampus}`],
          field: 'effective_body',
          beforeStatus: 'available',
          afterStatus: 'available',
          before: body('A覆盖', '', 'set'),
          after: body('A覆盖', '', 'set'),
        },
        {
          categoryId: managedId,
          scopeKeys: [`campus:${managedCampusB}`],
          field: 'effective_body',
          beforeStatus: 'available',
          afterStatus: 'available',
          before: body('旧基础', '旧简介', 'inherit'),
          after: body('新基础', '新简介', 'inherit'),
        },
        ...Array.from({ length: 18 }, () => ({
          categoryId: managedId,
          scopeKeys: [`campus:${managedCampusB}`],
          field: 'order' as const,
          beforeStatus: 'available' as const,
          afterStatus: 'available' as const,
          before: '1',
          after: '2',
        })),
        {
          categoryId: managedId,
          scopeKeys: [`campus:${dormant}`],
          field: 'effective_body',
          beforeStatus: 'available',
          afterStatus: 'available',
          before: body('休眠覆盖', '', 'set', false),
          after: body('休眠覆盖', '', 'set', false),
        },
      ],
    };
  };
  s.controller.selectOperation('edit_category_base_scoped');
  s.controller.setText('name', '新基础');
  await s.controller.prepare();
  const first = s.view().preview;
  assert.ok(first);
  assert.equal(first.changeCount, 22);
  assert.equal(first.to, 20);
  assert.match(first.lines.join('\n'), /共享基础正文/);
  assert.match(first.lines.join('\n'), /该范围实际显示正文/);
  assert.match(first.lines.join('\n'), /简介：（明确为空）/);
  assert.match(first.lines.join('\n'), /简介模式：继承共享基础/);
  const journal = JSON.stringify(s.pending());
  s.controller.pagePreview(1);
  const second = s.view().preview;
  assert.ok(second);
  assert.equal(second.to, 22);
  assert.match(second.lines.join('\n'), new RegExp(dormant));
  assert.match(second.lines.join('\n'), /当前不适用（保留的休眠视图）/);
  assert.equal(JSON.stringify(s.pending()), journal);
  await s.controller.commit();
  assert.equal(s.committed.length, 1);
  s.controller.dispose();
});

test('unresolved source conflicts explain trusted adjudication without guessing a campus or discarding the original request', async () => {
  const s = await editor();
  s.controller.selectOperation('set_category_scope_scoped');
  s.gateway.prepare = async () => {
    throw new ClientError('business', 'Unresolved sources', {
      serverCode: 'RATING_CATEGORY_SOURCE_UNRESOLVED',
    });
  };
  await s.controller.prepare();
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().preview, null);
  assert.match(s.view().error, /共享基础文字和业务状态/);
  assert.match(
    s.view().error,
    /身份映射、共享定义或基础元数据冲突须由可信来源裁决/,
  );
  assert.match(s.view().error, /不能按当前校园猜测/);
  assert.equal(s.committed.length, 0);
  const pending = s.pending();
  assert.ok(pending);
  await s.controller.recover();
  assert.deepEqual(s.pending(), pending);
  s.controller.requestCancel();
  await s.controller.confirmCancel();
  assert.equal(s.pending(), null);
  s.controller.dispose();
});

test('parent-held and override-revoked effective previews stay explicitly unavailable and never reuse cached set values as new input', async () => {
  for (const reason of ['PARENT_REVIEW_HELD', 'OVERRIDE_REVIEW_REVOKED']) {
    const s = categoryScopedHarness(),
      secret = `old cached override ${reason}`;
    s.current.rows = [
      managedCategory({
        name: null,
        description: null,
        baseName: null,
        baseDescription: null,
        blockedReason: reason,
        override: {
          name: { mode: 'set', value: secret },
          description: { mode: 'set', value: secret },
        },
      }),
    ];
    await s.controller.load(managedRoute);
    s.controller.selectOperation('edit_category_base_scoped');
    assert.equal(s.view().name, '');
    assert.equal(s.view().description, '');
    s.controller.setText('name', 'New explicitly typed base');
    s.controller.setText('description', 'New explicitly typed description');
    s.gateway.prepare = async (intent) => {
      s.prepared.push(intent);
      return {
        ...managementPreparation(intent, s.current.now),
        changes: [
          {
            categoryId: managedId,
            scopeKeys: [`campus:${managedCampus}`],
            field: 'base_body',
            before: null,
            beforeStatus: 'unavailable',
            after: JSON.stringify({
              name: 'New explicitly typed base',
              description: 'New explicitly typed description',
            }),
            afterStatus: 'available',
          },
          {
            categoryId: managedId,
            scopeKeys: [`campus:${managedCampus}`],
            field: 'effective_body',
            before: null,
            beforeStatus: 'unavailable',
            after: null,
            afterStatus: 'unavailable',
          },
        ],
      };
    };
    await s.controller.prepare();
    const preview = s.view().preview;
    assert.ok(preview);
    const effective = preview.lines.find((line) =>
      line.includes('该范围实际显示正文'),
    );
    assert.ok(effective);
    assert.match(effective, /变更后【不可用】正文已遮蔽/);
    assert.match(effective, /不是空字符串/);
    assert.equal(JSON.stringify(s.view()).includes(secret), false);
    assert.equal(JSON.stringify(s.pending()).includes(secret), false);
    assert.equal(s.committed.length, 0);
    s.controller.requestCancel();
    await s.controller.confirmCancel();
    s.controller.dispose();
  }
});

test('complete 10000-sibling reordering is blocked before freeze/network without clipping or splitting its editable draft', async () => {
  const s = categoryScopedHarness();
  s.current.rows = [
    managedCategory({ ordinal: '0' }),
    ...Array.from({ length: 9999 }, (_, index) =>
      managedCategory({
        id: categoryTestId(3000 + index),
        ordinal: String(index + 1),
      }),
    ),
  ];
  await s.controller.load(managedRoute);
  s.controller.selectOperation('reorder_categories_scoped');
  assert.equal(s.view().orderCount, 10000);
  assert.equal(s.view().order.length, 50);
  const before = [...s.calls];
  let freezes = 0;
  const store = s.runtime.pendingRatings!,
    freeze = store.freeze.bind(store);
  store.freeze = (attempt) => {
    freezes++;
    return freeze(attempt);
  };
  await s.controller.prepare();
  assert.equal(freezes, 0);
  assert.equal(s.pending(), null);
  assert.deepEqual(s.calls, before);
  assert.equal(s.prepared.length, 0);
  assert.equal(s.committed.length, 0);
  assert.equal(s.cancelled.length, 0);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().operation, 'reorder_categories_scoped');
  assert.equal(s.view().orderCount, 10000);
  assert.match(s.view().error, /不能截断或拆分提交/);
  assert.match(s.view().error, /完整同级集合本身过大，请联系管理者/);
  s.controller.move(categoryTestId(3000), 'up');
  assert.equal(s.view().order[0]!.key, categoryTestId(3000));
  await s.controller.prepare();
  assert.equal(freezes, 0);
  assert.equal(s.view().orderCount, 10000);
  s.controller.dispose();
  const normal = await editor();
  normal.controller.selectOperation('reorder_categories_scoped');
  const complete = normal.view().order.map((item) => item.key);
  await normal.controller.prepare();
  assert.equal(normal.prepared.length, 1);
  const intent = normal.prepared[0]!;
  assert.equal(intent.operation, 'reorder_categories_scoped');
  if (intent.operation === 'reorder_categories_scoped')
    assert.deepEqual(
      intent.payload.orderedIds,
      complete,
      'A normal equivalent ordering still sends its complete unchanged set',
    );
  assert.ok(normal.view().preview);
  await normal.controller.commit();
  assert.equal(normal.committed.length, 1);
  normal.controller.dispose();
});

test('legal maximum emoji batch text is preflighted by UTF-8 and stays editable until its complete request fits', async () => {
  const s = await editor();
  s.controller.selectOperation('batch_update_subcategories_scoped');
  for (let index = 1; index <= 32; index++) {
    s.controller.addNode();
    s.controller.setNodeText(`n${index}`, 'name', `New ${index}`);
    s.controller.setNodeText(`n${index}`, 'description', '😀'.repeat(500));
  }
  const before = [...s.calls];
  await s.controller.prepare();
  assert.deepEqual(s.calls, before);
  assert.equal(s.pending(), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().nodes.length, 32);
  assert.equal(s.view().nodes[0]!.description, '😀'.repeat(500));
  assert.match(s.view().error, /安全请求体预算/);
  for (let index = 1; index <= 4; index++)
    s.controller.setNodeText(`n${index}`, 'description', '');
  await s.controller.prepare();
  assert.equal(s.prepared.length, 1);
  const intent = s.prepared[0]!;
  assert.equal(intent.operation, 'batch_update_subcategories_scoped');
  if (intent.operation === 'batch_update_subcategories_scoped') {
    assert.equal(intent.payload.addNodes.length, 32);
    assert.equal(intent.payload.orderedChildren.length, 34);
    assert.equal(intent.payload.addNodes[4]!.description, '😀'.repeat(500));
  }
  s.controller.dispose();
});
