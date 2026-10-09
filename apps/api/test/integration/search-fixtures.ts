/** Search-only guarded fixtures. All dates are known synthetic publication facts,
 * never replacements for an undated imported post. No authority is mocked. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import type { PublishPost } from '../../src/community/contracts.js';
import type {
  EffectiveContentEnvelope,
  EffectiveContentEnvelopeV1,
} from '../../src/community/content-review/contracts.js';
import {
  createRuntimeActor,
  postApprovalEnvelope,
  postApprovalEnvelopeV1,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  observeExactQueries,
  seedExactContent,
} from '../support/exact-discovery-counts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

export type SearchActor = Awaited<ReturnType<typeof createRuntimeActor>> & {
  profileId: string;
};
export interface PrivateSearchPosition {
  v: number;
  kind: string;
  matcherId: string;
  orderId: string;
  after: { at: string; kind: 'post' | 'comment' | 'reply'; id: string };
  visible: {
    at: string;
    kind: 'post' | 'comment' | 'reply';
    id: string;
  } | null;
}
export async function searchHarness() {
  const database = process.env['TEST_DATABASE_URL'];
  assert.ok(
    database,
    'Set TEST_DATABASE_URL to disposable loopback whaleu_test; no skips',
  );
  const url = new URL(database);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database,
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '20',
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
  });
  const pool = new Pool(poolOptions(config));
  let suite: PoolClient | undefined, app: INestApplication | undefined;
  let owns = false,
    locked = false;
  let observer: ReturnType<typeof observeExactQueries> | undefined;
  const close = async () => {
    observer?.restore();
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
  };
  try {
    suite = await pool.connect();
    locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    assert.equal(locked, true, 'Run disposable integration suites serially');
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
      'Refusing existing WhaleU schemas',
    );
    owns = true;
    await runMigrations(
      pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    app = await NestFactory.create(AppModule.register(config), {
      logger: false,
    });
    configureHttp(app);
    await app.init();
    const application = app,
      http = app.getHttpServer();
    const policyId = await seedReviewPolicy(pool);
    observer = observeExactQueries(app);
    const observed = observer;
    const world = async () => {
      const scope = await seedCommunityScope(pool);
      const actor = async (campus = scope.home): Promise<SearchActor> => {
        const value = await createRuntimeActor(application);
        const affiliation = await setRuntimeVerification(
          pool,
          value.accountId,
          scope.institutionId,
          campus.regionId,
        );
        await appendIdentitySelection(
          pool,
          value.accountId,
          affiliation,
          scope,
          campus.campusId,
        );
        const changed = await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${value.accessToken}`)
          .send({
            expectedRevision: 0,
            nickname: 'SearchFixture',
            bio: '',
          });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        const reference = await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', `Bearer ${value.accessToken}`);
        assert.equal(reference.status, 200, JSON.stringify(reference.body));
        assert.equal(typeof reference.body.profileId, 'string');
        return { ...value, profileId: reference.body.profileId as string };
      };
      const author = await actor(),
        reader = await actor();
      const input = (extra: Partial<PublishPost> = {}): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic search body',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        ...extra,
      });
      const envelope = (
        extra: Partial<PublishPost> = {},
        owner = author,
      ): Promise<EffectiveContentEnvelopeV1> =>
        postApprovalEnvelopeV1(
          application,
          pool,
          owner.accountId,
          input(extra),
        );
      const seed = async (
        count: number,
        definition?: (index: number) => EffectiveContentEnvelope,
        options: Parameters<typeof seedExactContent>[5] = {},
      ) => {
        const base = await envelope();
        return seedExactContent(
          pool,
          policyId,
          'post',
          count,
          definition ?? (() => base),
          options,
        );
      };
      const publish = async (
        extra: Partial<PublishPost> = {},
        owner = author,
      ) => {
        const body = input(extra);
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(application, pool, owner.accountId, body),
        );
        const result = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(
          result.body.outcome,
          'created',
          JSON.stringify(result.body),
        );
        return { id: result.body.resourceId as string, approval, body };
      };
      const search = (
        query: Record<string, unknown> = {},
        viewer: SearchActor | null = reader,
      ) => {
        const call = request(http)
          .get('/v1/community/search')
          .query({
            spaceId: scope.home.spaceId,
            q: 'needle',
            type: 'post',
            ...query,
          });
        return viewer
          ? call.set('Authorization', `Bearer ${viewer.accessToken}`)
          : call;
      };
      return {
        scope,
        actor,
        author,
        reader,
        input,
        envelope,
        seed,
        publish,
        search,
      };
    };
    const position = async (cursor: string): Promise<PrivateSearchPosition> => {
      assert.match(cursor, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      const row = (
        await pool.query<{ position: PrivateSearchPosition }>(
          'SELECT position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
          [cursor],
        )
      ).rows[0];
      assert.ok(row, 'The opaque successor must exist in private storage');
      assert.deepEqual(Object.keys(row.position).sort(), [
        'after',
        'kind',
        'matcherId',
        'orderId',
        'v',
        'visible',
      ]);
      assert.equal(row.position.kind, 'search');
      assert.equal(row.position.orderId, 'created-desc-kind-asc-id-desc-v1');
      assert.equal(row.position.v, 3);
      assert.equal(
        row.position.matcherId,
        `unicode-lower-substring-v1:${process.versions['unicode']}`,
      );
      for (const coordinate of [row.position.after, row.position.visible])
        if (coordinate) {
          assert.deepEqual(Object.keys(coordinate).sort(), [
            'at',
            'id',
            'kind',
          ]);
          assert.match(
            coordinate.at,
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,
          );
        }
      return row.position;
    };
    const writeBlock = async (
      blocker: SearchActor,
      blocked: SearchActor,
      active = true,
      id?: string,
      retained?: PoolClient,
    ) => {
      const tx = retained ?? (await pool.connect()),
        relation = id ?? randomUUID();
      try {
        if (!retained) await tx.query('BEGIN');
        if (id)
          await tx.query(
            'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
            [id, active],
          );
        else
          await tx.query(
            "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,$4,1,'Synthetic search','profile',$5)",
            [
              relation,
              blocker.accountId,
              blocked.accountId,
              active,
              blocked.profileId,
            ],
          );
        await tx.query(
          'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
          [randomUUID(), active ? 'blocked' : 'unblocked', relation],
        );
        if (!retained) await tx.query('COMMIT');
        return relation;
      } catch (error) {
        if (!retained) await tx.query('ROLLBACK');
        throw error;
      } finally {
        if (!retained) tx.release();
      }
    };
    return {
      app: application,
      http,
      pool,
      policyId,
      observer: observed,
      world,
      position,
      writeBlock,
      close,
      mutate: <T>(operation: (tx: PoolClient) => Promise<T>) =>
        withCommunityScopeWriter(pool, operation),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type SearchHarness = Awaited<ReturnType<typeof searchHarness>>;
export type SearchWorld = Awaited<ReturnType<SearchHarness['world']>>;
export function ok(response: { status: number; body: unknown }) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
export function failure(
  response: { status: number; body: { error?: { code?: string } } },
  status: number,
  code?: string,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body), ['error']);
  if (code) assert.equal(response.body.error?.code, code);
}
