import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assistanceIntentHash,
  ASSISTANCE_PROFILE,
  type AssistanceRequest,
  type AssistanceResult,
} from '../src/ratings/assistance-contract';
import type { AssistanceGateway } from '../src/ratings/assistance-gateway';
import { PendingAssistanceStore } from '../src/ratings/assistance-pending';
import {
  categoryScopedHarness,
  managementNow,
  managedCampus,
  managedRoute,
} from './category-scoped-helpers';
import { categoryTestId } from './category-management-helpers';
import { deferred, flush } from './helpers';
const suggestion = '探索校园精彩评分分类';
function harness() {
  const s = categoryScopedHarness(),
    requests: AssistanceRequest[] = [],
    reads: string[] = [];
  let latest: AssistanceRequest;
  const result = (): AssistanceResult => ({
    status: 'available',
    version: 1,
    actorId: s.accountId,
    requestId: latest.requestId,
    purpose: latest.purpose,
    draftId: latest.draftId,
    inputRevision: latest.inputRevision,
    intentHash: assistanceIntentHash(latest),
    inputDigest: 'a'.repeat(64),
    resultId: categoryTestId(9600),
    resultDigest: createHash('sha256')
      .update(`whaleu:ratings:assistance:result:v1\n${suggestion}`)
      .digest('hex'),
    profileRevision: ASSISTANCE_PROFILE,
    outputContract: 1,
    text: suggestion,
    expiresAt: new Date(managementNow + 100000).toISOString(),
  });
  const gateway: AssistanceGateway = {
    create: async (request) => {
      requests.push(request);
      latest = request;
      return {
        version: 1,
        requestId: request.requestId,
        purpose: request.purpose,
        intentHash: assistanceIntentHash(request),
        outcome: 'generated',
      };
    },
    result: async (id) => {
      reads.push(id);
      return result();
    },
    status: async () => ({
      version: 1,
      requestId: latest.requestId,
      purpose: latest.purpose,
      intentHash: assistanceIntentHash(latest),
      outcome: 'generated',
    }),
    cancel: async () => ({
      version: 1,
      requestId: latest.requestId,
      purpose: latest.purpose,
      intentHash: assistanceIntentHash(latest),
      outcome: 'generated',
    }),
  };
  Object.assign(s.runtime, {
    assistance: gateway,
    pendingAssistance: new PendingAssistanceStore(
      s.storage,
      'category-assistance',
    ),
  });
  return { ...s, assistanceGateway: gateway, requests, reads, result };
}
test('root category suggestion has separate preview/adopt/edit and existing prepare/commit owners', async () => {
  const s = harness();
  await s.controller.load({ scope: 'campus', campusId: managedCampus });
  s.controller.selectOperation('create_categories_scoped');
  s.controller.setNodeText('n0', 'name', '课程讨论');
  s.controller.setNodeText('n0', 'description', '原有手写简介');
  await s.controller.generateDescription('n0');
  assert.equal(s.view().nodes[0]?.description, '原有手写简介');
  assert.equal(s.view().assistance.preview, suggestion);
  assert.equal(s.prepared.length, 0);
  assert.equal(s.committed.length, 0);
  assert.equal(s.requests[0]?.purpose, 'category_description');
  assert.ok(!JSON.stringify(s.requests).includes('原有手写简介'));
  await s.controller.adoptDescription();
  assert.equal(s.reads.length, 2);
  assert.equal(s.view().nodes[0]?.description, suggestion);
  s.controller.setNodeText('n0', 'description', '采用后再手动修改');
  await s.controller.prepare();
  assert.equal(s.prepared.length, 1);
  assert.equal(s.committed.length, 0);
  assert.equal(s.view().assistance.preview, '');
  const prepared = s.prepared[0]!;
  assert.equal(prepared.operation, 'create_categories_scoped');
  if (prepared.operation === 'create_categories_scoped')
    assert.equal(prepared.payload.nodes[0]?.description, '采用后再手动修改');
  await s.controller.commit();
  assert.equal(s.committed.length, 1);
  s.controller.dispose();
});
test('system root binds registered key/depth; ordinary edit and child nodes never gain generation', async () => {
  const s = harness();
  await s.controller.load({ scope: 'global' });
  s.controller.selectOperation('create_system_category_scoped');
  s.controller.selectSystemKey('synthetic_general');
  s.controller.choose('levelCount', '3');
  s.controller.setText('name', '系统课程');
  await s.controller.generateDescription();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0]?.purpose, 'category_description');
  if (
    s.requests[0]?.purpose === 'category_description' &&
    s.requests[0].payload.operation === 'create_system_category_scoped'
  )
    assert.equal(s.requests[0].payload.levelCount, 3);
  await s.controller.adoptDescription();
  assert.equal(s.view().description, suggestion);
  await s.controller.load(managedRoute);
  s.controller.selectOperation('edit_category_base_scoped');
  await s.controller.generateDescription();
  assert.equal(s.requests.length, 1);
  s.controller.dispose();
});
test('new root typing/placement and publication freeze defeat a delayed suggestion callback without losing metadata recovery', async () => {
  const s = harness();
  await s.controller.load({ scope: 'global' });
  s.controller.selectOperation('create_categories_scoped');
  s.controller.setNodeText('n0', 'name', '校园');
  const held = deferred<AssistanceResult>();
  s.assistanceGateway.result = async () => held.promise;
  const generating = s.controller.generateDescription('n0');
  await flush();
  s.controller.setNodeText('n0', 'description', '更新后的手写内容');
  held.resolve(s.result());
  await generating;
  assert.equal(s.view().assistance.preview, '');
  assert.equal(s.view().nodes[0]?.description, '更新后的手写内容');
  assert.ok(s.runtime.pendingAssistance!.load(s.accountId));
  await s.controller.prepare();
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().assistance.preview, '');
  await s.controller.adoptDescription();
  assert.equal(s.prepared.length, 1);
  s.controller.dispose();
});
