/** Real HTTP / PostgreSQL lifecycle and final-generation boundaries. Run only
 * under the parent's exclusive disposable PostgreSQL lease. Synthetic fixtures
 * supply bytes and exact Review decisions, never receipts or projections. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { MediaLifecycleRepository } from '../../src/media/lifecycle-repository.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import type { ExactObject } from '../../src/media/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  categoryIconRetirementCleanupSchema,
  categoryIconRetirementStatusSchema,
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import { RatingCategoryIconMediaService } from '../../src/ratings/category-management/icon-media.service.js';
import { RatingCategoryIconManagementService } from '../../src/ratings/category-management/icon-service.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const globalSelector = { kind: 'global' } as const;
const constraintViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23514';
async function imageFixture() {
  const sharp = (await import('sharp')).default;
  const png = await sharp({
    create: { width: 67, height: 49, channels: 3, background: '#235c81' },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp({
    create: { width: 73, height: 53, channels: 3, background: '#a56231' },
  })
    .jpeg()
    .toBuffer();
  const f = await categoryIconManagementFixture([
    { sha256: sha256(png), verdict: 'allow' },
    { sha256: sha256(jpeg), verdict: 'allow' },
  ]);
  return { f, png, jpeg };
}
async function createIntent(
  f: CategoryIconManagementFixture,
  selector: RatingNavigationSelector = globalSelector,
  campusIds?: string[],
) {
  return f.intent(await f.context(selector), 'create_categories_scoped', {
    parentId: null,
    placement: campusIds
      ? { kind: 'campuses', campusIds: [...campusIds].sort() }
      : { kind: 'global' },
    nodes: [
      {
        key: 'root',
        parentKey: null,
        name: 'Exact retirement category',
        description: 'Retained original request',
        icon: { mode: 'clear' },
      },
    ],
  });
}
async function createImage(
  f: CategoryIconManagementFixture,
  bytes: Buffer,
  selector: RatingNavigationSelector = globalSelector,
  campusIds?: string[],
) {
  const upload = await f.ready(
    await createIntent(f, selector, campusIds),
    { kind: 'new', key: 'root' },
    bytes,
  );
  const created = await f.execute(upload.input);
  const categoryId = created.receipt.result.categoryIds[0]!;
  const icon = (await f.publicPage(selector)).page.items.find(
    (item) => item.id === categoryId,
  )?.icon;
  assert.ok(
    icon,
    'The real compiled Category DTO must expose the new appearance',
  );
  return { upload, created, categoryId, icon };
}
async function edit(
  f: CategoryIconManagementFixture,
  categoryId: string,
  icon: { mode: 'keep' | 'clear' },
  selector: RatingNavigationSelector = globalSelector,
) {
  return f.intent(await f.context(selector), 'edit_category_base_scoped', {
    categoryId,
    name: 'Exact retirement category',
    description: 'Retained original request',
    icon,
  });
}
async function status(
  f: CategoryIconManagementFixture,
  requestId: string,
  appearanceIds?: string[],
) {
  const response = await f.post('retirement/status', {
    requestId,
    ...(appearanceIds ? { appearanceIds } : {}),
  });
  categoryIconHttpOk(response);
  assert.equal(response.headers['cache-control'], 'no-store');
  return categoryIconRetirementStatusSchema.parse(response.body).items;
}
async function queue(f: CategoryIconManagementFixture) {
  return (
    await f.pool
      .query(`SELECT appearance_id,causing_actor_id,causing_request_id,plan_digest,
    scope_keys,global_required,creation_transaction::text FROM whaleu_ratings.category_icon_retirement_queue
    ORDER BY appearance_id,causing_actor_id,causing_request_id`)
  ).rows;
}
async function binding(f: CategoryIconManagementFixture, appearanceId: string) {
  const row = (
    await f.pool.query<{
      detached_at: Date | null;
      detach_reason: string | null;
      state: string;
    }>(
      `SELECT b.detached_at,b.detach_reason,i.state FROM whaleu_ratings.category_icon_appearances a
      JOIN whaleu_media.bindings b ON b.id=a.media_binding_id JOIN whaleu_media.assets asset ON asset.id=a.asset_id
      JOIN whaleu_media.upload_intents i ON i.id=asset.intent_id WHERE a.id=$1`,
      [appearanceId],
    )
  ).rows[0];
  assert.ok(row);
  return row;
}
async function lifecycleState(f: CategoryIconManagementFixture) {
  return {
    artifacts: await f.artifacts(),
    queue: await queue(f),
    cleanup: (
      await f.pool.query(
        'SELECT * FROM whaleu_media.cleanup_obligations ORDER BY id',
      )
    ).rows,
  };
}
async function cleanup(
  f: CategoryIconManagementFixture,
  requestId: string,
  appearanceId: string,
) {
  const response = await f.post('retirement/cleanup', {
    requestId,
    appearanceIds: [appearanceId],
  });
  categoryIconHttpOk(response);
  assert.deepEqual(categoryIconRetirementCleanupSchema.parse(response.body), {
    state: 'cleanup_pending',
    appearanceIds: [appearanceId],
  });
  return response;
}
async function exactGrant(f: CategoryIconManagementFixture, campusId: string) {
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.rating_category_campus_grants
      (id,account_id,campus_id,approved_by_account_id,approval_reference,valid_from)
      VALUES($1,$2,$3,$2,'synthetic-retirement-all-of',clock_timestamp()-interval '1 second')`,
      [randomUUID(), f.admin.accountId, campusId],
    ),
  );
}

/** Join the unmodified real command owner to the guarded fixture transaction so
 * hostile statements can run after its complete graph, before actual COMMIT.
 * No receipt, cause, source, Review binding or projection is manufactured. */
