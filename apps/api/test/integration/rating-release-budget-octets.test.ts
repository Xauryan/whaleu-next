/** The original whole-release proof changes one exact length expression only. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';

test(
  '0096 preserves every original function and trigger except its exact whole-release UTF-8 length expression',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(95);
    t.after(() => f.close());
    const snapshot = async () => ({
      functions: (
        await f.pool.query<{
          oid: number;
          name: string;
          definition: string;
          acl: string | null;
        }>(
          `SELECT p.oid,n.nspname||'.'||p.proname name,pg_get_functiondef(p.oid) definition,p.proacl::text acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname LIKE 'whaleu_%' ORDER BY p.oid`,
        )
      ).rows,
      triggers: (
        await f.pool.query(`SELECT t.oid,pg_get_triggerdef(t.oid) definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname LIKE 'whaleu_%' ORDER BY t.oid`)
      ).rows,
    });
    const before = await snapshot();
    const needle =
      'octet_length(whaleu_ratings.creation_canonical_json(to_jsonb(x)))';
    const replacement =
      'whaleu_ratings.category_icon_canonical_octets(to_jsonb(x))';
    const old = before.functions.find(
      (f) => f.name === 'whaleu_ratings.verify_scoped_release',
    );
    assert.ok(old);
    assert.equal(old.definition.split(needle).length, 2);
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    await runMigrations(
      f.pool,
      migrations.filter((m) => Number(m.name.slice(0, 4)) <= 96),
      { mode: 'up' },
    );
    await f.restartApp(96);
    const expected = {
      ...before,
      functions: before.functions.map((f) =>
        f === old
          ? { ...f, definition: f.definition.replace(needle, replacement) }
          : f,
      ),
    };
    assert.deepEqual(
      await snapshot(),
      expected,
      'No other function byte, OID, ACL, verifier call, row-set branch or trigger may change',
    );
    assert.match(
      old.definition,
      /nodes>100000 OR members>100000 OR bytes>67108864/,
    );

    // Exercise the original to_jsonb(x) wrapper, including field names and nested
    // empty/nonempty containers. Scalar spelling remains PostgreSQL JSONB's own.
    const samples = [
      'null',
      'true',
      'false',
      '0',
      '-0',
      '-0.000',
      '1.2300e+20',
      '1e-100',
      '1000000000000000000000000000000',
      '[]',
      '{}',
      JSON.stringify({
        name: '中文 👩🏽‍💻 𝄞',
        description: '\t\n\r\b\f "\\',
        scopeKeys: ['global', null],
        payload: { z: [], a: {} },
      }),
      JSON.stringify({
        value: {
          ' a\\"\n ': ['\\'.repeat(32) + '"', '\u00a0\u2003\u2028\u2029', null],
          timestamp: '2026-10-11T10:00:00.000Z',
        },
      }),
    ];
    const differences = await f.pool.query(
      `WITH inputs AS (
      SELECT ordinal,raw::jsonb value FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY input(raw,ordinal)
    ) SELECT ordinal FROM inputs x WHERE
      whaleu_ratings.category_icon_canonical_octets(to_jsonb(x))
      IS DISTINCT FROM octet_length(convert_to(whaleu_ratings.creation_canonical_json(to_jsonb(x)),'UTF8'))::bigint`,
      [JSON.stringify(samples)],
    );
    assert.deepEqual(differences.rows, []);
    // Original 64 MiB ± 1 acceptance remains unchanged, and the wrapper itself
    // must be counted: {"value": <scalar>} has ten non-scalar ASCII bytes.
    const boundaries = (
      await f.pool.query(`WITH rows AS (
      SELECT delta,ordinal,to_jsonb(repeat('x',65524+CASE WHEN ordinal=1024 THEN delta ELSE 0 END)) value
      FROM generate_series(-1,1) delta CROSS JOIN generate_series(1,1024) ordinal
    ), encoded AS (
      SELECT delta,jsonb_build_object('value',value) value FROM rows
    ), totals AS (
      SELECT delta,sum(whaleu_ratings.category_icon_canonical_octets(value)) fast,
        sum(octet_length(convert_to(whaleu_ratings.creation_canonical_json(value),'UTF8'))) original
      FROM encoded GROUP BY delta
    ) SELECT delta,fast::text,original::text,fast>67108864 rejected FROM totals ORDER BY delta`)
    ).rows;
    assert.deepEqual(
      boundaries,
      [-1, 0, 1].map((delta) => ({
        delta,
        fast: String(67108864 + delta),
        original: String(67108864 + delta),
        rejected: delta > 0,
      })),
    );
  },
);
