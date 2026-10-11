import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

test(
  'C1 final budget counts exact original canonical UTF-8 octets without changing any hash codec',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const texts = [
      'null',
      'true',
      'false',
      '0',
      '-0',
      '-0.000',
      '1e-100',
      '1.2300e+20',
      '1000000000000000000000000000000',
      '[]',
      '{}',
    ];
    const strings = [
      '',
      ' ',
      '\t\n\r\b\f',
      '中文 👩🏽‍💻 𝄞',
      '\u00a0\u2003\u2028\u2029',
      'a : [ { , } ] b',
      '"',
      '\\',
      '\\" quoted whitespace \\"',
    ];
    for (let n = 0; n < 16; n++)
      strings.push('\\'.repeat(n) + '" \t suffix ' + '\\'.repeat(n + 1));
    for (const value of strings) {
      texts.push(JSON.stringify(value));
      texts.push(
        JSON.stringify({ [value]: [value, { ' z\n"\\ ': value }], a: null }),
      );
    }
    let seed = 0x4c31504f;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const value = (depth: number): unknown => {
      const choice = random() % (depth ? 6 : 4);
      if (choice === 0) return null;
      if (choice === 1) return random() % 2 === 0;
      if (choice === 2) return (random() - 0x80000000) / 1000;
      if (choice === 3) return strings[random() % strings.length];
      if (choice === 4)
        return Array.from({ length: random() % 4 }, () => value(depth - 1));
      return Object.fromEntries(
        Array.from({ length: random() % 4 }, (_, index) => [
          String(index) + strings[random() % strings.length],
          value(depth - 1),
        ]),
      );
    };
    for (let index = 0; index < 256; index++)
      texts.push(JSON.stringify(value(8)));
    const differences = await f.pool.query(
      `SELECT ord FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY e(raw,ord)
    WHERE whaleu_ratings.category_icon_canonical_octets(raw::jsonb)
      IS DISTINCT FROM octet_length(whaleu_ratings.creation_canonical_json(raw::jsonb))::bigint
    OR whaleu_ratings.category_icon_canonical_octets(raw::jsonb)
      IS DISTINCT FROM octet_length(whaleu_community.content_canonical_json(raw::jsonb))::bigint`,
      [JSON.stringify(texts)],
    );
    assert.equal(differences.rowCount, 0, JSON.stringify(differences.rows));

    // Raw SQL metadata sums exactly straddle the unchanged 64 MiB boundary.
    // Each token is bounded to 64 KiB; no giant HTTP payload or budget exemption.
    // Escaped and multibyte tokens above separately prove lexical correctness.
    const boundaries = (
      await f.pool.query<{
        delta: number;
        fast: string;
        original: string;
        rejected: boolean;
      }>(`WITH bytes AS MATERIALIZED (
    SELECT delta,ordinal,to_jsonb(repeat('x',65534+CASE WHEN ordinal=1024 THEN delta ELSE 0 END)) value
    FROM generate_series(-1,1) delta CROSS JOIN generate_series(1,1024) ordinal
  ), totals AS (
    SELECT delta,sum(whaleu_ratings.category_icon_canonical_octets(value)) fast,
      sum(octet_length(whaleu_ratings.creation_canonical_json(value))) original
    FROM bytes GROUP BY delta
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
    const definition = (
      await f.pool.query<{ body: string }>(
        `SELECT pg_get_functiondef('whaleu_ratings.verify_category_icon_release(uuid)'::regprocedure) body`,
      )
    ).rows[0]!.body;
    assert.match(
      definition,
      /original_bytes\+m\.serialized_bytes\+review_bytes>67108864/,
    );
    assert.match(definition, /category_icon_canonical_octets\(to_jsonb\(x\)\)/);
    assert.match(definition, /category_icon_canonical_octets\(to_jsonb\(b\)\)/);
  },
);
