import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { HotScoreEvaluator } from '../../src/community/hot-score/evaluator.js';
import { hotScoreFixture } from '../support/hot-score-fixture.js';

type Inputs = Parameters<HotScoreEvaluator['evaluate']>[0];
const zero: Inputs = {
  views: '0',
  postLikes: '0',
  subscriptions: '0',
  rawRootComments: '0',
  rawReplies: '0',
  eligibleComments: '0',
  uniqueEligibleAccounts: '0',
};
const max = '9223372036854775807';
/** Wider-scale PostgreSQL regression calculation with exp(ln(v)*2/5), not
 * the implementation's power expression. This is not a PHP oracle or a proof
 * of correctly-rounded transcendental arithmetic for every real input. */
async function widerScale(input: Inputs, tx: PoolClient) {
  const row = (
    await tx.query<{ score: string; unrounded: string }>(
      `
    WITH x AS (SELECT $1::numeric(250,180) v,$2::numeric(250,180) l,$3::numeric(250,180) s,$4::numeric(250,180) c,$5::numeric(250,180) a),
    y AS (SELECT (CASE WHEN v=0 THEN 0::numeric ELSE 7.6::numeric*exp(ln(v)*2::numeric/5::numeric) END)
       +24::numeric*ln(1::numeric+l)
       +greatest(least(1::numeric,sqrt(v/200::numeric)),least(1::numeric,sqrt(l/10::numeric)))
       *(10::numeric*ln(1::numeric+least(c,a*3::numeric))+2::numeric*ln(1::numeric+s)) AS n FROM x)
    SELECT round(n,4)::numeric(24,4)::text score,n::text unrounded FROM y`,
      [
        input.views,
        input.postLikes,
        input.subscriptions,
        input.eligibleComments,
        input.uniqueEligibleAccounts,
      ],
    )
  ).rows[0]!;
  return row;
}

