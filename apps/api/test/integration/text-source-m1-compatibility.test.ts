import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ConfigurationModule, loadConfig } from '../../src/config/config.js';
import { ObservabilityModule } from '../../src/observability/logger.js';
import { AccountPolicyModule } from '../../src/safety/account-policy/module.js';
import {
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  runMigrations,
} from '../../src/database/migrations.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { configureHttp } from '../../src/http/http.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../../src/community/content-review/contracts.js';
import type { EffectiveContentEnvelopeV6 } from '../../src/community/content-review/contracts.js';
import {
  sourceDescriptor,
  sourceOriginalIntentHash,
} from '../../src/community/text-source/protocol.js';
import { prepareTextSource } from '../../src/community/text-source/source.js';
import type {
  TextSourceDescriptor,
  TextSourceKind,
} from '../../src/community/text-source/contracts.js';
import {
  readingPostDetailSchema,
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingCommentsPageSchema,
  readingRepliesPageSchema,
  readingContextSchema,
} from '../../src/community/reading-content/contracts.js';
import { inspectReadingSchema } from '../../src/community/reading-formatting/readiness.js';
import { textSourceReadV2Schema } from '../../src/community/reading-formatting/reader.js';
import { installM1ProducerMapping } from '../support/historical-m1/loader.js';
import {
  M1_SYNTHETIC_APP,
  inspectExactM1,
  readExactM1Migrations,
  requireM1TestConfig,
} from '../support/historical-m1/boundary.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Compatibility, NOT current registration or production/TLS acceptance.
 * The real immutable 0001..0175 schema has no 0176/0177/0178/0179/0180 objects.
 * Only lifecycle-aware historical Identity and pre-Home PublicationService are
 * saved producers, with the pinned original source-helper module mapped only
 * at the two producer import edges. Review, receipts, source storage, native HTTP controllers,
 * canonical readers and mandatory access proofs are the CURRENT implementations.
 * No account/decision/source rows are seeded. Identity/scope facts are synthetic.
 */
