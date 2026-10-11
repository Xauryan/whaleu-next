/** Real C1 owner/Review8/Media8 boundaries. Run only under the parent's
 * exclusive disposable PostgreSQL lease. The only delivery hook is a held
 * synthetic provider callback; no SQL response, proof or receipt is replaced. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalRatingCategoryIconEnvelope,
  ratingCategoryIconApprovalDigest,
} from '../../src/community/content-review/rating-category-icon-contracts.js';
import { DatabaseService } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import type { CategoryIconMediaDescriptor } from '../../src/media/contracts-category-icon.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import { RatingCategoryIconManagementService } from '../../src/ratings/category-management/icon-service.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function imageFixture() {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 61, height: 47, channels: 3, background: '#376a91' },
  })
    .png()
    .toBuffer();
  const f = await categoryIconManagementFixture([
    { sha256: sha256(bytes), verdict: 'allow' },
  ]);
  return { f, bytes };
}
async function createIntent(f: CategoryIconManagementFixture) {
  return f.intent(await f.context(), 'create_categories_scoped', {
    parentId: null,
    placement: { kind: 'global' },
    nodes: [
      {
        key: 'root',
        parentKey: null,
        name: 'Deferred Category image',
        description: 'Exact final authority',
        icon: { mode: 'clear' },
      },
    ],
  });
}
async function publicIcon(
  f: CategoryIconManagementFixture,
  categoryId: string,
) {
  const icon = (await f.publicPage()).page.items.find(
    (item) => item.id === categoryId,
  )?.icon;
  assert.ok(
    icon,
    'The real public Category projection must supply its exact descriptor',
  );
  return icon;
}
function download(
  f: CategoryIconManagementFixture,
  icon: CategoryIconMediaDescriptor,
  actor = f.admin,
) {
  return f
    .auth(
      request(f.http).get(
        `/v3/media/ratings-category-icon/categories/${icon.categoryId}/appearances/${icon.appearanceId}/display-v1`,
      ),
      actor,
    )
    .query({ contextId: icon.contextId, contextToken: icon.contextToken });
}
async function publication(f: CategoryIconManagementFixture) {
  return {
    artifacts: await f.artifacts(),
    original: (
      await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'causes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM whaleu_ratings.scoped_command_causes r),
      'outcomes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM whaleu_ratings.scoped_command_outcomes r),
      'sources',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM whaleu_ratings.scoped_source_attestations r),
      'sourceHeads',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM whaleu_ratings.scoped_source_heads r),
      'releases',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM whaleu_ratings.scoped_releases r),
      'review',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_review_bindings r),
      'cleanup',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM whaleu_media.cleanup_obligations r)) value`)
    ).rows[0]!.value,
  };
}

/** Issue an actual immutable Review8 decision for the exact persisted envelope.
 * Its short original consumption deadline is never edited or extended. */
