import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  RATING_COMPLETE_POOL_BATCH_SIZE,
  RATING_COMPLETE_POOL_BYTE_LIMIT,
  RATING_COMPLETE_POOL_PATH_LIMIT,
  RATING_COMPLETE_POOL_PREPARATION_MS,
  RATING_COMPLETE_POOL_TARGET_LIMIT,
} from '../../src/ratings/random/complete-pool.repository.js';
import { RatingRandomDraw } from '../../src/ratings/random/draw.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { ratingEditFixture } from '../support/rating-edit-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';

type Fixture = Awaited<ReturnType<typeof ratingEditFixture>>;
type Edited = Awaited<ReturnType<Fixture['edit']>>;

function barrier() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reach, release, reached, held };
}

async function atBarrier(reached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Mixed-pool scan did not reach its real query barrier'),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForAdvisoryWriter(f: Fixture, pid: number) {
  const deadline = Date.now() + 3000;
  while (true) {
    const row = (
      await f.pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) waiting",
        [pid],
      )
    ).rows[0]!;
    if (row.waiting) return;
    assert.ok(
      Date.now() < deadline,
      'The real new-binding writer must reach the shared Safety barrier',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function epochs(f: Fixture) {
  return (
    await f.pool.query<{ pool: string; navigation: string; binding: string }>(
      `SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,
      (SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation,
      (SELECT epoch::text FROM whaleu_community.rating_review_binding_epoch) binding`,
    )
  ).rows[0]!;
}

test(
  'M2B real mixed-definition complete pool crosses every 128 boundary and retains late Review uncertainty',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      reader = await f.actor();
    const size = 529;
    const catalog = await f.catalog(owner, { count: size, depth: 3 });
    const ordered = [...catalog.targets].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const edited = new Map<string, Edited>();
    const previousEdits = new Map<string, Edited>();

    // Eleven real targets and sixteen HTTP edits suffice. Each of the five
    // batches contains v1/v2/v3; all four boundaries have v3 immediately before
    // and v2 immediately after. The final two candidates are edited v2 and v3.
    // Setup is 48 owner HTTP requests, well below the unchanged 120/min guard.
    for (const [index, version] of [
      [0, 2],
      [127, 3],
      [128, 2],
      [255, 3],
      [256, 2],
      [383, 3],
      [384, 2],
      [511, 3],
      [512, 2],
      [527, 2],
      [528, 3],
    ] as const) {
      const target = ordered[index]!;
      for (let next = 2; next <= version; next += 1) {
        const result = await f.edit(owner, target.id, {
          name: `Mixed pool ordinal ${index} current v${next}`,
          description: `Canonical edited definition ${next} at sorted ordinal ${index}`,
        });
        assert.equal(result.receipt.outcome, 'applied');
        assert.equal(result.receipt.contentVersion, next);
        assert.ok(result.reviewed);
        if (next === 2) previousEdits.set(target.id, result);
        edited.set(target.id, result);
      }
    }

    assert.deepEqual(
      [
        RATING_COMPLETE_POOL_BATCH_SIZE,
        RATING_COMPLETE_POOL_TARGET_LIMIT,
        RATING_COMPLETE_POOL_PATH_LIMIT,
        RATING_COMPLETE_POOL_BYTE_LIMIT,
        RATING_COMPLETE_POOL_PREPARATION_MS,
      ],
      [128, 10_000, 50_000, 64 * 1024 * 1024, 15_000],
    );
    const definitions = (
      await f.pool.query<{ target_id: string; content_version: number }>(
        `SELECT h.target_id,h.content_version FROM whaleu_ratings.target_definition_heads h
      JOIN whaleu_ratings.target_memberships m ON m.target_id=h.target_id
      WHERE m.catalog_id=$1 ORDER BY h.target_id`,
        [catalog.catalogId],
      )
    ).rows;
    assert.deepEqual(
      definitions.map((row) => row.target_id),
      ordered.map((target) => target.id),
    );
    assert.deepEqual(
      [1, 2, 3].map(
        (version) =>
          definitions.filter((row) => row.content_version === version).length,
      ),
      [518, 6, 5],
    );
    for (let offset = 0; offset < size; offset += 128)
      assert.deepEqual(
        [
          ...new Set(
            definitions
              .slice(offset, offset + 128)
              .map((row) => row.content_version),
          ),
        ].sort(),
        [1, 2, 3],
      );
    for (const boundary of [128, 256, 384, 512]) {
      assert.equal(definitions[boundary - 1]!.content_version, 3);
      assert.equal(definitions[boundary]!.content_version, 2);
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.target_edit_transitions',
        )
      ).rowCount,
      16,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.rating_target_definition_bindings',
        )
      ).rowCount,
      16,
    );

    const tail = ordered.at(-1)!,
      penultimate = ordered.at(-2)!;
    const tailEdit = edited.get(tail.id)!,
      penultimateEdit = edited.get(penultimate.id)!;
    const tailDecision = tailEdit.reviewed!.decisionId;
    const draw = f.app.get(RatingRandomDraw),
      originalDraw = draw.index.bind(draw);
    const requested: number[] = [];
    // Only the entropy outcome changes. Owners, branded batches, canonical
    // projections, Review joins, SQL rows, guards and final proofs stay real.
    draw.index = (maximum) => {
      requested.push(maximum);
      return maximum - 1;
    };
    t.after(() => {
      draw.index = originalDraw;
    });
    const observer = observeDirectoryQueries(f.app);
    t.after(() => observer.restore());
    let trace = { paths: 0, reviews: 0 };
    let pause: ReturnType<typeof barrier> | null = null;
    observer.setHook(async ({ sql }) => {
      if (
        sql.includes('paths AS MATERIALIZED (') &&
        sql.includes('ORDER BY m.catalog_id,m.target_id LIMIT $5')
      )
        trace.paths += 1;
      if (
        sql.includes(
          'LEFT JOIN whaleu_community.rating_target_definition_bindings v ON w.content_version>=2',
        )
      ) {
        trace.reviews += 1;
        // The observer runs after the actual PostgreSQL query, returning its
        // untouched result. A race pauses only after the fifth mixed join.
        if (trace.reviews === 5 && pause) {
          const current = pause;
          pause = null;
          current.reach();
          await current.held;
        }
      }
    });
    const sample = () => {
      trace = { paths: 0, reviews: 0 };
      requested.length = 0;
      return f
        .auth(request(f.http).get('/v1/ratings/random-target'), reader)
        .query({ categoryId: catalog.rootId })
        .timeout({ deadline: 20000 });
    };
    const assertComplete = (
      response: request.Response,
      expected: Edited,
      count = size,
    ) => {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.candidateCount, count);
      assert.deepEqual(trace, { paths: 5, reviews: 5 });
      assert.deepEqual(requested, [count]);
      assert.equal(response.body.item.regionId, null);
      assert.equal(response.body.item.target.id, expected.input.targetId);
      assert.equal(response.body.item.target.name, expected.input.name);
      assert.equal(
        response.body.item.target.description,
        expected.input.description,
      );
      assert.equal(
        response.body.item.target.revision,
        expected.receipt.revision,
      );
      assert.equal(response.body.item.summary.count, 0);
      assert.equal(response.headers['cache-control'], 'no-store');
    };

    await t.test(
      'the real draw sees all 529 candidates and selects the final-batch current v3 definition',
      async () => {
        const result = await sample();
        assertComplete(result, tailEdit);
        const detail = await f.auth(
          request(f.http).get(`/v1/ratings/targets/${tail.id}`),
          reader,
        );
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        assert.deepEqual(result.body.item.target, detail.body);
        const original = (
          await f.pool.query<{
            name: string;
            description: string;
            content_version: number;
          }>(
            'SELECT name,description,content_version FROM whaleu_ratings.targets WHERE id=$1',
            [tail.id],
          )
        ).rows[0]!;
        assert.ok(tail.approval.envelope.purpose === 'publish_rating_target');
        assert.equal(original.name, tail.approval.envelope.name);
        assert.equal(original.description, tail.approval.envelope.description);
        assert.equal(original.content_version, 1);
        assert.notEqual(result.body.item.target.name, original.name);
      },
    );

    await t.test(
      'revoking the last target legacy v1 and superseded v2 Review does not remove its current v3',
      async () => {
        const oldDecisions = [
          tail.approval.decisionId,
          previousEdits.get(tail.id)!.reviewed!.decisionId,
        ];
        assert.ok(oldDecisions.every((id) => id !== tailDecision));
        for (const id of oldDecisions)
          await setRatingReviewState(f.pool, id, 'revoked');
        assertComplete(await sample(), tailEdit);
        const oldStates = (
          await f.pool.query<{ state: string }>(
            `SELECT e.state FROM whaleu_community.rating_approval_heads h
        JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id
        WHERE h.decision_id=ANY($1::uuid[])`,
            [oldDecisions],
          )
        ).rows;
        assert.equal(oldStates.length, 2);
        assert.ok(oldStates.every((row) => row.state === 'revoked'));
        // Keep earlier definitions authoritative for the following current-v3
        // denial/unknown matrix, so an incorrect fallback to v1/v2 cannot pass.
        for (const id of oldDecisions)
          await setRatingReviewState(f.pool, id, 'allow');
        const restored = (
          await f.pool.query<{ decision_id: string; state: string }>(
            `SELECT h.decision_id,e.state FROM whaleu_community.rating_approval_heads h
        JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=h.decision_id
        WHERE h.decision_id=ANY($1::uuid[]) ORDER BY h.decision_id`,
            [oldDecisions],
          )
        ).rows;
        assert.deepEqual(
          restored,
          oldDecisions
            .map((decision_id) => ({ decision_id, state: 'allow' }))
            .sort((a, b) => a.decision_id.localeCompare(b.decision_id)),
        );
      },
    );

    await t.test(
      'an authoritative held or revoked current new-binding decision drops exactly the final target',
      async () => {
        for (const state of ['held', 'revoked'] as const) {
          await setRatingReviewState(f.pool, tailDecision, state);
          const result = await sample();
          assertComplete(result, penultimateEdit, size - 1);
          assert.notEqual(result.body.item.target.id, tail.id);
          const head = (
            await f.pool.query<{
              content_version: number;
              definition_revision: string;
            }>(
              'SELECT content_version,definition_revision FROM whaleu_ratings.target_definition_heads WHERE target_id=$1',
              [tail.id],
            )
          ).rows[0]!;
          assert.deepEqual(head, {
            content_version: 3,
            definition_revision: tailEdit.receipt.definitionRevision,
          });
          await setRatingReviewState(f.pool, tailDecision, 'allow');
          assertComplete(await sample(), tailEdit);
        }
      },
    );

    await t.test(
      'late missing, conflicting, unreconciled and future Review evidence aborts the whole pool before drawing',
      async () => {
        for (const evidence of [
          {
            state: 'allow',
            coverage: 'missing',
            provenance: 'accepted',
            future: false,
          },
          {
            state: 'revoked',
            coverage: 'conflicting',
            provenance: 'accepted',
            future: false,
          },
          {
            state: 'allow',
            coverage: 'complete',
            provenance: 'unreconciled',
            future: false,
          },
          {
            state: 'allow',
            coverage: 'complete',
            provenance: 'accepted',
            future: true,
          },
        ] as const) {
          // Append genuine Review facts and advance the canonical head. Never
          // erase an immutable binding or invent a mock SQL missing-row response.
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const eventId = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_community.rating_approval_events
            (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
            VALUES($1,$2,$3,$4,$5,'synthetic-rating-review','synthetic-mixed-pool-evidence',
              clock_timestamp()+CASE WHEN $6::boolean THEN interval '1 hour' ELSE interval '0' END)`,
              [
                eventId,
                tailDecision,
                evidence.state,
                evidence.coverage,
                evidence.provenance,
                evidence.future,
              ],
            );
            await tx.query(
              'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
              [tailDecision, eventId],
            );
          });
          const result = await sample();
          assert.equal(
            result.status,
            503,
            JSON.stringify({ evidence, body: result.body }),
          );
          assert.equal(result.body.error?.code, 'CONTENT_REVIEW_UNAVAILABLE');
          assert.equal(result.body.item, undefined);
          assert.equal(result.body.candidateCount, undefined);
          assert.deepEqual(trace, { paths: 5, reviews: 5 });
          assert.deepEqual(
            requested,
            [],
            'A late unknown candidate cannot be discarded to draw from a partial pool',
          );
        }
        await setRatingReviewState(f.pool, tailDecision, 'allow');
        assertComplete(await sample(), tailEdit);
      },
    );

    await t.test(
      'an actual pending new-binding statement during the fifth batch fails the final NOWAIT proof closed',
      async () => {
        const before = await epochs(f);
        const bindingsBefore = (
          await f.pool.query(
            'SELECT to_jsonb(b) row FROM whaleu_community.rating_target_definition_bindings b ORDER BY target_id,content_version',
          )
        ).rows;
        const holder = await f.pool.connect(),
          b = barrier();
        let reading: Promise<request.Response> | undefined,
          writing: Promise<unknown> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query("SET LOCAL lock_timeout='5s'");
          const pid = (
            await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          pause = b;
          reading = sample().then((response) => response);
          void reading.catch(() => undefined);
          await atBarrier(b.reached);
          assert.deepEqual(trace, { paths: 5, reviews: 5 });
          assert.deepEqual(requested, []);
          // PostgreSQL takes the target-table lock before running the real
          // statement trigger. This zero-row writer then waits for Safety; it
          // cannot acquire the epoch writer locks ahead of the authorized scan.
          writing = holder.query(
            'UPDATE whaleu_community.rating_target_definition_bindings SET digest=digest WHERE false',
          );
          void writing.catch(() => undefined);
          await waitForAdvisoryWriter(f, pid);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_community.rating_target_definition_bindings'::regclass AND mode='RowExclusiveLock' AND granted",
                [pid],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM pg_locks WHERE pid=$1 AND mode='RowExclusiveLock' AND granted
          AND relation IN ('whaleu_ratings.random_pool_epoch'::regclass,
            'whaleu_ratings.navigation_epoch'::regclass,
            'whaleu_community.rating_review_binding_epoch'::regclass)`,
                [pid],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(await epochs(f), before);
          b.release();
          const result = await reading;
          assert.equal(result.status, 503, JSON.stringify(result.body));
          assert.equal(result.body.error?.code, 'CONTENT_REVIEW_UNAVAILABLE');
          assert.equal(result.body.item, undefined);
          assert.equal(result.body.candidateCount, undefined);
          assert.deepEqual(trace, { paths: 5, reviews: 5 });
          // The pre-sample comparison is complete; the later mandatory proof must
          // still withhold the HTTP result when the writer conflicts with its fence.
          assert.deepEqual(requested, [size]);
          await writing;
          await holder.query('COMMIT');
          const after = await epochs(f);
          assert.equal(after.pool, before.pool);
          assert.equal(after.navigation, before.navigation);
          assert.equal(BigInt(after.binding), BigInt(before.binding) + 1n);
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT to_jsonb(b) row FROM whaleu_community.rating_target_definition_bindings b ORDER BY target_id,content_version',
              )
            ).rows,
            bindingsBefore,
          );
        } finally {
          pause = null;
          b.release();
          await reading?.catch(() => undefined);
          await writing?.catch(() => undefined);
          await holder.query('ROLLBACK');
          holder.release();
        }
        assertComplete(await sample(), tailEdit);
      },
    );

    await t.test(
      'a canonical HTTP edit queues behind the mixed scan and creates its new binding only afterward',
      async () => {
        const target = penultimate;
        const current = await f.editContext(owner, target.id);
        const input = f.editIntent(current, {
          name: 'Queued final-batch v3 definition',
          description:
            'Published only after the complete mixed scan releases Safety',
        });
        const prepared = await f.prepareEdit(owner, input);
        const approval = await f.approveEdit(owner, input);
        const before = await epochs(f),
          b = barrier();
        let reading: Promise<request.Response> | undefined,
          editing: Promise<request.Response> | undefined;
        try {
          pause = b;
          reading = sample().then((response) => response);
          void reading.catch(() => undefined);
          await atBarrier(b.reached);
          editing = f
            .commitEdit(owner, input, prepared.contextRevision)
            .then((response) => response);
          void editing.catch(() => undefined);
          await f.waitForLock(
            "pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1'",
          );
          assert.deepEqual(await epochs(f), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE decision_id=$1',
                [approval.decisionId],
              )
            ).rowCount,
            0,
          );
          b.release();
          const result = await reading;
          assertComplete(result, tailEdit);
          const committed = await editing;
          assert.equal(committed.status, 200, JSON.stringify(committed.body));
          assert.equal(
            committed.body.outcome,
            'applied',
            JSON.stringify(committed.body),
          );
          assert.equal(committed.body.contentVersion, 3);
          assert.equal(
            committed.body.definitionRevision,
            prepared.definitionRevision,
          );
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_community.rating_target_definition_bindings
          WHERE target_id=$1 AND content_version=3 AND definition_revision=$2 AND decision_id=$3`,
                [target.id, prepared.definitionRevision, approval.decisionId],
              )
            ).rowCount,
            1,
          );
          const after = await epochs(f);
          assert.ok(BigInt(after.pool) > BigInt(before.pool));
          assert.ok(BigInt(after.navigation) > BigInt(before.navigation));
          assert.ok(BigInt(after.binding) > BigInt(before.binding));
        } finally {
          pause = null;
          b.release();
          await Promise.allSettled(
            [reading, editing].filter((operation) => operation !== undefined),
          );
        }
        // Select the just-edited candidate through the same final-batch entropy
        // seam, retaining all 529 candidates and the ordinary canonical re-read.
        draw.index = (maximum) => {
          requested.push(maximum);
          return maximum - 2;
        };
        const fresh = await sample();
        assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
        assert.equal(fresh.body.candidateCount, size);
        assert.deepEqual(trace, { paths: 5, reviews: 5 });
        assert.deepEqual(requested, [size]);
        assert.equal(fresh.body.item.target.id, target.id);
        assert.equal(fresh.body.item.target.name, input.name);
        assert.equal(fresh.body.item.target.description, input.description);
        assert.equal(fresh.body.item.target.revision, prepared.revision);
      },
    );
  },
);
