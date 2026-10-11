import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { CategoryIconMediaReadProof } from '../src/media/category-icon-owner-proof.js';
import { CategoryIconMediaAssetRepository } from '../src/media/category-icon-asset-repository.js';
import type { CategoryIconMediaMutation } from '../src/media/category-icon-asset-repository.js';
import { CategoryIconRetirementProofRegistry } from '../src/media/category-icon-retirement-proof.js';
import type { CategoryIconTerminalRetirement } from '../src/media/category-icon-retirement-proof.js';
import { MediaCategoryIconPrepareScopes } from '../src/media/category-icon-prepare-scope.js';
import { MediaRequiredProof } from '../src/media/required-proof.js';
import {
  categoryIconReadFixture,
  categoryIconAssetRow,
  categoryIconQueryClient,
} from './support/media/category-icon-facts.js';

const unavailable = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'MEDIA_UNAVAILABLE';
test('Category icon current proof binds request, exact original qualification, epoch and authenticated viewer independently of uploader', async () => {
  const f = categoryIconReadFixture(),
    tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const proof = await f.registry.authorize('valid-token', f.request, tx);
    const read = f.registry.require(proof, f.request, tx);
    assert.equal(read.principal.accountId, f.viewer);
    assert.notEqual(read.principal.accountId, read.actorAccountId);
    assert.equal(Object.isFrozen(read.qualification.baseSource), true);
    assert.deepEqual(read.qualification, f.authority.qualification);
    for (const key of [
      'categoryId',
      'contextId',
      'appearanceId',
      'requestId',
    ] as const)
      assert.throws(() =>
        f.registry.require(proof, { ...f.request, [key]: randomUUID() }, tx),
      );
    assert.throws(() =>
      f.registry.require(proof, { ...f.request, purpose: 'download' }, tx),
    );
    assert.throws(() =>
      f.registry.require({} as CategoryIconMediaReadProof, f.request, tx),
    );
    await assert.rejects(f.registry.authorize('', f.request, tx));
    await assert.rejects(f.registry.authorize('bad-token', f.request, tx));
    const checkpoint = checkpointTransactionDeadlines(tx);
    restoreTransactionDeadlines(tx, checkpoint);
    assert.throws(() => f.registry.require(proof, f.request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Category icon upload scope requires exact current original-owner all-of authorization and cannot masquerade as target', async () => {
  const f = categoryIconReadFixture(),
    tx = {} as PoolClient;
  const input = {
    protocol: 'ratings-category-icon-media-v1',
    clientRequestId: randomUUID(),
    editScopeId: randomUUID(),
    scopeRevision: 'a'.repeat(64),
    slot: 'icon',
    declaration: { mime: 'image/png', bytes: 1, sha256: 'b'.repeat(64) },
  };
  let actor = f.actor;
  const scopes = new MediaCategoryIconPrepareScopes({
    async authorizePrepare() {
      return {
        actorAccountId: actor,
        serverScopeId: input.editScopeId,
        scopeRevision: input.scopeRevision,
        expiresAt: Date.now() + 10000,
        ownerKind: 'ratings',
        resourceKind: 'category_icon',
        targetKind: 'edit',
        contentVersion: 1,
        audience: 'content-gated',
        purpose: 'ratings-category-icon-image',
        slot: 'icon',
        ordinal: 0,
      };
    },
  });
  startTransactionDeadlines(tx);
  try {
    const proof = await scopes.authorizeCategoryIcon(f.actor, input, tx);
    assert.equal(scopes.require(proof, tx).scope.resourceKind, 'category_icon');
    await assert.rejects(scopes.authorizeRatings(f.actor, input, tx));
    actor = randomUUID();
    await assert.rejects(
      scopes.authorizeCategoryIcon(f.actor, input, tx),
      unavailable,
    );
    const checkpoint = checkpointTransactionDeadlines(tx);
    restoreTransactionDeadlines(tx, checkpoint);
    assert.throws(() => scopes.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Category icon bulk of 32 gathers every route before globally sorted batch, intent, asset and binding locks', async () => {
  const f = categoryIconReadFixture(),
    rows = Array.from({ length: 32 }, () => categoryIconAssetRow(f.actor));
  const q = categoryIconQueryClient((sql) => {
    if (sql.startsWith('SELECT intent_id FROM whaleu_media.assets'))
      return {
        rows: rows.map((r) => ({ intent_id: r.intent_id })),
        rowCount: 32,
      };
    if (sql.startsWith('SELECT a.*,i.protocol_version'))
      return { rows, rowCount: 32 };
    return undefined;
  });
  startTransactionDeadlines(q.tx);
  try {
    const assets = new CategoryIconMediaAssetRepository(f.registry);
    await assert.rejects(
      assets.acceptCategoryIconOwned(
        {
          actor: f.actor,
          scopeId: randomUUID(),
          scopeRevision: 'a'.repeat(64),
          expiresAt: Date.now() + 1000,
        },
        rows[0]!.id,
        {} as CategoryIconMediaMutation,
        q.tx,
      ),
    );
    const mutation = await assets.prepareCategoryIconMutation(
      f.actor,
      rows.map((r) => r.id).reverse(),
      null,
      q.tx,
    );
    const batch = q.calls.findIndex((c) =>
        c.sql.includes('FROM whaleu_media.publication_batches'),
      ),
      intents = q.calls.findIndex((c) =>
        c.sql.includes('FROM whaleu_media.upload_intents WHERE id IN'),
      ),
      sources = q.calls.findIndex((c) =>
        c.sql.startsWith('SELECT a.*,i.protocol_version'),
      ),
      bindings = q.calls.findIndex((c) =>
        c.sql.startsWith('SELECT * FROM whaleu_media.bindings'),
      );
    assert.ok(
      batch >= 0 && intents > batch && sources > intents && bindings > sources,
    );
    assert.deepEqual(q.calls[intents]!.values, [rows.map((r) => r.id).sort()]);
    assert.match(q.calls[sources]!.sql, /ORDER BY a.id FOR UPDATE OF a NOWAIT/);
    assert.equal(
      q.calls.filter((c) =>
        c.sql.includes('FROM whaleu_media.upload_intents WHERE id IN'),
      ).length,
      1,
    );
    await assert.rejects(assets.finishCategoryIconMutation(mutation, q.tx));
    await assert.rejects(checkTransactionDeadlines(q.tx), unavailable);
    await assert.rejects(
      assets.prepareCategoryIconMutation(
        f.actor,
        [...rows.map((r) => r.id), randomUUID()],
        null,
        q.tx,
      ),
    );
    await assert.rejects(
      assets.prepareCategoryIconMutation(
        f.actor,
        [rows[0]!.id, rows[0]!.id],
        null,
        q.tx,
      ),
    );
  } finally {
    clearTransactionDeadlines(q.tx);
  }
});

test('Category icon mutation finishes once, cannot survive savepoint rollback and retains preexisting Media proof conflicts', async () => {
  const f = categoryIconReadFixture(),
    q = categoryIconQueryClient(),
    assets = new CategoryIconMediaAssetRepository(f.registry);
  startTransactionDeadlines(q.tx);
  try {
    const checkpoint = checkpointTransactionDeadlines(q.tx);
    const rolledBack = await assets.prepareCategoryIconMutation(
      f.actor,
      [],
      null,
      q.tx,
    );
    restoreTransactionDeadlines(q.tx, checkpoint);
    await assert.rejects(assets.finishCategoryIconMutation(rolledBack, q.tx));
    const mutation = await assets.prepareCategoryIconMutation(
      f.actor,
      [],
      null,
      q.tx,
    );
    await assets.finishCategoryIconMutation(mutation, q.tx);
    await assert.rejects(assets.finishCategoryIconMutation(mutation, q.tx));
    await checkTransactionDeadlines(q.tx);
    assert.ok(
      q.calls.some((c) =>
        c.sql.includes('category_icon_request_markers IN SHARE MODE NOWAIT'),
      ),
    );
    assert.equal(q.calls.at(-1)?.sql, 'SELECT clock_timestamp() AS now');
    assert.equal(
      q.calls.some((c) => c.sql.includes('UPDATE whaleu_media.bindings')),
      false,
      'keep/archive/hide never implies detach',
    );
  } finally {
    clearTransactionDeadlines(q.tx);
  }
  startTransactionDeadlines(q.tx);
  try {
    await new MediaRequiredProof().capture(q.tx);
    const mutation = await assets.prepareCategoryIconMutation(
      f.actor,
      [],
      null,
      q.tx,
    );
    q.bump();
    await assets.finishCategoryIconMutation(mutation, q.tx);
    await assert.rejects(checkTransactionDeadlines(q.tx), unavailable);
  } finally {
    clearTransactionDeadlines(q.tx);
  }
});

test('Category icon terminal retirement is owner-authorized, single-use and accepts another authorized uploader without creator inference', async () => {
  const f = categoryIconReadFixture(),
    old = categoryIconAssetRow(randomUUID()),
    appearanceId = randomUUID(),
    bindingId = randomUUID();
  const retirement = {
    appearanceId,
    assetId: old.id,
    bindingId,
    actorAccountId: old.actor_id,
    manifestDigest: old.manifest_digest,
  };
  const registry = new CategoryIconRetirementProofRegistry({
    async authorizeTerminalRetirement(_credential, request) {
      return {
        actorAccountId: f.actor,
        requestId: request.requestId,
        closureRevision: 'a'.repeat(64),
        kind: 'terminal-no-recoverable-roots',
        appearances: [retirement],
      };
    },
  });
  const q = categoryIconQueryClient((sql) => {
    if (sql.startsWith('SELECT intent_id FROM'))
      return { rows: [{ intent_id: old.intent_id }], rowCount: 1 };
    if (sql.startsWith('SELECT a.*,i.protocol_version'))
      return { rows: [old], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM whaleu_media.bindings'))
      return {
        rows: [
          {
            id: bindingId,
            asset_id: old.id,
            resource_id: appearanceId,
            owner_kind: 'ratings',
            resource_kind: 'category_icon',
            content_version: '1',
            manifest_digest: old.manifest_digest,
            slot: 'icon',
            ordinal: 0,
            detached_at: null,
          },
        ],
        rowCount: 1,
      };
    return undefined;
  });
  startTransactionDeadlines(q.tx);
  try {
    const assets = new CategoryIconMediaAssetRepository(f.registry, registry);
    await assert.rejects(
      assets.prepareCategoryIconMutation(
        f.actor,
        [],
        {} as CategoryIconTerminalRetirement,
        q.tx,
      ),
    );
    const proof = await registry.authorize(
      'valid-token',
      { requestId: randomUUID(), appearanceIds: [appearanceId] },
      q.tx,
    );
    await assets.prepareCategoryIconMutation(f.actor, [], proof, q.tx);
    assert.notEqual(old.actor_id, f.actor);
    await assert.rejects(
      assets.prepareCategoryIconMutation(f.actor, [], proof, q.tx),
    );
    assert.equal(
      q.calls.some((c) => c.sql.includes('UPDATE whaleu_media.bindings')),
      false,
      'admission alone never detaches',
    );
  } finally {
    clearTransactionDeadlines(q.tx);
  }
});

test('One Category icon bulk capability attaches all 32 independently scoped new icons atomically and captures only the final write epoch', async () => {
  const f = categoryIconReadFixture(),
    rows = Array.from({ length: 32 }, () => categoryIconAssetRow(f.actor)),
    bindings: string[] = [];
  const deadline = new Date(Date.now() + 60000),
    eventId = randomUUID();
  let bump: () => void = () => undefined;
  const q = categoryIconQueryClient((sql, values) => {
    if (sql.startsWith('SELECT intent_id FROM whaleu_media.assets'))
      return {
        rows: rows.map((r) => ({ intent_id: r.intent_id })),
        rowCount: rows.length,
      };
    if (sql.startsWith('SELECT a.*,i.protocol_version'))
      return {
        rows: sql.includes('ANY(')
          ? rows
          : rows.filter((r) => r.id === values[0]),
        rowCount: sql.includes('ANY(') ? rows.length : 1,
      };
    if (sql.startsWith('SELECT state FROM whaleu_media.upload_intents'))
      return { rows: [{ state: 'ready' }], rowCount: 1 };
    if (sql.startsWith('SELECT expires_at FROM whaleu_media.upload_intents'))
      return { rows: [{ expires_at: deadline }], rowCount: 1 };
    if (
      sql.startsWith(
        'SELECT revision,event_id FROM whaleu_media.asset_safety_heads',
      )
    )
      return { rows: [{ revision: '1', event_id: eventId }], rowCount: 1 };
    if (sql.startsWith('SELECT e.*,t.read_at'))
      return {
        rows: [
          {
            state: 'allow',
            manifest_digest: rows.find((r) => r.id === values[0])!
              .manifest_digest,
            policy_revision: 'media-static-v1',
            effective_at: new Date(Date.now() - 1000),
            valid_until: deadline,
            read_at: new Date(),
            exact_time_valid: true,
          },
        ],
        rowCount: 1,
      };
    if (sql.startsWith('INSERT INTO whaleu_media.')) {
      bump();
      if (sql.startsWith('INSERT INTO whaleu_media.bindings'))
        bindings.push(values[0] as string);
      return { rows: [], rowCount: 1 };
    }
    return undefined;
  });
  bump = q.bump;
  startTransactionDeadlines(q.tx);
  try {
    const assets = new CategoryIconMediaAssetRepository(f.registry),
      mutation = await assets.prepareCategoryIconMutation(
        f.actor,
        rows.map((r) => r.id),
        null,
        q.tx,
      );
    for (const row of rows) {
      const scope = {
        actor: f.actor,
        scopeId: row.resource_id,
        scopeRevision: row.scope_revision,
        expiresAt: deadline.getTime(),
      };
      const accepted = await assets.acceptCategoryIconOwned(
        scope,
        row.id,
        mutation,
        q.tx,
      );
      const parent = {
        ownerKind: 'ratings' as const,
        resourceKind: 'category_icon' as const,
        resourceId: randomUUID(),
        contentVersion: 1 as const,
      };
      await assets.bindCategoryIcon(accepted, parent, mutation, q.tx);
      await assert.rejects(
        assets.bindCategoryIcon(accepted, parent, mutation, q.tx),
      );
    }
    assert.equal(bindings.length, 32);
    assert.equal(new Set(bindings).size, 32);
    assert.equal(
      q.calls.some((c) => c.sql.includes('UPDATE whaleu_media.bindings')),
      false,
    );
    await assets.finishCategoryIconMutation(mutation, q.tx);
    await checkTransactionDeadlines(q.tx);
    const capture = q.calls.findIndex((c) =>
      c.sql.startsWith('SELECT slot,version,epoch::text'),
    );
    const lastWrite = q.calls.reduce(
      (last, c, index) =>
        c.sql.startsWith('INSERT INTO whaleu_media.') ? index : last,
      -1,
    );
    assert.ok(
      capture > lastWrite,
      'final Media proof is captured after every new binding, not once per node',
    );
  } finally {
    clearTransactionDeadlines(q.tx);
  }
});
