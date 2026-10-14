import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import httpRequest from 'supertest';
import { sealToolCatalog } from '../../src/campus-tools/contracts.js';
import {
  campusToolsFixture,
  syntheticToolsCatalog,
  syntheticMapEntry,
} from '../support/campus-tools-fixture.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { CampusToolMediaProofRegistry } from '../../src/media/campus-tools-owner-proof.js';
import type { CampusToolMediaProof } from '../../src/media/campus-tools-owner-proof.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;

test(
  'campus tools initial facts survive same-transaction and deferred waits; exact source and transaction epochs fail closed',
  { timeout: 240000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campus = f.scope.home.campusId;
    const catalog = syntheticToolsCatalog(campus, {
      entries: [syntheticMapEntry()],
    });
    const receipt = await f.admit(catalog);
    const inject = async (
      hook: (
        sql: string,
        values: unknown[] | undefined,
        query: Query,
        tx: PoolClient,
      ) => Promise<void>,
      read = () => f.tools.hub(null, campus),
    ) => {
      const original = f.database.transaction,
        run = original.bind(f.database);
      f.database.transaction = async (work, options) => {
        let client: PoolClient | undefined,
          raw: PoolClient['query'] | undefined;
        try {
          return await run(async (tx) => {
            client = tx;
            raw = tx.query;
            const query = raw.bind(tx) as Query;
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              await hook(sql, values, query, tx);
              return result;
            }) as PoolClient['query'];
            return work(tx);
          }, options);
        } finally {
          if (client && raw) client.query = raw;
        }
      };
      try {
        return await read();
      } finally {
        f.database.transaction = original;
      }
    };
    await t.test(
      'Campus tuple update after original capture denies final response',
      async () => {
        let changed = false;
        await assert.rejects(
          inject(async (sql, _values, query) => {
            if (!changed && sql.startsWith('SELECT c.content')) {
              changed = true;
              await query(
                'UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=$1',
                [campus],
              );
            }
          }),
        );
        assert.ok(changed);
      },
    );
    await t.test(
      'restored read epoch invalidates required source proof',
      async () => {
        let changed = false;
        await assert.rejects(
          inject(async (sql, _values, _query, tx) => {
            if (!changed && sql.startsWith('SELECT c.content')) {
              changed = true;
              const checkpoint = checkpointTransactionDeadlines(tx);
              restoreTransactionDeadlines(tx, checkpoint);
            }
          }),
        );
        assert.ok(changed);
      },
    );
    await t.test(
      'configuration authority revocation after source read is final-required',
      async () => {
        let changed = false;
        await assert.rejects(
          inject(async (sql) => {
            if (!changed && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              changed = true;
              f.revoke(receipt.digest);
            }
          }),
        );
        assert.ok(changed);
        f.register(catalog);
      },
    );
    await t.test(
      'final table fence never waits behind a raw unrelated writer',
      async () => {
        const writer = await f.pool.connect();
        await writer.query('BEGIN');
        await writer.query(
          'UPDATE whaleu_campus_tools.media_bindings SET asset_id=asset_id WHERE false',
        );
        const start = performance.now();
        try {
          await assert.rejects(f.tools.hub(null, campus));
          assert.ok(performance.now() - start < 2000);
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      },
    );
    await t.test(
      'missing source cannot become accepted empty during a wait',
      async () => {
        const absent = f.scope.related.campusId;
        let changed = false;
        await assert.rejects(
          inject(
            async (sql, _values, query) => {
              if (!changed && sql.startsWith('SELECT c.content')) {
                changed = true;
                await query(
                  'UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=$1',
                  [absent],
                );
              }
            },
            () => f.tools.hub(null, absent),
          ),
        );
        assert.ok(changed);
        assert.equal((await f.tools.hub(null, absent)).state, 'unknown');
      },
    );
    await t.test(
      'real concurrent admission waits behind absent-head reader then becomes current',
      async () => {
        const absent = f.scope.foreign.campusId,
          candidate = syntheticToolsCatalog(absent);
        let writer: Promise<unknown> | undefined,
          arrived = false;
        const result = await inject(
          async (sql) => {
            if (arrived || !sql.startsWith('SELECT c.content')) return;
            arrived = true;
            writer = f.admit(candidate);
            let waiting = false;
            for (let i = 0; i < 100; i++) {
              const rows = await f.pool.query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%whaleu:campus-tools:v1:%' AND pid<>pg_backend_pid()) waiting",
              );
              if (rows.rows[0]?.waiting) {
                waiting = true;
                break;
              }
              await sleep(10);
            }
            assert.ok(
              waiting,
              'actual source writer must wait behind original absent-head scope',
            );
          },
          () => f.tools.hub(null, absent),
        );
        assert.equal(result.state, 'unknown');
        assert.ok(arrived);
        await writer;
        assert.equal((await f.tools.hub(null, absent)).state, 'known_empty');
      },
    );
    await t.test(
      'real deferred trigger changes original Campus tuple before final proof',
      async () => {
        let queued = false,
          inserted = false;
        await assert.rejects(
          inject(async (sql, _values, query) => {
            if (queued || !sql.startsWith('SELECT c.content')) return;
            queued = true;
            await query(
              'CREATE TEMP TABLE campus_tools_deferred_probe(campus_id uuid) ON COMMIT DROP',
            );
            await query(
              'CREATE FUNCTION pg_temp.campus_tools_deferred_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.01); UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=NEW.campus_id; RETURN NULL; END $$',
            );
            await query(
              'CREATE CONSTRAINT TRIGGER campus_tools_late_mutation AFTER INSERT ON campus_tools_deferred_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.campus_tools_deferred_mutation()',
            );
            await query('INSERT INTO campus_tools_deferred_probe VALUES($1)', [
              campus,
            ]);
            inserted = true;
          }),
          (error) =>
            error instanceof ApplicationError &&
            error.code === 'CAMPUS_TOOLS_UNAVAILABLE',
        );
        assert.ok(queued && inserted);
      },
    );
    await t.test(
      'exact deadline sampled after deferred work, including submillisecond equality',
      async () => {
        // PostgreSQL evaluates the final boundary from its textual deadline. No JS
        // Date truncation substitutes for the exact accepted source validity.
        for (const micros of [-1, 0, 1]) {
          let hit = false;
          const original = f.database.transaction,
            run = original.bind(f.database);
          f.database.transaction = async (work, options) => {
            let client: PoolClient | undefined,
              originalQuery: PoolClient['query'] | undefined;
            try {
              return await run(async (tx) => {
                client = tx;
                originalQuery = tx.query;
                const query = originalQuery.bind(tx) as Query;
                tx.query = (async (sql: string, values?: unknown[]) => {
                  if (
                    sql.startsWith(
                      'WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)',
                    )
                  ) {
                    hit = true;
                    return query(
                      `WITH instant AS MATERIALIZED (SELECT $1::timestamptz + $2::integer * interval '1 microsecond' now) SELECT now, ARRAY(SELECT ordinal::text FROM unnest($3::timestamptz[]) WITH ORDINALITY d(until,ordinal) WHERE NOT isfinite(until) OR until<=instant.now) expired FROM instant`,
                      [(values![0] as string[])[0], micros, values![0]],
                    );
                  }
                  return query(sql, values);
                }) as PoolClient['query'];
                return work(tx);
              }, options);
            } finally {
              if (client && originalQuery) client.query = originalQuery;
            }
          };
          try {
            if (micros < 0)
              assert.equal((await f.tools.hub(null, campus)).state, 'ready');
            else await assert.rejects(f.tools.hub(null, campus));
            assert.ok(hit);
          } finally {
            f.database.transaction = original;
          }
        }
      },
    );
  },
);