test(
  'internal score numeric: PostgreSQL 18 profile, full bigint range, support/cap/ln and final-only rounding',
  { timeout: 120000 },
  async (t) => {
    const f = await hotScoreFixture();
    const tx = await f.pool.connect();
    try {
      assert.equal(
        (await tx.query("SELECT current_setting('server_version_num') version"))
          .rows[0]!.version,
        '180006',
      );
      const evaluate = (input: Partial<Inputs>) =>
        f.evaluator.evaluate({ ...zero, ...input }, tx);
      await t.test(
        'closed-form exact zeros and positive view powers have fixed four decimals',
        async () => {
          for (const [views, expected] of [
            ['0', '0.0000'],
            ['1', '7.6000'],
            ['32', '30.4000'],
            ['243', '68.4000'],
            ['100000', '760.0000'],
          ] as const)
            assert.equal(await evaluate({ views }), expected);
          assert.equal(await evaluate({ postLikes: '1' }), '16.6355');
          assert.equal(
            await evaluate({ postLikes: '9' }),
            '55.2620',
            'Natural logarithm, not log base 10',
          );
          assert.equal(
            await evaluate({
              subscriptions: max,
              rawRootComments: max,
              eligibleComments: max,
              uniqueEligibleAccounts: max,
            }),
            '0.0000',
            'Comments and subscriptions alone have no support',
          );
        },
      );
      await t.test(
        'threshold edges and aggregate cap agree with a wider-scale numeric regression',
        async () => {
          const cases: Inputs[] = [];
          for (const views of ['0', '1', '199', '200', '201'])
            for (const postLikes of ['0', '1', '9', '10', '11'])
              cases.push({
                ...zero,
                views,
                postLikes,
                subscriptions: '11',
                rawRootComments: '11',
                eligibleComments: '11',
                uniqueEligibleAccounts: '2',
              });
          cases.push({
            ...zero,
            views: '200',
            rawRootComments: '11',
            eligibleComments: '11',
            uniqueEligibleAccounts: '2',
          });
          for (const input of cases) {
            const actual = await f.evaluator.evaluate(input, tx);
            assert.equal(
              actual,
              (await widerScale(input, tx)).score,
              JSON.stringify(input),
            );
            assert.match(actual, /^(0|[1-9]\d*)\.\d{4}$/);
          }
          const capped = await evaluate({
            views: '200',
            rawRootComments: '11',
            eligibleComments: '11',
            uniqueEligibleAccounts: '2',
          });
          assert.equal(
            capped,
            await evaluate({
              views: '200',
              rawRootComments: '6',
              eligibleComments: '6',
              uniqueEligibleAccounts: '2',
            }),
          );
          assert.notEqual(
            capped,
            await evaluate({
              views: '200',
              rawRootComments: '4',
              eligibleComments: '4',
              uniqueEligibleAccounts: '2',
            }),
            '10+1 contributions by two actors cap at six, not four',
          );
        },
      );
      await t.test(
        'full signed-bigint inputs cast before sum, cap multiplication and 1+count',
        async () => {
          const vectors: Inputs[] = [
            {
              views: max,
              postLikes: max,
              subscriptions: max,
              rawRootComments: max,
              rawReplies: max,
              eligibleComments: max,
              uniqueEligibleAccounts: max,
            },
            {
              ...zero,
              views: '9007199254740993',
              postLikes: '9007199254740993',
              subscriptions: '9007199254740993',
              rawRootComments: max,
              rawReplies: max,
              eligibleComments: max,
              uniqueEligibleAccounts: '3074457345618258603',
            },
            {
              ...zero,
              views: max,
              rawRootComments: max,
              rawReplies: max,
              eligibleComments: max,
              uniqueEligibleAccounts: '1',
            },
          ];
          for (const input of vectors) {
            const actual = await f.evaluator.evaluate(input, tx);
            assert.equal(actual, (await widerScale(input, tx)).score);
            assert.match(actual, /^[1-9]\d*\.\d{4}$/);
          }
        },
      );
      await t.test(
        'malformed, missing, negative, over-range and inconsistent raw counts fail closed',
        async () => {
          for (const key of Object.keys(zero) as (keyof Inputs)[])
            for (const value of [
              '',
              '-1',
              '01',
              '+1',
              '1.0',
              '1e2',
              'NaN',
              'Infinity',
              '9223372036854775808',
              null,
              undefined,
              1,
            ]) {
              await assert.rejects(
                f.evaluator.evaluate({ ...zero, [key]: value } as Inputs, tx),
                `${key}=${String(value)}`,
              );
            }
          for (const input of [
            { eligibleComments: '1' },
            {
              rawRootComments: '1',
              eligibleComments: '1',
              uniqueEligibleAccounts: '2',
            },
            { rawRootComments: '2', rawReplies: '2', eligibleComments: '5' },
          ])
            await assert.rejects(evaluate(input));
        },
      );
      await t.test(
        'rounding policy and near half-boundary formula vectors are explicit',
        async () => {
          assert.deepEqual(
            (
              await tx.query(
                'SELECT round(1.234449999999999999999::numeric,4)::text a,round(1.23445::numeric,4)::text b,round(1.234450000000000000001::numeric,4)::text c',
              )
            ).rows[0],
            { a: '1.2344', b: '1.2345', c: '1.2345' },
          );
          // Select deterministic views-only vectors just below and above the final
          // 4-decimal half boundary using DB numeric, never JS float predicates.
          const near = (
            await tx.query<{ views: string }>(
              `WITH s AS (SELECT n,7.6::numeric*power(n::numeric(80,40),0.4::numeric(80,40))*10000 AS x FROM generate_series(1,20000) n), ranked AS (SELECT n,abs(x-trunc(x)-0.5) d,CASE WHEN x-trunc(x)<0.5 THEN 0 ELSE 1 END side FROM s) SELECT n::text views FROM (SELECT *,row_number() OVER(PARTITION BY side ORDER BY d,n) r FROM ranked) q WHERE r<=4 ORDER BY side,r`,
            )
          ).rows;
          assert.equal(near.length, 8);
          for (const { views } of near) {
            const input = { ...zero, views };
            assert.equal(
              await evaluate({ views }),
              (await widerScale(input, tx)).score,
              `near-boundary views=${views}`,
            );
          }
        },
      );
    } finally {
      tx.release();
      await f.close();
    }
  },
);
