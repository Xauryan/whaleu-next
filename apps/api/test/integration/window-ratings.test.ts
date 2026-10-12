import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  windowRatingFixture,
  windowHistory,
} from '../support/window-rating-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { windowIntentHash } from '../../src/ratings/windows/service.js';
import { WindowRepository } from '../../src/ratings/windows/repository.js';
const base = '/v1/ratings/windows';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'W1 accepted topology, mutable signed own CAS, strict raw causality and exact source/current proofs',
  { timeout: 240000 },
  async (t) => {
    const f = await windowRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer();
    const get = (path = '', a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (id: string, body: object, a = actor) =>
      request(http)
        .post(`${base}/${id}/score`)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);
    const cancel = (id: string, body: object, a = actor) =>
      request(http)
        .post(`${base}/requests/${id}/cancel`)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);
    const w = f.add(),
      empty = f.add(),
      unknown = f.add({ history: 'unknown' }),
      second = f.add({
        canteenId: randomUUID(),
        canteenRevision: randomUUID(),
        floorId: randomUUID(),
        floorKey: '屋顶-A',
        floorLabel: 'Synthetic Roof',
        canteenName: 'Other Synthetic Canteen',
      });
    let catalog: string,
      revision: string,
      original: ReturnType<typeof f.command>,
      receipt: unknown;
    await t.test(
      'default unavailable; independent known-empty topology/history; raw floor and accepted mappings',
      async () => {
        ok(await request(http).get(base), 401);
        assert.equal(
          (await get()).body.error.code,
          'WINDOW_CATALOG_UNAVAILABLE',
        );
        catalog = await f.accept([]);
        let r = await get('/catalog');
        ok(r);
        assert.deepEqual(r.body.canteens, []);
        catalog = await f.accept([w, empty, unknown, second]);
        r = await get('/catalog');
        ok(r);
        assert.equal(r.body.canteens.length, 2);
        assert.equal(
          r.body.canteens.find((v: { id: string }) => v.id === w.canteenId)
            .floors[0].sourceFloorKey,
          'B1-mezzanine',
        );
        r = await get('/' + w.id);
        ok(r);
        assert.deepEqual(r.body.window.summary, {
          kind: 'known',
          ratingCount: 0,
          mean: null,
        });
        assert.deepEqual(r.body.myScore, { kind: 'not_submitted' });
        r = await get('/' + unknown.id);
        ok(r);
        assert.deepEqual(r.body.window.summary, { kind: 'unavailable' });
        assert.deepEqual(r.body.myScore, { kind: 'unavailable' });
        const q = f.command(catalog, unknown);
        ok(await post(unknown.id, q), 503);
        ok(await get('/requests/' + q.clientRequestId), 404);
      },
    );
    await t.test(
      'phone-only actor can score every integer, edits replace population and original receipt never rewinds head',
      async () => {
        for (let score = -10; score <= 10; score++) {
          const q = f.command(catalog, w, {
              score,
              expectedOwnScoreRevision: revision ?? null,
            }),
            r = await post(w.id, q);
          ok(r);
          assert.equal(r.body.outcome, 'applied');
          revision = r.body.scoreRevision;
          if (score === -10) {
            original = q;
            receipt = r.body;
          }
          const detail = await get('/' + w.id);
          ok(detail);
          assert.equal(detail.body.myScore.score, score);
          assert.equal(detail.body.window.summary.ratingCount, 1);
          assert.equal(detail.body.window.summary.mean, score);
        }
        assert.deepEqual((await post(w.id, original)).body, receipt);
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        assert.equal((await get('/' + w.id)).body.myScore.score, 10);
        const q = f.command(catalog, w, {
          score: 10,
          expectedOwnScoreRevision: revision,
        });
        const r = await post(w.id, q);
        ok(r);
        assert.equal(r.body.outcome, 'noop');
        assert.equal(r.body.scoreRevision, revision);
        const stale = await post(
          w.id,
          f.command(catalog, w, { score: 10, expectedOwnScoreRevision: null }),
        );
        ok(stale);
        assert.equal(stale.body.code, 'WINDOW_SCORE_REVISION_CONFLICT');
        ok(await post(w.id, { ...original, score: 0 }), 409);
      },
    );
    await t.test(
      'strict endpoint rejects invalid/coerced scores and missing own revision before any command',
      async () => {
        for (const score of [-11, 11, -0.5, 0.5, '0', null, true, {}, []])
          ok(await post(w.id, f.command(catalog, w, { score })), 400);
        const q = f.command(catalog, w);
        const { expectedOwnScoreRevision: omitted, ...missing } = q;
        assert.equal(omitted, null);
        ok(await post(w.id, missing), 400);
      },
    );
    await t.test(
      'two actors and negative PostgreSQL half-away-from-zero means preserve a real zero',
      async () => {
        let r = await post(
          w.id,
          f.command(catalog, w, {
            score: -1,
            expectedOwnScoreRevision: revision,
          }),
        );
        ok(r);
        revision = r.body.scoreRevision;
        r = await post(w.id, f.command(catalog, w, { score: 0 }), other);
        ok(r);
        const a3 = await f.actor(),
          a4 = await f.actor();
        ok(await post(w.id, f.command(catalog, w, { score: 0 }), a3));
        ok(await post(w.id, f.command(catalog, w, { score: 0 }), a4));
        r = await get('/' + w.id);
        ok(r);
        assert.deepEqual(r.body.window.summary, {
          kind: 'known',
          ratingCount: 4,
          mean: -0.3,
        });
        assert.equal((await get('/' + w.id, other)).body.myScore.score, 0);
        r = await post(
          w.id,
          f.command(catalog, w, {
            score: 0,
            expectedOwnScoreRevision: revision,
          }),
        );
        ok(r);
        revision = r.body.scoreRevision;
        assert.deepEqual((await get('/' + w.id + '/summary')).body, {
          kind: 'known',
          ratingCount: 4,
          mean: 0,
        });
      },
    );
    await t.test(
      'both absent and edit concurrency have exactly one CAS winner, immutable durable stale conflicts',
      async () => {
        const c = f.add();
        catalog = await f.accept([w, empty, unknown, second, c]);
        const q1 = f.command(catalog, c, { score: -10 }),
          q2 = f.command(catalog, c, { score: 10 });
        const results = await Promise.all([post(c.id, q1), post(c.id, q2)]);
        results.forEach((r) => ok(r));
        assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        const current = (await get('/' + c.id)).body.myScore;
        const edits = [
          f.command(catalog, c, {
            score: 1,
            expectedOwnScoreRevision: current.revision,
          }),
          f.command(catalog, c, {
            score: 2,
            expectedOwnScoreRevision: current.revision,
          }),
        ];
        const edited = await Promise.all(edits.map((q) => post(c.id, q)));
        edited.forEach((r) => ok(r));
        assert.deepEqual(edited.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        for (let i = 0; i < 2; i++)
          assert.deepEqual((await post(c.id, edits[i]!)).body, edited[i]!.body);
        assert.equal((await get('/' + c.id + '/summary')).body.ratingCount, 1);
      },
    );
    await t.test(
      'stable replacement catalog preserves head/history; parent withdrawal is explicit hardening',
      async () => {
        const before = (await get('/' + w.id)).body.myScore;
        catalog = await f.accept([w, empty, unknown, second]);
        assert.deepEqual((await get('/' + w.id)).body.myScore, before);
        const old = f.command(catalog, w, {
          score: 5,
          expectedOwnScoreRevision: revision,
        });
        catalog = await f.accept([w, empty, unknown, second]);
        const conflict = await post(w.id, old);
        ok(conflict);
        assert.equal(conflict.body.code, 'WINDOW_REVISION_CONFLICT');
        await f.accept([{ ...w, parentActive: false }]);
        ok(await get('/' + w.id), 404);
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        catalog = await f.accept([w, empty, unknown, second]);
      },
    );
    await t.test(
      'signed means/count then stable ID, positive-only min filter, exact parent/floor selectors',
      async () => {
        ok(await post(second.id, f.command(catalog, second, { score: -10 })));
        let r = await get('?minRating=0');
        ok(r);
        assert.ok(r.body.items.some((v: { id: string }) => v.id === second.id));
        r = await get('?minRating=-10');
        ok(r);
        assert.ok(r.body.items.some((v: { id: string }) => v.id === second.id));
        r = await get('?minRating=0.1');
        ok(r);
        assert.deepEqual(r.body.items, []);
        r = await get(
          '?canteenIds=' + second.canteenId + '&floorId=' + second.floorId,
        );
        ok(r);
        assert.deepEqual(
          r.body.items.map((v: { id: string }) => v.id),
          [second.id],
        );
        r = await get('?limit=1');
        ok(r);
        const ids = [r.body.items[0].id];
        while (r.body.nextCursor) {
          r = await get(
            '?limit=1&cursor=' + encodeURIComponent(r.body.nextCursor),
          );
          ok(r);
          ids.push(r.body.items[0].id);
        }
        assert.equal(new Set(ids).size, 4);
        assert.deepEqual(ids.slice(0, 2), [w.id, second.id]);
        assert.equal(ids.at(-1), unknown.id);
      },
    );
    await t.test(
      'off-page score/history mutations and exact expiry invalidate the whole cursor population',
      async () => {
        let r = await get('?limit=1');
        ok(r);
        const cursor = r.body.nextCursor;
        ok(await post(empty.id, f.command(catalog, empty, { score: 10 })));
        assert.equal(
          (await get('?limit=1&cursor=' + encodeURIComponent(cursor))).body
            .error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        r = await get('?limit=1');
        await windowHistory(f.pool, unknown.id, 'accepted_empty');
        assert.equal(
          (
            await get(
              '?limit=1&cursor=' + encodeURIComponent(r.body.nextCursor),
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        await windowHistory(
          f.pool,
          second.id,
          'accepted_empty',
          new Date(Date.now() + 200),
        );
        r = await get('?limit=1');
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(
          (
            await get(
              '?limit=1&cursor=' + encodeURIComponent(r.body.nextCursor),
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        await windowHistory(f.pool, second.id, 'accepted_empty');
      },
    );
    await t.test(
      'equal signed means use population count then stable ascending ID without page duplication',
      async () => {
        const x = f.add(),
          y = f.add();
        catalog = await f.accept([w, empty, unknown, second, x, y]);
        ok(await post(x.id, f.command(catalog, x, { score: 0 })));
        ok(await post(y.id, f.command(catalog, y, { score: 0 })));
        const r = await get();
        ok(r);
        assert.deepEqual(
          r.body.items
            .filter((v: { id: string }) => [w.id, x.id, y.id].includes(v.id))
            .map((v: { id: string }) => v.id),
          [w.id, ...[x.id, y.id].sort()],
        );
        catalog = await f.accept([w, empty, unknown, second]);
      },
    );
    await t.test(
      'an external uncommitted source writer after the real directory read fails bounded final owner fencing',
      async () => {
        const owner = f.app.get(WindowRepository),
          original = owner.page.bind(owner),
          writer = await f.pool.connect();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => (entered = resolve)),
          hold = new Promise<void>((resolve) => (release = resolve));
        owner.page = async (...args) => {
          const result = await original(...args);
          entered();
          await hold;
          return result;
        };
        try {
          const reading = get().then((r) => r);
          await ready;
          await writer.query('BEGIN');
          await writer.query(
            "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
          );
          release();
          ok(await reading, 503);
          await writer.query('COMMIT');
        } finally {
          release();
          owner.page = original;
          await writer.query('ROLLBACK');
          writer.release();
          await f.pool.query(
            "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
          );
        }
      },
    );
    await t.test(
      'unknown history does not erase own zero and cannot mint false conflict',
      async () => {
        await windowHistory(f.pool, w.id, 'unknown');
        const r = await get('/' + w.id);
        ok(r);
        assert.equal(r.body.myScore.score, 0);
        assert.deepEqual(r.body.window.summary, { kind: 'unavailable' });
        const q = f.command(catalog, w, {
          score: 3,
          expectedOwnScoreRevision: randomUUID(),
        });
        ok(await post(w.id, q), 503);
        ok(await get('/requests/' + q.clientRequestId), 404);
        await windowHistory(f.pool, w.id, 'accepted_empty');
      },
    );
    await t.test(
      'durable cancellation wins against late original write and remains recoverable after source/eligibility loss',
      async () => {
        const q = f.command(catalog, w, {
          score: 4,
          expectedOwnScoreRevision: revision,
        });
        let r = await cancel(q.clientRequestId, { windowId: w.id, command: q });
        ok(r);
        assert.equal(r.body.code, 'WINDOW_SCORE_CANCELLED');
        assert.deepEqual((await post(w.id, q)).body, r.body);
        await f.pool.query(
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
        );
        await f.certify(actor.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        assert.deepEqual((await post(w.id, original)).body, receipt);
        const cancelled = f.command(catalog, w, { score: 8 });
        r = await cancel(cancelled.clientRequestId, {
          windowId: w.id,
          command: cancelled,
        });
        ok(r);
        assert.equal(r.body.code, 'WINDOW_SCORE_CANCELLED');
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        catalog = await f.accept([w, empty, unknown, second]);
      },
    );
    await t.test(
      'raw immutable events/head/receipts and no fabricated noops/rejections/invalid UUID or timestamp',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.window_score_events SET score=1',
          'DELETE FROM whaleu_ratings.window_score_heads',
          'TRUNCATE whaleu_ratings.window_commands',
          'UPDATE whaleu_ratings.window_commands SET receipt=receipt',
          'UPDATE whaleu_ratings.window_score_heads SET revision=revision',
        ])
          await assert.rejects(f.pool.query(sql));
        const session = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_identity.sessions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
            [actor.accountId],
          )
        ).rows[0]!.id;
        for (const patch of [
          { score: '0' },
          { expectedOwnScoreRevision: 7 },
          { expectedCatalogRevision: 123 },
          { score: 0.2 },
        ]) {
          const q = f.command(catalog, w, patch);
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await tx.query(
                'INSERT INTO whaleu_ratings.window_commands(actor_id,request_id,session_id,window_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                  actor.accountId,
                  q.clientRequestId,
                  session,
                  w.id,
                  q,
                  windowIntentHash(actor.accountId, w.id, q),
                  {
                    requestId: q.clientRequestId,
                    operation: 'window.score.set.v1',
                    windowId: w.id,
                    outcome: 'rejected',
                    code: 'WINDOW_SCORE_CANCELLED',
                  },
                ],
              );
            }),
          );
        }
        const own = (await get('/' + w.id)).body.myScore;
        for (const mode of [
          'noop',
          'source-conflict',
          'own-conflict',
          'timestamp',
        ]) {
          const q = f.command(catalog, w, {
            score: own.score,
            expectedOwnScoreRevision: own.revision,
          });
          const response =
            mode === 'source-conflict' || mode === 'own-conflict'
              ? {
                  requestId: q.clientRequestId,
                  operation: 'window.score.set.v1',
                  windowId: w.id,
                  outcome: 'rejected',
                  code:
                    mode === 'source-conflict'
                      ? 'WINDOW_REVISION_CONFLICT'
                      : 'WINDOW_SCORE_REVISION_CONFLICT',
                }
              : {
                  requestId: q.clientRequestId,
                  operation: 'window.score.set.v1',
                  windowId: w.id,
                  outcome: 'noop',
                  score: own.score,
                  scoreRevision: own.revision,
                  recordedAt:
                    mode === 'timestamp'
                      ? own.recordedAt.replace('Z', '+00:00')
                      : own.recordedAt,
                };
          if (mode === 'noop') q.expectedOwnScoreRevision = null;
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await tx.query(
                'INSERT INTO whaleu_ratings.window_commands(actor_id,request_id,session_id,window_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                  actor.accountId,
                  q.clientRequestId,
                  session,
                  w.id,
                  q,
                  windowIntentHash(actor.accountId, w.id, q),
                  response,
                ],
              );
            }),
          );
        }
      },
    );
    await t.test(
      'session/phone/Safety and independent canonical mapping remain current required facts',
      async () => {
        const unverified = await f.actor({
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        ok(await get('', unverified), 403);
        const banned = await f.actor();
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [banned.accountId],
        );
        ok(await get('', banned), 403);
        await f.pool.query(
          'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
          [w.campusId],
        );
        ok(await get(), 503);
        await f.pool.query(
          'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
          [w.campusId],
        );
      },
    );
    await t.test(
      'accepted metadata is sealed and concurrent acceptance waits for complete earlier assembly',
      async () => {
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_ratings.window_entries(catalog_id,window_id,revision,canteen_id,floor_id,name,is_active) VALUES($1,$2,$3,$4,$5,$6,true)',
            [
              catalog,
              randomUUID(),
              randomUUID(),
              w.canteenId,
              w.floorId,
              'Late Synthetic Window',
            ],
          ),
          /sealed/,
        );
        const candidate = randomUUID();
        await f.pool.query(
          "INSERT INTO whaleu_ratings.window_catalogs(id,source_namespace,source_reference,source_revision,coverage,scope_policy,policy_reference,valid_until) VALUES($1,'synthetic:window-fixture','synthetic:seal-race','synthetic:seal-race','complete','authenticated_phone','synthetic:seal-test',clock_timestamp()+interval '1 hour')",
          [candidate],
        );
        const writer = await f.pool.connect(),
          sealer = await f.pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(
            'INSERT INTO whaleu_ratings.canteen_entries SELECT $1,canteen_id,revision,name,is_active,campus_id,source_campus_key,campus_label,campus_mapping_reference FROM whaleu_ratings.canteen_entries WHERE catalog_id=$2 AND canteen_id=$3',
            [candidate, catalog, w.canteenId],
          );
          await sealer.query('BEGIN');
          const accepting = sealer.query(
            'INSERT INTO whaleu_ratings.window_catalog_acceptances(catalog_id) VALUES($1)',
            [candidate],
          );
          await f.waitForLock(
            'INSERT INTO whaleu_ratings.window_catalog_acceptances',
          );
          await writer.query('COMMIT');
          await accepting;
          await sealer.query('COMMIT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.canteen_entries WHERE catalog_id=$1',
                [candidate],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_ratings.window_floor_entries(catalog_id,canteen_id,floor_id,label,is_active) VALUES($1,$2,$3,$4,true)',
              [candidate, w.canteenId, w.floorId, 'Late Synthetic Floor'],
            ),
            /sealed/,
          );
        } finally {
          await writer.query('ROLLBACK');
          await sealer.query('ROLLBACK');
          writer.release();
          sealer.release();
        }
      },
    );
    await t.test(
      'source read and exact boundary are captured together across expiry and future-acceptance pauses',
      async () => {
        await f.pool
          .query(`ALTER FUNCTION whaleu_ratings.window_source(uuid,timestamptz) RENAME TO w1_original_source;
        CREATE FUNCTION whaleu_ratings.window_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$DECLARE value jsonb;BEGIN value:=whaleu_ratings.w1_original_source(wid,instant);PERFORM pg_sleep(0.6);RETURN value;END$$`);
        try {
          await windowHistory(
            f.pool,
            w.id,
            'accepted_empty',
            new Date(Date.now() + 300),
          );
          ok(await get('/' + w.id), 503);
          await windowHistory(
            f.pool,
            w.id,
            'accepted_empty',
            new Date(Date.now() + 3600000),
            new Date(Date.now() + 300),
          );
          ok(await get('/' + w.id), 503);
        } finally {
          await f.pool.query(
            'DROP FUNCTION whaleu_ratings.window_source(uuid,timestamptz); ALTER FUNCTION whaleu_ratings.w1_original_source(uuid,timestamptz) RENAME TO window_source',
          );
          await windowHistory(f.pool, w.id, 'accepted_empty');
        }
      },
    );
    await t.test(
      'PostgreSQL exact microsecond source/history boundary predicates and unsupported raw isolation',
      async () => {
        const row = (
          await f.pool.query(
            `SELECT whaleu_ratings.window_history($1,a.accepted_at-interval '1 microsecond') IS NULL before,whaleu_ratings.window_history($1,a.accepted_at)=a.id accepted,whaleu_ratings.window_history($1,a.valid_until) IS NULL expired FROM whaleu_ratings.window_history_heads h JOIN whaleu_ratings.window_history_assertions a ON a.id=h.assertion_id WHERE h.window_id=$1`,
            [w.id],
          )
        ).rows[0];
        assert.deepEqual(row, { before: true, accepted: true, expired: true });
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            client.query('SELECT whaleu_ratings.window_fence()'),
          );
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );
    await t.test(
      'real deferred source/parent/remap/session/phone/Safety changes roll back both changing event and receipt',
      async () => {
        const inactiveCatalog = await f.accept([{ ...w, parentActive: false }]);
        await f.pool.query(
          'UPDATE whaleu_ratings.window_catalog_head SET catalog_id=$1',
          [catalog],
        );
        const cases = [
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
          "UPDATE whaleu_ratings.window_catalog_head SET catalog_id='" +
            inactiveCatalog +
            "'",
          "UPDATE whaleu_campus.campuses SET is_active=false WHERE id='" +
            w.campusId +
            "'",
          "UPDATE whaleu_campus.campus_region_assignments SET operating_region_id='" +
            f.scope.related.regionId +
            "' WHERE campus_id='" +
            w.campusId +
            "'",
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
          'UPDATE whaleu_verification.account_heads SET snapshot_id=NULL WHERE account_id=NEW.actor_id',
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
        ];
        for (const [index, change] of cases.entries()) {
          const a = await f.actor({
              affiliation: 'unverified',
              identity: false,
            }),
            q = f.command(catalog, w, { score: -8 });
          // Use a legitimate append-only Verification snapshot/event/head
          // transition with unavailable phone coverage, never overwrite a head
          // backwards or bypass its own ledger constraints.
          let sql = change;
          if (index === 5) {
            const snapshot = randomUUID();
            sql = `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) SELECT '${snapshot}',h.account_id,h.revision+1,s.affiliation_assertion_id,s.student_number_assertion_id,NULL,s.application_state,s.application_coverage FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=NEW.actor_id;
            INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) SELECT '${randomUUID()}',account_id,'${randomUUID()}','reconciled_snapshot',account_id,revision,'${snapshot}',revision+1,'synthetic_fixture' FROM whaleu_verification.account_heads WHERE account_id=NEW.actor_id;
            UPDATE whaleu_verification.account_heads SET revision=revision+1,snapshot_id='${snapshot}' WHERE account_id=NEW.actor_id`;
          }
          await f.pool.query(
            'CREATE FUNCTION whaleu_ratings.w1_test_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              sql +
              ';RETURN NULL;END$$; CREATE CONSTRAINT TRIGGER zz_w1_test_change AFTER INSERT ON whaleu_ratings.window_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.w1_test_change()',
          );
          try {
            const r = await post(w.id, q, a);
            assert.ok(
              [401, 403, 409, 503].includes(r.status),
              JSON.stringify(r.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.window_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.window_score_events WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_w1_test_change ON whaleu_ratings.window_commands;DROP FUNCTION whaleu_ratings.w1_test_change()',
            );
          }
        }
      },
    );
    await t.test(
      'actual deferred wait crossing phone/history/catalog expiry rolls back mutation and receipt',
      async () => {
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.w1_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$; CREATE CONSTRAINT TRIGGER zz_w1_test_wait AFTER INSERT ON whaleu_ratings.window_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.w1_test_wait()',
        );
        try {
          for (const kind of [
            'phone',
            'history',
            'catalog',
            'session',
            'safety',
          ]) {
            const a = await f.actor({
                affiliation: 'unverified',
                identity: false,
              }),
              q = f.command(catalog, w, { score: -5 });
            if (kind === 'session')
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
                [a.sessionId],
              );
            if (kind === 'safety')
              await f.pool.query(
                "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '400 milliseconds' WHERE account_id=$1",
                [a.accountId],
              );
            if (kind === 'phone')
              await f.certify(a.accountId, {
                phone: 'verified',
                affiliation: 'unverified',
                identity: false,
                expiresAt: new Date(Date.now() + 400),
              });
            if (kind === 'history')
              await windowHistory(
                f.pool,
                w.id,
                'accepted_empty',
                new Date(Date.now() + 400),
              );
            if (kind === 'catalog') {
              catalog = await f.accept([w, empty, unknown, second], {
                validUntil: new Date(Date.now() + 400),
              });
              q.expectedCatalogRevision = catalog;
            }
            const denied = await post(w.id, q, a);
            assert.ok(
              (kind === 'session' ? [401, 503] : [503]).includes(denied.status),
              JSON.stringify(denied.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.window_commands WHERE actor_id=$1 AND request_id=$2',
                  [a.accountId, q.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.window_score_heads WHERE actor_id=$1 AND window_id=$2',
                  [a.accountId, w.id],
                )
              ).rowCount,
              0,
            );
            if (kind === 'history')
              await windowHistory(f.pool, w.id, 'accepted_empty');
            if (kind === 'catalog')
              catalog = await f.accept([w, empty, unknown, second]);
          }
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_w1_test_wait ON whaleu_ratings.window_commands;DROP FUNCTION whaleu_ratings.w1_test_wait()',
          );
        }
      },
    );
  },
);