async function commandThenSql(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  contextRevision: string,
  after: (tx: PoolClient) => Promise<void>,
) {
  const database = f.app.get(DatabaseService),
    original = database.transaction;
  try {
    await withCommunityScopeWriter(f.pool, async (tx) => {
      database.transaction = async <T>(
        work: (client: PoolClient) => Promise<T>,
      ): Promise<T> => work(tx);
      const receipt = await f.app
        .get(RatingCategoryIconManagementService)
        .commit(f.admin.accessToken, {
          intent: input,
          preparationContextRevision: contextRevision,
        });
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      await after(tx);
    });
  } finally {
    database.transaction = original;
  }
}
async function replaceExternalPolicySource(tx: PoolClient) {
  // The policy is an external synthetic owner input, not a managed Category
  // derivative. Replacing scope_absence after creation would correctly fail the
  // immediate managed-lineage guard and never exercise the final-generation seal.
  const prior = (
    await tx.query<{ id: string; revision: string; source_key: string }>(
      `SELECT s.id,s.revision,s.source_key FROM whaleu_ratings.scoped_source_heads h
      JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
      WHERE s.source_kind='native_scoped_category_management'
        AND s.source_key='synthetic-category-icon-management' AND s.issuer='synthetic-scoped-issuer'`,
    )
  ).rows;
  assert.equal(prior.length, 1);
  const id = randomUUID(),
    revision = randomUUID();
  const inserted = await tx.query(
    `INSERT INTO whaleu_ratings.scoped_source_attestations
    (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,
      source_reference,policy_reference,effective_at,valid_until)
    SELECT $1::uuid,$2::uuid,s.source_kind,s.source_key,s.scope_keys,s.payload,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,
        'kind',s.source_kind,'key',s.source_key,'scopeKeys',s.scope_keys,'payload',s.payload)),
      s.coverage,s.provenance,s.issuer,'synthetic-retirement-policy:'||$1::uuid::text,s.policy_reference,
      greatest(clock_timestamp(),s.effective_at+interval '1 microsecond'),s.valid_until
    FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=$3 AND s.revision=$4`,
    [id, revision, prior[0]!.id, prior[0]!.revision],
  );
  assert.equal(inserted.rowCount, 1);
  const changed = await tx.query(
    `UPDATE whaleu_ratings.scoped_source_heads SET source_id=$1,source_revision=$2
    WHERE source_kind='native_scoped_category_management' AND source_key=$3 AND source_id=$4 AND source_revision=$5`,
    [id, revision, prior[0]!.source_key, prior[0]!.id, prior[0]!.revision],
  );
  assert.equal(
    changed.rowCount,
    1,
    'The legal source writer must replace the exact external policy head',
  );
}
async function holdReview(tx: PoolClient, decisionId: string) {
  const eventId = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_events
    (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
    VALUES($1,$2,'held','complete','accepted','synthetic-retirement-review','synthetic-late-review-hold',clock_timestamp())`,
    [eventId, decisionId],
  );
  await tx.query(
    'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
    [decisionId, eventId],
  );
}
async function advanceZeroRows(tx: PoolClient) {
  const before = (
    await tx.query<{ epoch: string }>(
      'SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
    )
  ).rows[0]!.epoch;
  const result = await tx.query(
    'UPDATE whaleu_ratings.category_icon_definition_heads SET retention=retention WHERE false',
  );
  assert.equal(result.rowCount, 0);
  const after = (
    await tx.query<{ epoch: string }>(
      'SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
    )
  ).rows[0]!.epoch;
  assert.equal(
    BigInt(after),
    BigInt(before) + 1n,
    'Even a zero-row raw writer must queue a new final-generation event',
  );
}

test(
  'Category replacement and clear retain exact durable retirement causes; cleanup stages deletion without claiming it',
  { timeout: 360000 },
  async (t) => {
    const { f, png, jpeg } = await imageFixture();
    t.after(() => f.close());
    const first = await createImage(f, png);
    assert.deepEqual(
      await status(f, first.upload.input.payload.clientRequestId),
      [],
    );
    const replacement = await f.ready(
      await edit(f, first.categoryId, { mode: 'clear' }),
      { kind: 'base', categoryId: first.categoryId },
      jpeg,
      'image/jpeg',
    );
    const replaced = await f.execute(replacement.input);
    const second = (await f.publicPage()).page.items.find(
      (item) => item.id === first.categoryId,
    )?.icon;
    assert.ok(second);
    assert.notEqual(second.appearanceId, first.icon.appearanceId);
    const cleared = await f.execute(
      await edit(f, first.categoryId, { mode: 'clear' }),
    );
    assert.equal(
      (await f.publicPage()).page.items.find(
        (item) => item.id === first.categoryId,
      )?.icon,
      null,
    );
    const obligations = await queue(f);
    assert.equal(obligations.length, 2);
    for (const [appearanceId, command] of [
      [first.icon.appearanceId, replaced],
      [second.appearanceId, cleared],
    ] as const) {
      const obligation = obligations.find(
        (row) => row.appearance_id === appearanceId,
      )!;
      const prepared = await f.stored(command.input);
      assert.equal(obligation.causing_actor_id, f.admin.accountId);
      assert.equal(
        obligation.causing_request_id,
        command.input.payload.clientRequestId,
      );
      assert.equal(obligation.plan_digest, prepared.media_plan.plan.digest);
      assert.deepEqual(
        obligation.scope_keys,
        prepared.media_plan.plan.affectedScopeKeys,
      );
      assert.equal(
        obligation.global_required,
        prepared.media_plan.plan.globalRequired,
      );
      assert.equal((await binding(f, appearanceId)).detached_at, null);
      assert.deepEqual(await status(f, command.input.payload.clientRequestId), [
        { appearanceId, state: 'eligible' },
      ]);
      assert.deepEqual(
        await status(f, command.input.payload.clientRequestId, [appearanceId]),
        [{ appearanceId, state: 'eligible' }],
      );
    }
    const objects = (
      await f.pool.query<{
        object: ExactObject;
        sha256: string;
        bytes: string;
      }>(
        `SELECT jsonb_build_object('provider',provider,'environment',environment,'bucket',bucket,
        'key',object_key,'version',object_version) object,sha256,bytes::text
        FROM whaleu_media.variants WHERE asset_id=$1 ORDER BY variant_name`,
        [first.upload.status.assetId],
      )
    ).rows;
    assert.equal(objects.length, 2);
    await cleanup(
      f,
      replaced.input.payload.clientRequestId,
      first.icon.appearanceId,
    );
    const retired = await binding(f, first.icon.appearanceId);
    assert.ok(retired.detached_at instanceof Date);
    assert.equal(
      retired.detach_reason,
      'ratings-category-icon-terminal-retirement',
    );
    assert.equal(retired.state, 'cleanup_pending');
    assert.deepEqual(await status(f, replaced.input.payload.clientRequestId), [
      { appearanceId: first.icon.appearanceId, state: 'retired' },
    ]);
    assert.deepEqual(
      await queue(f),
      obligations,
      'Terminal cleanup never erases the originating obligation',
    );
    assert.ok(f.storage);
    for (const object of objects) {
      const measured = await f.storage.measure(object.object);
      assert.equal(measured.sha256, object.sha256);
      assert.equal(
        measured.bytes,
        Number(object.bytes),
        'Staging cleanup is not physical deletion',
      );
    }
    const cleanupRows = (
      await f.pool.query(
        `SELECT c.state,c.confirmed_deleted_at FROM whaleu_media.cleanup_obligations c JOIN whaleu_media.variants v ON (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=(v.provider,v.environment,v.bucket,v.object_key,v.object_version) WHERE v.asset_id=$1`,
        [first.upload.status.assetId],
      )
    ).rows;
    assert.ok(cleanupRows.length > 0);
    assert.ok(
      cleanupRows.every(
        (row) => row.state === 'pending' && row.confirmed_deleted_at === null,
      ),
    );
    const beforeReplay = await lifecycleState(f);
    assert.deepEqual(
      (await f.commit(replaced.input, replaced.prepared.contextRevision)).body,
      replaced.receipt,
    );
    assert.deepEqual(
      (await f.post('prepare', replaced.input)).body,
      replaced.receipt,
    );
    assert.notEqual(
      (
        await f.post('retirement/cleanup', {
          requestId: replaced.input.payload.clientRequestId,
          appearanceIds: [first.icon.appearanceId],
        })
      ).status,
      200,
      'A retired appearance cannot obtain another terminal mutation',
    );
    assert.deepEqual(await lifecycleState(f), beforeReplay);
    // The same real owner retirement must reach physical absence, not merely
    // a terminal logical state. Preserve the original quiet period and retry.
    const quiet = (
      await f.pool.query<{ at: Date }>(
        "SELECT max(not_before) at FROM whaleu_media.cleanup_obligations WHERE state='pending'",
      )
    ).rows[0]!.at.getTime();
    const wait = Math.max(0, quiet - Date.now() + 100);
    assert.ok(wait <= 121000);
    await delay(wait);
    const lifecycle = new MediaLifecycleRepository();
    const lease = await withCommunityScopeWriter(f.pool, (tx) =>
      lifecycle.claimCleanup(tx),
    );
    assert.ok(lease);
    assert.equal(
      await withCommunityScopeWriter(f.pool, (tx) =>
        lifecycle.settleCleanup(lease, 'retryable', tx),
      ),
      'retryable',
    );
    const retry = (
      await f.pool.query<{ state: string; attempt: number; not_before: Date }>(
        'SELECT state,attempt,not_before FROM whaleu_media.cleanup_obligations WHERE id=$1',
        [lease.id],
      )
    ).rows[0]!;
    assert.equal(retry.state, 'retryable');
    assert.equal(retry.attempt, 1);
    await delay(Math.max(0, retry.not_before.getTime() - Date.now() + 100));
    const worker = new SyntheticMediaCleanup(f.pool, f.storage);
    let drained = false;
    for (let cursor = 0; cursor < 50; cursor++) {
      const result = await worker.runOne();
      if (result === 'idle') {
        drained = true;
        break;
      }
      assert.equal(
        result,
        'deleted',
        'Every claimed exact retired object is independently confirmed',
      );
    }
    assert.equal(
      drained,
      true,
      'Continuation exhausts a bounded durable queue',
    );
    for (const object of objects)
      await assert.rejects(() => f.storage!.measure(object.object));
    const physical = (
      await f.pool.query(
        `SELECT c.state,c.confirmed_deleted_at FROM whaleu_media.cleanup_obligations c JOIN whaleu_media.variants v ON (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=(v.provider,v.environment,v.bucket,v.object_key,v.object_version) WHERE v.asset_id=$1`,
        [first.upload.status.assetId],
      )
    ).rows;
    assert.ok(physical.length > 0);
    assert.ok(
      physical.every(
        (row) =>
          row.state === 'deleted' && row.confirmed_deleted_at instanceof Date,
      ),
    );
    assert.deepEqual(await status(f, replaced.input.payload.clientRequestId), [
      { appearanceId: first.icon.appearanceId, state: 'retired' },
    ]);
  },
);

test(
  'Category retirement status and cleanup require exact original request, bounded IDs and current all-of removed-campus authority',
  { timeout: 360000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const campus = { kind: 'campus', campusId: f.campusA } as const;
    const image = await createImage(f, png, campus, [f.campusA, f.campusB]);
    const cleared = await f.execute(
      await edit(f, image.categoryId, { mode: 'clear' }, campus),
    );
    await f.execute(
      f.intent(await f.context(campus), 'set_category_scope_scoped', {
        categoryId: image.categoryId,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        propagation: 'self',
      }),
    );
    const exact = {
      requestId: cleared.input.payload.clientRequestId,
      appearanceIds: [image.icon.appearanceId],
    };
    const obligations = await queue(f);
    assert.ok(obligations[0]!.scope_keys.includes(`campus:${f.campusB}`));
    const stranger = await f.actor();
    await f.grant(stranger, 'super_admin');
    for (const route of ['retirement/status', 'retirement/cleanup']) {
      assert.notEqual(
        (await f.post(route, exact, stranger)).status,
        200,
        'Another administrator cannot take over the original actor request',
      );
      for (const body of [
        { ...exact, requestId: randomUUID() },
        { ...exact, appearanceIds: [randomUUID()] },
        { ...exact, appearanceIds: [] },
        {
          ...exact,
          appearanceIds: [image.icon.appearanceId, image.icon.appearanceId],
        },
        {
          ...exact,
          appearanceIds: Array.from({ length: 257 }, () => randomUUID()),
        },
      ])
        assert.notEqual(
          (await f.post(route, body)).status,
          200,
          JSON.stringify(body),
        );
    }
    assert.notEqual(
      (await f.post('retirement/cleanup', { requestId: exact.requestId }))
        .status,
      200,
    );
    await exactGrant(f, f.campusA);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id
        WHERE account_id=$1 AND role='super_admin' AND revoked_at IS NULL`,
        [f.admin.accountId],
      ),
    );
    assert.notEqual(
      (await f.post('retirement/status', { requestId: exact.requestId }))
        .status,
      200,
    );
    assert.notEqual((await f.post('retirement/status', exact)).status, 200);
    assert.notEqual((await f.post('retirement/cleanup', exact)).status, 200);
    assert.equal((await binding(f, image.icon.appearanceId)).detached_at, null);
    assert.deepEqual(await queue(f), obligations);
    await exactGrant(f, f.campusB);
    assert.deepEqual(await status(f, exact.requestId), [
      { appearanceId: image.icon.appearanceId, state: 'eligible' },
    ]);
    await cleanup(f, exact.requestId, image.icon.appearanceId);
  },
);

