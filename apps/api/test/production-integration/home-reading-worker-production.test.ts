import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import {
  DatabaseService,
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
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import type { ContentKind } from '../../src/community/content-review/contracts.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { configureHomeAdmission } from '../../src/community/home-feed-policy/admission.js';
import { configureHomePublication } from '../../src/community/home-feed-policy/activation.js';
import { HOME_POLICY_SOURCE } from '../../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../../src/community/home-feed-policy/admission-contract.js';
import {
  FORMATTER,
  jobKey,
  planSchema,
} from '../../src/community/reading-formatting/contracts.js';
import { formatSource } from '../../src/community/reading-formatting/formatter.js';
import {
  inspectReadingSchema,
  requireReadingSchema,
} from '../../src/community/reading-formatting/readiness.js';
import { assertReadingWorkerRole } from '../../src/community/reading-formatting/worker-process.js';
import {
  readingTablePrivileges,
  readingColumnPrivileges,
} from '../../src/community/reading-formatting/role-contract.js';
import { ReadingFormattingRuntime } from '../../src/community/reading-formatting/runtime.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  createReadingWorkerLogin,
  readingLoginAuthMode,
} from '../support/reading-worker-login.js';
import { withReadingWorkerRole } from '../support/reading-worker-role.js';
import { readingWorkerDockerTarget } from '../support/reading-worker-docker-target.js';
import {
  readingCliEnvironment,
  startReadingCli,
} from '../support/reading-worker-cli.js';

interface Preparation {
  preparationId: string;
  currentRevision: number;
  previewDigest: string;
}
interface PublishedSource {
  kind: ContentKind;
  id: string;
  requestId: string;
  digest: string;
  text: string;
  sourceHash: string;
  version: 6 | 7 | 8;
  immutable: unknown;
}
const plain = {
  version: 1,
  format: 'plain',
  readingFormatting: 'auto',
} as const;
const sourceText = (kind: ContentKind) =>
  ('鲸'.repeat(119) + '。').repeat(kind === 'post' ? 3 : 2);
const canonicalTables = {
  post: 'posts',
  comment: 'root_comments',
  reply: 'replies',
} as const;
const homeReadRelations = [
  'whaleu_community.home_discussion_parent_bindings',
  'whaleu_community.home_post_dispositions',
];
// Exact0176 contract before the separately reviewed two SELECT additions.
// Do not regenerate this hash from a changed contract to approve new powers.
const originalRoleContractSha256 =
  '7b1a30d13e62baeafd4cbeab9ec627733233a80aea42bbcd8cbb191a3bafedc8';

/** Dedicated full-prefix verified-TLS regression, not an eligibility-function
 * probe. The real publisher enqueues immutable V6/V7/V8 sources; the real
 * production worker must claim and complete them through its managed COMMIT.
 * Identity facts alone are synthetic. No hand-inserted Review/activation/job,
 * unreviewed grant, owner-proof replacement, budget override or provider call.
 * Existing0176 privileges are pinned; only two reviewed Home SELECT grants join.
 * Default acceptance also requires the ordinary compiled worker entry. */
