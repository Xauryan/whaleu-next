import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCategoryManagement,
  decodeReclassificationCommand,
  type CategoryManagement,
  type ReclassificationCommand,
} from '../src/category-reclassification/contract';
import {
  CategoryReclassificationController,
  type CategoryReclassificationView,
} from '../src/category-reclassification/controller';
import type { CategoryReclassificationGateway } from '../src/category-reclassification/gateway';
import { PendingCategoryReclassificationStore } from '../src/category-reclassification/pending';
import { MemoryStorage } from './helpers';
import { postId, requestId, setup } from './community-helpers';

const unavailable = (): CategoryManagement => ({
  postId,
  currentCategory: 'water',
  revision: 0,
  canChange: false,
  targets: [],
});
function harness(initial = unavailable()) {
  const s = setup();
  let management = initial;
  let view!: CategoryReclassificationView;
  const submitted: ReclassificationCommand[] = [];
  const gateway: CategoryReclassificationGateway = {
    management: async () => management,
    submit: async (command) => {
      submitted.push(command);
      return {
        requestId: command.clientRequestId,
        postId: command.postId,
        expectedRevision: command.expectedRevision,
        targetCategory: command.targetCategory,
        outcome: 'rejected',
        code: 'POST_CATEGORY_UNAVAILABLE',
      };
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const controller = new CategoryReclassificationController(
    {
      ...s.runtime,
      categoryReclassification: gateway,
      pendingCategoryReclassification: new PendingCategoryReclassificationStore(
        new MemoryStorage(),
        'synthetic-water-move-contract',
      ),
    },
    (next) => {
      view = next;
    },
  );
  return {
    controller,
    submitted,
    view: () => view,
    setManagement: (next: CategoryManagement) => {
      management = next;
    },
  };
}

test('current unavailable water management never exposes a change or sends a command', async () => {
  const h = harness();
  await h.controller.load(postId);
  assert.equal(h.view().management?.canChange, false);
  assert.deepEqual(h.view().management?.targets, []);
  assert.equal(h.view().status, '此帖子当前不能更改分类');
  await h.controller.request(postId, 'discussion');
  assert.equal(h.view().confirming, null);
  await h.controller.submit();
  assert.deepEqual(h.submitted, []);
  h.controller.dispose();
});

test('future wire compatibility trusts an explicit server target list, not water category membership', async () => {
  // Synthetic response contract only. Migration 0178 does not supply this grant.
  const authorized: CategoryManagement = {
    ...unavailable(),
    canChange: true,
    targets: ['discussion'],
  };
  assert.deepEqual(decodeCategoryManagement(authorized), authorized);
  const h = harness(authorized);
  await h.controller.load(postId);
  await h.controller.request(postId, 'scenery');
  assert.equal(h.view().confirming, null);
  await h.controller.request(postId, 'water');
  assert.equal(h.view().confirming, null);
  await h.controller.request(postId, 'discussion');
  assert.equal(h.view().confirming, 'change');
  assert.equal(h.view().desired, 'discussion');
  assert.deepEqual(h.submitted, []);
  h.controller.closeConfirmation();
  h.setManagement(unavailable());
  await h.controller.request(postId, 'discussion');
  assert.equal(h.view().management?.canChange, false);
  assert.equal(h.view().confirming, null);
  await h.controller.submit();
  assert.deepEqual(h.submitted, []);
  h.controller.dispose();
});

test('water source permission does not widen targets, malformed grants, other source categories, or legacy commands', () => {
  for (const patch of [
    { canChange: true },
    { targets: ['discussion'] },
    { canChange: true, targets: ['water'] },
    { canChange: true, targets: ['discussion', 'discussion'] },
    { canChange: true, targets: ['discussion'], revision: 2147483647 },
    { canChange: true, targets: ['discussion'], currentCategory: 'feedback' },
    { canChange: true, targets: ['discussion'], currentCategory: 'trading' },
    {
      canChange: true,
      targets: ['discussion'],
      currentCategory: 'future_category',
    },
  ])
    assert.throws(() =>
      decodeCategoryManagement({ ...unavailable(), ...patch }),
    );
  const command = {
    clientRequestId: requestId,
    postId,
    expectedRevision: 0,
    targetCategory: 'discussion',
  };
  assert.deepEqual(decodeReclassificationCommand(command), command);
  assert.throws(() =>
    decodeReclassificationCommand({ ...command, targetCategory: 'water' }),
  );
  assert.throws(() =>
    decodeReclassificationCommand({ ...command, originalCategory: 'water' }),
  );
});