test(
  'exact M1 historical producers / current native readers preserve reviewed source without later owners',
  { timeout: 240000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Explicit disposable TEST_DATABASE_URL required');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const initial = loadConfig(base);
    requireM1TestConfig(initial);
    const pool = new Pool(poolOptions(initial));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let owns = false,
      locked = false;
    let producerMapping:
      ReturnType<typeof installM1ProducerMapping> | undefined;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
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
      await runMigrations(pool, await readExactM1Migrations(), { mode: 'up' });
      const scope = await seedCommunityScope(pool);
      const operatorId = 'manual:synthetic:m1-compatibility';
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: operatorId,
      });
      producerMapping = installM1ProducerMapping(config);
      const [{ CommunityModule }, { configureHistoricalM1 }] =
        await Promise.all([
          import('../../src/community/community.module.js'),
          import('../support/historical-m1/configure.js'),
        ]);
      producerMapping.assertComplete();
      // Narrow test root, no saved AppModule and no alternate HTTP/read owner.
      const builder = Test.createTestingModule({
        imports: [
          ConfigurationModule.register(config),
          ObservabilityModule,
          AccountPolicyModule,
          CommunityModule,
        ],
      });
      await configureHistoricalM1(builder, config);
      const module = await builder.compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const db = app.get(DatabaseService);
      await db.transaction(async (tx) => {
        await inspectExactM1(tx);
        assert.deepEqual(await inspectReadingSchema(tx), { status: 'missing' });
      });
      const accessToken = mintToken('access');
      const actor = await app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: M1_SYNTHETIC_APP,
          subject: randomUUID(),
        },
        {
          access: hashToken(accessToken),
          refresh: hashToken(mintToken('refresh')),
        },
      );
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
      const http = app.getHttpServer(),
        auth = `Bearer ${accessToken}`;
      const get = (path: string) =>
        request(http).get(path).set('Authorization', auth);
      const post = (path: string, body: Record<string, unknown>) =>
        request(http).post(path).set('Authorization', auth).send(body);
      const runtime = app.get(TextReviewRuntime);
      const operator = new TextReviewOperator(runtime, operatorId);
      const run = (command: Parameters<TextReviewOperator['run']>[0]) =>
        db.transaction((tx) => operator.run(command, tx));
      const capability = `/v1/community/text-source-capabilities?spaceId=${scope.home.spaceId}&category=discussion&authorMode=named`;
      assert.equal((await get(capability)).body.availability, 'unavailable');
      await run({
        command: 'init-source-policy',
        basis: 'Synthetic exact-M1 source compatibility policy',
      });
      assert.equal((await get(capability)).body.availability, 'available');
      assert.equal(runtime.configured(), false);
      for (const command of [
        'init-policy',
        'init-related-policy',
        'init-feedback',
      ] as const)
        await assert.rejects(
          run({ command, basis: 'Unrelated review must remain unavailable' }),
        );
      await assert.rejects(
        db.transaction((tx) =>
          new TextReviewOperator(runtime, 'manual:wrong:reviewer').run(
            { command: 'list' },
            tx,
          ),
        ),
      );

      const prepare = async (path: string, body: Record<string, unknown>) => {
        const response = await post(
          path.replace('/v1/community/', '/v1/community/reviews/'),
          body,
        );
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'pending');
      };
      const decide = async (
        body: Record<string, unknown>,
        kind: TextSourceKind,
        decision: 'allow' | 'reject',
      ) => {
        const displayed = (await run({
          command: 'show',
          accountId: actor.accountId,
          requestId: String(body['clientRequestId']),
        })) as { digest: string; envelope: EffectiveContentEnvelopeV6 };
        const envelope = canonicalEnvelope(displayed.envelope);
        assert.equal(envelope.version, 6);
        if (envelope.version !== 6)
          assert.fail('Expected immutable V6 source evidence');
        const expected = prepareTextSource(
          body['text'],
          body['textSource'],
          kind,
        );
        assert.ok(expected);
        assert.equal(envelope.text, expected.canonicalText);
        assert.deepEqual(
          sourceDescriptor(envelope.textSource),
          expected.descriptor,
        );
        assert.equal(envelope.textSource.sourceHash, expected.sourceHash);
        assert.equal(displayed.digest, approvalDigest(envelope));
        const stored = (
          await db.query(
            'SELECT envelope,digest,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, body['clientRequestId']],
          )
        ).rows[0]!;
        assert.equal(
          canonicalJson(stored['envelope']),
          canonicalJson(envelope),
        );
        assert.equal(stored['digest'], displayed.digest);
        assert.equal(
          stored['intent_hash'],
          sourceOriginalIntentHash(envelope, 'named'),
        );
        await run({
          command: 'decide',
          accountId: actor.accountId,
          requestId: String(body['clientRequestId']),
          digest: displayed.digest,
          decision,
          basis:
            'Synthetic reviewer checked exact canonical source, descriptor and digest',
        });
        return { digest: displayed.digest, expected, envelope };
      };
      const expectedSources = new Map<
        string,
        ReturnType<typeof prepareTextSource>
      >();
      const publish = async (
        path: string,
        body: Record<string, unknown>,
        kind: TextSourceKind,
      ) => {
        await prepare(path, body);
        const reviewed = await decide(body, kind, 'allow');
        const first = await post(path, body);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(first.body.outcome, 'created');
        const id = first.body.resourceId as string;
        expectedSources.set(id, reviewed.expected);
        // Preserve the original M1-only V2 source-read guarantee using genuine
        // historical producers, not a current application on an old schema.
        const sourceRead = await request(http)
          .get(`/v2/community/text-sources/${kind}/${id}`)
          .set('Authorization', auth);
        assert.equal(sourceRead.status, 200, JSON.stringify(sourceRead.body));
        const decodedSource = textSourceReadV2Schema.parse(sourceRead.body);
        assert.deepEqual(decodedSource.presentation, { status: 'source' });
        assert.equal(
          decodedSource.source.text,
          reviewed.expected.canonicalText,
        );
        assert.equal(decodedSource.source.classification, 'reviewedSource');
        if (decodedSource.source.classification !== 'reviewedSource')
          throw new Error('Expected reviewed historical source');
        assert.deepEqual(decodedSource.source.textSource, {
          ...reviewed.expected.descriptor,
          sourceHash: reviewed.expected.sourceHash,
        });
        assert.deepEqual(await inspectReadingSchema(suite!), {
          status: 'missing',
        });
        assert.deepEqual((await post(path, body)).body, first.body);
        // CRLF normalization is the existing source contract, not trimming/NFC.
        assert.deepEqual(
          (await post(path, { ...body, text: reviewed.expected.canonicalText }))
            .body,
          first.body,
        );
        assert.equal(
          (
            await post(path, {
              ...body,
              text: String(body['text']) + ' changed',
            })
          ).status,
          409,
        );
        const stored = (
          await db.query(
            `SELECT s.source_hash,s.original_intent_hash,s.approval_digest,s.source_format,s.reading_formatting,
            d.issuer,d.provenance_ref,d.envelope,d.envelope_version,b.envelope binding,p.receipt
           FROM whaleu_community.community_text_sources s
           JOIN whaleu_community.content_approval_decisions d ON d.id=s.decision_id
           JOIN whaleu_community.content_approval_bindings b ON b.content_kind=s.content_kind AND b.content_id=s.content_id
           JOIN whaleu_community.publication_requests p ON p.account_id=s.account_id AND p.client_request_id=s.client_request_id
           WHERE s.content_kind=$1 AND s.content_id=$2`,
            [kind, id],
          )
        ).rows[0]!;
        assert.equal(stored['source_hash'], reviewed.expected.sourceHash);
        assert.equal(
          stored['original_intent_hash'],
          sourceOriginalIntentHash(reviewed.envelope, 'named'),
        );
        assert.equal(stored['approval_digest'], reviewed.digest);
        assert.equal(
          stored['source_format'],
          reviewed.expected.descriptor.format,
        );
        assert.equal(
          stored['reading_formatting'],
          reviewed.expected.descriptor.format === 'plain'
            ? reviewed.expected.descriptor.readingFormatting
            : null,
        );
        assert.equal(stored['issuer'], operatorId);
        assert.ok(String(stored['provenance_ref']).includes(operatorId));
        assert.equal(stored['envelope_version'], 6);
        assert.equal(
          canonicalJson(stored['envelope']),
          canonicalJson(reviewed.envelope),
        );
        assert.equal(
          canonicalJson(stored['binding']),
          canonicalJson(reviewed.envelope),
        );
        assert.deepEqual(stored['receipt'], first.body);
        return { id, path, body, receipt: first.body, digest: reviewed.digest };
      };
      const assertSources = (value: unknown): number => {
        if (value === null || typeof value !== 'object') return 0;
        const object = value as Record<string, unknown>;
        let count = 0;
        if (
          object['classification'] === 'reviewedSource' &&
          'value' in object
        ) {
          const reading = object['value'] as {
            source: { id: string; text: string; textSource: unknown };
            presentation: unknown;
          };
          const expected = expectedSources.get(reading.source.id);
          assert.ok(expected, 'No unproved or fabricated source may appear');
          assert.equal(reading.source.text, expected.canonicalText);
          assert.deepEqual(reading.source.textSource, {
            ...expected.descriptor,
            sourceHash: expected.sourceHash,
          });
          assert.deepEqual(reading.presentation, { status: 'source' });
          count++;
        }
        for (const nested of Object.values(object))
          count += assertSources(nested);
        return count;
      };
      const roots: Awaited<ReturnType<typeof publish>>[] = [];
      for (const textSource of [
        { version: 1, format: 'plain', readingFormatting: 'auto' },
        { version: 1, format: 'plain', readingFormatting: 'off' },
        { version: 1, format: 'markdown' },
      ] satisfies TextSourceDescriptor[]) {
        const text = `  e\u0301 ${textSource.format === 'markdown' ? '**authored**' : 'authored'}\r\n${'鲸'.repeat(300)}  `;
        const root = await publish(
          '/v1/community/posts',
          {
            clientRequestId: randomUUID(),
            spaceId: scope.home.spaceId,
            category: 'discussion',
            text,
            imageAssetIds: [],
            authorMode: 'named',
            commentsPolicy: 'open',
            allowAnonymousDm: false,
            textSource,
          },
          'post',
        );
        roots.push(root);
        const child = await publish(
          `/v1/community/posts/${root.id}/comments`,
          {
            clientRequestId: randomUUID(),
            text,
            imageAssetIds: [],
            authorMode: 'named',
            textSource,
          },
          'comment',
        );
        const reply = await publish(
          `/v1/community/comments/${child.id}/replies`,
          {
            clientRequestId: randomUUID(),
            text,
            imageAssetIds: [],
            authorMode: 'named',
            targetReplyId: null,
            textSource,
          },
          'reply',
        );
        const endpoints = [
          [`posts/${root.id}`, readingPostDetailSchema],
          [
            `posts/${root.id}/comments?sort=time&order=asc&previewLimit=5`,
            readingCommentsPageSchema,
          ],
          [`comments/${child.id}`, readingCommentDetailSchema],
          [`comments/${child.id}/replies`, readingRepliesPageSchema],
          [`replies/${reply.id}`, readingReplyDetailSchema],
          [
            `posts/${root.id}/discussion-context?replyId=${reply.id}`,
            readingContextSchema,
          ],
        ] as const;
        for (const [path, schema] of endpoints) {
          const url = `/v2/community/${path}`;
          const response = await get(url);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          schema.parse(response.body);
          assert.ok(assertSources(response.body) > 0);
          assert.equal(response.headers['cache-control'], 'no-store');
          const unauthenticated = await request(http).get(url);
          assert.equal(unauthenticated.status, 401);
          assert.equal(assertSources(unauthenticated.body), 0);
        }
        // Real immutable storage, not a mocked successful Review decision.
        await assert.rejects(
          db.query(
            'UPDATE whaleu_community.community_text_sources SET source_hash=source_hash WHERE content_id=$1',
            [root.id],
          ),
        );
        await assert.rejects(
          db.query(
            'UPDATE whaleu_community.content_approval_decisions SET digest=digest WHERE account_id=$1',
            [actor.accountId],
          ),
        );
        await run({
          command: 'withdraw',
          accountId: actor.accountId,
          requestId: String(root.body['clientRequestId']),
          digest: root.digest,
          state: 'revoked',
          basis:
            'Synthetic current-authority withdrawal must deny the entire discussion',
        });
        for (const [path] of endpoints) {
          const denied = await get(`/v2/community/${path}`);
          assert.ok(
            denied.status >= 400 && denied.status < 500,
            JSON.stringify(denied.body),
          );
          assert.equal(assertSources(denied.body), 0);
        }
        assert.deepEqual((await post(root.path, root.body)).body, root.receipt);
      }
      const rejected = { ...roots[0]!.body, clientRequestId: randomUUID() };
      await prepare('/v1/community/posts', rejected);
      await decide(rejected, 'post', 'reject');
      const before = (
        await db.query(
          'SELECT count(*)::integer n FROM whaleu_community.community_text_sources',
        )
      ).rows[0]!['n'];
      const rejection = await post('/v1/community/posts', rejected);
      assert.equal(rejection.status, 201);
      assert.equal(rejection.body.outcome, 'rejected');
      assert.equal(rejection.body.code, 'CONTENT_REJECTED');
      assert.deepEqual(
        (await post('/v1/community/posts', rejected)).body,
        rejection.body,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::integer n FROM whaleu_community.community_text_sources',
          )
        ).rows[0]!['n'],
        before,
      );
      // Independent real partial0180 negatives. The full175 source/reader
      // assertions above remain intact, and no later migration is applied.
      const partialEpoch = [
        [
          'account epoch column',
          'ALTER TABLE whaleu_identity.accounts ADD COLUMN session_revocation_epoch bigint NOT NULL DEFAULT 0',
        ],
        [
          'session issued epoch column',
          'ALTER TABLE whaleu_identity.sessions ADD COLUMN issued_revocation_epoch bigint NOT NULL DEFAULT 0',
        ],
        [
          'account epoch constraint',
          'ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT session_epoch_account_nonnegative CHECK(true)',
        ],
        [
          'session issued epoch constraint',
          'ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT session_epoch_issued_nonnegative CHECK(true)',
        ],
        [
          'account epoch trigger',
          'CREATE TRIGGER session_epoch_account BEFORE UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()',
        ],
        [
          'session issued epoch trigger',
          'CREATE TRIGGER session_epoch_issued BEFORE UPDATE ON whaleu_identity.sessions FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()',
        ],
        [
          'account epoch guard',
          'CREATE FUNCTION whaleu_identity.session_epoch_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
        ],
        [
          'session issued epoch guard',
          'CREATE FUNCTION whaleu_identity.session_epoch_issued_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
        ],
        [
          'epoch protocol',
          "CREATE FUNCTION whaleu_identity.session_epoch_protocol() RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$",
        ],
      ] as const;
      for (const [label, statement] of partialEpoch)
        await t.test(`exact175 rejects unledgered0180 ${label}`, async () => {
          await assert.rejects(
            db.transaction(async (tx) => {
              await tx.query(statement);
              await inspectExactM1(tx);
            }),
            /Partial\/future owners are not exact M1/,
          );
          await db.transaction(inspectExactM1);
        });
      // There is still no formatting queue/head/result, Home or registration owner.
      await db.transaction(async (tx) => {
        await inspectExactM1(tx);
        assert.deepEqual(await inspectReadingSchema(tx), { status: 'missing' });
      });
    } finally {
      await app?.close();
      producerMapping?.deregister();
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