async function approveExpiringIcon(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
) {
  const stored = await f.stored(input);
  assert.equal(stored.media_plan.reviewEnvelopes.length, 1);
  const envelope = canonicalRatingCategoryIconEnvelope(
    stored.media_plan.reviewEnvelopes[0],
  );
  return withCommunityScopeWriter(f.pool, async (tx) => {
    const policy = randomUUID(),
      decisionId = randomUUID(),
      eventId = randomUUID();
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    const evaluatedAt = new Date(now.getTime() - 1000);
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_policies
      (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from)
      VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-category-deferred-review','synthetic-exact-review8-policy',$2)`,
      [policy, new Date(evaluatedAt.getTime() - 1000)],
    );
    const deadline = (
      await tx.query<{ consume_until: Date }>(
        `INSERT INTO whaleu_community.rating_approval_decisions
      (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,
       evaluated_at,consume_until,visibility_model)
      VALUES($1,$2,'publish_rating_category_icon',8,$3,$4::jsonb,$5,'allow','complete','accepted',
       'synthetic-category-deferred-review','synthetic-exact-prepared-envelope',$6,clock_timestamp()+interval '3 seconds','durable')
      RETURNING consume_until`,
        [
          decisionId,
          envelope.accountId,
          ratingCategoryIconApprovalDigest(envelope),
          canonicalJson(envelope),
          policy,
          evaluatedAt,
        ],
      )
    ).rows[0]!.consume_until;
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_events
      (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
      VALUES($1,$2,'allow','complete','accepted','synthetic-category-deferred-review','synthetic-exact-review8-event',$3)`,
      [eventId, decisionId, evaluatedAt],
    );
    await tx.query(
      'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [decisionId, eventId],
    );
    return { decisionId, deadline };
  });
}

/** Join the unmodified command owner to the actual guarded transaction. Only
 * its transaction boundary is composed; all reads, mutations and proofs run. */
async function commandThenSql(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  revision: string,
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
          preparationContextRevision: revision,
        });
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      await after(tx);
    });
  } finally {
    database.transaction = original;
  }
}

test(
  'C1 real Review8 consumption expires inside a PostgreSQL deferred wait and rolls back the whole prepared image publication',
  { timeout: 120000 },
  async (t) => {
    const { f, bytes } = await imageFixture();
    t.after(() => f.close());
    const upload = await f.ready(
      await createIntent(f),
      { kind: 'new', key: 'root' },
      bytes,
    );
    const prepared = await f.prepare(upload.input);
    await f.approveText(upload.input);
    const blocker = await f.pool.connect();
    const gate = [1464356191, 81];
    let pending: Promise<void> | undefined,
      commandPid = 0,
      reached = false;
    let before: Awaited<ReturnType<typeof publication>> | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock($1,$2)', gate);
      const blockerPid = (
        await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      const approved = await approveExpiringIcon(f, upload.input);
      before = await publication(f);
      pending = commandThenSql(
        f,
        upload.input,
        prepared.contextRevision,
        async (tx) => {
          const current = (
            await tx.query<{ pid: number; current: boolean; bound: boolean }>(
              `SELECT pg_backend_pid() pid,
          clock_timestamp()<$1::timestamptz current,
          EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_review_bindings WHERE decision_id=$2) bound`,
              [approved.deadline, approved.decisionId],
            )
          ).rows[0]!;
          assert.equal(
            current.current,
            true,
            'The real command must reach the deferred gate before its original 3-second Review deadline',
          );
          assert.equal(
            current.bound,
            true,
            'The original owner must have consumed and bound this exact Review8 decision',
          );
          commandPid = current.pid;
          // This temporary constraint really runs in PostgreSQL during the normal
          // finalizer's SET CONSTRAINTS. It does not fabricate owner facts or sleep
          // in application code after a supposedly completed final proof.
          await tx.query(`CREATE TEMP TABLE category_icon_deferred_wait(id integer) ON COMMIT DROP;
          CREATE OR REPLACE FUNCTION pg_temp.category_icon_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(1464356191,81); RETURN NEW; END $$;
          CREATE CONSTRAINT TRIGGER category_icon_deferred_wait AFTER INSERT ON category_icon_deferred_wait
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.category_icon_deferred_wait();
          INSERT INTO category_icon_deferred_wait VALUES(1)`);
        },
      );
      void pending.catch(() => undefined);
      for (let attempt = 0; attempt < 300; attempt++) {
        if (commandPid) {
          const state = (
            await f.pool.query<{
              waiting: boolean;
              blockers: number[];
              current: boolean;
            }>(
              `SELECT
            wait_event='advisory' AND query='SET CONSTRAINTS ALL IMMEDIATE' waiting,
            pg_blocking_pids(pid) blockers,clock_timestamp()<$2::timestamptz current
            FROM pg_stat_activity WHERE pid=$1`,
              [commandPid, approved.deadline],
            )
          ).rows[0];
          if (state?.waiting && state.blockers.includes(blockerPid)) {
            assert.equal(
              state.current,
              true,
              'The exact original deadline must still be current when PostgreSQL actually enters its deferred wait',
            );
            reached = true;
            break;
          }
        }
        await delay(10);
      }
      assert.equal(
        reached,
        true,
        'The real finalizer must be observed blocked by the exact PostgreSQL advisory-lock owner',
      );
      await f.pool.query(
        'SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.01)',
        [approved.deadline],
      );
      assert.equal(
        (
          await f.pool.query<{ expired: boolean }>(
            'SELECT consume_until<=clock_timestamp() expired FROM whaleu_community.rating_approval_decisions WHERE id=$1',
            [approved.decisionId],
          )
        ).rows[0]!.expired,
        true,
      );
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1,$2)', gate);
      blocker.release();
      // Always drain the command before restoring fixture resources, including
      // an assertion failure before the barrier. Rejections stay observable below.
      await pending?.catch(() => undefined);
    }
    assert.ok(before);
    await assert.rejects(
      pending,
      (error: unknown) =>
        reached &&
        error instanceof ApplicationError &&
        error.code === 'CONTENT_REVIEW_UNAVAILABLE',
    );
    assert.deepEqual(
      await publication(f),
      before,
      'Deadline failure must atomically remove the receipt, source publication, Review binding, Media binding, appearance, release and owner epochs',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
          [upload.status.assetId],
        )
      ).rowCount,
      0,
    );
    // A fresh lawful decision, without a deadline change, proves the failure was
    // the waited-out approval rather than a permanently invalid fixture graph.
    await f.approveIcons(upload.input);
    const lawful = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(lawful);
    assert.equal(
      ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
      'applied',
    );
  },
);

async function reviewState(
  f: CategoryIconManagementFixture,
  decisionId: string,
  state: 'held' | 'allow',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_events
      (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
      VALUES($1,$2,$3,'complete','accepted','synthetic-category-delivery-review','synthetic-exact-staged-review',clock_timestamp())`,
      [eventId, decisionId, state],
    );
    const changed = await tx.query(
      'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
      [decisionId, eventId],
    );
    assert.equal(changed.rowCount, 1);
  });
}

