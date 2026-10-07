import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
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
import { configureHttp } from '../../src/http/http.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import type { PublishPost } from '../../src/community/contracts.js';
import type { TopologySnapshotData } from '../../src/campus/community-policy/fact-validation.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  appendTopologyRevision,
  seedCommunityScope,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  insertSyntheticAssertion,
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

interface CampusSummary {
  id: string;
  name: string;
  operatingRegion: { id: string; name: string };
}
interface OwnState {
  affiliation: 'verified' | 'unverified' | 'unavailable';
  selection: 'valid' | 'selection_required' | 'unavailable';
  reason: string;
  selectedCampus: CampusSummary | null;
  options: { status: 'known' | 'unavailable'; items: CampusSummary[] };
  writeEligibility: {
    phone: 'verified' | 'unverified' | 'unavailable';
    safety: 'allowed' | 'restricted' | 'unavailable';
  };
  canSelect: boolean;
  expectedStateRevision: string | null;
  guidance: string;
}
interface Choice {
  requestId: string;
  campusId: string;
  expectedStateRevision: string;
}

type Actor = Awaited<ReturnType<typeof createRuntimeActor>>;
const route = '/v1/me/identity-campus';

/** Normal AppModule and PostgreSQL only. Fixtures issue canonical inputs, never
 * the chosen event in successful selection scenarios. No policy/provider ports
 * are replaced, and no production grants or startup facts are installed. */
