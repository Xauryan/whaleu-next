/** Source-only acceptance additions. Run only under the parent's exclusive PG
 * lease on the existing isolated loopback whaleu_test fixture. No provider use. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { checkTransactionDeadlines } from '../../src/database/transaction-deadlines.js';
import { CategoryIconMediaRequiredProof } from '../../src/media/category-icon-required-proof.js';
import { MediaRequiredProof } from '../../src/media/required-proof.js';
import { CategoryIconMediaRecoveryRepository } from '../../src/media/category-icon-recovery-repository.js';
import { MediaRecoveryRepository } from '../../src/media/recovery-repository.js';
import { MediaLifecycleRepository } from '../../src/media/lifecycle-repository.js';
import {
  categoryIconMediaRequestHash,
  prepareCategoryIconMediaSchema,
} from '../../src/media/contracts-category-icon.js';
import { ApplicationError } from '../../src/http/application-error.js';
const conflict = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'MEDIA_REQUEST_CONFLICT';

test(
  'Media8 codec, raw namespace constraints and both recovery directions use the actual additive schema',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      key = randomUUID(),
      hash = 'a'.repeat(64);
    const input = prepareCategoryIconMediaSchema.parse({
      protocol: 'ratings-category-icon-media-v1',
      clientRequestId: key,
      editScopeId: randomUUID(),
      scopeRevision: 'b'.repeat(64),
      slot: 'icon',
      declaration: { mime: 'image/png', bytes: 12, sha256: 'c'.repeat(64) },
    });
    const codec = (
      await f.pool.query<{ shape: boolean; hash: string }>(
        'SELECT whaleu_media.category_icon_prepare_shape($1::jsonb) shape,whaleu_media.category_icon_request_hash($2::uuid,$1::jsonb) hash',
        [JSON.stringify(input), actor.accountId],
      )
    ).rows[0]!;
    assert.equal(codec.shape, true);
    assert.equal(
      codec.hash,
      categoryIconMediaRequestHash(actor.accountId, input),
    );
    for (const patch of [
      { protocol: 'ratings-target-media-v1' },
      { slot: 'cover' },
      { approved: true },
      { targetId: randomUUID() },
      { declaration: { ...input.declaration, bytes: 0 } },
      { declaration: { ...input.declaration, sha256: 'a' } },
    ]) {
      assert.equal(
        (
          await f.pool.query<{ valid: boolean }>(
            'SELECT whaleu_media.category_icon_prepare_shape($1::jsonb) valid',
            [JSON.stringify({ ...input, ...patch })],
          )
        ).rows[0]!.valid,
        false,
      );
    }
    const lifecycle = new MediaLifecycleRepository(),
      assets = {
        async readyOwned() {
          return null;
        },
      },
      category = new CategoryIconMediaRecoveryRepository(lifecycle, assets),
      legacy = new MediaRecoveryRepository(lifecycle, assets);
    const cancelled = await withCommunityScopeWriter(f.pool, (tx) =>
      category.cancelRequest(
        actor.accountId,
        key,
        { protocol: 'ratings-category-icon-media-v1', requestHash: hash },
        tx,
      ),
    );
    assert.equal(cancelled.state, 'cancelled_before_prepare');
    assert.equal(
      (
        await f.pool.query<{ protocol_namespace: number }>(
          'SELECT protocol_namespace FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor.accountId, key],
        )
      ).rows[0]!.protocol_namespace,
      8,
    );
    await assert.rejects(
      inTransaction(f.pool, (tx) => legacy.recover(actor.accountId, key, tx)),
      conflict,
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        legacy.cancelRequest(actor.accountId, key, { requestHash: hash }, tx),
      ),
      conflict,
    );
    const oldKey = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      legacy.cancelRequest(actor.accountId, oldKey, { requestHash: hash }, tx),
    );
    await assert.rejects(
      inTransaction(f.pool, (tx) =>
        category.recover(actor.accountId, oldKey, tx),
      ),
      conflict,
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        category.cancelRequest(
          actor.accountId,
          oldKey,
          { protocol: 'ratings-category-icon-media-v1', requestHash: hash },
          tx,
        ),
      ),
      conflict,
    );
    for (const namespace of [null, 8]) {
      const rawKey = randomUUID();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,state,terminal_reason,protocol_namespace) VALUES($1,$2,$3,'cancelled_before_prepare','cancelled',$4)`,
            [actor.accountId, rawKey, hash, namespace],
          );
          if (namespace === null)
            await tx.query(
              'INSERT INTO whaleu_media.category_icon_request_markers(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
              [actor.accountId, rawKey, hash],
            );
        }),
        /Category icon|Media8/,
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_capability_sources',
        )
      ).rowCount,
      0,
      'migration never issues activation/capability',
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_media.assets')).rowCount,
      0,
      'codec/recovery does not synthesize ready media',
    );
  },
);

test(
  'Media8 zero-row/raw writer fence observes final epochs, retains outer proofs and allows two final readers',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const row = (
      await f.pool.query<{ tgtype: number; tgenabled: string }>(
        `SELECT tgtype,tgenabled FROM pg_trigger WHERE tgrelid='whaleu_media.category_icon_request_markers'::regclass AND tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure`,
      )
    ).rows[0]!;
    assert.equal(row.tgtype, 62);
    assert.equal(row.tgenabled, 'O');
    const prove = () =>
      inTransaction(
        f.pool,
        (tx) => new CategoryIconMediaRequiredProof().capture(tx),
        { isolationLevel: 'read committed' },
      );
    const writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'DELETE FROM whaleu_media.category_icon_request_markers WHERE false',
      );
      await assert.rejects(prove(), /Media|media/);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await prove();
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('TRUNCATE whaleu_media.category_icon_request_markers'),
      ),
      /immutable|retained/,
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await new MediaRequiredProof().capture(tx);
        await tx.query(
          'DELETE FROM whaleu_media.category_icon_request_markers WHERE false',
        );
        await new CategoryIconMediaRequiredProof().capture(tx);
      }),
      /Media|media/,
    );
    await inTransaction(
      f.pool,
      async (first) => {
        await new CategoryIconMediaRequiredProof().capture(first);
        await checkTransactionDeadlines(first);
        await inTransaction(
          f.pool,
          async (second) => {
            await new CategoryIconMediaRequiredProof().capture(second);
            await checkTransactionDeadlines(second);
          },
          { isolationLevel: 'read committed' },
        );
      },
      { isolationLevel: 'read committed' },
    );
  },
);

test(
  'Media8 upgrade preserves previous Media SQL function bodies and real old-schema recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(87);
    t.after(() => f.close());
    const names = [
      'binding_guard',
      'scope_consumption_complete',
      'ratings_binding_guard',
      'ratings_appearance_coupling',
      'ratings_discussion_binding_guard',
      'ratings_discussion_request_consistent',
      'profile_request_marker_consistent',
    ];
    const functions = async () =>
      (
        await f.pool.query<{ proname: string; definition: string }>(
          `SELECT proname,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_media' AND proname=ANY($1::text[]) ORDER BY proname`,
          [names],
        )
      ).rows;
    const before = await functions();
    assert.equal(before.length, names.length);
    const actor = await f.actor(),
      key = randomUUID(),
      legacy = new MediaRecoveryRepository(new MediaLifecycleRepository(), {
        async readyOwned() {
          return null;
        },
      });
    assert.equal(
      (
        await withCommunityScopeWriter(f.pool, (tx) =>
          legacy.cancelRequest(
            actor.accountId,
            key,
            { requestHash: 'a'.repeat(64) },
            tx,
          ),
        )
      ).state,
      'terminal',
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT to_regclass('whaleu_media.category_icon_request_markers') relation",
        )
      ).rows[0].relation,
      null,
    );
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    assert.deepEqual(await functions(), before);
    assert.equal(
      (
        await inTransaction(f.pool, (tx) =>
          legacy.recover(actor.accountId, key, tx),
        )
      ).state,
      'terminal',
    );
  },
);