/** Stop only the real synthetic provider's callback, with its actual file stream
 * paused. The first real authorization has committed; the second has not run. */
async function changeDuringStaging(
  f: CategoryIconManagementFixture,
  icon: CategoryIconMediaDescriptor,
  actor: CategoryIconManagementFixture['admin'],
  change: () => Promise<void>,
) {
  const storage = f.storage;
  assert.ok(storage);
  const original = storage.openExact,
    entered = latch(),
    release = latch(),
    quiet = latch();
  let source: Readable | undefined,
    emitted = 0,
    calls = 0,
    settled = false;
  storage.openExact = async (object, maximumBytes) => {
    calls++;
    const opened = await original.call(storage, object, maximumBytes);
    source = opened.stream;
    source.on('data', (chunk: Buffer) => {
      emitted += chunk.byteLength;
    });
    source.pause();
    source.once('close', quiet.resolve);
    entered.resolve();
    await release.promise;
    return opened;
  };
  const pending = download(f, icon, actor).then((response) => {
    settled = true;
    return response;
  });
  void pending.catch(() => undefined);
  try {
    await Promise.race([
      entered.promise,
      pending.then((response) => {
        assert.fail(
          `The first real authorization failed before provider staging: ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
    assert.ok(source);
    assert.equal(source.readableFlowing, false);
    assert.equal(emitted, 0);
    assert.equal(settled, false);
    const hold = (
      await f.pool.query<{ id: string; closed_at: Date | null }>(
        `SELECT id,closed_at
      FROM whaleu_ratings.category_icon_delivery_holds WHERE appearance_id=$1 AND actor_id=$2 AND context_id=$3 AND closed_at IS NULL`,
        [icon.appearanceId, actor.accountId, icon.contextId],
      )
    ).rows;
    assert.equal(
      hold.length,
      1,
      'The first real Media8 authorization must commit its exact open physical-delivery hold',
    );
    await change();
    assert.equal(
      settled,
      false,
      'The legal owner change commits while the actual storage callback is still held',
    );
    assert.equal(emitted, 0);
    release.resolve();
    const response = await pending;
    assert.ok(response.status >= 400, JSON.stringify(response.body));
    assert.equal(typeof response.body.error?.code, 'string');
    assert.notEqual(
      response.headers['content-type']?.startsWith('image/'),
      true,
      'No image headers or body may leave the controller after the staged authority changes',
    );
    await quiet.promise;
    assert.equal(
      calls,
      1,
      'Only one exact provider object may have been staged',
    );
    assert.equal(
      emitted,
      0,
      'The real provider stream must be destroyed without emitting a single image byte',
    );
    assert.equal(source.destroyed, true);
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      closed = (
        await f.pool.query<{ closed: boolean }>(
          'SELECT closed_at IS NOT NULL closed FROM whaleu_ratings.category_icon_delivery_holds WHERE id=$1',
          [hold[0]!.id],
        )
      ).rows[0]!.closed;
      if (closed) break;
      await delay(10);
    }
    assert.equal(
      closed,
      true,
      'Only the actual provider-stream close may settle the retained delivery hold',
    );
    return response;
  } finally {
    release.resolve();
    storage.openExact = original;
    await pending.catch(() => undefined);
    source?.destroy();
  }
}

test(
  'C1 Media8 denies staged image bytes after committed Review, access and archive changes; restore retains the original appearance',
  { timeout: 120000 },
  async (t) => {
    const { f, bytes } = await imageFixture();
    t.after(() => f.close());
    const upload = await f.ready(
      await createIntent(f),
      { kind: 'new', key: 'root' },
      bytes,
    );
    const created = await f.execute(upload.input),
      categoryId = created.receipt.result.categoryIds[0]!;
    const original = await publicIcon(f, categoryId);
    categoryIconHttpOk(await download(f, original));

    await t.test(
      'Review held commits during actual provider staging and the final exact Review8 check denies all bytes',
      async () => {
        assert.equal(created.icons.length, 1);
        const decisionId = created.icons[0]!.decisionId;
        const icon = await publicIcon(f, categoryId);
        const response = await changeDuringStaging(
          f,
          icon,
          f.admin,
          async () => {
            await reviewState(f, decisionId, 'held');
            assert.equal(
              (
                await f.pool.query<{ state: string }>(
                  `SELECT e.state FROM whaleu_community.rating_approval_heads h
          JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id WHERE h.decision_id=$1`,
                  [decisionId],
                )
              ).rows[0]!.state,
              'held',
            );
          },
        );
        assert.equal(response.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
        const denied = await download(f, icon);
        assert.ok(
          denied.status >= 400,
          'A later request must still fail while the exact Review remains held',
        );
        await reviewState(f, decisionId, 'allow');
        categoryIconHttpOk(await download(f, await publicIcon(f, categoryId)));
      },
    );

    await t.test(
      'the current viewer session is revoked during staging without changing the uploader or image',
      async () => {
        const viewer = await f.actor();
        const icon = (
          await f.publicPage({ kind: 'global' }, viewer)
        ).page.items.find((item) => item.id === categoryId)?.icon;
        assert.ok(icon);
        assert.notEqual(viewer.accountId, f.admin.accountId);
        const response = await changeDuringStaging(
          f,
          icon,
          viewer,
          async () => {
            await withCommunityScopeWriter(f.pool, async (tx) => {
              const changed = await tx.query(
                `UPDATE whaleu_identity.sessions
            SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE account_id=$1 AND revoked_at IS NULL`,
                [viewer.accountId],
              );
              assert.equal(
                changed.rowCount,
                1,
                'Revoke the actual separate viewer session',
              );
            });
          },
        );
        assert.equal(response.body.error.code, 'SESSION_REVOKED');
        assert.ok((await download(f, icon, viewer)).status >= 400);
        categoryIconHttpOk(await download(f, await publicIcon(f, categoryId)));
      },
    );

    await t.test(
      'archive commits while bytes are staged; stale release cannot deliver and lawful restore reuses the exact binding',
      async () => {
        const icon = await publicIcon(f, categoryId);
        await changeDuringStaging(f, icon, f.admin, async () => {
          await f.execute(
            f.intent(await f.context(), 'set_category_lifecycle_scoped', {
              categoryId,
              state: 'archived',
              restore: false,
            }),
          );
          assert.equal((await f.detail(categoryId)).businessState, 'archived');
        });
        assert.ok((await download(f, icon)).status >= 400);
        assert.equal(
          (await f.publicPage()).page.items.some(
            (item) => item.id === categoryId,
          ),
          false,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1',
              [icon.appearanceId],
            )
          ).rowCount,
          0,
          'A recoverable archived appearance cannot be terminally retired by a failed delivery',
        );
        const binding = (
          await f.pool.query<{ detached_at: Date | null }>(
            'SELECT detached_at FROM whaleu_media.bindings WHERE id=$1',
            [icon.bindingId],
          )
        ).rows[0];
        assert.ok(binding);
        assert.equal(binding.detached_at, null);
        await f.execute(
          f.intent(await f.context(), 'set_category_lifecycle_scoped', {
            categoryId,
            state: 'disabled',
            restore: true,
          }),
        );
        await f.execute(
          f.intent(await f.context(), 'set_category_lifecycle_scoped', {
            categoryId,
            state: 'enabled',
            restore: false,
          }),
        );
        const restored = await publicIcon(f, categoryId);
        assert.equal(restored.appearanceId, original.appearanceId);
        assert.equal(restored.bindingId, original.bindingId);
        categoryIconHttpOk(await download(f, restored));
      },
    );
  },
);
