/** Encoding-only optimization: no original verifier or mutable proof is cached. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';

const plan = () => ({
  version: 1,
  accountId: 'actor',
  requestId: 'request',
  intentHash: 'hash',
  operation: 'create_categories_scoped',
  sourceIssues: [
    {
      id: 'source',
      revision: 'revision',
      kind: 'scoped_category_base',
      key: 'category',
      scopeKeys: ['global'],
      payload: { content: ['中文', null, true, { z: 0, a: '"\\\n' }] },
      previousSourceId: null,
      previousSourceRevision: null,
    },
  ],
  envelopes: [{ body: { description: '\t\n\r\b\f 中文 👩🏽‍💻' } }],
  categoryIds: ['category'],
  affectedScopeKeys: ['global'],
  globalRequired: true,
  beforeHeads: [
    { scopeKey: 'global', catalogRevision: 'catalog', headRevision: 'head' },
  ],
  beforeCompatHeads: [
    {
      compatKey: 'global_compat',
      versionId: 'version',
      legacyCatalogId: null,
      scopeKeys: ['global'],
    },
  ],
  beforeBaseAvailability: [
    { sourceId: 'source', sourceRevision: 'revision', current: true },
  ],
  beforeVector: [
    {
      id: 'source',
      revision: 'revision',
      kind: 'kind',
      key: 'key',
      digest: 'd',
    },
  ],
  beforeDigest: 'before',
  policySourceId: 'policy',
  policySourceRevision: 'policy-revision',
  registrySourceIds: [],
  changes: [
    {
      categoryId: 'category',
      scopeKeys: ['global'],
      field: 'create',
      before: null,
      after: '{}',
      beforeStatus: 'absent',
      afterStatus: 'available',
    },
  ],
  affectedTargetCount: 0,
  previewDigest: '',
  validUntil: '2026-01-01T00:00:00.000Z',
  noop: false,
});
const body = () => ({
  categories: [
    {
      id: 'category',
      parentId: null,
      level: 1,
      kind: 'general',
      systemKey: null,
      originKind: 'global',
      name: '中文 👩🏽‍💻',
      description: '\t\n\r\b\f "\\',
      active: true,
      hidden: false,
      ordinal: '0',
    },
  ],
  memberships: [
    { targetId: 'second', categoryId: 'category', ordinal: '10' },
    { targetId: 'first', categoryId: 'category', ordinal: '2' },
  ],
});

test(
  '0095 preserves every original proof and compares complete canonical UTF-8 bytes, including fallback shapes',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture(94);
    t.after(() => f.close());
    const functions = async () =>
      (
        await f.pool.query<{
          oid: number;
          name: string;
          definition: string;
          acl: string | null;
        }>(
          `SELECT p.oid,p.proname name,pg_get_functiondef(p.oid) definition,p.proacl::text acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname LIKE 'whaleu_%' ORDER BY p.oid`,
        )
      ).rows;
    const triggers = async () =>
      (
        await f.pool.query(`SELECT t.oid,pg_get_triggerdef(t.oid) definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname LIKE 'whaleu_%' ORDER BY t.oid`)
      ).rows;
    const beforeFunctions = await functions(),
      beforeTriggers = await triggers();
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    await runMigrations(
      f.pool,
      migrations.filter((m) => Number(m.name.slice(0, 4)) <= 95),
      { mode: 'up' },
    );
    await f.restartApp(95);
    const afterFunctions = new Map(
      (await functions()).map((row) => [row.oid, row]),
    );
    for (const before of beforeFunctions) {
      const after = afterFunctions.get(before.oid);
      assert.ok(
        after,
        'Original function OIDs must survive the forward migration',
      );
      if (before.name === 'scoped_digest') {
        assert.equal(after.acl, before.acl);
        continue;
      }
      assert.deepEqual(
        after,
        before,
        `The original ${before.name} proof/codec must remain byte-identical`,
      );
    }
    assert.deepEqual(await triggers(), beforeTriggers);
    assert.equal(
      (await f.pool.query('SHOW statement_timeout')).rows[0]!.statement_timeout,
      '15s',
    );

    const strings = [
      '',
      '\t\n\r\b\f',
      '中文 👩🏽‍💻 𝄞',
      '\u00a0\u2003\u2028\u2029',
      '"',
      '\\',
      'a : [ { , } ] b',
    ];
    for (let n = 0; n < 16; n++)
      strings.push('\\'.repeat(n) + '" \t suffix ' + '\\'.repeat(n + 1));
    const raw = [
      'null',
      'true',
      'false',
      '0',
      '-0',
      '-0.000',
      '1.00',
      '1e-100',
      '1.2300e+20',
      '1000000000000000000000000000000',
      '[]',
      '{}',
    ];
    for (const value of strings) {
      raw.push(
        JSON.stringify(value),
        JSON.stringify({ [value]: [value, { aa: value, a: null, z: true }] }),
      );
    }
    for (const length of [32767, 32768, 65535, 65536])
      raw.push(JSON.stringify('中\\"\n'.repeat(Math.floor(length / 4))));
    let seed = 0x4c319500;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const randomValue = (depth: number): unknown => {
      switch (random() % (depth ? 6 : 4)) {
        case 0:
          return null;
        case 1:
          return random() % 2 === 0;
        case 2:
          return (random() - 0x80000000) / 1000;
        case 3:
          return strings[random() % strings.length];
        case 4:
          return Array.from({ length: random() % 4 }, () =>
            randomValue(depth - 1),
          );
        default:
          return Object.fromEntries(
            Array.from({ length: random() % 4 }, (_, n) => [
              String(n) + strings[random() % strings.length],
              randomValue(depth - 1),
            ]),
          );
      }
    };
    for (let n = 0; n < 256; n++) raw.push(JSON.stringify(randomValue(8)));
    const lexical = await f.pool.query(
      `SELECT ordinal FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY input(raw,ordinal)
    WHERE convert_to(whaleu_ratings.category_digest_canonical_json(raw::jsonb),'UTF8')
      IS DISTINCT FROM convert_to(whaleu_ratings.creation_canonical_json(raw::jsonb),'UTF8')`,
      [JSON.stringify(raw)],
    );
    assert.deepEqual(
      lexical.rows,
      [],
      'Compare every byte, not just a digest or octet count',
    );
    assert.deepEqual(
      (
        await f.pool
          .query(`SELECT whaleu_ratings.category_digest_canonical_json(NULL) canonical,
    whaleu_ratings.category_digest_fast_canonical('compat-body',NULL) fast,
    whaleu_ratings.scoped_digest('compat-body',NULL) digest`)
      ).rows[0],
      { canonical: null, fast: null, digest: null },
    );

    const cases: { domain: string; value: unknown; fast: boolean }[] = [
      { domain: 'compat-body', value: body(), fast: true },
      {
        domain: 'compat-body',
        value: { categories: [], memberships: [] },
        fast: true,
      },
      { domain: 'category-plan', value: plan(), fast: true },
      {
        domain: 'category-plan',
        value: { ...plan(), sourceIssues: [], envelopes: [], changes: [] },
        fast: true,
      },
      {
        domain: 'category-plan',
        value: {
          ...plan(),
          sourceIssues: [
            {
              ...plan().sourceIssues[0],
              placement: {
                revision: 'r',
                categoryId: 'c',
                baseSourceId: 's',
                baseSourceRevision: 'r',
              },
            },
          ],
        },
        fast: true,
      },
    ];
    for (const domain of ['compat-body', 'category-plan']) {
      for (const value of [
        null,
        true,
        1,
        'text',
        [],
        {},
        { categories: [], memberships: null },
      ])
        cases.push({ domain, value, fast: false });
    }
    for (const [domain, original] of [
      ['compat-body', body()],
      ['category-plan', plan()],
    ] as const) {
      for (const key of Object.keys(original)) {
        const missing: Record<string, unknown> = { ...original };
        delete missing[key];
        cases.push({ domain, value: missing, fast: false });
      }
      cases.push({
        domain,
        value: { ...original, unknown: true },
        fast: false,
      });
    }
    for (const changed of [
      { ...body(), memberships: [{ ...body().memberships[0], unknown: true }] },
      {
        ...body(),
        memberships: [{ targetId: 't', categoryId: 'c', ordinal: 1 }],
      },
      { ...body(), categories: [{ ...body().categories[0], unknown: true }] },
      { ...body(), categories: [{ ...body().categories[0], active: null }] },
      { ...body(), categories: [null] },
    ])
      cases.push({ domain: 'compat-body', value: changed, fast: false });
    for (const changed of [
      { ...plan(), version: 2 },
      {
        ...plan(),
        sourceIssues: [{ ...plan().sourceIssues[0], unknown: true }],
      },
      {
        ...plan(),
        sourceIssues: [{ ...plan().sourceIssues[0], placement: {} }],
      },
      {
        ...plan(),
        sourceIssues: [{ ...plan().sourceIssues[0], payload: null }],
      },
      {
        ...plan(),
        beforeVector: [{ ...plan().beforeVector[0], unknown: true }],
      },
      { ...plan(), beforeHeads: [null] },
      {
        ...plan(),
        beforeCompatHeads: [
          { ...plan().beforeCompatHeads[0], scopeKeys: [null] },
        ],
      },
      { ...plan(), changes: [{ ...plan().changes[0], unknown: true }] },
      { ...plan(), envelopes: [null] },
      { ...plan(), categoryIds: [1] },
    ])
      cases.push({ domain: 'category-plan', value: changed, fast: false });
    for (const domain of [
      'vector',
      'category-before',
      'category-issuance',
      'source',
      'unknown-domain',
    ])
      cases.push({ domain, value: body(), fast: false });
    for (const item of cases) {
      const row = (
        await f.pool.query<{
          fast: string | null;
          original: string;
          same_bytes: boolean;
          same_hash: boolean;
        }>(
          `WITH input AS (
      SELECT $1::text domain,$2::jsonb value
    ), encodings AS (
      SELECT *,whaleu_ratings.category_digest_fast_canonical(domain,value) fast,
        whaleu_ratings.creation_canonical_json(value) original FROM input
    ) SELECT fast,original,convert_to(coalesce(fast,original),'UTF8')=convert_to(original,'UTF8') same_bytes,
      whaleu_ratings.scoped_digest(domain,value)=encode(sha256(convert_to('whaleu:rating-scoped-'||domain||':v1'||chr(10)||original,'UTF8')),'hex') same_hash
    FROM encodings`,
          [item.domain, JSON.stringify(item.value)],
        )
      ).rows[0]!;
      assert.equal(row.fast !== null, item.fast, JSON.stringify(item));
      assert.equal(row.same_bytes, true, JSON.stringify(item));
      assert.equal(row.same_hash, true, JSON.stringify(item));
    }
    // Raw numeric lexemes and duplicate keys survive PostgreSQL's own JSONB
    // normalization exactly, including inside explicitly opaque plan payloads.
    for (const literal of ['-0.000', '1.00', '1e-100', '1.2300e+20']) {
      const rawPlan = JSON.stringify(plan()).replace(
        '"payload":{',
        `"payload":{"number":${literal},"duplicate":0,"duplicate":1,`,
      );
      const row = (
        await f.pool.query(
          `SELECT
      convert_to(whaleu_ratings.category_digest_fast_canonical('category-plan',$1::jsonb),'UTF8')
      =convert_to(whaleu_ratings.creation_canonical_json($1::jsonb),'UTF8') exact`,
          [rawPlan],
        )
      ).rows[0]!;
      assert.equal(row.exact, true);
    }
  },
);