test(
  'normal runtime own identity-campus selection and recovery',
  { timeout: 180000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use disposable loopback whaleu_test');
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
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run disposable suites serially');
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
      const runtime = app,
        http = app.getHttpServer();
      const auth = (actor: Actor) => `Bearer ${actor.accessToken}`;
      const get = (actor: Actor) =>
        request(http).get(route).set('Authorization', auth(actor));
      const put = (actor: Actor, input: unknown) =>
        request(http)
          .put(route)
          .set('Authorization', auth(actor))
          .send(input as object);
      const receipt = (actor: Actor, id: string) =>
        request(http)
          .get(`${route}/requests/${id}`)
          .set('Authorization', auth(actor));
      const state = async (actor: Actor): Promise<OwnState> => {
        const response = await get(actor);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.match(response.headers['cache-control'] as string, /no-store/);
        assert.match(response.headers['vary'] as string, /Authorization/i);
        return response.body as OwnState;
      };
      const intent = (view: OwnState, campusId: string): Choice => {
        assert.equal(view.canSelect, true, JSON.stringify(view));
        assert.match(view.expectedStateRevision ?? '', /^ic1:[a-f0-9]{64}$/);
        return {
          requestId: randomUUID(),
          campusId,
          expectedStateRevision: view.expectedStateRevision!,
        };
      };
      const selections = async (actor: Actor) =>
        (
          await pool.query(
            'SELECT * FROM whaleu_campus.community_identity_selections WHERE account_id=$1 ORDER BY revision',
            [actor.accountId],
          )
        ).rows;
      const head = async (actor: Actor) =>
        (
          await pool.query(
            'SELECT * FROM whaleu_campus.community_identity_heads WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows;
      const noChoice = async (actor: Actor, requestId?: string) => {
        assert.equal(
          (
            await pool.query(
              'SELECT * FROM whaleu_campus.identity_selection_requests WHERE account_id=$1',
              [actor.accountId],
            )
          ).rowCount,
          0,
        );
        assert.equal((await selections(actor)).length, 0);
        assert.equal((await head(actor)).length, 0);
        if (requestId) {
          const missing = await receipt(actor, requestId);
          assert.equal(missing.status, 404, JSON.stringify(missing.body));
          assert.equal(
            missing.body.error?.code,
            'IDENTITY_CAMPUS_REQUEST_NOT_FOUND',
          );
        }
      };
      const empty = await createRuntimeActor(runtime);
      await t.test(
        'empty startup, repeated status and login do not manufacture authority facts',
        async () => {
          for (let i = 0; i < 3; i++) {
            const view = await state(empty);
            assert.equal(view.affiliation, 'unavailable');
            assert.equal(view.selection, 'unavailable');
            assert.equal(view.selectedCampus, null);
            assert.deepEqual(view.options, {
              status: 'unavailable',
              items: [],
            });
            assert.equal(view.canSelect, false);
            assert.equal(view.expectedStateRevision, null);
          }
          for (const table of [
            'whaleu_verification.assertions',
            'whaleu_verification.snapshots',
            'whaleu_authorization.role_grants',
            'whaleu_campus.community_topology_heads',
            'whaleu_campus.community_identity_heads',
            'whaleu_campus.community_identity_selections',
            'whaleu_campus.identity_selection_requests',
            'whaleu_community.region_policy_heads',
            'whaleu_community.content_approval_decisions',
          ])
            assert.equal(
              (await pool.query(`SELECT * FROM ${table}`)).rowCount,
              0,
              table,
            );
          const login = await request(http)
            .post('/v1/auth/wechat/login')
            .send({ code: 'no-provider-bypass' });
          assert.notEqual(login.status, 200);
          await noChoice(empty);
          assert.equal((await request(http).get(route)).status, 401);
          assert.equal(
            (
              await request(http)
                .put(route)
                .send({
                  requestId: randomUUID(),
                  campusId: randomUUID(),
                  expectedStateRevision: `ic1:${'a'.repeat(64)}`,
                })
            ).status,
            401,
          );
        },
      );

      const scope = await seedCommunityScope(pool);
      const originalTopology = structuredClone(scope.topology);
      const replaceTopology = async (
        topology = originalTopology,
        validUntil?: number,
      ) => {
        scope.topologySnapshotId = await appendTopologyRevision(
          pool,
          topology,
          validUntil === undefined ? {} : { validUntil },
        );
      };
      const actorWithFacts = async (
        affiliation: 'verified' | 'unverified' | 'unavailable' = 'verified',
        phone: 'verified' | 'unverified' | 'unavailable' = 'verified',
        expiresAt?: Date,
      ) => {
        const actor = await createRuntimeActor(runtime);
        const facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
          affiliation,
          phone,
          expiresAt,
        );
        return { actor, facts };
      };
      const choose = async (actor: Actor, campusId = scope.home.campusId) => {
        const input = intent(await state(actor), campusId);
        const result = await put(actor, input);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(Object.keys(result.body).sort(), [
          'campusId',
          'outcome',
          'requestId',
          'selectionRevision',
        ]);
        assert.equal(result.body.requestId, input.requestId);
        assert.equal(result.body.campusId, campusId);
        assert.ok(
          Number.isSafeInteger(result.body.selectionRevision) &&
            result.body.selectionRevision > 0,
        );
        return { input, body: result.body };
      };
      const safety = async (
        actor: Actor,
        patch: 'restricted' | 'unknown' | 'allowed',
        validUntil: Date | null = null,
      ) =>
        withCommunityScopeWriter(pool, (tx) =>
          tx.query(
            `UPDATE whaleu_safety.account_heads SET actions_allowed=$2, restriction_coverage=$3, valid_until=$4 WHERE account_id=$1`,
            [
              actor.accountId,
              patch !== 'restricted',
              patch === 'unknown' ? 'missing' : 'complete',
              validUntil,
            ],
          ),
        );

      /** Phone-only replacement deliberately reuses the same affiliation assertion.
       * It obeys the verification head discipline without any later gate upgrade. */
      const replacePhone = async (actor: Actor, tx: PoolClient) => {
        const old = (
          await tx.query<{ revision: number; snapshot_id: string }>(
            'SELECT revision,snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
            [actor.accountId],
          )
        ).rows[0]!;
        const snapshot = (
          await tx.query<{
            affiliation_assertion_id: string;
            student_number_assertion_id: string | null;
          }>(
            'SELECT affiliation_assertion_id,student_number_assertion_id FROM whaleu_verification.snapshots WHERE id=$1',
            [old.snapshot_id],
          )
        ).rows[0]!;
        const phone = syntheticAssertion(
          actor.accountId,
          scope.institutionId,
          'phone',
        );
        await insertSyntheticAssertion(tx, phone);
        const snapshotId = randomUUID(),
          revision = old.revision + 1;
        await tx.query(
          `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
          VALUES($1,$2,$3,$4,$5,$6,'none','complete')`,
          [
            snapshotId,
            actor.accountId,
            revision,
            snapshot.affiliation_assertion_id,
            snapshot.student_number_assertion_id,
            phone.id,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
          VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_fixture')`,
          [
            randomUUID(),
            actor.accountId,
            randomUUID(),
            old.revision,
            snapshotId,
            revision,
          ],
        );
        await tx.query(
          'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
          [actor.accountId, revision, snapshotId],
        );
        return { snapshotId, assertionId: snapshot.affiliation_assertion_id };
      };

      await t.test(
        'known candidates are readable with missing phone, restrictions and unknown safety without a write grant',
        async () => {
          for (const phone of ['unverified', 'unavailable'] as const) {
            const { actor } = await actorWithFacts('verified', phone);
            const view = await state(actor);
            assert.equal(view.affiliation, 'verified');
            assert.equal(view.selection, 'unavailable');
            assert.equal(view.reason, 'history_unknown');
            assert.equal(view.options.status, 'known');
            assert.deepEqual(
              view.options.items.map((c) => c.id).sort(),
              [scope.home.campusId, scope.related.campusId].sort(),
            );
            assert.equal(view.writeEligibility.phone, phone);
            assert.equal(view.canSelect, false);
            assert.equal(view.expectedStateRevision, null);
            const denied = await put(actor, {
              requestId: randomUUID(),
              campusId: scope.home.campusId,
              expectedStateRevision: `ic1:${'a'.repeat(64)}`,
            });
            assert.equal(
              denied.body.error?.code,
              phone === 'unverified'
                ? 'PHONE_VERIFICATION_REQUIRED'
                : 'VERIFICATION_UNAVAILABLE',
            );
            await noChoice(actor);
          }
          for (const gate of ['restricted', 'unknown'] as const) {
            const { actor } = await actorWithFacts();
            const before = await state(actor);
            await safety(actor, gate);
            const view = await state(actor);
            assert.equal(view.options.status, 'known');
            assert.equal(view.options.items.length, 2);
            assert.equal(
              view.writeEligibility.safety,
              gate === 'unknown' ? 'unavailable' : gate,
            );
            assert.equal(view.canSelect, false);
            const denied = await put(
              actor,
              intent(before, scope.home.campusId),
            );
            assert.equal(
              denied.body.error?.code,
              gate === 'restricted'
                ? 'SAFETY_ACTION_RESTRICTED'
                : 'SAFETY_UNAVAILABLE',
            );
            await noChoice(actor);
          }
        },
      );

      await t.test(
        'missing and known unverified affiliation remain distinct and never expose inferred candidates',
        async () => {
          for (const affiliation of ['unverified', 'unavailable'] as const) {
            const { actor } = await actorWithFacts(affiliation);
            const view = await state(actor);
            assert.equal(view.affiliation, affiliation);
            assert.equal(view.selection, 'unavailable');
            assert.equal(
              view.reason,
              affiliation === 'unverified'
                ? 'affiliation_required'
                : 'affiliation_unavailable',
            );
            assert.equal(view.selectedCampus, null);
            assert.deepEqual(view.options, {
              status: 'unavailable',
              items: [],
            });
            assert.equal(view.canSelect, false);
            const input = {
              requestId: randomUUID(),
              campusId: scope.home.campusId,
              expectedStateRevision: `ic1:${'0'.repeat(64)}`,
            };
            assert.notEqual((await put(actor, input)).status, 200);
            await noChoice(actor, input.requestId);
          }
        },
      );

      await t.test(
        'browsing preference and synthetic management role never establish affiliation or identity eligibility',
        async () => {
          const { actor } = await actorWithFacts('unavailable', 'verified');
          await pool.query(
            'INSERT INTO whaleu_profile.profiles(account_id,selected_campus_id,revision) VALUES($1,$2,1)',
            [actor.accountId, scope.home.campusId],
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
          VALUES($1,$2,'school_admin',$3,$2,'synthetic-role-not-affiliation')`,
              [randomUUID(), actor.accountId, scope.home.regionId],
            ),
          );
          const view = await state(actor);
          assert.equal(view.affiliation, 'unavailable');
          assert.deepEqual(view.options, { status: 'unavailable', items: [] });
          assert.equal(view.canSelect, false);
          const result = await put(actor, {
            requestId: randomUUID(),
            campusId: scope.home.campusId,
            expectedStateRevision: `ic1:${'a'.repeat(64)}`,
          });
          assert.equal(result.body.error?.code, 'IDENTITY_CAMPUS_UNAVAILABLE');
          await noChoice(actor);
        },
      );

      await t.test(
        'required is an explicit event; missing, null and unreconciled history are not rewritten by reads',
        async () => {
          const absent = await actorWithFacts();
          const nullHead = await actorWithFacts();
          const required = await actorWithFacts();
          const unknown = await actorWithFacts();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'INSERT INTO whaleu_campus.community_identity_heads(account_id) VALUES($1)',
              [nullHead.actor.accountId],
            ),
          );
          await appendIdentitySelection(
            pool,
            required.actor.accountId,
            required.facts,
            scope,
            null,
            'selection_required',
          );
          const unknownId = await appendIdentitySelection(
            pool,
            unknown.actor.accountId,
            unknown.facts,
            scope,
            scope.home.campusId,
            'selected',
            { provenanceState: 'unknown' },
          );
          for (const entry of [absent, nullHead, unknown]) {
            const beforeHead = await head(entry.actor),
              beforeEvents = await selections(entry.actor);
            const view = await state(entry.actor);
            assert.equal(view.selection, 'unavailable');
            assert.equal(view.reason, 'history_unknown');
            assert.equal(view.selectedCampus, null);
            assert.equal(view.canSelect, true);
            assert.deepEqual(await head(entry.actor), beforeHead);
            assert.deepEqual(await selections(entry.actor), beforeEvents);
          }
          const view = await state(required.actor);
          assert.equal(view.selection, 'selection_required');
          assert.equal(view.reason, 'choice_required');
          assert.equal(view.guidance, 'choose');
          const saved = await choose(unknown.actor);
          assert.equal(saved.body.outcome, 'applied');
          assert.equal(saved.body.selectionRevision, 2);
          assert.equal((await selections(unknown.actor))[0].id, unknownId);
          assert.equal(
            (await selections(unknown.actor))[0].provenance_state,
            'unknown',
          );
        },
      );

      await t.test(
        'expired accepted selected and required events distinguish stale bindings from elapsed validity without read mutation',
        async () => {
          for (const selectionState of [
            'selected',
            'selection_required',
          ] as const) {
            for (const staleBinding of [false, true]) {
              const { actor, facts } = await actorWithFacts();
              await appendIdentitySelection(
                pool,
                actor.accountId,
                facts,
                scope,
                selectionState === 'selected' ? scope.home.campusId : null,
                selectionState,
                {
                  validUntil: Date.now() - 1000,
                  effectiveAt: new Date(Date.now() - 60000),
                },
              );
              if (staleBinding)
                await inTransaction(pool, (tx) => replacePhone(actor, tx));
              const beforeHead = await head(actor),
                beforeEvents = await selections(actor);
              const view = await state(actor);
              assert.equal(view.selection, 'unavailable');
              assert.equal(
                view.reason,
                staleBinding ? 'inputs_changed' : 'choice_no_longer_valid',
              );
              assert.equal(view.selectedCampus, null);
              assert.equal(view.options.status, 'known');
              assert.equal(view.canSelect, true);
              assert.deepEqual(await head(actor), beforeHead);
              assert.deepEqual(await selections(actor), beforeEvents);
            }
          }
        },
      );

      await t.test(
        'explicit user choice without student number creates only a current event consumed by real community authority',
        async () => {
          const { actor, facts } = await actorWithFacts();
          await noChoice(actor);
          await pool.query(
            'INSERT INTO whaleu_profile.profiles(account_id,selected_campus_id,revision) VALUES($1,$2,7)',
            [actor.accountId, scope.foreign.campusId],
          );
          const beforeProfile = (
            await pool.query(
              'SELECT * FROM whaleu_profile.profiles WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows;
          const beforeVerification = (
            await pool.query(
              'SELECT * FROM whaleu_verification.account_heads WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows;
          const grants = (
            await pool.query('SELECT * FROM whaleu_authorization.role_grants')
          ).rows;
          const configHeads = (
            await pool.query(
              'SELECT * FROM whaleu_community.region_policy_heads',
            )
          ).rows;
          const saved = await choose(actor, scope.related.campusId);
          assert.equal(saved.body.outcome, 'applied');
          assert.equal(saved.body.selectionRevision, 1);
          const events = await selections(actor);
          assert.equal(events.length, 1);
          assert.equal(events[0].affiliation_assertion_id, facts.assertionId);
          assert.equal(events[0].affiliation_snapshot_id, facts.snapshotId);
          assert.equal(
            events[0].topology_snapshot_id,
            scope.topologySnapshotId,
          );
          assert.equal(events[0].coverage_state, 'complete');
          assert.equal(events[0].provenance_state, 'accepted');
          assert.ok(events[0].source_reference);
          assert.ok(events[0].policy_reference);
          const view = await state(actor);
          assert.equal(view.selection, 'valid');
          assert.equal(view.reason, 'current');
          assert.equal(view.selectedCampus?.id, scope.related.campusId);
          const authority = await runtime
            .get(DatabaseService)
            .transaction(async (tx) => {
              const access = runtime.get(CommunityAccessService);
              await access.actor(actor.accessToken, tx);
              const space = await runtime
                .get(CommunityRepository)
                .space(scope.related.spaceId, tx);
              return access.authority(actor.accountId, space, tx, {
                publication: true,
              });
            });
          assert.equal(authority.identityStatus, 'valid');
          assert.equal(authority.identityRegionId, scope.related.regionId);
          assert.equal(authority.scopeRelation, 'home');
          assert.equal(
            authority.studentVerified,
            true,
            'Affiliation is sufficient; no student-number assertion is issued',
          );
          assert.ok(authority.publicationScope);
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM whaleu_verification.assertions WHERE account_id=$1 AND fact_kind='student_number'",
                [actor.accountId],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_profile.profiles WHERE account_id=$1',
                [actor.accountId],
              )
            ).rows,
            beforeProfile,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_verification.account_heads WHERE account_id=$1',
                [actor.accountId],
              )
            ).rows,
            beforeVerification,
          );
          assert.deepEqual(
            (await pool.query('SELECT * FROM whaleu_authorization.role_grants'))
              .rows,
            grants,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.region_policy_heads',
              )
            ).rows,
            configHeads,
          );
          const unchanged = await choose(actor, scope.related.campusId);
          assert.equal(unchanged.body.outcome, 'unchanged');
          assert.equal(unchanged.body.selectionRevision, 1);
          assert.equal((await selections(actor)).length, 1);
        },
      );

      await t.test(
        'structurally unreconciled head is unavailable and never silently repaired',
        async () => {
          const { actor, facts } = await actorWithFacts();
          await appendIdentitySelection(pool, actor.accountId, facts, scope);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_campus.community_identity_selections
          (id,account_id,revision,selection_state,campus_id,affiliation_assertion_id,affiliation_snapshot_id,topology_snapshot_id,
           coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
          SELECT $2,account_id,revision+1,selection_state,campus_id,affiliation_assertion_id,affiliation_snapshot_id,topology_snapshot_id,
            coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference
          FROM whaleu_campus.community_identity_selections WHERE account_id=$1 AND revision=1`,
              [actor.accountId, randomUUID()],
            ),
          );
          const beforeHead = await head(actor),
            beforeEvents = await selections(actor);
          const view = await state(actor);
          assert.equal(view.selection, 'unavailable');
          assert.equal(view.reason, 'history_unknown');
          assert.equal(view.selectedCampus, null);
          assert.equal(view.canSelect, false);
          assert.equal(view.expectedStateRevision, null);
          const result = await put(actor, {
            requestId: randomUUID(),
            campusId: scope.home.campusId,
            expectedStateRevision: `ic1:${'a'.repeat(64)}`,
          });
          assert.equal(result.body.error?.code, 'IDENTITY_CAMPUS_UNAVAILABLE');
          assert.deepEqual(await head(actor), beforeHead);
          assert.deepEqual(await selections(actor), beforeEvents);
        },
      );

      await t.test(
        'strict private DTO, UUID normalization, rejected authority input and own-account receipt isolation',
        async () => {
          const { actor, facts } = await actorWithFacts();
          const other = await actorWithFacts();
          const view = await state(actor);
          assert.deepEqual(Object.keys(view).sort(), [
            'affiliation',
            'canSelect',
            'expectedStateRevision',
            'guidance',
            'options',
            'reason',
            'selectedCampus',
            'selection',
            'writeEligibility',
          ]);
          for (const campus of view.options.items) {
            assert.deepEqual(Object.keys(campus).sort(), [
              'id',
              'name',
              'operatingRegion',
            ]);
            assert.deepEqual(Object.keys(campus.operatingRegion).sort(), [
              'id',
              'name',
            ]);
          }
          const serialized = JSON.stringify(view);
          for (const privateValue of [
            actor.accountId,
            facts.assertionId,
            facts.snapshotId,
            scope.topologySnapshotId,
            scope.institutionId,
            'student_number',
            'phone_binding_reference',
            'source_reference',
            'policy_reference',
            'role_grants',
          ])
            assert.equal(
              serialized.includes(privateValue),
              false,
              privateValue,
            );
          const input = intent(view, scope.home.campusId);
          assert.equal(
            (
              await request(http)
                .get(route)
                .set('Authorization', auth(actor))
                .query({ accountId: other.actor.accountId })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(http)
                .get(`${route}/requests/${input.requestId}`)
                .set('Authorization', auth(actor))
                .query({ accountId: other.actor.accountId })
            ).status,
            400,
          );
          for (const field of [
            'accountId',
            'affiliationAssertionId',
            'topologySnapshotId',
            'role',
            'verified',
            'schoolCode',
            'selectedCampusId',
            'provenance',
          ]) {
            assert.equal(
              (await put(actor, { ...input, [field]: randomUUID() })).status,
              400,
              field,
            );
          }
          for (const invalid of [
            { ...input, requestId: '00000000-0000-1000-8000-000000000000' },
            { ...input, requestId: 'bad' },
            { ...input, campusId: 'bad' },
            { ...input, expectedStateRevision: 'ic1:short' },
            { ...input, expectedStateRevision: `ic2:${'a'.repeat(64)}` },
            { ...input, expectedStateRevision: null },
          ])
            assert.equal((await put(actor, invalid)).status, 400);
          await noChoice(actor);
          const normalized = await put(actor, {
            ...input,
            requestId: input.requestId.toUpperCase(),
            campusId: input.campusId.toUpperCase(),
          });
          assert.equal(normalized.status, 200, JSON.stringify(normalized.body));
          assert.equal(normalized.body.requestId, input.requestId);
          assert.equal(normalized.body.campusId, input.campusId);
          assert.deepEqual(
            (await receipt(actor, input.requestId.toUpperCase())).body,
            normalized.body,
          );
          const hidden = await receipt(other.actor, input.requestId);
          assert.equal(hidden.status, 404);
          assert.equal(
            hidden.body.error?.code,
            'IDENTITY_CAMPUS_REQUEST_NOT_FOUND',
          );
          assert.equal(
            (
              await request(http)
                .get(`/v1/accounts/${actor.accountId}/identity-campus`)
                .set('Authorization', auth(other.actor))
            ).status,
            404,
          );
          const denied = await put(other.actor, input);
          assert.equal(
            denied.body.error?.code,
            'IDENTITY_CAMPUS_REVISION_CONFLICT',
          );
          await noChoice(other.actor, input.requestId);
        },
      );

      await t.test(
        'same key exact replay is durable, different intent conflicts, independent simultaneous keys only change once',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          const responses = await Promise.all([
            put(actor, input),
            put(actor, input),
            put(actor, input),
          ]);
          for (const response of responses) {
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.deepEqual(response.body, responses[0]!.body);
          }
          assert.equal((await selections(actor)).length, 1);
          assert.equal((await head(actor))[0].revision, 1);
          for (const changed of [
            { ...input, campusId: scope.related.campusId },
            { ...input, expectedStateRevision: `ic1:${'b'.repeat(64)}` },
          ]) {
            const conflict = await put(actor, changed);
            assert.equal(conflict.status, 409);
            assert.equal(
              conflict.body.error?.code,
              'IDENTITY_CAMPUS_REQUEST_CONFLICT',
            );
          }
          const next = intent(await state(actor), scope.related.campusId);
          const race = await Promise.all([
            put(actor, next),
            put(actor, { ...next, requestId: randomUUID() }),
          ]);
          assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            race.find((r) => r.status === 409)!.body.error?.code,
            'IDENTITY_CAMPUS_REVISION_CONFLICT',
          );
          assert.equal((await selections(actor)).length, 2);
          assert.equal((await head(actor))[0].revision, 2);
          assert.deepEqual((await put(actor, input)).body, responses[0]!.body);
          assert.equal(
            (await state(actor)).selectedCampus?.id,
            scope.related.campusId,
            'Replay must not restore the old head',
          );
        },
      );

      await t.test(
        'receipt persistence is immutable and binds the actual account event and revision',
        async () => {
          const { actor } = await actorWithFacts();
          const saved = await choose(actor);
          const events = await selections(actor);
          const rows = (
            await pool.query(
              'SELECT * FROM whaleu_campus.identity_selection_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, saved.input.requestId],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].selection_id, events[0].id);
          assert.equal(rows[0].selection_revision, events[0].revision);
          assert.equal(rows[0].campus_id, events[0].campus_id);
          assert.equal(rows[0].operation, 'select_identity_campus');
          assert.equal(rows[0].intent_version, 1);
          assert.match(rows[0].intent_hash as string, /^[a-f0-9]{64}$/);
          await assert.rejects(
            withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.identity_selection_requests SET campus_id=$2 WHERE account_id=$1',
                [actor.accountId, scope.related.campusId],
              ),
            ),
          );
          await assert.rejects(
            withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'DELETE FROM whaleu_campus.identity_selection_requests WHERE account_id=$1',
                [actor.accountId],
              ),
            ),
          );
          assert.deepEqual(
            (await receipt(actor, saved.input.requestId)).body,
            saved.body,
          );
        },
      );

      await t.test(
        'phone-only snapshot and topology revisions require explicit refreshed same-ID confirmation',
        async () => {
          const { actor } = await actorWithFacts();
          const original = await choose(actor);
          const oldView = await state(actor);
          const priorSelection = (await selections(actor))[0];
          const replacement = await inTransaction(pool, (tx) =>
            replacePhone(actor, tx),
          );
          assert.equal(
            replacement.assertionId,
            priorSelection.affiliation_assertion_id,
          );
          const stale = await state(actor);
          assert.equal(stale.selection, 'unavailable');
          assert.equal(stale.reason, 'inputs_changed');
          assert.equal(stale.selectedCampus, null);
          assert.equal(stale.canSelect, true);
          assert.equal((await selections(actor)).length, 1);
          assert.equal(
            (await put(actor, intent(oldView, scope.home.campusId))).body.error
              ?.code,
            'IDENTITY_CAMPUS_REVISION_CONFLICT',
          );
          const rebound = await choose(actor);
          assert.equal(rebound.body.outcome, 'applied');
          assert.equal(rebound.body.selectionRevision, 2);
          assert.equal(
            (await selections(actor))[1].affiliation_snapshot_id,
            replacement.snapshotId,
          );
          const topologyOldView = await state(actor);
          await replaceTopology();
          assert.equal((await state(actor)).reason, 'inputs_changed');
          assert.equal(
            (await put(actor, intent(topologyOldView, scope.home.campusId)))
              .body.error?.code,
            'IDENTITY_CAMPUS_REVISION_CONFLICT',
          );
          const topologyRebound = await choose(actor);
          assert.equal(topologyRebound.body.outcome, 'applied');
          assert.equal(topologyRebound.body.selectionRevision, 3);
          assert.deepEqual(
            (await receipt(actor, original.input.requestId)).body,
            original.body,
          );
        },
      );

      await t.test(
        'complete singleton and known empty are authoritative only after physical inventory reconciliation',
        async () => {
          const topology = structuredClone(originalTopology);
          const otherGroup = topology.regions.find(
            (r) => r.regionId === scope.foreign.regionId,
          )!.groupId;
          topology.regions.find(
            (r) => r.regionId === scope.related.regionId,
          )!.groupId = otherGroup;
          await replaceTopology(topology);
          const singleton = await actorWithFacts();
          const singleView = await state(singleton.actor);
          assert.deepEqual(
            singleView.options.items.map((c) => c.id),
            [scope.home.campusId],
          );
          assert.equal(singleView.canSelect, true);
          await noChoice(singleton.actor, randomUUID());
          assert.equal((await choose(singleton.actor)).body.outcome, 'applied');
          const emptyTopology = structuredClone(topology);
          emptyTopology.assignments.find(
            (a) => a.campusId === scope.home.campusId,
          )!.isActive = false;
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [scope.home.campusId],
            ),
          );
          try {
            await replaceTopology(emptyTopology);
            const emptyActor = await actorWithFacts();
            const view = await state(emptyActor.actor);
            assert.deepEqual(view.options, { status: 'known', items: [] });
            assert.equal(view.canSelect, false);
            assert.equal(view.expectedStateRevision, null);
            await noChoice(emptyActor.actor);
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
                [scope.home.campusId],
              ),
            );
            await replaceTopology();
          }
        },
      );

      await t.test(
        'unknown campus, missing physical row, malformed membership and assignment disagreement are never known empty',
        async () => {
          const { actor } = await actorWithFacts();
          const extraCampusId = randomUUID();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Unreviewed physical campus','synthetic',true)",
              [extraCampusId, scope.institutionId],
            ),
          );
          try {
            assert.deepEqual((await state(actor)).options, {
              status: 'unavailable',
              items: [],
            });
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                [extraCampusId],
              ),
            );
          }
          const mutations: ((value: TopologySnapshotData) => void)[] = [
            (value) => {
              value.assignments.push({
                campusId: randomUUID(),
                institutionId: scope.institutionId,
                regionId: scope.home.regionId,
                coverage: 'complete',
                isActive: true,
              });
            },
            (value) => {
              value.assignments = value.assignments.filter(
                (a) => a.campusId !== scope.related.campusId,
              );
            },
            (value) => {
              value.regions.find(
                (r) => r.regionId === scope.related.regionId,
              )!.coverage = 'missing';
            },
            (value) => {
              value.groups[0]!.coverage = 'conflicting';
            },
            (value) => {
              value.assignments.push({ ...value.assignments[0]! });
            },
            (value) => {
              value.assignments.find(
                (a) => a.campusId === scope.related.campusId,
              )!.regionId = scope.home.regionId;
            },
          ];
          try {
            for (const change of mutations) {
              const topology = structuredClone(originalTopology);
              change(topology);
              await replaceTopology(topology);
              const view = await state(actor);
              assert.deepEqual(view.options, {
                status: 'unavailable',
                items: [],
              });
              assert.equal(view.canSelect, false);
              await noChoice(actor);
            }
          } finally {
            await replaceTopology();
          }
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
              [scope.related.campusId, scope.foreign.regionId],
            ),
          );
          try {
            assert.deepEqual((await state(actor)).options, {
              status: 'unavailable',
              items: [],
            });
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
                [scope.related.campusId, scope.related.regionId],
              ),
            );
          }
        },
      );

      await t.test(
        'valid selected campus remains visible when independent option enumeration is unavailable',
        async () => {
          const { actor } = await actorWithFacts();
          await choose(actor);
          const missing = randomUUID();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Unreviewed inventory','synthetic',true)",
              [missing, scope.institutionId],
            ),
          );
          try {
            const view = await state(actor);
            assert.equal(view.selection, 'valid');
            assert.equal(view.selectedCampus?.id, scope.home.campusId);
            assert.deepEqual(view.options, {
              status: 'unavailable',
              items: [],
            });
            assert.equal(view.canSelect, false);
            assert.equal(view.expectedStateRevision, null);
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                [missing],
              ),
            );
          }
        },
      );

      await t.test(
        'same explicit group does not qualify a campus in a different institution',
        async () => {
          const institutionId = randomUUID(),
            campusId = randomUUID(),
            regionId = randomUUID();
          await withCommunityScopeWriter(pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Other synthetic institution')",
              [institutionId],
            );
            await tx.query(
              "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Other institution region',true)",
              [regionId],
            );
            await tx.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Other institution campus','synthetic',true)",
              [campusId, institutionId],
            );
            await tx.query(
              'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES($1,$2)',
              [campusId, regionId],
            );
          });
          const topology = structuredClone(originalTopology);
          const groupId = topology.regions.find(
            (r) => r.regionId === scope.home.regionId,
          )!.groupId;
          topology.regions.push({
            regionId,
            institutionId,
            groupId,
            coverage: 'complete',
            isActive: true,
          });
          topology.assignments.push({
            campusId,
            institutionId,
            regionId,
            coverage: 'complete',
            isActive: true,
          });
          await replaceTopology(topology);
          try {
            const { actor } = await actorWithFacts();
            const view = await state(actor);
            assert.equal(view.options.status, 'known');
            assert.deepEqual(
              view.options.items.map((c) => c.id).sort(),
              [scope.home.campusId, scope.related.campusId].sort(),
            );
            const denied = await put(actor, intent(view, campusId));
            assert.equal(
              denied.body.error?.code,
              'IDENTITY_CAMPUS_NOT_ELIGIBLE',
            );
            await noChoice(actor);
          } finally {
            await replaceTopology();
          }
        },
      );

      await t.test(
        'different institution or explicit unrelated group is never selectable',
        async () => {
          const { actor } = await actorWithFacts();
          const unknownId = randomUUID();
          for (const campusId of [scope.foreign.campusId, unknownId]) {
            const denied = await put(
              actor,
              intent(await state(actor), campusId),
            );
            assert.equal(denied.status, 409, JSON.stringify(denied.body));
            assert.equal(
              denied.body.error?.code,
              'IDENTITY_CAMPUS_NOT_ELIGIBLE',
            );
          }
          await noChoice(actor);
        },
      );

      await t.test(
        'historical publication scope and exact approvals are unchanged by subsequent reselection',
        async () => {
          const { actor } = await actorWithFacts();
          await choose(actor);
          await seedReviewPolicy(pool);
          const input: PublishPost = {
            clientRequestId: randomUUID(),
            spaceId: scope.home.spaceId,
            category: 'discussion',
            text: `Identity campus historical scope ${randomUUID()}`,
            imageAssetIds: [],
            authorMode: 'named',
            commentsPolicy: 'open',
          };
          await approveEnvelope(
            pool,
            await postApprovalEnvelope(runtime, pool, actor.accountId, input),
          );
          const published = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth(actor))
            .send(input);
          assert.equal(published.status, 201, JSON.stringify(published.body));
          const id = published.body.resourceId as string;
          const beforePost = (
            await pool.query(
              'SELECT * FROM whaleu_community.posts WHERE id=$1',
              [id],
            )
          ).rows;
          const beforeBinding = (
            await pool.query(
              'SELECT * FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
              [id],
            )
          ).rows;
          await choose(actor, scope.related.campusId);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.posts WHERE id=$1',
                [id],
              )
            ).rows,
            beforePost,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
                [id],
              )
            ).rows,
            beforeBinding,
          );
          assert.equal(
            (
              await request(http)
                .get(`/v1/community/posts/${id}`)
                .set('Authorization', auth(actor))
            ).status,
            200,
          );
        },
      );

      await t.test(
        'successful receipt survives current affiliation, phone, safety, topology and physical eligibility loss',
        async () => {
          const { actor } = await actorWithFacts();
          const saved = await choose(actor);
          await choose(actor, scope.related.campusId);
          const laterHead = await head(actor);
          await setRuntimeVerification(
            pool,
            actor.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unverified',
            'unverified',
          );
          await safety(actor, 'restricted');
          await replaceTopology();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [scope.home.campusId],
            ),
          );
          try {
            assert.deepEqual(
              (await receipt(actor, saved.input.requestId)).body,
              saved.body,
            );
            assert.deepEqual((await put(actor, saved.input)).body, saved.body);
            assert.deepEqual(await head(actor), laterHead);
            assert.equal((await state(actor)).selectedCampus, null);
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
                [scope.home.campusId],
              ),
            );
          }
        },
      );

      await t.test(
        'blocked account, revoked session and expired token still deny successful receipt recovery',
        async () => {
          for (const mode of ['account', 'session', 'token'] as const) {
            const { actor } = await actorWithFacts();
            const saved = await choose(actor);
            if (mode === 'account')
              await pool.query(
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [actor.accountId],
              );
            if (mode === 'session')
              await pool.query(
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(), revoke_reason='logout' WHERE id=$1",
                [actor.sessionId],
              );
            if (mode === 'token')
              await pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
                [actor.sessionId],
              );
            for (const result of [
              await receipt(actor, saved.input.requestId),
              await put(actor, saved.input),
            ]) {
              assert.notEqual(result.status, 200);
              assert.equal(
                result.body.error?.code,
                mode === 'account'
                  ? 'ACCOUNT_BLOCKED'
                  : mode === 'session'
                    ? 'SESSION_REVOKED'
                    : 'ACCESS_TOKEN_EXPIRED',
              );
            }
            assert.equal((await selections(actor)).length, 1);
          }
        },
      );

      await t.test(
        'exclusive outer gate precedes all actor locks and prevents shared-to-exclusive upgrade deadlock',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await lockSafetyPolicy(blocker);
          try {
            let settled = false;
            const pending = put(actor, input).then((response) => {
              settled = true;
              return response;
            });
            await sleep(80);
            assert.equal(
              settled,
              false,
              'PUT waits for the exclusive outer gate',
            );
            // If PUT locked actor rows under a shared gate first, NOWAIT fails here.
            await blocker.query(
              'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
              [actor.accountId],
            );
            await blocker.query(
              'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE NOWAIT',
              [actor.sessionId],
            );
            await blocker.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200, JSON.stringify(result.body));
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );

      await t.test(
        'concurrent gate-held safety restriction and physical deactivation are observed before any new event',
        async () => {
          for (const mode of ['safety', 'campus', 'account'] as const) {
            const { actor } = await actorWithFacts();
            const input = intent(await state(actor), scope.home.campusId);
            const writer = await pool.connect();
            await writer.query('BEGIN');
            await lockSafetyPolicy(writer, true);
            try {
              if (mode === 'safety')
                await writer.query(
                  'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                  [actor.accountId],
                );
              if (mode === 'campus')
                await writer.query(
                  'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                  [scope.home.campusId],
                );
              if (mode === 'account')
                await writer.query(
                  "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                  [actor.accountId],
                );
              let settled = false;
              const pending = put(actor, input).then((response) => {
                settled = true;
                return response;
              });
              await sleep(70);
              assert.equal(settled, false);
              await writer.query('COMMIT');
              const result = await pending;
              assert.notEqual(result.status, 200);
              if (mode === 'safety')
                assert.equal(
                  result.body.error?.code,
                  'SAFETY_ACTION_RESTRICTED',
                );
              if (mode === 'account')
                assert.equal(result.body.error?.code, 'ACCOUNT_BLOCKED');
              assert.equal((await selections(actor)).length, 0);
              assert.equal((await head(actor)).length, 0);
              if (mode !== 'account')
                assert.equal(
                  (await receipt(actor, input.requestId)).status,
                  404,
                );
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              if (mode === 'campus')
                await withCommunityScopeWriter(pool, (tx) =>
                  tx.query(
                    'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
                    [scope.home.campusId],
                  ),
                );
            }
          }
        },
      );

      await t.test(
        'catalog statement triggers protect shared readers even without an explicit writer gate',
        async () => {
          const { actor } = await actorWithFacts();
          const campusId = randomUUID();
          const changes = [
            {
              sql: "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Trigger protected inventory','synthetic',true)",
              values: [campusId, scope.institutionId],
            },
            {
              sql: 'UPDATE whaleu_campus.institutions SET name=name WHERE id=$1',
              values: [scope.institutionId],
            },
            {
              sql: 'UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=$1',
              values: [scope.home.campusId],
            },
            {
              sql: 'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=operating_region_id WHERE campus_id=$1',
              values: [scope.home.campusId],
            },
            {
              sql: 'UPDATE whaleu_campus.operating_regions SET name=name WHERE id=$1',
              values: [scope.home.regionId],
            },
          ];
          try {
            for (const change of changes) {
              const reader = await pool.connect(),
                writer = await pool.connect();
              await reader.query('BEGIN');
              await lockSafetyPolicy(reader);
              await writer.query('BEGIN');
              try {
                let settled = false;
                // Intentionally no lockSafetyPolicy(writer,true): the trigger is
                // the only protection for this absent-row/direct-statement writer.
                const pending = writer
                  .query(change.sql, change.values)
                  .then((value) => {
                    settled = true;
                    return value;
                  });
                await sleep(70);
                assert.equal(settled, false, change.sql);
                await reader.query('COMMIT');
                await pending;
                await writer.query('COMMIT');
              } finally {
                await reader.query('ROLLBACK');
                await writer.query('ROLLBACK');
                reader.release();
                writer.release();
              }
            }
            assert.deepEqual((await state(actor)).options, {
              status: 'unavailable',
              items: [],
            });
            await noChoice(actor);
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                [campusId],
              ),
            );
          }
        },
      );

      await t.test(
        'concurrent catalog insertion cannot escape the complete inventory comparison',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          const campusId = randomUUID();
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await lockSafetyPolicy(writer, true);
          try {
            await writer.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Concurrent inventory','synthetic',true)",
              [campusId, scope.institutionId],
            );
            let settled = false;
            const pending = put(actor, input).then((result) => {
              settled = true;
              return result;
            });
            await sleep(70);
            assert.equal(settled, false);
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(
              result.body.error?.code,
              'IDENTITY_CAMPUS_UNAVAILABLE',
            );
            await noChoice(actor, input.requestId);
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                [campusId],
              ),
            );
          }
        },
      );

      await t.test(
        'verification head replacement waits, then invalidates the old comparison token without a selection',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            'SELECT * FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
            [actor.accountId],
          );
          try {
            // The verification-only writer does not acquire the later outer gate.
            let settled = false;
            const pending = put(actor, input).then((response) => {
              settled = true;
              return response;
            });
            await sleep(60);
            assert.equal(settled, false);
            await replacePhone(actor, writer);
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 409, JSON.stringify(result.body));
            assert.equal(
              result.body.error?.code,
              'IDENTITY_CAMPUS_REVISION_CONFLICT',
            );
            await noChoice(actor, input.requestId);
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          const old = await state(actor);
          await setRuntimeVerification(
            pool,
            actor.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          const stale = await put(actor, intent(old, scope.related.campusId));
          assert.equal(
            stale.body.error?.code,
            'IDENTITY_CAMPUS_REVISION_CONFLICT',
          );
          assert.equal((await selections(actor)).length, 0);
        },
      );

      await t.test(
        'session rotation ahead of a waiting selection rejects its superseded token and preserves same-account recovery',
        async () => {
          const { actor } = await actorWithFacts();
          const first = await choose(actor);
          const next = intent(await state(actor), scope.related.campusId);
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE',
            [actor.sessionId],
          );
          try {
            // Real production validation, minting and rotation, with no override.
            // The HTTP refresh rate limiter has no test key configured; only this
            // internal actor setup step calls the owner service directly.
            const rotation = runtime
              .get(IdentityService)
              .refresh(actor.refreshToken);
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              waiting = (
                await pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock') waiting",
                  ['%r.consumed_at%'],
                )
              ).rows[0]!.waiting;
              if (waiting) break;
              await sleep(10);
            }
            assert.equal(
              waiting,
              true,
              'The real session rotation must be queued on the session row before selection',
            );
            let settled = false;
            const pending = put(actor, next).then((value) => {
              settled = true;
              return value;
            });
            await sleep(70);
            assert.equal(settled, false);
            await blocker.query('COMMIT');
            const refreshed = await rotation;
            assert.equal(refreshed.accountId, actor.accountId);
            const expired = await pending;
            assert.equal(expired.body.error?.code, 'ACCESS_TOKEN_EXPIRED');
            const currentActor = {
              ...actor,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
            };
            assert.equal((await selections(actor)).length, 1);
            assert.deepEqual(
              (await receipt(currentActor, first.input.requestId)).body,
              first.body,
            );
            assert.deepEqual(
              (await put(currentActor, first.input)).body,
              first.body,
            );
            assert.equal(
              (await receipt(currentActor, next.requestId)).status,
              404,
            );
            const retried = await put(currentActor, next);
            assert.equal(retried.status, 200, JSON.stringify(retried.body));
            assert.equal(retried.body.selectionRevision, 2);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );

      await t.test(
        'atomic topology and assignment remap conflicts with a waiting old-version selection',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await lockSafetyPolicy(writer, true);
          try {
            const old = (
              await writer.query<{ revision: number; snapshot_id: string }>(
                "SELECT revision,snapshot_id FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
              )
            ).rows[0]!;
            const topology = structuredClone(originalTopology);
            topology.assignments.find(
              (a) => a.campusId === scope.home.campusId,
            )!.regionId = scope.related.regionId;
            const nextId = randomUUID();
            await writer.query(
              `INSERT INTO whaleu_campus.community_topology_snapshots
            (id,revision,topology,coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
            VALUES($1,$2,$3::jsonb,'complete','accepted',clock_timestamp(),'policy_exempt',NULL,'synthetic-atomic-remap','synthetic-community-policy-v1')`,
              [nextId, old.revision + 1, JSON.stringify(topology)],
            );
            await writer.query(
              "UPDATE whaleu_campus.community_topology_heads SET revision=$1,snapshot_id=$2 WHERE scope_key='community'",
              [old.revision + 1, nextId],
            );
            await writer.query(
              'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
              [scope.home.campusId, scope.related.regionId],
            );
            let settled = false;
            const pending = put(actor, input).then((value) => {
              settled = true;
              return value;
            });
            await sleep(70);
            assert.equal(settled, false);
            await writer.query('COMMIT');
            const stale = await pending;
            assert.equal(
              stale.body.error?.code,
              'IDENTITY_CAMPUS_REVISION_CONFLICT',
            );
            await noChoice(actor, input.requestId);
            const view = await state(actor);
            assert.equal(view.options.status, 'known');
            assert.equal(
              view.options.items.find((c) => c.id === scope.home.campusId)
                ?.operatingRegion.id,
              scope.related.regionId,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
                [scope.home.campusId, scope.home.regionId],
              ),
            );
            await replaceTopology();
          }
        },
      );

      await t.test(
        'presented token expiry during a session-row wait cannot create a head or receipt',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE session_id=$1",
            [actor.sessionId],
          );
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE',
            [actor.sessionId],
          );
          try {
            let settled = false;
            const pending = put(actor, input).then((result) => {
              settled = true;
              return result;
            });
            await sleep(70);
            assert.equal(settled, false);
            await writer.query('SELECT pg_sleep(0.3)');
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(result.body.error?.code, 'ACCESS_TOKEN_EXPIRED');
            assert.equal((await selections(actor)).length, 0);
            assert.equal((await head(actor)).length, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_campus.identity_selection_requests WHERE account_id=$1',
                  [actor.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );

      await t.test(
        'expiry during deferred constraints rolls back the new event, absent head and success receipt atomically',
        async () => {
          await pool.query(`CREATE FUNCTION whaleu_campus.identity_selection_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.75); RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER identity_selection_test_wait AFTER INSERT ON whaleu_campus.community_identity_selections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_campus.identity_selection_test_wait()`);
          try {
            for (const mode of [
              'affiliation',
              'phone',
              'safety',
              'topology',
              'session',
            ] as const) {
              const { actor } = await actorWithFacts();
              const deadline = new Date(Date.now() + 500);
              if (mode === 'affiliation' || mode === 'phone') {
                const a = syntheticAssertion(
                  actor.accountId,
                  scope.institutionId,
                  'affiliation',
                  {
                    origin_region_id: scope.home.regionId,
                    ...(mode === 'affiliation' ? { expires_at: deadline } : {}),
                  },
                );
                const p = syntheticAssertion(
                  actor.accountId,
                  scope.institutionId,
                  'phone',
                  mode === 'phone' ? { expires_at: deadline } : {},
                );
                await setSyntheticSnapshot(pool, actor.accountId, [a, p]);
              }
              if (mode === 'safety') await safety(actor, 'allowed', deadline);
              if (mode === 'topology')
                await replaceTopology(originalTopology, deadline.getTime());
              if (mode === 'session')
                await pool.query(
                  'UPDATE whaleu_identity.sessions SET access_expires_at=$2,refresh_expires_at=$2,absolute_expires_at=$2 WHERE id=$1',
                  [actor.sessionId, deadline],
                );
              const input = intent(await state(actor), scope.home.campusId);
              const started = Date.now();
              const result = await put(actor, input);
              assert.ok(
                Date.now() - started >= 700,
                `${mode}: selection must reach the deferred wait`,
              );
              assert.equal(
                result.body.error?.code,
                mode === 'session'
                  ? 'ACCESS_TOKEN_EXPIRED'
                  : mode === 'safety'
                    ? 'SAFETY_UNAVAILABLE'
                    : mode === 'topology'
                      ? 'IDENTITY_CAMPUS_UNAVAILABLE'
                      : 'VERIFICATION_UNAVAILABLE',
                mode,
              );
              assert.notEqual(
                result.status,
                200,
                `${mode}: ${JSON.stringify(result.body)}`,
              );
              assert.notEqual(
                result.status,
                500,
                `${mode}: deadlines must be owned errors`,
              );
              assert.equal((await selections(actor)).length, 0, mode);
              assert.equal((await head(actor)).length, 0, mode);
              assert.equal(
                (
                  await pool.query(
                    'SELECT * FROM whaleu_campus.identity_selection_requests WHERE account_id=$1',
                    [actor.accountId],
                  )
                ).rowCount,
                0,
                mode,
              );
              if (mode !== 'session')
                assert.equal(
                  (await receipt(actor, input.requestId)).status,
                  404,
                  mode,
                );
              if (mode === 'topology') await replaceTopology();
            }
          } finally {
            await pool.query(
              'DROP TRIGGER identity_selection_test_wait ON whaleu_campus.community_identity_selections; DROP FUNCTION whaleu_campus.identity_selection_test_wait()',
            );
            await replaceTopology();
          }
        },
      );

      await t.test(
        'receipt recovery after an ignored successful response never duplicates the committed event',
        async () => {
          const { actor } = await actorWithFacts();
          const input = intent(await state(actor), scope.home.campusId);
          // Model a lost transport response by discarding it. Recovery is exact key,
          // never a freshly generated intent or stale status returned as authority.
          await put(actor, input);
          const recovered = await receipt(actor, input.requestId);
          assert.equal(recovered.status, 200);
          assert.deepEqual((await put(actor, input)).body, recovered.body);
          assert.equal((await selections(actor)).length, 1);
          assert.equal((await state(actor)).selection, 'valid');
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