test(
  'dedicated Media proof rejects fabricated, request, cross-owner, transaction and restored-epoch capabilities',
  { timeout: 180000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campus = f.scope.home.campusId,
      image = await f.image(),
      entry = {
        id: randomUUID(),
        sourceId: 'research',
        ordinal: 0,
        revision: randomUUID(),
        title: 'Synthetic image',
        state: 'enabled' as const,
        kind: 'research' as const,
        description: 'Synthetic',
        compatibility: null,
        image,
        link: null,
      };
    const catalog = syntheticToolsCatalog(campus, { entries: [entry] });
    await f.admit(catalog);
    const target = {
        campusId: campus,
        catalogId: catalog.id,
        entryId: entry.id,
        bindingId: image.bindingId,
      },
      request = { target, requestId: randomUUID() };
    let retained: CampusToolMediaProof | undefined;
    await f.database.transaction(
      async (tx) => {
        const proof = await f.media.registry.authorize(null, request, tx);
        retained = proof;
        assert.equal(
          f.media.registry.require(proof, request, tx).reference.assetId,
          image.assetId,
        );
        assert.throws(() =>
          f.media.registry.require({} as CampusToolMediaProof, request, tx),
        );
        assert.throws(() =>
          f.media.registry.require(
            proof,
            { ...request, requestId: randomUUID() },
            tx,
          ),
        );
        assert.throws(() =>
          f.media.registry.require(
            proof,
            {
              ...request,
              target: { ...target, campusId: f.scope.foreign.campusId },
            },
            tx,
          ),
        );
        const foreign = new CampusToolMediaProofRegistry({
          authorizeCurrent: async () => {
            throw new Error('unreachable');
          },
        });
        assert.throws(() => foreign.require(proof, request, tx));
      },
      { isolationLevel: 'read committed' },
    );
    await assert.rejects(
      f.database.transaction(
        async (tx) => {
          const proof = await f.media.registry.authorize(null, request, tx),
            checkpoint = checkpointTransactionDeadlines(tx);
          restoreTransactionDeadlines(tx, checkpoint);
          assert.throws(() => f.media.registry.require(proof, request, tx));
        },
        { isolationLevel: 'read committed' },
      ),
    );
    await f.database.transaction(
      async (tx) => {
        assert.ok(retained);
        assert.throws(() => f.media.registry.require(retained!, request, tx));
      },
      { isolationLevel: 'read committed' },
    );
    const descriptor = await f.media.descriptor(null, target);
    assert.equal(descriptor.assetId, image.assetId);
    const open = f.storage.openExact.bind(f.storage);
    let opened = false;
    f.storage.openExact = async (object, maximum) => {
      const result = await open(object, maximum);
      opened = true;
      f.revoke(sealToolCatalog(catalog).digest);
      return result;
    };
    try {
      await assert.rejects(
        f.media.open(null, target, 'display-v1', 'synthetic-storage-race'),
      );
      assert.ok(opened);
    } finally {
      f.storage.openExact = open;
      f.register(catalog);
    }

    const replacement = syntheticToolsCatalog(campus, {
      expectedHead: catalog.id,
    });
    await f.admit(replacement);
    await assert.rejects(
      f.media.open(null, target, 'display-v1', 'synthetic-connection'),
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
        [f.scope.home.regionId],
      ),
    );
    const response = await httpRequest(f.app.getHttpServer()).get(
      `/v1/campuses/${campus}/tools`,
    );
    assert.notEqual(response.status, 200);
  },
);