test(
  'Category live preparation holds a displaced image until its actual closed receipt; replay never opens a new request',
  { timeout: 300000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const image = await createImage(f, png);
    const keep = await edit(f, image.categoryId, { mode: 'keep' });
    const kept = await f.prepare(keep);
    const cleared = await f.execute(
      await edit(f, image.categoryId, { mode: 'clear' }),
    );
    const exact = {
      requestId: cleared.input.payload.clientRequestId,
      appearanceIds: [image.icon.appearanceId],
    };
    assert.deepEqual(await status(f, exact.requestId), [
      { appearanceId: image.icon.appearanceId, state: 'held' },
    ]);
    assert.equal(
      (
        await f.pool.query<{ blocker: string }>(
          'SELECT whaleu_ratings.category_icon_retirement_blocker($1) blocker',
          [image.icon.appearanceId],
        )
      ).rows[0]!.blocker,
      'prepared_command',
    );
    const before = await lifecycleState(f);
    assert.notEqual((await f.post('retirement/cleanup', exact)).status, 200);
    assert.deepEqual(await lifecycleState(f), before);
    const cancelled = await f.post('cancel', keep);
    categoryIconHttpOk(cancelled);
    const closed = ratingCategoryIconReceiptSchema.parse(cancelled.body);
    assert.equal(closed.outcome, 'closed');
    assert.deepEqual(await status(f, exact.requestId), [
      { appearanceId: image.icon.appearanceId, state: 'eligible' },
    ]);
    await cleanup(f, exact.requestId, image.icon.appearanceId);
    const after = await lifecycleState(f);
    assert.deepEqual((await f.commit(keep, kept.contextRevision)).body, closed);
    assert.deepEqual((await f.post('prepare', keep)).body, closed);
    const recovered = await f.auth(
      request(f.http).get(
        `/v5/ratings/requests/${keep.payload.clientRequestId}`,
      ),
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(recovered.body, closed);
    assert.deepEqual(await lifecycleState(f), after);
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2`,
          [f.admin.accountId, keep.payload.clientRequestId],
        )
      ).rowCount,
      1,
    );
  },
);

test(
  'Category actual open delivery stream holds retirement until physical stream closure, without changing the Category epoch',
  { timeout: 300000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const image = await createImage(f, png);
    const delivery = f.app.get(RatingCategoryIconMediaService).delivery;
    assert.ok(delivery);
    const requestId = randomUUID();
    const beforeEpoch = (
      await f.pool.query(
        'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
      )
    ).rows;
    const opened = await delivery.open(
      f.admin.accessToken,
      {
        requestId,
        purpose: 'download',
        categoryId: image.categoryId,
        appearanceId: image.icon.appearanceId,
        contextId: image.icon.contextId,
        contextToken: image.icon.contextToken,
      },
      'display-v1',
    );
    t.after(() => opened.abort());
    assert.equal(opened.headers['Cache-Control'], 'private, no-store');
    assert.equal(opened.stream.destroyed, false);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
        )
      ).rows,
      beforeEpoch,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_delivery_holds WHERE id=$1 AND closed_at IS NULL',
          [requestId],
        )
      ).rowCount,
      1,
      'The real two-proof delivery path enrolled its durable hold',
    );
    const cleared = await f.execute(
      await edit(f, image.categoryId, { mode: 'clear' }),
    );
    assert.deepEqual(await status(f, cleared.input.payload.clientRequestId), [
      { appearanceId: image.icon.appearanceId, state: 'held' },
    ]);
    assert.equal(
      (
        await f.pool.query<{ blocker: string }>(
          'SELECT whaleu_ratings.category_icon_retirement_blocker($1) blocker',
          [image.icon.appearanceId],
        )
      ).rows[0]!.blocker,
      'delivery',
    );
    assert.notEqual(
      (
        await f.post('retirement/cleanup', {
          requestId: cleared.input.payload.clientRequestId,
          appearanceIds: [image.icon.appearanceId],
        })
      ).status,
      200,
    );
    const closureEpoch = (
      await f.pool.query(
        'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
      )
    ).rows;
    opened.abort();
    const deadline = Date.now() + 5000;
    while (
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_delivery_holds WHERE id=$1 AND closed_at IS NULL',
          [requestId],
        )
      ).rowCount
    ) {
      assert.ok(
        Date.now() < deadline,
        'Physical stream closure must persist its exact hold closure',
      );
      await delay(10);
    }
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
        )
      ).rows,
      closureEpoch,
    );
    assert.deepEqual(await status(f, cleared.input.payload.clientRequestId), [
      { appearanceId: image.icon.appearanceId, state: 'eligible' },
    ]);
    await cleanup(
      f,
      cleared.input.payload.clientRequestId,
      image.icon.appearanceId,
    );
  },
);

test(
  'Category raw inserts, updates, deletes and forged retirements cannot rewrite durable original causal ownership',
  { timeout: 300000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const image = await createImage(f, png);
    await f.rejectSql('reachable image cannot gain a terminal record', (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.category_icon_terminal_retirements
        (appearance_id,asset_id,binding_id,actor_id,manifest_digest,closure_revision,causing_actor_id,causing_request_id)
        SELECT id,asset_id,media_binding_id,actor_id,manifest_digest,repeat('a',64),$2,$3
        FROM whaleu_ratings.category_icon_appearances WHERE id=$1`,
        [
          image.icon.appearanceId,
          f.admin.accountId,
          image.upload.input.payload.clientRequestId,
        ],
      ),
    );
    await f.rejectSql(
      'original creation does not authorize a displaced-image obligation',
      (tx) =>
        tx.query(
          `INSERT INTO whaleu_ratings.category_icon_retirement_queue
        (appearance_id,causing_actor_id,causing_request_id,plan_digest,scope_keys,global_required)
        SELECT $1,actor_id,request_id,plan_digest,affected_scope_keys,(media_plan->'plan'->>'globalRequired')::boolean
        FROM whaleu_ratings.category_icon_preparations WHERE actor_id=$2 AND request_id=$3`,
          [
            image.icon.appearanceId,
            f.admin.accountId,
            image.upload.input.payload.clientRequestId,
          ],
        ),
    );
    const cleared = await f.execute(
      await edit(f, image.categoryId, { mode: 'clear' }),
    );
    const before = await lifecycleState(f);
    for (const sql of [
      "UPDATE whaleu_ratings.category_icon_retirement_queue SET scope_keys=ARRAY['global'] WHERE appearance_id=$1",
      'DELETE FROM whaleu_ratings.category_icon_retirement_queue WHERE appearance_id=$1',
      "UPDATE whaleu_ratings.category_icon_appearances SET manifest_digest=repeat('b',64) WHERE id=$1",
      'DELETE FROM whaleu_ratings.category_icon_appearances WHERE id=$1',
    ])
      await f.rejectSql(sql, (tx) => tx.query(sql, [image.icon.appearanceId]));
    for (const sql of [
      "UPDATE whaleu_ratings.category_icon_definition_heads SET retention='dormant' WHERE root_key IN (SELECT root_key FROM whaleu_ratings.category_icon_definition_heads LIMIT 1)",
      'DELETE FROM whaleu_ratings.category_icon_definition_heads',
      "UPDATE whaleu_ratings.scoped_command_causes SET proof='{}'::jsonb WHERE account_id=$1 AND request_id=$2",
      'DELETE FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2',
    ])
      await f.rejectSql(sql, (tx) =>
        sql.includes('$1')
          ? tx.query(sql, [
              f.admin.accountId,
              cleared.input.payload.clientRequestId,
            ])
          : tx.query(sql),
      );
    await f.rejectSql('original exact source heads are retained', (tx) =>
      tx.query(
        'DELETE FROM whaleu_ratings.scoped_source_heads WHERE source_id IN (SELECT base_source_id FROM whaleu_ratings.category_icon_definitions WHERE category_id=$1)',
        [image.categoryId],
      ),
    );
    assert.deepEqual(await lifecycleState(f), before);
    await cleanup(
      f,
      cleared.input.payload.clientRequestId,
      image.icon.appearanceId,
    );
    const retired = await lifecycleState(f);
    await f.rejectSql('terminal retirement is immutable', (tx) =>
      tx.query(
        'DELETE FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1',
        [image.icon.appearanceId],
      ),
    );
    assert.deepEqual(await lifecycleState(f), retired);
  },
);

