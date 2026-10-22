import {
  inventory,
  relationSql,
} from '../../src/account-deletion/owners/preflight.js';
import {
  deletionMetadataRelations,
  reviewedRelations,
  supportedTables,
} from '../../src/account-deletion/owner-registry.js';
import { DeletionError } from '../../src/account-deletion/contracts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  canonicalEnvelope,
  canonicalJson,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import { prepareTextSource } from '../../src/community/text-source/source.js';
import {
  appendTextSource,
  textSourceIntentHash,
} from '../../src/community/text-source/protocol.js';
import { withReviewedTextSource } from '../../src/community/text-source/publication.js';
import type { TextSourceDescriptor } from '../../src/community/text-source/contracts.js';
import type { EffectiveContentEnvelopeV1 } from '../../src/community/content-review/contracts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Capture all installed application rows, not only the source-owner count.
 * Catalog names and ownership/grants are retained, including protected schemas. */
async function sourceOwnerState(pool: Pool) {
  const schemas = (
    await pool.query<{ name: string; owner: number; acl: string | null }>(
      "SELECT nspname name,nspowner owner,nspacl::text acl FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY nspname COLLATE \"C\"",
    )
  ).rows;
  const relations = (
    await pool.query<{
      relation: string;
      kind: string;
      owner: number;
      acl: string | null;
    }>(
      "SELECT n.nspname||'.'||c.relname relation,c.relkind kind,c.relowner owner,c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND c.relkind IN('r','p','m','f') ORDER BY (n.nspname||'.'||c.relname) COLLATE \"C\"",
    )
  ).rows;
  const rows: Record<string, string[]> = {};
  for (const { relation, kind } of relations) {
    assert.ok(['r', 'p'].includes(kind));
    rows[relation] = (
      await pool.query<{ raw: string }>(
        `SELECT to_jsonb(t)::text raw FROM ${relationSql(relation)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows.map(({ raw }) => raw);
  }
  return { schemas, relations, rows };
}

/** Future central PG gate: actual SQL, no mock evaluator. This file is drafted,
 * not execution evidence. The companion HTTP suite owns real publication flows. */
test(
  '0175 upgrade preserves legacy bytes, independently validates source hashes and ordered intents',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const pool = new Pool(
      poolOptions(
        loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: database,
          PG_SSL_MODE: 'disable',
          LOG_LEVEL: 'silent',
        }),
      ),
    );
    let suite: PoolClient | undefined,
      locked = false,
      owns = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const fresh = migrations.find(
        (m) => m.name === '0175_community_text_sources.sql',
      );
      assert.ok(fresh);
      assert.deepEqual(
        migrations.filter((m) => m.name.startsWith('0174_')).map((m) => m.name),
        ['0174_account_deletion_inventory_collation.sql'],
        'The published c27 inventory qualification must precede M1',
      );
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0175_'),
        { mode: 'up' },
      );
      const before = (
        await pool.query(
          'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
        )
      ).rows;
      const legacy = JSON.parse(
        readFileSync(
          new URL(
            '../fixtures/text-source-legacy-goldens.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { envelope: unknown; canonical: string; digest: string }[];
      const queryLegacy = async () => {
        const results = [];
        for (const fixture of legacy)
          results.push(
            (
              await pool.query(
                `SELECT whaleu_community.content_canonical_json($1::jsonb) canonical,
        encode(sha256(convert_to('whaleu-content-approval:v'||($1::jsonb->>'version')||chr(10)||whaleu_community.content_canonical_json($1::jsonb),'UTF8')),'hex') digest`,
                [JSON.stringify(fixture.envelope)],
              )
            ).rows[0],
          );
        return results;
      };
      const beforeLegacy = await queryLegacy();
      // Preserve the genuine M1 owner boundary before installing later owners.
      // Use the ordinary checksum/prefix-verified runner, never hide namespaces.
      const sourcePrefix = migrations.filter(
        (m) => Number(m.name.slice(0, 4)) <= 175,
      );
      assert.equal(sourcePrefix.at(-1)?.name, fresh.name);
      await runMigrations(pool, sourcePrefix, { mode: 'up' });
      await t.test(
        'historical 0175 empty source owner exceeds the exact reviewed inventory bound',
        async () => {
          assert.deepEqual(
            (
              await pool.query<{ name: string; checksum: string }>(
                'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
              )
            ).rows,
            sourcePrefix.map(({ name, checksum }) => ({ name, checksum })),
          );
          assert.deepEqual(await queryLegacy(), beforeLegacy);
          const before = await sourceOwnerState(pool);
          assert.deepEqual(
            before.schemas.map(({ name }) => name),
            [
              ...new Set([
                ...[...reviewedRelations].map((name) => name.split('.')[0]),
                'whaleu_account_deletion',
                'whaleu_meta',
              ]),
            ].sort(),
          );
          assert.deepEqual(
            before.relations.map(({ relation }) => relation),
            [
              ...reviewedRelations,
              ...deletionMetadataRelations,
              'whaleu_community.community_text_sources',
            ].sort(),
          );
          assert.equal(
            reviewedRelations.has('whaleu_community.community_text_sources'),
            false,
          );
          assert.equal(
            supportedTables.has('whaleu_community.community_text_sources'),
            false,
          );
          assert.deepEqual(
            before.rows['whaleu_community.community_text_sources'],
            [],
          );
          // One new unreviewed source relation exceeds the registry bound;
          // the later UNREGISTERED_OWNER_RELATION branch is not reached.
          await assert.rejects(
            inTransaction(pool, (tx) => inventory(tx)),
            (error: unknown) =>
              error instanceof DeletionError &&
              error.code === 'INVENTORY_BOUND_EXCEEDED',
          );
          assert.deepEqual(await sourceOwnerState(pool), before);
        },
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      // Require the complete ordered 0182 predecessor prefix, not a latest-version pin.
      // Later checked-in migrations remain part of the full ledger below.
      const requiredCurrentPrefix = migrations.slice(0, 182);
      assert.deepEqual(
        requiredCurrentPrefix.map(({ name }) => name.slice(0, 4)),
        Array.from({ length: 182 }, (_, index) =>
          String(index + 1).padStart(4, '0'),
        ),
      );
      assert.equal(
        requiredCurrentPrefix.at(-1)?.name,
        '0182_real_deletion_request_authority.sql',
      );
      assert.deepEqual(
        (
          await pool.query<{ name: string; checksum: string }>(
            'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
          )
        ).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT name,checksum FROM whaleu_meta.schema_migrations WHERE name<'0175_' ORDER BY name",
          )
        ).rows,
        before,
      );
      assert.deepEqual(await queryLegacy(), beforeLegacy);
      assert.deepEqual(
        beforeLegacy,
        legacy.map((f) => ({ canonical: f.canonical, digest: f.digest })),
      );
      const counts = (
        await pool.query(`SELECT whaleu_community.admin_post_removal_inventory_current() post,
      whaleu_community.admin_discussion_removal_inventory_current() discussion,
      (SELECT count(*)::integer FROM whaleu_community.content_approval_policies WHERE policy_key='local-text-source-v1') policies,
      (SELECT count(*)::integer FROM whaleu_community.community_text_sources) sources`)
      ).rows[0];
      assert.deepEqual(counts, {
        post: true,
        discussion: true,
        policies: 0,
        sources: 0,
      });
      await t.test(
        'current chain namespace gate denies erasure with an empty source owner unchanged',
        async () => {
          const before = await sourceOwnerState(pool);
          const knownSchemas = new Set(
            [...reviewedRelations].map((name) => name.split('.')[0]),
          );
          assert.deepEqual(
            before.schemas
              .map(({ name }) => name)
              .filter(
                (name) =>
                  !knownSchemas.has(name) &&
                  !['whaleu_account_deletion', 'whaleu_meta'].includes(name),
              ),
            ['whaleu_real_deletion', 'whaleu_real_deletion_admission'],
          );
          assert.equal(
            reviewedRelations.has('whaleu_community.community_text_sources'),
            false,
          );
          assert.equal(
            supportedTables.has('whaleu_community.community_text_sources'),
            false,
          );
          assert.deepEqual(
            before.rows['whaleu_community.community_text_sources'],
            [],
          );
          // The protected 0181/0182 namespaces fail before the relation bound.
          // This is not evidence of the historical per-owner inventory stage.
          await assert.rejects(
            inTransaction(pool, (tx) => inventory(tx)),
            (error: unknown) =>
              error instanceof DeletionError &&
              error.code === 'UNREGISTERED_OWNER_SCHEMA',
          );
          assert.deepEqual(await sourceOwnerState(pool), before);
        },
      );
      const id = (n: number) =>
        `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const base: EffectiveContentEnvelopeV1 = {
        version: 1,
        accountId: id(1),
        purpose: 'publish_post',
        spaceId: id(2),
        category: 'discussion',
        authorMode: 'named',
        commentsPolicy: 'open',
        postId: null,
        rootCommentId: null,
        targetReplyId: null,
        text: 'Original',
        images: [],
        component: { kind: 'none' },
        trading: null,
        scope: {
          originalSpaceId: id(2),
          originalRegionId: id(3),
          authorOriginRegionId: id(3),
          identityRegionId: id(3),
          topologySnapshotId: null,
          sync: 'none',
        },
      };
      for (const descriptor of [
        { version: 1, format: 'plain', readingFormatting: 'auto' },
        { version: 1, format: 'plain', readingFormatting: 'off' },
        { version: 1, format: 'markdown' },
      ] as const satisfies readonly TextSourceDescriptor[]) {
        for (const text of [
          'First\r\n second 🐳',
          '  exact e\u0301\t終  ',
          '# Heading\n- original',
          'literal [x](https://example.test)',
        ]) {
          for (const operation of [
            'publish_post',
            'publish_comment',
            'publish_reply',
          ] as const) {
            for (const mode of ['named', 'anonymous'] as const) {
              const kind =
                operation === 'publish_post'
                  ? 'post'
                  : operation === 'publish_comment'
                    ? 'comment'
                    : 'reply';
              const source = prepareTextSource(text, descriptor, kind)!;
              const draft = {
                ...base,
                purpose: operation,
                text: source.canonicalText,
                authorMode: mode,
                postId: operation === 'publish_post' ? null : id(4),
                rootCommentId: operation === 'publish_reply' ? id(5) : null,
                targetReplyId: operation === 'publish_reply' ? id(6) : null,
              };
              const envelope = canonicalEnvelope({
                ...withReviewedTextSource(draft, descriptor),
                images: [],
              });
              const intent = appendTextSource(
                operation === 'publish_post'
                  ? {
                      spaceId: id(2),
                      category: 'discussion',
                      text: source.canonicalText,
                      imageAssetIds: [],
                      authorMode: mode,
                      commentsPolicy: 'open',
                    }
                  : operation === 'publish_comment'
                    ? {
                        postId: id(4),
                        text: source.canonicalText,
                        imageAssetIds: [],
                        authorMode: mode,
                      }
                    : {
                        rootCommentId: id(5),
                        targetReplyId: id(6),
                        text: source.canonicalText,
                        imageAssetIds: [],
                        authorMode: mode,
                      },
                descriptor,
              );
              const actual = (
                await pool.query(
                  `SELECT whaleu_community.text_source_envelope_valid($1::jsonb) valid,
              whaleu_community.text_source_hash($2,$3) hash,
              whaleu_community.text_source_intent_hash($1::jsonb,$4) intent,
              whaleu_community.content_canonical_json($1::jsonb) canonical`,
                  [
                    JSON.stringify(envelope),
                    descriptor.format,
                    source.canonicalText,
                    mode,
                  ],
                )
              ).rows[0];
              assert.deepEqual(actual, {
                valid: true,
                hash: source.sourceHash,
                intent: textSourceIntentHash(operation, intent),
                canonical: canonicalJson(envelope),
              });
              assert.equal(approvalDigest(envelope).length, 64);
              for (const mutation of [
                { text: 'altered' },
                {
                  textSource: {
                    ...(envelope.version === 6 ? envelope.textSource : {}),
                    sourceHash: '0'.repeat(64),
                  },
                },
                { images: [{ assetId: id(7), digest: 'a'.repeat(64) }] },
                { allowAnonymousDm: true },
                { commentsPolicy: 'restricted' },
                { extra: 1 },
              ])
                assert.equal(
                  (
                    await pool.query<{ valid: boolean }>(
                      'SELECT whaleu_community.text_source_envelope_valid($1::jsonb) valid',
                      [JSON.stringify({ ...envelope, ...mutation })],
                    )
                  ).rows[0]!.valid,
                  false,
                );
            }
          }
        }
      }
      for (const text of [
        '#1',
        '`#1234567`',
        '[label](https://example.test/#1234567)',
        '\\#1234567',
        'whaleu-asset:x',
      ]) {
        const source = prepareTextSource(
          text,
          { version: 1, format: 'markdown' },
          'post',
        )!;
        const envelope = {
          ...canonicalEnvelope(base),
          version: 6,
          text,
          allowAnonymousDm: null,
          textSource: { ...source.descriptor, sourceHash: source.sourceHash },
        };
        assert.equal(
          (
            await pool.query<{ valid: boolean }>(
              'SELECT whaleu_community.text_source_envelope_valid($1::jsonb) valid',
              [JSON.stringify(envelope)],
            )
          ).rows[0]!.valid,
          false,
        );
      }
      assert.equal(
        (
          await pool.query<{ definition: unknown }>(
            'SELECT whaleu_community.text_source_definition($1,$2,$3::jsonb) definition',
            ['post', id(4), JSON.stringify(canonicalEnvelope(base).scope)],
          )
        ).rows[0]!.definition,
        null,
      );
      // Catalog-level closure proves the actual installed triggers, not merely
      // the source-text array. Exact actor/admission/distribution arguments exclude
      // the unrelated applicability-policy generation. Preserve Media INSERT vs
      // other statement timing rather than accepting arbitrary trigger shapes.
      const originalSources = (
        await pool.query<{ relation: string }>(`
        SELECT DISTINCT t.tgrelid::regclass::text relation FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgenabled='O' AND (
          (t.tgfoid='whaleu_community.related_sync_advance_generation()'::regprocedure
           AND encode(t.tgargs,'hex') IN ('6163746f7200','61646d697373696f6e00','646973747269627574696f6e00')
           AND (t.tgtype=62 OR (t.tgrelid='whaleu_media.bindings'::regclass AND t.tgtype=58)))
          OR (t.tgfoid='whaleu_community.related_sync_advance_view_generation()'::regprocedure AND t.tgtype=62 AND t.tgargs=''::bytea)
          OR (t.tgfoid='whaleu_community.related_sync_media_binding_insert()'::regprocedure AND t.tgtype=4 AND t.tgargs=''::bytea))
        ORDER BY relation`)
      ).rows;
      assert.ok(originalSources.length > 40);
      // 0178 adds two actor-generation sources with its own Home closure.
      // They are not members of the unchanged 0175 text-source trigger set.
      // Assert this extension independently rather than changing 61 to 63.
      const homeActorSources = [
        'whaleu_community.home_discussion_parent_bindings',
        'whaleu_community.home_post_dispositions',
      ];
      assert.deepEqual(
        originalSources
          .map((row) => row.relation)
          .filter((relation) => homeActorSources.includes(relation))
          .sort(),
        homeActorSources,
      );
      const originalTextSourceRelations = originalSources
        .map((row) => row.relation)
        .filter((relation) => !homeActorSources.includes(relation));
      const directSources = [
        'whaleu_safety.account_punishment_heads',
        'whaleu_safety.account_punishments',
        'whaleu_safety.account_punishment_terminals',
        'whaleu_community.publication_cancel_fences',
        'whaleu_media.media_owner_states',
        'whaleu_community.post_distribution_bindings',
        'whaleu_community.trading_listings',
        'whaleu_community.post_rating_target_links',
        'whaleu_community.report_origins',
        'whaleu_community.publication_requests',
        'whaleu_community.outbox',
        'whaleu_community.text_review_requests',
      ];
      const expectedSources = [
        ...new Set([...originalTextSourceRelations, ...directSources]),
      ].sort();
      assert.equal(expectedSources.length, 61);
      assert.deepEqual(
        (
          await pool.query<{ relation: string }>(
            `SELECT tgrelid::regclass::text relation FROM pg_trigger WHERE tgname='text_source_dependency_recheck' AND NOT tgisinternal ORDER BY relation`,
          )
        ).rows
          .map((row) => row.relation)
          .sort(),
        expectedSources,
      );
      for (const relation of expectedSources) {
        const installed = (
          await pool.query<{
            tgtype: number;
            enabled: boolean;
            function: string;
          }>(
            `
          SELECT tgtype,tgenabled='O' enabled,tgfoid::regprocedure::text AS "function" FROM pg_trigger
          WHERE tgrelid=$1::regclass AND tgname='text_source_dependency_recheck' AND NOT tgisinternal`,
            [relation],
          )
        ).rows;
        assert.deepEqual(
          installed,
          [
            {
              tgtype: 60,
              enabled: true,
              function: 'whaleu_community.text_source_recheck_authority()',
            },
          ],
          relation,
        );
      }
      for (const relation of [
        'whaleu_community.report_origins',
        'whaleu_community.publication_requests',
        'whaleu_community.outbox',
      ]) {
        assert.deepEqual(
          (
            await pool.query<{
              tgtype: number;
              tgdeferrable: boolean;
              tginitdeferred: boolean;
            }>(
              `
          SELECT tgtype,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=$1::regclass
          AND tgname='text_source_causal_recheck' AND NOT tgisinternal`,
              [relation],
            )
          ).rows,
          [{ tgtype: 29, tgdeferrable: true, tginitdeferred: true }],
          relation,
        );
      }
      const columns = (
        await pool.query<{
          relation: string;
          name: string;
          type: string;
          notnull: boolean;
          hasdefault: boolean;
        }>(`
        SELECT a.attrelid::regclass::text relation,a.attname name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull AS "notnull",a.atthasdef hasdefault
        FROM pg_attribute a WHERE (a.attrelid,a.attname) IN
          (('whaleu_community.content_approval_decisions'::regclass,'text_source_issuance_transaction'),
           ('whaleu_community.text_review_requests'::regclass,'text_source_transition_transaction'))
        ORDER BY relation`)
      ).rows;
      assert.deepEqual(columns, [
        {
          relation: 'whaleu_community.content_approval_decisions',
          name: 'text_source_issuance_transaction',
          type: 'xid8',
          notnull: false,
          hasdefault: false,
        },
        {
          relation: 'whaleu_community.text_review_requests',
          name: 'text_source_transition_transaction',
          type: 'xid8',
          notnull: false,
          hasdefault: false,
        },
      ]);
      const triggers = (
        await pool.query<{ tgname: string }>(
          'SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname',
          ['whaleu_community.community_text_sources'],
        )
      ).rows.map((r) => r.tgname);
      for (const name of [
        'text_source_immutable',
        'text_source_insert_guard',
        'text_source_complete',
        'a000_account_deletion_writer_fence',
        'a_discovery_count_epoch',
      ])
        assert.ok(triggers.includes(name), name);
    } finally {
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
