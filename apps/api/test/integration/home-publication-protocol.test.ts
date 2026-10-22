import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
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
import { configureHttp } from '../../src/http/http.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import { configureHomeAdmission } from '../../src/community/home-feed-policy/admission.js';
import { configureHomePublication } from '../../src/community/home-feed-policy/activation.js';
import { HOME_POLICY_SOURCE } from '../../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../../src/community/home-feed-policy/admission-contract.js';
import { evaluateLegacyHomePolicy } from '../../src/community/home-feed-policy/policy.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Actual full-prefix SQL plus the real HTTP publisher/issuer. Identity and
 * campus facts are synthetic disposable inputs, not production acceptance. */
test(
  '0178 Home exact publication/source/parent protocol and predecessor preservation',
  { timeout: 300000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_STATEMENT_TIMEOUT_MS: '60000',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
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
            await suite.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const currentMigrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const preEpochMigrations = currentMigrations.filter(
        (m) => Number(m.name.slice(0, 4)) <= 179,
      );
      assert.equal(
        preEpochMigrations.at(-1)?.name,
        '0179_identity_registration_guard.sql',
      );
      const migrations = currentMigrations.filter(
        (m) => Number(m.name.slice(0, 4)) <= 178,
      );
      const assertInstalledPrefix = async (through: number) => {
        assert.deepEqual(
          (
            await pool.query<{ name: string }>(
              'SELECT name FROM whaleu_meta.schema_migrations ORDER BY name',
            )
          ).rows.map(({ name }) => name),
          currentMigrations
            .filter((m) => Number(m.name.slice(0, 4)) <= through)
            .map(({ name }) => name),
        );
      };
      const extension = migrations.at(-1)!;
      assert.equal(extension.name, '0178_home_publication_protocol.sql');
      assert.equal(migrations.at(-2)?.name, '0177_home_policy_admission.sql');
      await runMigrations(pool, migrations.slice(0, -1), { mode: 'up' });
      await assertInstalledPrefix(177);
      const frozen = (
        await pool.query<{
          name: string;
          body: string;
        }>(`SELECT proname name,prosrc body FROM pg_proc WHERE oid IN (
      'whaleu_community.text_source_intent_hash(jsonb,text)'::regprocedure,
      'whaleu_community.text_source_hash(text,text)'::regprocedure,
      'whaleu_community.content_canonical_json(jsonb)'::regprocedure)`)
      ).rows;
      const renamedNames = [
        'profile_moderation_definition',
        'text_source_definition',
        'text_source_review_current',
        'text_source_assert',
        'text_source_authority_assert',
        'reading_format_source_current',
      ];
      const renamedBefore = (
        await pool.query<{ name: string; body: string; attributes: unknown }>(
          "SELECT proname name,prosrc body,to_jsonb(p)-'proname'-'prosrc' attributes FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_community' AND p.proname=ANY($1)",
          [renamedNames],
        )
      ).rows;
      assert.equal(renamedBefore.length, 6);
      await t.test(
        'drifted predecessor cannot be blindly resealed',
        async () => {
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                `CREATE OR REPLACE FUNCTION whaleu_community.text_source_definition(kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RETURN NULL;END$$`,
              );
              await tx.query(extension.sql);
            }),
            /Unexpected Home predecessor source/,
          );
        },
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'all six retained predecessor bodies and complete pg_proc properties remain exact apart from two qualified parameter labels',
        async () => {
          for (const original of renamedBefore) {
            const adapted = (
              await pool.query<{ body: string; attributes: unknown }>(
                "SELECT prosrc body,to_jsonb(p)-'proname'-'prosrc' attributes FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_community' AND p.proname=$1",
                [`${original.name}_pre_home`],
              )
            ).rows[0]!;
            const relabeled = [
              'text_source_assert',
              'reading_format_source_current',
            ].includes(original.name);
            assert.deepEqual(
              adapted.attributes,
              original.attributes,
              original.name,
            );
            assert.equal(
              adapted.body,
              relabeled
                ? original.body.replace(
                    `${original.name}.kind`,
                    `${original.name}_pre_home.kind`,
                  )
                : original.body,
              original.name,
            );
            t.diagnostic(
              JSON.stringify({
                legacyFunction: original.name,
                before: original,
                after: adapted,
              }),
            );
          }
        },
      );
      for (const row of frozen) {
        assert.equal(
          (
            await pool.query<{ body: string }>(
              'SELECT prosrc body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2',
              ['whaleu_community', row.name],
            )
          ).rows[0]!.body,
          row.body,
        );
      }
      assert.equal(
        (
          await pool.query(
            'SELECT whaleu_community.home_publication_current() value',
          )
        ).rows[0]!.value,
        null,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT whaleu_community.reading_format_protocol()->>'catalog'=whaleu_community.reading_format_catalog() valid",
          )
        ).rows[0]!.valid,
        true,
      );
      await t.test(
        'plain fixed-source rule matches Unicode/token boundary matrix; unsupported input is not silently coerced',
        async () => {
          const spaces = [
            ' ',
            '\t',
            '\n',
            '\r',
            '\v',
            '\f',
            '\u0085',
            '\u180e',
            '\u00a0',
            '\u1680',
            ...Array.from({ length: 11 }, (_, i) =>
              String.fromCodePoint(0x2000 + i),
            ),
            '\u2028',
            '\u2029',
            '\u202f',
            '\u205f',
            '\u3000',
            '\ufeff',
          ];
          const corpus = new Set([
            'a',
            '测试',
            '三个字',
            '四个汉字',
            '😀😀😀',
            '😀😀😀😀',
            'e\u0301',
            '#1000000',
            '#10000000',
            '#100000000',
            '#10000000#10000000',
            '#10000000#10000001',
            '#10000000 #10000001',
            '#10000000\n#100000001',
            '#01234567',
            '#123456',
            '#1000000000',
            'x#10000000',
            '_#10000000',
            '/#10000000',
            '\\#10000000',
            '#10000000x',
            '#10000000_',
            'https://example.test/#10000000',
            '#10000000 https://example.test/',
            '看看 #10000000',
            '#10000000，',
            '#10000000好',
            '##10000000',
            '#10000000#10000000#10000000',
            ...spaces.flatMap((w) => [
              `${w}测试${w}`,
              `${w}#10000000${w}`,
              `#10000000${w}#10000001`,
              `${w}${w}a${w}${w}`,
            ]),
          ]);
          assert.ok(corpus.size > 100);
          for (const text of corpus) {
            const expected = evaluateLegacyHomePolicy({
              originalCategory: { sourceCommit: HOME_POLICY_SOURCE, choose: 2 },
              text,
              format: 'plain',
              hasImages: false,
              hasPoll: false,
              hasGroup: false,
              hasLink: false,
              auditExempt: false,
            });
            assert.equal(expected.status, 'resolved');
            const actual = (
              await pool.query<{ value: string | null }>(
                "SELECT whaleu_community.home_restriction($1,'plain') value",
                [text],
              )
            ).rows[0]!.value;
            assert.equal(
              actual,
              expected.restriction?.reason ?? null,
              JSON.stringify(text),
            );
          }
          for (const text of [
            'a',
            '测试',
            '四个汉字',
            '`a`',
            '**字**',
            '## 抽',
          ]) {
            const expected = evaluateLegacyHomePolicy({
              originalCategory: { sourceCommit: HOME_POLICY_SOURCE, choose: 2 },
              text,
              format: 'markdown',
              hasImages: false,
              hasPoll: false,
              hasGroup: false,
              hasLink: false,
              auditExempt: false,
            });
            assert.equal(expected.status, 'resolved');
            assert.equal(
              (
                await pool.query(
                  "SELECT whaleu_community.home_restriction($1,'markdown') value",
                  [text],
                )
              ).rows[0]!.value,
              expected.restriction?.reason ?? null,
            );
          }
          await assert.rejects(
            pool.query(
              "SELECT whaleu_community.home_restriction('a','unknown')",
            ),
            { code: '22023' },
          );
          await assert.rejects(
            pool.query("SELECT whaleu_community.home_restriction($1,'plain')", [
              '\0测试',
            ]),
            { code: '22021' },
          );
        },
      );
      await t.test(
        'JSONB source key removal uses explicit extraction precedence',
        async () => {
          const document = JSON.stringify({
            textSource: {
              version: 1,
              format: 'plain',
              readingFormatting: 'auto',
              sourceHash: 'a'.repeat(64),
            },
          });
          await assert.rejects(
            pool.query("SELECT ($1::jsonb->'textSource'-'sourceHash') value", [
              document,
            ]),
            (error: unknown) => {
              t.diagnostic(
                `Unparenthesized original expression: ${String(error)}`,
              );
              return (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                String(error.code).startsWith('42')
              );
            },
          );
          assert.deepEqual(
            (
              await pool.query(
                "SELECT (($1::jsonb->'textSource')-'sourceHash') value",
                [document],
              )
            ).rows[0]!.value,
            { version: 1, format: 'plain', readingFormatting: 'auto' },
          );
        },
      );
      // Finish the exact 0177 -> 0178 SQL proof before current Identity starts.
      await assertInstalledPrefix(178);
      await runMigrations(pool, preEpochMigrations, { mode: 'up' });
      await assertInstalledPrefix(179);
      assert.deepEqual(
        currentMigrations
          .filter((m) => {
            const version = Number(m.name.slice(0, 4));
            return version >= 178 && version <= 181;
          })
          .map((m) => m.name),
        [
          '0178_home_publication_protocol.sql',
          '0179_identity_registration_guard.sql',
          '0180_identity_session_revocation_epoch.sql',
          '0181_identity_real_deletion_preparations.sql',
        ],
      );
      await runMigrations(pool, currentMigrations, { mode: 'up' });
      assert.deepEqual(
        (
          await pool.query<{ name: string; checksum: string }>(
            'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
          )
        ).rows,
        currentMigrations.map(({ name, checksum }) => ({ name, checksum })),
      );
      // Upgrading Identity must preserve the installed Home/Reading seals.
      assert.deepEqual(
        (
          await pool.query(`SELECT
            whaleu_community.home_publication_protocol()->>'catalog'=whaleu_community.home_publication_catalog() publication,
            whaleu_community.home_reading_protocol()->>'catalog'=whaleu_community.home_reading_catalog() home_reading,
            whaleu_community.reading_format_protocol()->>'catalog'=whaleu_community.reading_format_catalog() reading`)
        ).rows[0],
        { publication: true, home_reading: true, reading: true },
      );

      const scope = await seedCommunityScope(pool);
      const operatorName = `manual:${hostname()}:${userInfo().username}`;
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_OPERATOR: operatorName,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer(),
        actor = await createRuntimeActor(app);
      const facts = await setRuntimeVerification(
        pool,
        actor.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        actor.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        operatorName,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-source-policy',
            basis: 'Disposable Home source Review proof',
          },
          tx,
        ),
      );
      let legacyAfterActivation: (() => Promise<void>) | undefined;
      await t.test(
        'preactivation V6 publication and reading retain exact legacy parameter authority',
        async () => {
          const legacyActor = await createRuntimeActor(app!);
          const legacyFacts = await setRuntimeVerification(
            pool,
            legacyActor.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            legacyActor.accountId,
            legacyFacts,
            scope,
            scope.home.campusId,
          );
          const source = {
            version: 1,
            format: 'plain',
            readingFormatting: 'auto',
          };
          const legacyPublish = async (
            path: string,
            body: Record<string, unknown>,
          ) => {
            const input = { ...body, clientRequestId: randomUUID() };
            const callLegacy = (route: string) =>
              request(http)
                .post(route)
                .set('Authorization', `Bearer ${legacyActor.accessToken}`)
                .send(input);
            const queued = await callLegacy(
              path.replace('/v1/community/', '/v1/community/reviews/'),
            );
            assert.equal(queued.status, 200, JSON.stringify(queued.body));
            assert.equal(queued.body.status, 'pending');
            const pending = (
              await pool.query<{
                digest: string;
                envelope: { version: number };
              }>(
                'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [legacyActor.accountId, input.clientRequestId],
              )
            ).rows[0]!;
            assert.equal(pending.envelope.version, 6);
            await inTransaction(pool, (tx) =>
              operator.run(
                {
                  command: 'decide',
                  accountId: legacyActor.accountId,
                  requestId: input.clientRequestId,
                  digest: pending.digest,
                  decision: 'allow',
                  basis: 'Disposable exact V6 predecessor regression',
                },
                tx,
              ),
            );
            const created = await callLegacy(path);
            assert.equal(created.status, 201, JSON.stringify(created.body));
            assert.equal(created.body.outcome, 'created');
            return {
              id: created.body.resourceId as string,
              requestId: input.clientRequestId,
              digest: pending.digest,
            };
          };
          const oldPost = await legacyPublish('/v1/community/posts', {
            spaceId: scope.home.spaceId,
            category: 'discussion',
            text: '旧'.repeat(320),
            imageAssetIds: [],
            authorMode: 'named',
            commentsPolicy: 'open',
            textSource: source,
          });
          const oldComment = await legacyPublish(
            `/v1/community/posts/${oldPost.id}/comments`,
            {
              text: '评'.repeat(220),
              imageAssetIds: [],
              authorMode: 'named',
              textSource: source,
            },
          );
          const oldReply = await legacyPublish(
            `/v1/community/comments/${oldComment.id}/replies`,
            {
              targetReplyId: null,
              text: '复'.repeat(220),
              imageAssetIds: [],
              authorMode: 'named',
              textSource: source,
            },
          );
          const oldNodes = [
            ['post', oldPost],
            ['comment', oldComment],
            ['reply', oldReply],
          ] as const;
          const verifyLegacy = async (kind: string, id: string) => {
            await pool.query(
              'SELECT whaleu_community.text_source_assert($1,$2)',
              [kind, id],
            );
            const actual = (
              await pool.query(
                `SELECT
              whaleu_community.text_source_definition($1,$2,b.scope)=b.envelope definition,
              whaleu_community.text_source_review_current(b.decision_id,false) review,
              whaleu_community.reading_format_source_current($1,$2) eligible
              FROM whaleu_community.content_approval_bindings b WHERE content_kind=$1 AND content_id=$2`,
                [kind, id],
              )
            ).rows[0];
            assert.deepEqual(
              actual,
              { definition: true, review: true, eligible: true },
              kind,
            );
          };
          for (const [kind, oldNode] of oldNodes)
            await verifyLegacy(kind, oldNode.id);
          legacyAfterActivation = async () => {
            for (const [kind, oldNode] of oldNodes) {
              await verifyLegacy(kind, oldNode.id);
              const read = await request(http)
                .get(`/v1/community/text-sources/${kind}/${oldNode.id}`)
                .set('Authorization', `Bearer ${legacyActor.accessToken}`);
              assert.equal(read.status, 200, JSON.stringify(read.body));
              assert.equal(read.body.classification, 'reviewedSource');
              assert.equal(read.body.readingFormattingEligible, true);
            }
            const laterComment = await legacyPublish(
              `/v1/community/posts/${oldPost.id}/comments`,
              {
                text: '后'.repeat(220),
                imageAssetIds: [],
                authorMode: 'named',
                textSource: source,
              },
            );
            await verifyLegacy('comment', laterComment.id);
            await inTransaction(pool, (tx) =>
              operator.run(
                {
                  command: 'withdraw',
                  accountId: legacyActor.accountId,
                  requestId: oldPost.requestId,
                  digest: oldPost.digest,
                  state: 'revoked',
                  basis: 'Disposable exact old parent permission invalidation',
                },
                tx,
              ),
            );
            for (const [kind, oldNode] of oldNodes)
              assert.equal(
                (
                  await pool.query(
                    'SELECT whaleu_community.reading_format_source_current($1,$2) eligible',
                    [kind, oldNode.id],
                  )
                ).rows[0]!.eligible,
                false,
                kind,
              );
          };
        },
      );
      const definition: HomeAdmissionDefinition = {
        version: 1,
        sourceCommit: HOME_POLICY_SOURCE,
        categoryMappings: [
          {
            nativeCategory: 'discussion',
            sourceKind: 'regional',
            legacyChoose: 2,
          },
          { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
        ],
        scopeMappings: [
          {
            sourceSpaceId: scope.home.spaceId,
            sourceKind: 'regional',
            sourceRegionId: scope.home.regionId,
            targetWaterSpaceId: scope.home.spaceId,
            targetRegionId: scope.home.regionId,
          },
        ],
        authorModes: ['named', 'anonymous'],
        exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
        surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
        markdownReferences: false,
      };
      const proposal = {
        definition,
        evidenceRef: 'Disposable original Home mapping',
        validForHours: 2,
      };
      const prepared = (await inTransaction(pool, (tx) =>
        configureHomeAdmission(
          { command: 'prepare', ...proposal },
          config,
          operatorName,
          tx,
        ),
      )) as {
        preparationId: string;
        currentRevision: number;
        previewDigest: string;
      };
      await inTransaction(pool, (tx) =>
        configureHomeAdmission(
          {
            command: 'apply',
            ...proposal,
            preparationId: prepared.preparationId,
            expectedRevision: prepared.currentRevision,
            previewDigest: prepared.previewDigest,
          },
          config,
          operatorName,
          tx,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT whaleu_community.home_publication_current() value',
          )
        ).rows[0]!.value,
        null,
        'metadata alone never activates publication',
      );
      const activation = (await inTransaction(pool, (tx) =>
        configureHomePublication(
          {
            command: 'prepare',
            evidenceRef: 'Disposable tested Home runtime installation',
            validForHours: 1,
          },
          config,
          operatorName,
          tx,
        ),
      )) as {
        preparationId: string;
        currentRevision: number;
        previewDigest: string;
      };
      await inTransaction(pool, (tx) =>
        configureHomePublication(
          {
            command: 'apply',
            preparationId: activation.preparationId,
            expectedRevision: activation.currentRevision,
            previewDigest: activation.previewDigest,
          },
          config,
          operatorName,
          tx,
        ),
      );
      assert.ok(
        (
          await pool.query(
            'SELECT whaleu_community.home_publication_current() value',
          )
        ).rows[0]!.value,
      );
      await t.test(
        'activation preserves existing V6 post/comment/reply source reads and later V6 descendants; revoked parent still fails closed',
        async () => {
          assert.ok(legacyAfterActivation);
          await legacyAfterActivation();
        },
      );
      const runtime = app.get(TextReviewRuntime);
      const requireEnvelope = runtime.requireEnvelope.bind(runtime);
      t.mock.method(
        runtime,
        'requireEnvelope',
        async (
          envelope: Parameters<typeof requireEnvelope>[0],
          tx: PoolClient,
        ) => {
          try {
            return await requireEnvelope(envelope, tx);
          } catch (error) {
            if (
              (envelope.version === 7 || envelope.version === 8) &&
              envelope.textSource !== null
            ) {
              const diagnostics = await tx.query(
                `SELECT
              whaleu_community.home_source_valid($1::jsonb->'textSource',$1::jsonb->>'text') source_valid,
              whaleu_community.home_requested_intent_hash($1::jsonb->'home'->'requestedIntent') requested_hash,
              whaleu_community.home_evidence_valid($1::jsonb->'home') evidence_valid,
              whaleu_community.home_envelope_valid($1::jsonb) envelope_valid,
              whaleu_community.home_review_admitted($1::jsonb) admitted,
              whaleu_community.text_source_destination_current(($1::jsonb->>'accountId')::uuid,$1::jsonb->'scope',$1::jsonb->>'authorMode',$1::jsonb->'home'->'requestedIntent'->>'category',$1::jsonb->>'purpose',NULL) destination_current,
              whaleu_community.home_publication_current() activation`,
                [JSON.stringify(envelope)],
              );
              t.diagnostic(
                JSON.stringify({
                  envelope,
                  diagnostics: diagnostics.rows,
                  error: error instanceof Error ? error.stack : String(error),
                }),
              );
            }
            throw error;
          }
        },
      );
      const auth = `Bearer ${actor.accessToken}`;
      const call = (path: string, body: Record<string, unknown>) =>
        request(http).post(path).set('Authorization', auth).send(body);
      const publish = async (path: string, body: Record<string, unknown>) => {
        const submitted = await call(
          path.replace('/v1/community/', '/v1/community/reviews/'),
          body,
        );
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.status, 'pending');
        const q = (
          await pool.query<{
            digest: string;
            envelope: unknown;
            intent_hash: string;
          }>(
            'SELECT digest,envelope,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, body['clientRequestId']],
          )
        ).rows[0]!;
        const canonical = canonicalEnvelope(q.envelope);
        assert.equal(q.digest, approvalDigest(canonical));
        if (canonical.version === 7) {
          assert.equal(
            (
              await pool.query(
                'SELECT whaleu_community.home_envelope_valid($1::jsonb) valid',
                [JSON.stringify(canonical)],
              )
            ).rows[0]!.valid,
            true,
          );
          for (const altered of [
            {
              ...canonical,
              textSource: {
                ...canonical.textSource,
                sourceHash: '0'.repeat(64),
              },
            },
            {
              ...canonical,
              textSource: {
                ...canonical.textSource,
                readingFormatting: 'invalid',
              },
            },
          ])
            assert.equal(
              (
                await pool.query(
                  'SELECT whaleu_community.home_envelope_valid($1::jsonb) valid',
                  [JSON.stringify(altered)],
                )
              ).rows[0]!.valid,
              false,
            );
        }

        assert.equal(
          (
            await pool.query(
              'SELECT whaleu_community.home_envelope_valid($1::jsonb) valid,whaleu_community.home_intent_hash($1::jsonb,$2) intent',
              [JSON.stringify(canonical), body['authorMode']],
            )
          ).rows[0]!.valid,
          true,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT whaleu_community.home_intent_hash($1::jsonb,$2) intent',
              [JSON.stringify(canonical), body['authorMode']],
            )
          ).rows[0]!.intent,
          q.intent_hash,
        );
        await inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: actor.accountId,
              requestId: body['clientRequestId'] as string,
              digest: q.digest,
              decision: 'allow',
              basis: 'Explicit exact disposable Home source review',
            },
            tx,
          ),
        );
        const published = await call(path, body);
        assert.equal(published.status, 201, JSON.stringify(published.body));
        assert.equal(published.body.outcome, 'created');
        assert.deepEqual((await call(path, body)).body, published.body);
        return { id: published.body.resourceId as string, envelope: canonical };
      };
      const plain = { version: 1, format: 'plain', readingFormatting: 'auto' };
      const postBody = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: '三个字',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        textSource: plain,
      };
      await t.test(
        'source-only activation rejects explicit-null source without falling back or writing',
        async () => {
          const ordinary = {
            ...postBody,
            clientRequestId: randomUUID(),
            textSource: undefined,
          };
          const reviewed = await call('/v1/community/reviews/posts', ordinary);
          assert.notEqual(reviewed.body.status, 'pending');
          assert.equal(
            reviewed.body.error?.code ?? reviewed.body.code,
            'CONTENT_REVIEW_UNAVAILABLE',
            JSON.stringify(reviewed.body),
          );
          const denied = await call('/v1/community/posts', ordinary);
          assert.notEqual(denied.status, 201);
          assert.equal(
            denied.body.error?.code ?? denied.body.code,
            'CONTENT_REVIEW_UNAVAILABLE',
            JSON.stringify(denied.body),
          );
          const writes = await pool.query<{ n: number }>(
            `SELECT (
          (SELECT count(*) FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2)
          +(SELECT count(*) FROM whaleu_community.posts WHERE account_id=$1)
          +(SELECT count(*) FROM whaleu_community.content_approval_bindings WHERE account_id=$1)
        )::integer n`,
            [actor.accountId, ordinary.clientRequestId],
          );
          assert.equal(writes.rows[0]!.n, 0);
        },
      );
      const post = await publish('/v1/community/posts', postBody);
      assert.equal(post.envelope.version, 7);
      assert.equal(post.envelope.category, 'water');
      assert.equal(
        (
          await pool.query(
            'SELECT whaleu_community.home_post_disposition_valid($1) valid',
            [post.id],
          )
        ).rows[0]!.valid,
        true,
      );
      const child = await publish(`/v1/community/posts/${post.id}/comments`, {
        clientRequestId: randomUUID(),
        text: '仍然保留评论原文',
        imageAssetIds: [],
        authorMode: 'named',
        textSource: plain,
      });
      assert.equal(child.envelope.version, 8);
      const reply = await publish(
        `/v1/community/comments/${child.id}/replies`,
        {
          clientRequestId: randomUUID(),
          targetReplyId: null,
          text: '回复不继承短文分类',
          imageAssetIds: [],
          authorMode: 'named',
          textSource: plain,
        },
      );
      assert.equal(reply.envelope.version, 8);
      const markdownPost = await publish('/v1/community/posts', {
        ...postBody,
        clientRequestId: randomUUID(),
        text: '**Markdown 原文**',
        textSource: {
          version: 1,
          format: 'markdown',
        },
      });
      assert.equal(markdownPost.envelope.version, 7);
      assert.equal(markdownPost.envelope.category, 'discussion');

      await t.test(
        'exact source/receipt graph is retained and metadata cannot be rewritten or downgraded',
        async () => {
          for (const [kind, value] of [
            ['post', post],
            ['comment', child],
            ['reply', reply],
            ['post', markdownPost],
          ] as const) {
            const row = (
              await pool.query<{
                envelope: unknown;
                source_hash: string;
                text: string;
              }>(
                `SELECT b.envelope,s.source_hash,b.envelope->>'text' text FROM whaleu_community.content_approval_bindings b JOIN whaleu_community.community_text_sources s USING(content_kind,content_id) WHERE b.content_kind=$1 AND b.content_id=$2`,
                [kind, value.id],
              )
            ).rows[0]!;
            assert.deepEqual(row.envelope, value.envelope);
            assert.ok(
              value.envelope.version === 7 || value.envelope.version === 8,
            );
            assert.ok(value.envelope.textSource);
            assert.equal(
              row.source_hash,
              createHash('sha256')
                .update(
                  `whaleu-community-text-source:v1\n${value.envelope.textSource!.format}\n${row.text}`,
                )
                .digest('hex'),
            );
            await pool.query(
              'SELECT whaleu_community.home_publication_assert($1,$2)',
              [kind, value.id],
            );
            await assert.rejects(
              inTransaction(pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.community_text_sources SET source_hash=$1 WHERE content_kind=$2 AND content_id=$3',
                  ['0'.repeat(64), kind, value.id],
                ),
              ),
              { code: '23514' },
            );
          }
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                "UPDATE whaleu_community.home_post_dispositions SET evidence=jsonb_set(evidence,'{result}','null') WHERE post_id=$1",
                [post.id],
              ),
            ),
            { code: '23514' },
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.home_discussion_parent_bindings SET parent_digest=$1 WHERE content_id=$2',
                ['0'.repeat(64), child.id],
              ),
            ),
            { code: '23514' },
          );
          const bad = { ...post.envelope, version: 6 };
          assert.equal(
            (
              await pool.query(
                'SELECT whaleu_community.home_envelope_valid($1::jsonb) valid',
                [JSON.stringify(bad)],
              )
            ).rows[0]!.valid,
            false,
          );
        },
      );
    } finally {
      await app?.close();
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