for (const disturbance of ['source', 'review', 'savepoint'] as const) {
  test(
    `Category last-generation seal rejects late ${disturbance} changes after early full constraint validation`,
    { timeout: 240000 },
    async (t) => {
      const f = await categoryIconManagementFixture([], { runtime: false });
      t.after(() => f.close());
      const input = await createIntent(f);
      const prepared = await f.prepare(input);
      await f.approveText(input);
      const icons = await f.approveIcons(input);
      assert.equal(icons.length, 1);
      const before = await lifecycleState(f);
      let earlyPassed = false,
        namedBoundaryReached = false;
      await assert.rejects(
        commandThenSql(f, input, prepared.contextRevision, async (tx) => {
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          earlyPassed = true;
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          if (disturbance === 'savepoint') {
            const beforeSavepoint = (
              await tx.query(
                'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
              )
            ).rows;
            await tx.query('SAVEPOINT late_generation');
            await advanceZeroRows(tx);
            await holdReview(tx, icons[0]!.decisionId);
            await tx.query('ROLLBACK TO SAVEPOINT late_generation');
            assert.deepEqual(
              (
                await tx.query(
                  'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton',
                )
              ).rows,
              beforeSavepoint,
            );
            await tx.query(
              'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation IMMEDIATE',
            );
            await tx.query(
              'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation DEFERRED',
            );
          }
          if (disturbance === 'review')
            await holdReview(tx, icons[0]!.decisionId);
          else await replaceExternalPolicySource(tx);
          if (disturbance !== 'source') await advanceZeroRows(tx);
          namedBoundaryReached = true;
          await tx.query(
            'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation IMMEDIATE',
          );
          assert.fail(
            'The exact named last-generation seal accepted a disturbed real command graph',
          );
        }),
        (error: unknown) =>
          earlyPassed && namedBoundaryReached && constraintViolation(error),
      );
      assert.ok(
        earlyPassed,
        'The complete real command graph must pass early SQL validation',
      );
      assert.ok(
        namedBoundaryReached,
        'An earlier row guard or application proof cannot supply the expected rejection',
      );
      assert.deepEqual(
        await lifecycleState(f),
        before,
        'The original request and whole owner graph roll back atomically',
      );
      const lawful = await f.commit(input, prepared.contextRevision);
      categoryIconHttpOk(lawful);
      assert.equal(
        ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
        'applied',
      );
    },
  );
}

