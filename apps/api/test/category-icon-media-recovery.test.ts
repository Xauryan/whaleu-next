import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { MediaRecoveryRepository } from '../src/media/recovery-repository.js';
import { CategoryIconMediaRecoveryRepository } from '../src/media/category-icon-recovery-repository.js';
import { MediaLifecycleRepository } from '../src/media/lifecycle-repository.js';
import {
  categoryIconRequestMarker,
  reserveCategoryIconRequestMarker,
  rejectCategoryIconRequestMarker,
} from '../src/media/category-icon-request-marker.js';
import { MediaIngressRepository } from '../src/media/ingress-repository.js';
import type { MediaIngressPlanningPort } from '../src/media/application-v2.js';
const conflict = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'MEDIA_REQUEST_CONFLICT';

test('Media8 markers reserve the shared original request namespace without treating any other protocol tombstone as Category', async () => {
  const actor = randomUUID(),
    id = randomUUID(),
    hash = 'a'.repeat(64);
  let marker: string | null = null,
    occupied = false,
    inserts = 0;
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      if (
        sql.startsWith(
          'SELECT request_hash FROM whaleu_media.category_icon_request_markers',
        )
      )
        return {
          rows: marker === null ? [] : [{ request_hash: marker }],
          rowCount: marker === null ? 0 : 1,
        };
      if (sql.startsWith('SELECT 1 FROM whaleu_media.upload_request_fences'))
        return { rows: occupied ? [{}] : [], rowCount: occupied ? 1 : 0 };
      if (
        sql.startsWith('INSERT INTO whaleu_media.category_icon_request_markers')
      ) {
        marker = values[2] as string;
        inserts++;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  await assert.rejects(categoryIconRequestMarker(actor, id, tx));
  startTransactionDeadlines(tx);
  try {
    occupied = true;
    await assert.rejects(
      reserveCategoryIconRequestMarker(actor, id, hash, tx),
      conflict,
    );
    assert.equal(inserts, 0);
    occupied = false;
    await rejectCategoryIconRequestMarker(actor, id, tx);
    await reserveCategoryIconRequestMarker(actor, id, hash, tx);
    await reserveCategoryIconRequestMarker(actor, id, hash, tx);
    assert.equal(inserts, 1);
    await assert.rejects(
      reserveCategoryIconRequestMarker(actor, id, 'b'.repeat(64), tx),
      conflict,
    );
    await assert.rejects(
      rejectCategoryIconRequestMarker(actor, id, tx),
      conflict,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Historical request recovery retains null/absent namespace behavior and never queries Media8 schema', async () => {
  const actor = randomUUID(),
    id = randomUUID(),
    hash = 'a'.repeat(64),
    lifecycle = new MediaLifecycleRepository(),
    assets = {
      async readyOwned() {
        return null;
      },
    };
  for (const namespace of [undefined, null, 8]) {
    const sqls: string[] = [];
    const tx = {
      async query(sql: string) {
        sqls.push(sql);
        assert.equal(sql.includes('category_icon'), false);
        if (sql.startsWith('SELECT * FROM whaleu_media.upload_request_fences'))
          return {
            rows: [
              {
                request_hash: hash,
                intent_id: null,
                state: 'cancelled_before_prepare',
                ...(namespace === undefined
                  ? {}
                  : { protocol_namespace: namespace }),
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('clock_timestamp()'))
          return { rows: [{ now: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    startTransactionDeadlines(tx);
    try {
      for (const protocol of [2, 3, 4] as const) {
        const repository = new MediaRecoveryRepository(
          lifecycle,
          assets,
          protocol,
        );
        if (namespace === 8)
          await assert.rejects(repository.recover(actor, id, tx), conflict);
        else if (protocol === 4)
          await assert.rejects(repository.recover(actor, id, tx), {
            name: 'ZodError',
          }); // Generic recovery has never exposed a v4 receipt; batch4 owns its recovery.
        else
          assert.equal(
            (await repository.recover(actor, id, tx)).state,
            'terminal',
          );
      }
      const repository = new MediaRecoveryRepository(lifecycle, assets);
      if (namespace === 8)
        await assert.rejects(
          repository.cancelRequest(actor, id, { requestHash: hash }, tx),
          conflict,
        );
      else
        assert.equal(
          (await repository.cancelRequest(actor, id, { requestHash: hash }, tx))
            .state,
          'terminal',
        );
      assert.ok(
        sqls.some((sql) =>
          sql.startsWith('SELECT * FROM whaleu_media.upload_request_fences'),
        ),
      );
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('Media8 cancelled-before recovery requires both its marker and exact8 shared-fence discriminator', async () => {
  const actor = randomUUID(),
    id = randomUUID(),
    hash = 'a'.repeat(64);
  for (const namespace of [undefined, null, 8]) {
    const tx = {
      async query(sql: string) {
        if (
          sql.startsWith(
            'SELECT request_hash FROM whaleu_media.category_icon_request_markers',
          )
        )
          return { rows: [{ request_hash: hash }], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM whaleu_media.upload_request_fences'))
          return {
            rows: [
              {
                request_hash: hash,
                intent_id: null,
                state: 'cancelled_before_prepare',
                protocol_namespace: namespace,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('clock_timestamp()'))
          return { rows: [{ now: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    startTransactionDeadlines(tx);
    try {
      const repository = new CategoryIconMediaRecoveryRepository(
        new MediaLifecycleRepository(),
        {
          async readyOwned() {
            return null;
          },
        },
      );
      if (namespace === 8)
        assert.equal(
          (await repository.recover(actor, id, tx)).state,
          'cancelled_before_prepare',
        );
      else await assert.rejects(repository.recover(actor, id, tx), conflict);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('Only typed8 ingress can query Category owner upload scopes; old protocols fail before any new-schema read', async () => {
  const tx = {
    async query() {
      throw new Error('No database query permitted');
    },
  } as unknown as PoolClient;
  const planning = {
    writerInstanceId: randomUUID(),
  } as MediaIngressPlanningPort;
  startTransactionDeadlines(tx);
  try {
    for (const protocol of [2, 3, 4, 5, 6, 7] as const)
      await assert.rejects(
        new MediaIngressRepository(
          planning,
          protocol,
        ).originalCategoryIconInput(randomUUID(), randomUUID(), tx),
        (e) => e instanceof ApplicationError && e.code === 'MEDIA_UNAVAILABLE',
      );
    await assert.rejects(
      new MediaIngressRepository(planning, 8).originalRatingsInput(
        randomUUID(),
        randomUUID(),
        tx,
      ),
    );
    await assert.rejects(
      new MediaIngressRepository(planning, 8).originalInput(
        randomUUID(),
        randomUUID(),
        tx,
      ),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
