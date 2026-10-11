import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunityRuntime } from '../src/community/runtime';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import { CategoryIconCoordinator } from '../src/ratings/category-icon-coordinator';
import { categoryIconDraftSlots } from '../src/ratings/category-icon-draft';
import {
  categoryIconTextIntent,
  decodeRatingCategoryIconReceipt,
} from '../src/ratings/category-icon-contract';
import {
  decodeRatingCategoryScopedIntent,
  ratingCategoryScopedIntentHash,
} from '../src/ratings/category-scoped-contract';
import {
  categoryIconPrepareForScope,
  categoryIconScopeRequestHash,
  type CategoryIconScopeInput,
  type CategoryIconScope,
} from '../src/ratings/category-icon-upload-scope';
import {
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
  type CategoryIconGrant,
} from '../src/ratings/category-icon-media-contract';
import type { CategoryIconMediaGateway } from '../src/ratings/category-icon-media-gateway';
import type { CategoryIconUploadTransfer } from '../src/ratings/category-icon-upload';
import {
  categoryIconHarness,
  iconId,
  iconReceipt,
  mediaSnapshot,
} from './category-icon-helpers';
import { managementIntent } from './category-scoped-helpers';
import { accountId } from './identity-helpers';
test('32 separately owned native icons freeze text once and atomically publish after every upload and complete', async () => {
  const h = categoryIconHarness();
  h.controller.dispose();
  const resident = new Set<string>(),
    owner = {},
    calls: string[] = [];
  let sequence = 0,
    picks = 0,
    maxResident = 0,
    committed = false;
  const scopes = new Map<
    string,
    {
      input: CategoryIconScopeInput;
      scope: CategoryIconScope;
      status: CategoryIconMediaStatus;
    }
  >();
  const registry = new MediaLocalFiles({
    stat: async (path) => (resident.has(path) ? 5 * 1024 * 1024 : 0),
    image: async () => ({ width: 1, height: 1, type: 'png' }),
    readError: async () => null,
    unlink: async (path) => {
      resident.delete(path);
    },
  });
  const record = (scopeId: string) => {
    const found = [...scopes.values()].find(
      (v) => v.scope.editScopeId === scopeId,
    );
    assert.ok(found);
    return found;
  };
  const media: CategoryIconMediaGateway = {
    descriptor: async () => {
      throw Error('No provider descriptors in synthetic upload');
    },
    scope: async (input) => {
      calls.push('scope');
      const pending = h.store.load(accountId).uploads!;
      assert.ok(
        pending.members.some(
          (member) =>
            member.scopeInput.clientRequestId === input.clientRequestId,
        ),
        'identity is durable BEFORE network',
      );
      const existing = scopes.get(input.clientRequestId);
      if (existing) return existing.scope;
      const n = scopes.size,
        scope = {
          editScopeId: iconId(100 + n),
          scopeRevision: 'd'.repeat(64),
          categoryId: iconId(200 + n),
          identityId: iconId(300 + n),
          expiresAt: '2026-10-11T00:00:00.000Z',
        },
        prepare = categoryIconPrepareForScope(input, scope),
        status: CategoryIconMediaStatus = {
          protocol: 'ratings-category-icon-media-v1',
          editScopeId: scope.editScopeId,
          intentId: iconId(400 + n),
          requestId: input.clientRequestId,
          requestHash: categoryIconPrepareHash(accountId, prepare),
          serverNow: 1000,
          status: 'prepared',
          operationDeadlineAt: 9999999999999,
          upload: 'none',
        };
      scopes.set(input.clientRequestId, { input, scope, status });
      return scope;
    },
    prepare: async (input) => {
      calls.push('prepare-upload');
      return record(input.editScopeId).status;
    },
    recover: async (requestId) => {
      calls.push('recover-upload');
      return {
        protocol: 'ratings-category-icon-media-v1',
        requestId,
        serverNow: 1000,
        state: 'not_recorded',
        requestHash: null,
      };
    },
    status: async (scopeId) => record(scopeId).status,
    grant: async (scopeId) => {
      calls.push('grant');
      const row = record(scopeId),
        d = row.input.declaration;
      return {
        protocol: 'ratings-category-icon-media-v1',
        editScopeId: scopeId,
        intentId: row.status.intentId,
        strategy: 'authenticated-multipart-v1',
        generation: '1',
        grantId: iconId(500 + scopes.size),
        method: 'POST',
        fieldName: 'file',
        maxBytes: 5242880,
        expectedBytes: d.bytes,
        expectedMime: d.mime,
        expectedSha256: d.sha256,
        grantExpiresAt: 2000,
        operationDeadlineAt: 3000,
        serverNow: 1000,
      };
    },
    finalize: async (scopeId) => {
      calls.push('finalize');
      const row = record(scopeId),
        old = row.status;
      row.status = {
        protocol: old.protocol,
        editScopeId: old.editScopeId,
        intentId: old.intentId,
        requestId: old.requestId,
        requestHash: old.requestHash,
        serverNow: 1000,
        status: 'ready_unbound',
        assetId: iconId(600 + [...scopes.keys()].indexOf(old.requestId)),
        readyRetentionUntil: 9999999999999,
        editExpiresAt: 9999999999999,
        bindBefore: 9999999999999,
        mediaProof: 'current',
      };
      return row.status;
    },
    recoverScope: async (requestId, hash) => {
      calls.push('recover-scope');
      const row = scopes.get(requestId);
      assert.ok(row);
      assert.equal(hash, categoryIconScopeRequestHash(row.input));
      assert.equal(row.status.status, 'ready_unbound');
      const ready = row.status as Extract<
          CategoryIconMediaStatus,
          { status: 'ready_unbound' }
        >,
        status: CategoryIconMediaStatus = committed
          ? {
              protocol: ready.protocol,
              editScopeId: ready.editScopeId,
              intentId: ready.intentId,
              requestId: ready.requestId,
              requestHash: ready.requestHash,
              serverNow: 1000,
              status: 'bound_history',
              assetId: ready.assetId,
              bindingId: iconId(800),
              appearanceId: iconId(801),
              categoryId: row.scope.categoryId,
              attachmentState: 'active',
            }
          : ready;
      return {
        state: 'known',
        scope: row.scope,
        recovery: {
          protocol: ready.protocol,
          requestId,
          requestHash: ready.requestHash,
          serverNow: 1000,
          state: 'recorded',
          status,
        },
      };
    },
    cancelScope: async () => {
      throw Error('No cancellation during successful commit');
    },
    cancelRequest: async () => {
      throw Error('No cross-owner cancellation');
    },
  };
  const transfer: CategoryIconUploadTransfer = {
    localFiles: registry,
    pick: async (session) => {
      picks++;
      const reservation = registry.reserve(),
        path = `wxfile://tmp/icon-${picks}.png`;
      resident.add(path);
      maxResident = Math.max(maxResident, resident.size);
      return registry.adopt(
        path,
        5 * 1024 * 1024,
        owner,
        session.current(),
        reservation,
      );
    },
    inspect: async () => ({
      mime: 'image/png',
      bytes: 5 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    }),
    remove: (file) => registry.release(file),
    settled: () => true,
    clearSession: () => undefined,
    upload: async (grant: CategoryIconGrant) => {
      calls.push('native');
      const credit = registry.acquireTransfer(accountId);
      const complete = Promise.resolve().then(() => {
        calls.push('native-complete');
        credit();
      });
      return {
        complete,
        result: Promise.resolve({
          protocol: grant.protocol,
          editScopeId: grant.editScopeId,
          status: 'uploadObserved',
          intentId: grant.intentId,
          generation: grant.generation,
          grantId: grant.grantId,
          bytes: grant.expectedBytes,
          sha256: grant.expectedSha256,
          next: 'finalize',
        }),
      };
    },
  };
  const runtime: CommunityRuntime = {
    ...h.runtime,
    ratingCategoryIconMedia: media,
    ratingCategoryIconUpload: transfer,
    newRequestId: async () => iconId(1000 + sequence++),
  };
  h.gateway.commit = async (intent) => {
    committed = true;
    const old = iconReceipt(intent);
    assert.notEqual(old.outcome, 'closed');
    if (old.outcome === 'closed') throw Error('fixture');
    return decodeRatingCategoryIconReceipt({
      ...old,
      result: {
        ...old.result,
        categoryIds: [...scopes.values()].map((v) => v.scope.categoryId),
      },
    });
  };
  const coordinator = new CategoryIconCoordinator(
    runtime,
    { now: () => 1000, schedule: () => () => undefined },
    () => undefined,
  );
  try {
    const text = managementIntent('batch_update_subcategories_scoped');
    if (text.operation !== 'batch_update_subcategories_scoped')
      throw Error('fixture');
    const nodes = Array.from({ length: 32 }, (_, n) => ({
        key: `n${n}`,
        parentKey: null,
        name: `节点 ${n}`,
        description: '',
      })),
      draft = decodeRatingCategoryScopedIntent({
        ...text,
        payload: {
          ...text.payload,
          addNodes: nodes,
          orderedChildren: nodes.map((n) => ({ kind: 'new', key: n.key })),
        },
      }),
      slots = categoryIconDraftSlots(
        draft,
        new Map(nodes.map((n) => [`new:${n.key}`, 'replace' as const])),
      );
    coordinator.start(draft, mediaSnapshot, iconId(999), slots);
    for (const slot of slots) {
      await coordinator.append(slot.key, new Cancellation());
      assert.equal(resident.size, 0);
      assert.equal(committed, false);
    }
    assert.equal(picks, 32);
    assert.equal(maxResident, 1);
    assert.equal(h.store.load(accountId).uploads!.members.length, 32);
    for (const row of scopes.values())
      assert.equal(
        ratingCategoryScopedIntentHash(
          decodeRatingCategoryScopedIntent({
            protocolVersion: 2,
            context: row.input.context,
            operation: row.input.operation,
            payload: row.input.payload,
          }),
        ),
        ratingCategoryScopedIntentHash(draft),
      );
    const prepared = await coordinator.prepare(new Cancellation());
    assert.ok(!('outcome' in prepared));
    if ('outcome' in prepared) throw Error('fixture');
    const intent = h.store.load(accountId).command!.intent;
    assert.deepEqual(categoryIconTextIntent(intent), draft);
    assert.equal(committed, false);
    await coordinator.commit(prepared, new Cancellation());
    assert.equal(committed, true);
    assert.equal(h.store.load(accountId).command, null);
    assert.equal(h.store.load(accountId).uploads, null);
    assert.equal(calls.filter((c) => c === 'native-complete').length, 32);
  } finally {
    coordinator.dispose();
  }
});