test(
  'Home0178 reading worker: genuine V6/V7/V8 queue, restricted production CLI, exact results and fail-closed authority',
  { timeout: 300000 },
  async (t) => {
    await t.test(
      'only two explicit Home SELECT grants extend the exact0176 role contract',
      () => {
        assert.deepEqual(
          readingTablePrivileges
            .filter((p) => homeReadRelations.includes(p.relation))
            .map((p) => ({ ...p }))
            .sort((a, b) => a.relation.localeCompare(b.relation)),
          homeReadRelations.map((relation) => ({
            relation,
            privilege: 'SELECT',
          })),
        );
        assert.equal(
          createHash('sha256')
            .update(
              JSON.stringify({
                tables: readingTablePrivileges.filter(
                  (p) => !homeReadRelations.includes(p.relation),
                ),
                columns: readingColumnPrivileges,
              }),
            )
            .digest('hex'),
          originalRoleContractSha256,
        );
      },
    );
    const authMode = readingLoginAuthMode(
      process.env['TEST_READING_LOGIN_AUTH'],
    );
    t.diagnostic(
      authMode === 'password'
        ? 'Explicit password lane; existing0176 CLI suite owns wrong-password authentication proof.'
        : 'Explicit controlled loopback-trust lane; no password-authentication claim.',
    );
    const phase =
      process.env['TEST_READING_CLI_EXECUTION'] ?? 'source_and_compiled';
    assert.ok(phase === 'source_and_compiled' || phase === 'source');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    if (phase === 'source_and_compiled')
      await access(
        join(apiRoot, 'dist/community/reading-formatting/process-reading.js'),
      );
    else
      t.diagnostic(
        'Source-only probe; ordinary compiled CLI acceptance remains NOT RUN.',
      );
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Explicit disposable verified-TLS TEST_DATABASE_URL required',
    );
    const docker = readingWorkerDockerTarget(
      process.env['TEST_READING_DOCKER_TARGET'],
      database,
      authMode,
    );
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      DATABASE_URL: database,
      PG_SSL_MODE: 'verify-full',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PG_STATEMENT_TIMEOUT_MS: '60000',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      login: Awaited<ReturnType<typeof createReadingWorkerLogin>> | undefined,
      rolePool: Pool | undefined;
    let owned = false,
      locked = false;
    const children: ReturnType<typeof startReadingCli>[] = [];
    let failure: unknown;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true);
      assert.equal(
        (
          await suite.query<{ ssl: boolean }>(
            'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
          )
        ).rows[0]?.ssl,
        true,
      );
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
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
      owned = true;
      const migrations = await readMigrations(join(apiRoot, 'migrations'));
      assert.deepEqual(
        migrations
          .filter((m) => {
            const version = Number(m.name.slice(0, 4));
            return version >= 178 && version <= 182;
          })
          .map((m) => m.name),
        [
          '0178_home_publication_protocol.sql',
          '0179_identity_registration_guard.sql',
          '0180_identity_session_revocation_epoch.sql',
          '0181_identity_real_deletion_preparations.sql',
          '0182_real_deletion_request_authority.sql',
        ],
      );
      // Capture the exact pre-Home bodies before 0178, independently of the
      // current migration tail. The production runtime below needs the full chain.
      const preHomeMigrations = migrations.filter(
        (migration) => Number(migration.name.slice(0, 4)) <= 177,
      );
      assert.equal(
        preHomeMigrations.at(-1)?.name,
        '0177_home_policy_admission.sql',
      );
      await runMigrations(pool, preHomeMigrations, { mode: 'up' });
      const retainedNames = [
        'profile_moderation_definition',
        'text_source_definition',
        'text_source_review_current',
        'text_source_assert',
        'text_source_authority_assert',
        'reading_format_source_current',
      ];
      const predecessors = (
        await pool.query<{ name: string; body: string; attributes: unknown }>(
          "SELECT proname name,prosrc body,to_jsonb(p)-'proname'-'prosrc' attributes FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_community' AND p.proname=ANY($1)",
          [retainedNames],
        )
      ).rows;
      assert.equal(predecessors.length, 6);
      const catalogBody = (
        await pool.query<{ body: string }>(
          "SELECT prosrc body FROM pg_proc WHERE oid='whaleu_community.reading_format_catalog()'::regprocedure",
        )
      ).rows[0]!.body;
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'formal0178 retains every predecessor attribute and the original0176 catalog collector',
        async () => {
          for (const original of predecessors) {
            const retained = (
              await pool.query<{ body: string; attributes: unknown }>(
                "SELECT prosrc body,to_jsonb(p)-'proname'-'prosrc' attributes FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_community' AND p.proname=$1",
                [`${original.name}_pre_home`],
              )
            ).rows[0]!;
            assert.deepEqual(
              retained.attributes,
              original.attributes,
              original.name,
            );
            assert.equal(
              retained.body,
              ['text_source_assert', 'reading_format_source_current'].includes(
                original.name,
              )
                ? original.body.replace(
                    `${original.name}.kind`,
                    `${original.name}_pre_home.kind`,
                  )
                : original.body,
              original.name,
            );
          }
          assert.equal(
            (
              await pool.query<{ body: string }>(
                "SELECT prosrc body FROM pg_proc WHERE oid='whaleu_community.reading_format_catalog()'::regprocedure",
              )
            ).rows[0]!.body,
            catalogBody,
          );
        },
      );
      assert.deepEqual(
        (
          await pool.query<{ name: string; checksum: string }>(
            'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
          )
        ).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
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
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: operatorName,
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const actor = await createRuntimeActor(app);
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
      const review = (command: Parameters<TextReviewOperator['run']>[0]) =>
        inTransaction(pool, (tx) => operator.run(command, tx));
      await review({
        command: 'init-source-policy',
        basis: 'Disposable exact original-source reading-worker proof',
      });
      const http = app.getHttpServer();
      const immutable = async (kind: ContentKind, id: string) =>
        (
          await pool.query(
            `SELECT to_jsonb(s) source,to_jsonb(b) binding,n.text canonical_text,
              (SELECT to_jsonb(h) FROM whaleu_community.home_post_dispositions h WHERE h.post_id=${kind === 'post' ? 'n.id' : 'n.post_id'}) home_post,
              (SELECT to_jsonb(h) FROM whaleu_community.home_discussion_parent_bindings h WHERE h.content_kind=$1 AND h.content_id=$2) home_parent
              FROM whaleu_community.community_text_sources s JOIN whaleu_community.content_approval_bindings b USING(content_kind,content_id) JOIN whaleu_community.${canonicalTables[kind]} n ON n.id=s.content_id WHERE s.content_kind=$1 AND s.content_id=$2`,
            [kind, id],
          )
        ).rows[0];
      const publish = async (
        kind: ContentKind,
        path: string,
        body: Record<string, unknown>,
        version: 6 | 7 | 8,
        queued = true,
      ): Promise<PublishedSource> => {
        const requestId = randomUUID(),
          input = { ...body, clientRequestId: requestId };
        const call = (route: string) =>
          request(http)
            .post(route)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(input);
        const submitted = await call(
          path.replace('/v1/community/', '/v1/community/reviews/'),
        );
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.status, 'pending');
        const pending = (
          await pool.query<{ digest: string; envelope: unknown }>(
            'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        const envelope = canonicalEnvelope(pending.envelope);
        assert.equal(envelope.version, version);
        assert.equal(pending.digest, approvalDigest(envelope));
        await review({
          command: 'decide',
          accountId: actor.accountId,
          requestId,
          digest: pending.digest,
          decision: 'allow',
          basis: 'Inspected exact disposable reading source',
        });
        const result = await call(path);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.outcome, 'created');
        const id = result.body.resourceId as string;
        assert.match(id, /^[a-f0-9-]{36}$/);
        assert.deepEqual(
          (await call(path)).body,
          result.body,
          'Idempotency cannot duplicate enrollment',
        );
        assert.ok(
          (envelope.version === 6 ||
            envelope.version === 7 ||
            envelope.version === 8) &&
            envelope.textSource,
        );
        const sourceHash = createHash('sha256')
          .update(
            `whaleu-community-text-source:v1\n${envelope.textSource.format}\n${envelope.text}`,
          )
          .digest('hex');
        assert.equal(envelope.textSource.sourceHash, sourceHash);
        const snapshot = await immutable(kind, id);
        assert.ok(snapshot);
        assert.equal(snapshot.source.source_hash, sourceHash);
        assert.equal(snapshot.source.source_format, envelope.textSource.format);
        assert.equal(snapshot.source.source_revision, 1);
        assert.equal(snapshot.source.client_request_id, requestId);
        assert.equal(snapshot.canonical_text, envelope.text);
        assert.deepEqual(snapshot.binding.envelope, envelope);
        if (version === 6) {
          assert.equal(snapshot.home_post, null);
          assert.equal(snapshot.home_parent, null);
        } else {
          assert.ok(snapshot.home_post);
          if (version === 7) {
            assert.ok(envelope.version === 7);
            assert.equal(snapshot.home_post.post_id, id);
            assert.equal(
              snapshot.home_post.decision_id,
              snapshot.binding.decision_id,
            );
            assert.equal(snapshot.home_post.digest, pending.digest);
            assert.deepEqual(snapshot.home_post.evidence, envelope.home);
            assert.equal(snapshot.home_parent, null);
          } else {
            assert.ok(snapshot.home_parent);
            assert.equal(snapshot.home_parent.content_kind, kind);
            assert.equal(snapshot.home_parent.content_id, id);
            assert.equal(
              snapshot.home_parent.post_id,
              snapshot.home_post.post_id,
            );
            assert.equal(
              snapshot.home_parent.parent_decision_id,
              snapshot.home_post.decision_id,
            );
            assert.equal(
              snapshot.home_parent.parent_digest,
              snapshot.home_post.digest,
            );
            assert.equal(
              snapshot.home_parent.decision_id,
              snapshot.binding.decision_id,
            );
            assert.equal(snapshot.home_parent.digest, pending.digest);
          }
        }
        const jobs = (
          await pool.query(
            'SELECT job_key,state,claims,source_hash,source_revision,publication_request_id,formatter_version,generation FROM whaleu_community.reading_format_jobs WHERE content_kind=$1 AND content_id=$2',
            [kind, id],
          )
        ).rows;
        if (queued) {
          assert.deepEqual(jobs, [
            {
              job_key: jobKey(
                {
                  kind,
                  id,
                  sourceHash,
                  sourceRevision: 1,
                  publicationRequestId: requestId,
                },
                1,
              ),
              state: 'pending',
              claims: 0,
              source_hash: sourceHash,
              source_revision: 1,
              publication_request_id: requestId,
              formatter_version: FORMATTER,
              generation: 1,
            },
          ]);
        } else {
          assert.deepEqual(jobs, []);
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.reading_format_heads WHERE content_kind=$1 AND content_id=$2',
                [kind, id],
              )
            ).rows[0]!.n,
            0,
          );
        }
        return {
          kind,
          id,
          requestId,
          digest: pending.digest,
          text: envelope.text,
          sourceHash,
          version,
          immutable: snapshot,
        };
      };
      const postBody = (text: string) => ({
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        textSource: plain,
      });
      const graph = async (home: boolean) => {
        const post = await publish(
          'post',
          '/v1/community/posts',
          postBody(sourceText('post')),
          home ? 7 : 6,
        );
        const comment = await publish(
          'comment',
          `/v1/community/posts/${post.id}/comments`,
          {
            text: sourceText('comment'),
            imageAssetIds: [],
            authorMode: 'named',
            textSource: plain,
          },
          home ? 8 : 6,
        );
        const reply = await publish(
          'reply',
          `/v1/community/comments/${comment.id}/replies`,
          {
            targetReplyId: null,
            text: sourceText('reply'),
            imageAssetIds: [],
            authorMode: 'named',
            textSource: plain,
          },
          home ? 8 : 6,
        );
        return [post, comment, reply] as const;
      };
      assert.equal(
        (
          await pool.query(
            'SELECT whaleu_community.home_publication_current() value',
          )
        ).rows[0]!.value,
        null,
      );
      const old = await graph(false);
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
      const admit = async (evidenceRef: string) => {
        const proposal = { definition, evidenceRef, validForHours: 2 };
        const prepared = (await inTransaction(pool, (tx) =>
          configureHomeAdmission(
            { command: 'prepare', ...proposal },
            config,
            operatorName,
            tx,
          ),
        )) as Preparation;
        return inTransaction(pool, (tx) =>
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
      };
      await admit(
        'Disposable Home fixed-source admission for real reading-worker regression',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT whaleu_community.home_publication_current() value',
          )
        ).rows[0]!.value,
        null,
        'Metadata admission alone cannot activate Home publication',
      );
      const activation = (await inTransaction(pool, (tx) =>
        configureHomePublication(
          {
            command: 'prepare',
            evidenceRef:
              'Disposable formal installed0178 reading-worker fixture',
            validForHours: 1,
          },
          config,
          operatorName,
          tx,
        ),
      )) as Preparation;
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
      const home = await graph(true);
      const markdown = await publish(
        'post',
        '/v1/community/posts',
        {
          ...postBody(`**${sourceText('post')}**`),
          textSource: { version: 1, format: 'markdown' },
        },
        7,
        false,
      );
      const optedOut = await publish(
        'post',
        '/v1/community/posts',
        {
          ...postBody(sourceText('post')),
          textSource: { ...plain, readingFormatting: 'off' },
        },
        7,
        false,
      );

      login = await createReadingWorkerLogin(pool, database, docker);
      rolePool = new Pool(
        poolOptions(
          loadConfig({
            ...base,
            NODE_ENV: 'production',
            DATABASE_URL: login.database,
            PG_POOL_MAX: '1',
          }),
        ),
      );
      await t.test(
        'direct restricted TLS LOGIN retains the original0176 role contract and schema seal',
        async () => {
          const connection = await rolePool!.connect();
          try {
            assert.deepEqual(
              (
                await connection.query(
                  'SELECT current_user AS current,session_user AS session,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) ssl',
                )
              ).rows[0],
              { current: login!.name, session: login!.name, ssl: true },
            );
            await assertReadingWorkerRole(connection);
            for (const relation of homeReadRelations) {
              assert.deepEqual(
                (
                  await connection.query(
                    `SELECT has_table_privilege(current_user,$1,'SELECT') AS "select",
                  has_table_privilege(current_user,$1,'INSERT') AS "insert",
                  has_table_privilege(current_user,$1,'UPDATE') AS "update",
                  has_table_privilege(current_user,$1,'DELETE') AS "delete",
                  has_table_privilege(current_user,$1,'TRUNCATE') AS "truncate",
                  has_table_privilege(current_user,$1,'TRIGGER') AS "trigger",
                  has_table_privilege(current_user,$1,'REFERENCES') AS "references",
                  has_table_privilege(current_user,$1,'MAINTAIN') AS "maintain",
                  has_any_column_privilege(current_user,$1,'INSERT') AS "columnInsert",
                  has_any_column_privilege(current_user,$1,'UPDATE') AS "columnUpdate",
                  has_any_column_privilege(current_user,$1,'REFERENCES') AS "columnReferences"`,
                    [relation],
                  )
                ).rows[0],
                {
                  select: true,
                  insert: false,
                  update: false,
                  delete: false,
                  truncate: false,
                  trigger: false,
                  references: false,
                  maintain: false,
                  columnInsert: false,
                  columnUpdate: false,
                  columnReferences: false,
                },
                relation,
              );
            }
            const schema = await inspectReadingSchema(connection);
            assert.equal(schema.status, 'ready');
            assert.ok(schema.status === 'ready');
            assert.match(schema.homeCatalog ?? '', /^[a-f0-9]{64}$/);
            const seals = (
              await connection.query<{
                original: string;
                home: string;
                actual_home: string;
              }>(
                `SELECT whaleu_community.reading_format_protocol()->>'catalog' original,
                whaleu_community.home_reading_protocol()->>'catalog' home,
                whaleu_community.home_reading_catalog() actual_home`,
              )
            ).rows[0]!;
            assert.equal(seals.home, seals.actual_home);
            assert.equal(schema.homeCatalog, seals.home);
            assert.equal(
              schema.catalog,
              createHash('sha256')
                .update(
                  `whaleu-reading-home-schema:v1\n${seals.original}\n${seals.home}`,
                )
                .digest('hex'),
            );
            assert.equal(
              (
                await connection.query(
                  "SELECT whaleu_community.reading_format_protocol()->>'catalog'=whaleu_community.reading_format_catalog() valid",
                )
              ).rows[0]!.valid,
              true,
            );
          } finally {
            connection.release();
          }
        },
      );
      const launch = (entry: 'source' | 'compiled') => {
        const env = readingCliEnvironment(
          apiRoot,
          login!.database,
          'once',
          process.env,
        );
        assert.equal(env['NODE_ENV'], 'production');
        assert.equal(env['PG_SSL_MODE'], 'verify-full');
        assert.equal(env['COMMUNITY_TEXT_REVIEW'], 'disabled');
        // Four bounded ticks suffice for six sources with the unchanged two-claim
        // limit. This changes only CLI cycle count, not100/500ms owner budgets.
        const child = startReadingCli(apiRoot, entry, 'once', {
          ...env,
          COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: '4',
        });
        children.push(child);
        return child.done;
      };
      const success = (result: Awaited<ReturnType<typeof launch>>) => {
        assert.equal(result.problem, null);
        assert.equal(result.signal, null);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, 'empty');
        assert.equal(result.health.at(-1)?.state, 'stopped');
        assert.ok(result.health.some((h) => h.ticks >= 1));
      };
      const complete = async (source: PublishedSource) => {
        const row = (
          await pool.query(
            `SELECT j.state,j.claims,j.source_hash,j.source_revision,j.publication_request_id,j.formatter_version,j.generation,r.plan,r.lease_fence::text,j.lease_fence::text job_fence FROM whaleu_community.reading_format_jobs j LEFT JOIN whaleu_community.reading_format_results r USING(job_key) WHERE j.content_kind=$1 AND j.content_id=$2`,
            [source.kind, source.id],
          )
        ).rows[0];
        assert.ok(row);
        assert.equal(
          row.state,
          'complete',
          `${source.version}:${source.kind} must actually finish, not merely pass CLI health`,
        );
        assert.equal(row.claims, 1);
        assert.equal(row.source_hash, source.sourceHash);
        assert.equal(row.source_revision, 1);
        assert.equal(row.publication_request_id, source.requestId);
        assert.equal(row.formatter_version, FORMATTER);
        assert.equal(row.generation, 1);
        assert.equal(row.lease_fence, row.job_fence);
        const plan = planSchema.parse(row.plan);
        const expected = formatSource({
          kind: source.kind,
          id: source.id,
          sourceRevision: 1,
          sourceHash: source.sourceHash,
          publicationRequestId: source.requestId,
          text: source.text,
          descriptor: plain,
        });
        assert.equal(expected.kind, 'plan');
        assert.ok(expected.kind === 'plan');
        assert.deepEqual(plan, expected.plan);
        assert.equal(plan.mode, 'grouped');
        assert.equal(
          plan.spans
            .map((span) => source.text.slice(span.start, span.end))
            .join(''),
          source.text,
        );
        assert.deepEqual(
          await immutable(source.kind, source.id),
          source.immutable,
          'Worker must not mutate any source/binding/canonical text',
        );
      };
      const unclaimed = async (
        sources: readonly PublishedSource[],
        probed = false,
      ) => {
        for (const source of sources) {
          const row = (
            await pool.query(
              `SELECT j.state,j.claims,(r.job_key IS NOT NULL) result,j.schedule_state,j.scheduling_reason,j.probe_count FROM whaleu_community.reading_format_jobs j LEFT JOIN whaleu_community.reading_format_results r USING(job_key) WHERE j.content_kind=$1 AND j.content_id=$2`,
              [source.kind, source.id],
            )
          ).rows[0]!;
          assert.equal(row.state, 'pending');
          assert.equal(row.claims, 0);
          assert.equal(row.result, false);
          if (probed) {
            assert.equal(row.scheduling_reason, 'authority_unavailable');
            assert.ok(row.probe_count >= 1 && row.probe_count <= 3);
            assert.ok(['deferred', 'quarantined'].includes(row.schedule_state));
          } else {
            assert.equal(row.probe_count, 0);
            assert.equal(row.schedule_state, 'runnable');
            assert.equal(row.scheduling_reason, null);
          }
          assert.deepEqual(
            await immutable(source.kind, source.id),
            source.immutable,
          );
        }
      };
      await t.test(
        'official migration exclusive gate rejects an actual restricted managed claim without waiting or writes',
        async () => {
          const runtime = app!.get(ReadingFormattingRuntime),
            databaseService = app!.get(DatabaseService);
          const candidate = (await runtime.candidates(null)).find(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'content_id' in value &&
              value.content_id === home[0].id,
          );
          assert.ok(candidate);
          const migrator = await pool.connect();
          let held = false;
          try {
            held = (
              await migrator.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1,$2) locked',
                [...MIGRATION_LOCK],
              )
            ).rows[0]!.locked;
            assert.equal(held, true);
            const started = performance.now();
            // Existing test-only SET LOCAL ROLE wrapper preserves the real owner
            // policy/finalizer and keeps the role through COMMIT or ROLLBACK.
            await assert.rejects(
              withReadingWorkerRole(databaseService, login!.name, () =>
                runtime.claim(candidate),
              ),
              { code: 'COMMUNITY_UNAVAILABLE' },
            );
            assert.ok(
              performance.now() - started < 500,
              'Nonblocking migration gate must reject within the existing500ms owner budget',
            );
            await unclaimed([...old, ...home]);
          } finally {
            try {
              if (held)
                assert.equal(
                  (
                    await migrator.query<{ unlocked: boolean }>(
                      'SELECT pg_advisory_unlock($1,$2) unlocked',
                      [...MIGRATION_LOCK],
                    )
                  ).rows[0]!.unlocked,
                  true,
                );
            } finally {
              migrator.release(true);
            }
          }
        },
      );
      await t.test(
        'direct restricted managed reading retains the shared migration gate through COMMIT and ROLLBACK',
        async () => {
          const migrator = await pool.connect();
          const rollback = new Error('Intentional disposable reading rollback');
          const tryMigration = async () =>
            (
              await migrator.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1,$2) locked',
                [...MIGRATION_LOCK],
              )
            ).rows[0]!.locked;
          let held = false;
          try {
            for (const ending of ['commit', 'rollback']) {
              const reading = inTransaction(
                rolePool!,
                async (tx) => {
                  assert.equal(
                    (
                      await tx.query<{ principal: string }>(
                        'SELECT current_user principal',
                      )
                    ).rows[0]!.principal,
                    login!.name,
                  );
                  await requireReadingSchema(tx);
                  held = await tryMigration();
                  assert.equal(
                    held,
                    false,
                    `${ending}: migration must not enter the live reading transaction`,
                  );
                  if (ending === 'rollback') throw rollback;
                },
                { isolationLevel: 'read committed' },
              );
              if (ending === 'rollback')
                await assert.rejects(reading, (error) => error === rollback);
              else await reading;
              held = await tryMigration();
              assert.equal(
                held,
                true,
                `${ending}: completed transaction must release the shared gate`,
              );
              assert.equal(
                (
                  await migrator.query<{ unlocked: boolean }>(
                    'SELECT pg_advisory_unlock($1,$2) unlocked',
                    [...MIGRATION_LOCK],
                  )
                ).rows[0]!.unlocked,
                true,
              );
              held = false;
            }
          } finally {
            try {
              if (held)
                await migrator.query('SELECT pg_advisory_unlock($1,$2)', [
                  ...MIGRATION_LOCK,
                ]);
            } finally {
              migrator.release(true);
            }
          }
          // This is cooperative protection against the official migrator. A DBA
          // bypassing that migration gate remains an explicitly trusted boundary.
          await unclaimed([...old, ...home]);
        },
      );
      await t.test(
        'catalog drift rejects the real production CLI before any tick without resealing',
        async () => {
          const originalCost = Number(
            (
              await pool.query<{ cost: number }>(
                "SELECT procost cost FROM pg_proc WHERE oid='whaleu_community.reading_format_plan(text)'::regprocedure",
              )
            ).rows[0]!.cost,
          );
          assert.ok(Number.isFinite(originalCost) && originalCost > 0);
          try {
            await pool.query(
              `ALTER FUNCTION whaleu_community.reading_format_plan(text) COST ${originalCost + 1}`,
            );
            const result = await launch('source');
            assert.equal(result.problem, null);
            assert.equal(result.signal, null);
            assert.equal(result.code, 1);
            assert.equal(result.stderr, 'expected_failure');
            assert.deepEqual(
              result.health.map((h) => h.state),
              ['starting', 'failed'],
            );
            assert.ok(result.health.every((h) => h.ticks === 0));
            await unclaimed([...old, ...home]);
          } finally {
            await pool.query(
              `ALTER FUNCTION whaleu_community.reading_format_plan(text) COST ${originalCost}`,
            );
          }
        },
      );
      const assertSealedBeforeTick = async () => {
        const result = await launch('source');
        assert.equal(result.problem, null);
        assert.equal(result.signal, null);
        assert.equal(result.code, 1);
        assert.equal(result.stderr, 'expected_failure');
        assert.deepEqual(
          result.health.map((h) => h.state),
          ['starting', 'failed'],
        );
        assert.ok(result.health.every((h) => h.ticks === 0));
        await unclaimed([...old, ...home]);
      };
      for (const [relation, trigger] of [
        ['home_post_dispositions', 'home_post_dispositions_immutable'],
        ['home_discussion_parent_bindings', 'home_discussion_parent_immutable'],
        ['home_post_dispositions', 'home_metadata_insert_guard'],
        ['home_discussion_parent_bindings', 'home_metadata_insert_guard'],
      ])
        await t.test(
          `Home seal rejects disabled ${relation}.${trigger} before any real CLI tick`,
          async () => {
            try {
              await pool.query(
                `ALTER TABLE whaleu_community.${relation} DISABLE TRIGGER ${trigger}`,
              );
              await assertSealedBeforeTick();
            } finally {
              await pool.query(
                `ALTER TABLE whaleu_community.${relation} ENABLE TRIGGER ${trigger}`,
              );
            }
          },
        );
      for (const [signature, drift] of [
        [
          'home_metadata_insert_guard()',
          'CREATE OR REPLACE FUNCTION whaleu_community.home_metadata_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$',
        ],
        [
          'home_definition(text,uuid,jsonb)',
          'CREATE OR REPLACE FUNCTION whaleu_community.home_definition(kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RETURN NULL;END$$',
        ],
      ])
        await t.test(
          `Home seal rejects altered ${signature} body before any real CLI tick`,
          async () => {
            const original = (
              await pool.query<{ definition: string }>(
                'SELECT pg_get_functiondef($1::regprocedure) definition',
                [`whaleu_community.${signature}`],
              )
            ).rows[0]!.definition;
            try {
              await pool.query(drift!);
              await assertSealedBeforeTick();
            } finally {
              await pool.query(original);
            }
          },
        );
      await t.test(
        'actual source CLI completes preactivation V6 and activated V7/V8 sources with exact immutable plans',
        async () => {
          success(await launch('source'));
          for (const source of [...old, ...home]) await complete(source);
        },
      );
      if (phase === 'source_and_compiled')
        await t.test(
          'ordinary compiled production CLI completes an independently published V7/V8 graph',
          async () => {
            const built = await graph(true);
            success(await launch('compiled'));
            for (const source of built) await complete(source);
          },
        );
      await t.test(
        'Markdown and explicit off never enqueue or change source during worker processing',
        async () => {
          for (const source of [markdown, optedOut]) {
            assert.equal(
              (
                await pool.query<{ n: number }>(
                  'SELECT count(*)::integer n FROM whaleu_community.reading_format_jobs WHERE content_kind=$1 AND content_id=$2',
                  [source.kind, source.id],
                )
              ).rows[0]!.n,
              0,
            );
            assert.deepEqual(
              await immutable(source.kind, source.id),
              source.immutable,
            );
          }
        },
      );
      await t.test(
        'fresh-publication guard blocks same-key late insertion and historical V6 absent-to-present Home metadata',
        async () => {
          const rejected = async (sql: string, values: unknown[]) => {
            await assert.rejects(
              inTransaction(pool, (tx) => tx.query(sql, values)),
              {
                code: '23514',
                constraint: 'home_publication_causal',
                message: 'Home evidence requires fresh exact publication',
              },
            );
          };
          await rejected(
            `INSERT INTO whaleu_community.home_post_dispositions(post_id,decision_id,digest,evidence,publication_transaction)
           SELECT post_id,decision_id,digest,evidence,pg_current_xact_id() FROM whaleu_community.home_post_dispositions WHERE post_id=$1`,
            [home[0].id],
          );
          for (const source of home.slice(1))
            await rejected(
              `INSERT INTO whaleu_community.home_discussion_parent_bindings(content_kind,content_id,post_id,parent_decision_id,parent_digest,decision_id,digest,publication_transaction)
           SELECT content_kind,content_id,post_id,parent_decision_id,parent_digest,decision_id,digest,pg_current_xact_id()
           FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=$1 AND content_id=$2`,
              [source.kind, source.id],
            );
          await rejected(
            `INSERT INTO whaleu_community.home_post_dispositions(post_id,decision_id,digest,evidence,publication_transaction)
           SELECT b.content_id,b.decision_id,b.digest,h.evidence,pg_current_xact_id()
           FROM whaleu_community.content_approval_bindings b CROSS JOIN whaleu_community.home_post_dispositions h
           WHERE b.content_kind='post' AND b.content_id=$1 AND h.post_id=$2`,
            [old[0].id, home[0].id],
          );
          for (const source of old.slice(1))
            await rejected(
              `INSERT INTO whaleu_community.home_discussion_parent_bindings(content_kind,content_id,post_id,parent_decision_id,parent_digest,decision_id,digest,publication_transaction)
           SELECT b.content_kind,b.content_id,h.post_id,h.decision_id,h.digest,b.decision_id,b.digest,pg_current_xact_id()
           FROM whaleu_community.content_approval_bindings b CROSS JOIN whaleu_community.home_post_dispositions h
           WHERE b.content_kind=$1 AND b.content_id=$2 AND h.post_id=$3`,
              [source.kind, source.id, home[0].id],
            );
          for (const source of [...old, ...home])
            assert.deepEqual(
              await immutable(source.kind, source.id),
              source.immutable,
            );
        },
      );
      await t.test(
        'owner-pool replacement, deletion and truncation hit immutable guards rather than a worker privilege denial',
        async () => {
          const attempts = [
            {
              sql: 'UPDATE whaleu_community.home_post_dispositions SET digest=$2 WHERE post_id=$1',
              values: [home[0].id, '0'.repeat(64)],
            },
            {
              sql: 'UPDATE whaleu_community.home_discussion_parent_bindings SET post_id=$2,parent_decision_id=$3,parent_digest=$4 WHERE content_kind=$1 AND content_id=$5',
              values: [
                'comment',
                randomUUID(),
                randomUUID(),
                '0'.repeat(64),
                home[1].id,
              ],
            },
            {
              sql: 'UPDATE whaleu_community.home_discussion_parent_bindings SET post_id=$2,parent_decision_id=$3,parent_digest=$4 WHERE content_kind=$1 AND content_id=$5',
              values: [
                'reply',
                randomUUID(),
                randomUUID(),
                '0'.repeat(64),
                home[2].id,
              ],
            },
            {
              sql: 'DELETE FROM whaleu_community.home_discussion_parent_bindings WHERE content_id=$1',
              values: [home[1].id],
            },
            {
              sql: 'DELETE FROM whaleu_community.home_post_dispositions WHERE post_id=$1',
              values: [home[0].id],
            },
            {
              sql: 'TRUNCATE whaleu_community.home_discussion_parent_bindings',
              values: [],
            },
            {
              sql: 'TRUNCATE whaleu_community.home_post_dispositions,whaleu_community.home_discussion_parent_bindings',
              values: [],
            },
          ];
          for (const attempt of attempts)
            await assert.rejects(
              inTransaction(pool, (tx) =>
                tx.query(attempt.sql, attempt.values),
              ),
              {
                code: '23514',
                message: 'Content approval evidence is immutable',
              },
            );
          for (const source of [...old, ...home])
            assert.deepEqual(
              await immutable(source.kind, source.id),
              source.immutable,
            );
        },
      );
      await t.test(
        'owner-pool fault injection after constraint drain rolls back a real completion and Home dependency DDL',
        async () => {
          // Supplemental adversarial owner-pool transaction, NOT a claim that the
          // restricted production LOGIN can perform DDL or mutate Home metadata.
          // The CLI source/compiled lanes above separately prove its real powers.
          const target = await publish(
            'post',
            '/v1/community/posts',
            postBody(sourceText('post')),
            7,
          );
          const runtime = app!.get(ReadingFormattingRuntime);
          const candidate = (await runtime.candidates(null)).find(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'content_id' in value &&
              value.content_id === target.id,
          );
          assert.ok(candidate);
          const claim = await runtime.claim(candidate);
          assert.ok(claim);
          const computed = formatSource(claim.source);
          assert.ok(computed.kind === 'plan');
          const state = async () =>
            (
              await pool.query(
                `SELECT to_jsonb(j) job,to_jsonb(s) slot,(SELECT to_jsonb(r) FROM whaleu_community.reading_format_results r WHERE r.job_key=j.job_key) result
           FROM whaleu_community.reading_format_jobs j JOIN whaleu_community.reading_format_slots s ON s.slot_id=j.slot_id WHERE j.job_key=$1`,
                [claim.key],
              )
            ).rows[0];
          const before = await state();
          assert.ok(before);
          assert.equal(before.job.state, 'running');
          assert.equal(before.job.claims, 1);
          assert.equal(before.result, null);
          const originalCost = Number(
            (
              await pool.query<{ cost: number }>(
                "SELECT procost cost FROM pg_proc WHERE oid='whaleu_community.home_definition(text,uuid,jsonb)'::regprocedure",
              )
            ).rows[0]!.cost,
          );
          assert.ok(Number.isFinite(originalCost) && originalCost > 0);
          const databaseService = app!.get(DatabaseService),
            originalMethod = databaseService.transaction,
            original = originalMethod.bind(databaseService);
          let injected = false;
          databaseService.transaction = (operation, options) =>
            original(async (tx) => {
              const result = await operation(tx);
              assert.equal(
                result,
                true,
                'The genuine completion must reach its tentative successful callback',
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                `ALTER FUNCTION whaleu_community.home_definition(text,uuid,jsonb) COST ${originalCost + 1}`,
              );
              injected = true;
              return result;
            }, options);
          try {
            await assert.rejects(runtime.complete(claim, computed.plan), {
              code: 'COMMUNITY_UNAVAILABLE',
            });
            assert.equal(injected, true);
          } finally {
            databaseService.transaction = originalMethod;
          }
          assert.deepEqual(
            await state(),
            before,
            'Failed final proof rolls back result, job transition and slot release',
          );
          assert.equal(
            Number(
              (
                await pool.query<{ cost: number }>(
                  "SELECT procost cost FROM pg_proc WHERE oid='whaleu_community.home_definition(text,uuid,jsonb)'::regprocedure",
                )
              ).rows[0]!.cost,
            ),
            originalCost,
            'DDL rolls back in the same managed transaction',
          );
          assert.deepEqual(
            await immutable(target.kind, target.id),
            target.immutable,
          );
          assert.equal(
            await runtime.complete(claim, computed.plan),
            true,
            'Unmodified same lease/claim remains usable after rollback',
          );
          await complete(target);
        },
      );
      await t.test(
        'revoked V7 parent prevents actual claims/results for itself and both V8 descendants',
        async () => {
          const revoked = await graph(true);
          await review({
            command: 'withdraw',
            accountId: actor.accountId,
            requestId: revoked[0].requestId,
            digest: revoked[0].digest,
            state: 'revoked',
            basis: 'Disposable exact parent revocation before worker claim',
          });
          success(await launch('source'));
          await unclaimed(revoked, true);
        },
      );
      await t.test(
        'inactive publication scope prevents actual claims/results for pending V7/V8 sources',
        async () => {
          const inactive = await graph(true);
          // Existing disposable scope-owner fixture action, not a manufactured
          // Review/activation/source/job or an account-lifecycle shortcut.
          await pool.query(
            'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
            [scope.home.spaceId],
          );
          try {
            success(await launch('source'));
            await unclaimed(inactive, true);
          } finally {
            await pool.query(
              'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
              [scope.home.spaceId],
            );
          }
        },
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_community.reading_format_slots WHERE job_key IS NOT NULL',
          )
        ).rows[0]!.n,
        0,
      );
      const checked = await rolePool.connect();
      try {
        await assertReadingWorkerRole(checked);
        assert.equal((await inspectReadingSchema(checked)).status, 'ready');
      } finally {
        checked.release();
      }
    } catch (error) {
      failure = error;
    }
    const cleanup: unknown[] = [];
    for (const child of children) {
      try {
        await child.stop();
      } catch {
        cleanup.push(new Error('Reading CLI child cleanup failed'));
      }
    }
    try {
      await rolePool?.end();
    } catch {
      cleanup.push(new Error('Restricted role pool cleanup failed'));
    }
    try {
      await app?.close();
    } catch {
      cleanup.push(new Error('Application cleanup failed'));
    }
    if (login) {
      try {
        assert.equal(
          (
            await pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM pg_stat_activity WHERE usename=$1',
              [login.name],
            )
          ).rows[0]!.n,
          0,
        );
        await login.close();
        assert.equal(
          (
            await pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM pg_roles WHERE rolname=$1',
              [login.name],
            )
          ).rows[0]!.n,
          0,
        );
      } catch {
        cleanup.push(new Error('Disposable LOGIN role cleanup failed'));
      }
    }
    if (owned)
      for (const schema of migrationSchemaNames) {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } catch {
          cleanup.push(new Error('Disposable schema cleanup failed'));
        }
      }
    if (locked) {
      try {
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      } catch {
        cleanup.push(new Error('Fixture lock cleanup failed'));
      }
    }
    suite?.release();
    try {
      await pool.end();
    } catch {
      cleanup.push(new Error('Administrator pool cleanup failed'));
    }
    if (cleanup.length)
      throw new AggregateError(
        failure === undefined ? cleanup : [failure, ...cleanup],
        'Home reading-worker fixture cleanup failed',
      );
    if (failure !== undefined) throw failure;
  },
);