test(
  'Category final generation independently rejects a late Media safety writer after valid Review8 and early SQL seals',
  { timeout: 300000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const upload = await f.ready(
      await createIntent(f),
      { kind: 'new', key: 'root' },
      png,
    );
    const prepared = await f.prepare(upload.input);
    await f.approveText(upload.input);
    await f.approveIcons(upload.input);
    const before = await lifecycleState(f);
    let earlyPassed = false,
      namedBoundaryReached = false;
    await assert.rejects(
      commandThenSql(f, upload.input, prepared.contextRevision, async (tx) => {
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        earlyPassed = true;
        await tx.query('SET CONSTRAINTS ALL DEFERRED');
        const event = randomUUID();
        const epoch = (
          await tx.query<{ epoch: string }>(
            'SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
          )
        ).rows[0]!.epoch;
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events
        (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        SELECT $1::uuid,a.id,h.revision+1,'held',a.manifest_digest,a.policy_revision,
          'synthetic-category-retirement',$1::uuid::text,'{"testOnly":true}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes'
        FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
          [event, upload.status.assetId],
        );
        const changed = await tx.query(
          `UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1`,
          [upload.status.assetId, event],
        );
        assert.equal(changed.rowCount, 1);
        assert.ok(
          BigInt(
            (
              await tx.query<{ epoch: string }>(
                'SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
              )
            ).rows[0]!.epoch,
          ) > BigInt(epoch),
          'A raw Media safety writer must re-enqueue the Category full-graph boundary without another Category statement',
        );
        namedBoundaryReached = true;
        await tx.query(
          'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation IMMEDIATE',
        );
        assert.fail(
          'Current Review8 cannot substitute for current exact Media8 safety',
        );
      }),
      (error: unknown) =>
        earlyPassed && namedBoundaryReached && constraintViolation(error),
    );
    assert.ok(earlyPassed && namedBoundaryReached);
    assert.deepEqual(await lifecycleState(f), before);
    const lawful = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(lawful);
    assert.equal(
      ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
      'applied',
    );
  },
);

test(
  'Category retirement admits only untouched exact housekeeping and rechecks every worker or cleanup hold at terminal commit',
  { timeout: 360000 },
  async (t) => {
    const { f, png } = await imageFixture();
    t.after(() => f.close());
    const image = await createImage(f, png);
    const cleared = await f.execute(
      await edit(f, image.categoryId, { mode: 'clear' }),
    );
    const requestId = cleared.input.payload.clientRequestId;
    const scratch = (
      await f.pool.query<{
        id: string;
        state: string;
        attempt: number;
        writer_state: string;
      }>(
        `SELECT c.id,c.state,c.attempt,w.state writer_state FROM whaleu_media.cleanup_obligations c
        JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
        JOIN whaleu_media.upload_ingress g ON g.object_attempt_id=w.object_attempt_id
        JOIN whaleu_media.assets a ON a.intent_id=g.intent_id
        WHERE a.id=$1 AND c.reason='ingress-scratch'`,
        [image.upload.status.assetId],
      )
    ).rows;
    assert.equal(
      scratch.length,
      1,
      'The real multipart upload must retain its actual scratch obligation',
    );
    assert.deepEqual(
      {
        state: scratch[0]!.state,
        attempt: scratch[0]!.attempt,
        writer: scratch[0]!.writer_state,
      },
      { state: 'pending', attempt: 0, writer: 'retired' },
    );
    assert.deepEqual(await status(f, requestId), [
      { appearanceId: image.icon.appearanceId, state: 'eligible' },
    ]);
    const before = await lifecycleState(f);
    const blockers = async (tx: PoolClient) =>
      (
        await tx.query<{ initial: string | null; final: string | null }>(
          `SELECT whaleu_ratings.category_icon_retirement_blocker($1,false) initial,
        whaleu_ratings.category_icon_retirement_blocker($1,true) final`,
          [image.icon.appearanceId],
        )
      ).rows[0]!;
    const retained = { initial: 'retention', final: 'retention' };

    await t.test(
      'retryable, retained, prior attempts and live or expired delete leases remain held in both phases',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          assert.deepEqual(await blockers(tx), { initial: null, final: null });
          for (const item of [
            { state: 'retryable', attempt: 1, lease: null },
            { state: 'retained', attempt: 0, lease: null },
            { state: 'pending', attempt: 1, lease: null },
            {
              state: 'deleting',
              attempt: 1,
              lease: new Date(Date.now() + 60000),
            },
            {
              state: 'deleting',
              attempt: 1,
              lease: new Date(Date.now() - 60000),
            },
          ]) {
            await tx.query('SAVEPOINT scratch_state');
            const changed = await tx.query(
              `UPDATE whaleu_media.cleanup_obligations
            SET state=$2,attempt=$3,lease_token=$4,lease_until=$5 WHERE id=$1`,
              [
                scratch[0]!.id,
                item.state,
                item.attempt,
                item.lease ? randomUUID() : null,
                item.lease,
              ],
            );
            assert.equal(changed.rowCount, 1);
            assert.deepEqual(
              await blockers(tx),
              retained,
              `${item.state}/${item.attempt}/${item.lease?.toISOString() ?? 'no lease'}`,
            );
            if (item.state === 'deleting') {
              await tx.query(
                `UPDATE whaleu_media.cleanup_obligations
              SET state='pending',lease_token=NULL,lease_until=NULL WHERE id=$1`,
                [scratch[0]!.id],
              );
              assert.deepEqual(
                await blockers(tx),
                retained,
                'Removing or expiring the lease cannot erase a prior physical attempt',
              );
            }
            await tx.query('ROLLBACK TO SAVEPOINT scratch_state');
            assert.deepEqual(await blockers(tx), {
              initial: null,
              final: null,
            });
          }
        });
        assert.deepEqual(await lifecycleState(f), before);
      },
    );

    await t.test(
      'exact terminal staging is allowed only in final phase; matching bytes alone never authorize an unrelated obligation',
      async () => {
        // These are the original stageKnownCleanup metadata shapes over actual
        // immutable upload objects. No storage effect, receipt or binding is seeded.
        const sources = [
          `SELECT a.id object_attempt_id,NULL::uuid derived_attempt_id,NULL::uuid asset_id,NULL::text variant_name,
          'cleanup:'||a.id::text||':staging' effect_key,a.provider,a.environment,
          a.staging_bucket bucket,a.staging_key object_key,a.source_version object_version,'intent-cancelled' reason
          FROM whaleu_media.object_attempts a JOIN whaleu_media.assets asset ON asset.intent_id=a.intent_id WHERE asset.id=$1`,
          `SELECT NULL::uuid object_attempt_id,d.id derived_attempt_id,NULL::uuid asset_id,NULL::text variant_name,
          'cleanup:derived:'||d.id::text effect_key,d.provider,d.environment,d.bucket,d.object_key,d.object_version,'intent-terminal' reason
          FROM whaleu_media.derived_object_attempts d JOIN whaleu_media.assets a ON a.intent_id=d.intent_id
          WHERE a.id=$1 AND d.variant_name='display-v1'`,
          `SELECT NULL::uuid object_attempt_id,NULL::uuid derived_attempt_id,v.asset_id,v.variant_name,
          'cleanup:'||v.asset_id::text||':'||v.variant_name effect_key,v.provider,v.environment,v.bucket,v.object_key,v.object_version,'intent-cancelled' reason
          FROM whaleu_media.variants v WHERE v.asset_id=$1 AND v.variant_name='display-v1'`,
        ];
        await withCommunityScopeWriter(f.pool, async (tx) => {
          for (const source of sources) {
            for (const shape of [
              'exact',
              'wrong-effect',
              'wrong-reason',
            ] as const) {
              await tx.query('SAVEPOINT staged_obligation');
              const inserted = await tx.query(
                `WITH exact_object AS (${source})
              INSERT INTO whaleu_media.cleanup_obligations
                (id,effect_key,object_attempt_id,derived_attempt_id,asset_id,variant_name,provider,environment,
                  bucket,object_key,object_version,reason,not_before)
              SELECT gen_random_uuid(),CASE WHEN $2::text='wrong-effect' THEN 'unrecognized:'||effect_key ELSE effect_key END,
                object_attempt_id,derived_attempt_id,asset_id,variant_name,provider,environment,bucket,object_key,object_version,
                CASE WHEN $2::text='wrong-reason' THEN 'unrecognized-retention' ELSE reason END,clock_timestamp()+interval '2 minutes'
              FROM exact_object`,
                [image.upload.status.assetId, shape],
              );
              assert.equal(inserted.rowCount, 1);
              assert.deepEqual(
                await blockers(tx),
                shape === 'exact'
                  ? { initial: 'retention', final: null }
                  : retained,
                `Only exact original ${shape} obligations may pass final phase, never initial admission`,
              );
              await tx.query('ROLLBACK TO SAVEPOINT staged_obligation');
            }
          }
        });
        assert.deepEqual(await lifecycleState(f), before);
      },
    );

    await t.test(
      'cold cancellation is quiet but an attempted then cancelled worker remains unresolved',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          for (const attempted of [false, true]) {
            await tx.query('SAVEPOINT worker_history');
            const jobId = randomUUID();
            const inserted = await tx.query(
              `INSERT INTO whaleu_media.jobs
            (id,kind,effect_key,intent_id,asset_id,expected_generation)
            SELECT $1::uuid,'reconcile','synthetic-retirement-worker:'||$1::uuid::text,i.id,a.id,i.generation
              FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$2`,
              [jobId, image.upload.status.assetId],
            );
            assert.equal(inserted.rowCount, 1);
            assert.deepEqual(await blockers(tx), {
              initial: 'worker',
              final: 'worker',
            });
            if (attempted) {
              await tx.query(
                `UPDATE whaleu_media.jobs SET status='leased',attempt=1,
              lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
                [jobId, randomUUID()],
              );
              assert.deepEqual(
                await blockers(tx),
                { initial: 'worker', final: 'worker' },
                'An expired worker lease is still a hold',
              );
            }
            await tx.query(
              `UPDATE whaleu_media.jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1`,
              [jobId],
            );
            assert.deepEqual(
              await blockers(tx),
              attempted
                ? { initial: 'worker', final: 'worker' }
                : { initial: null, final: null },
            );
            await tx.query('ROLLBACK TO SAVEPOINT worker_history');
          }
        });
        assert.deepEqual(await lifecycleState(f), before);
      },
    );

    await t.test(
      'the real terminal final guard rejects a newly leased exact staged derivative',
      async () => {
        const database = f.app.get(DatabaseService),
          original = database.transaction;
        let staged = false,
          namedBoundaryReached = false;
        try {
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              database.transaction = async <T>(
                work: (client: PoolClient) => Promise<T>,
              ): Promise<T> => work(tx);
              const result = await f.app
                .get(RatingCategoryIconMediaService)
                .retire(f.admin.accessToken, {
                  requestId,
                  appearanceIds: [image.icon.appearanceId],
                });
              assert.deepEqual(result, {
                state: 'cleanup_pending',
                appearanceIds: [image.icon.appearanceId],
              });
              staged = true;
              assert.equal((await blockers(tx)).final, null);
              const changed = await tx.query(
                `UPDATE whaleu_media.cleanup_obligations SET state='deleting',attempt=attempt+1,
            lease_token=$2,lease_until=clock_timestamp()-interval '1 second'
            WHERE id=(SELECT c.id FROM whaleu_media.cleanup_obligations c
              JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
              JOIN whaleu_media.assets a ON a.intent_id=d.intent_id WHERE a.id=$1 ORDER BY c.id LIMIT 1)`,
                [image.upload.status.assetId, randomUUID()],
              );
              assert.equal(
                changed.rowCount,
                1,
                'The mutation must target a derivative staged by the real Media lifecycle',
              );
              assert.equal((await blockers(tx)).final, 'retention');
              namedBoundaryReached = true;
              await tx.query(
                'SET CONSTRAINTS whaleu_ratings.category_icon_terminal_final IMMEDIATE',
              );
              assert.fail(
                'A terminal publication must not commit across an unresolved physical cleanup attempt',
              );
            }),
            (error: unknown) =>
              staged && namedBoundaryReached && constraintViolation(error),
          );
        } finally {
          database.transaction = original;
        }
        assert.ok(staged && namedBoundaryReached);
        assert.deepEqual(
          await lifecycleState(f),
          before,
          'Failed terminal publication rolls back detach and every staged obligation',
        );
        assert.deepEqual(await status(f, requestId), [
          { appearanceId: image.icon.appearanceId, state: 'eligible' },
        ]);
      },
    );
    await cleanup(f, requestId, image.icon.appearanceId);
  },
);
