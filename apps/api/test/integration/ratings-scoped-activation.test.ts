import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { ApplicationError } from '../../src/http/application-error.js';

const publicationTables = [
  'catalogs',
  'catalog_heads',
  'categories',
  'catalog_category_lineage',
  'catalog_materializations',
  'target_memberships',
  'category_identities',
  'category_base_versions',
  'category_scope_versions',
  'category_base_heads',
  'category_release_catalogs',
  'targets',
  'target_sources',
  'target_definition_versions',
  'target_definition_heads',
  'target_definition_lifecycles',
  'target_create_transitions',
  'category_command_transitions',
  'requests',
  'command_claims',
  'scoped_command_causes',
  'scoped_source_attestations',
  'scoped_source_heads',
  'scoped_releases',
  'scoped_release_scopes',
  'scoped_catalogs',
  'scoped_catalog_heads',
  'scoped_categories',
  'scoped_category_lineage',
  'scoped_target_memberships',
  'compat_versions',
  'compat_heads',
  'compat_projection_manifests',
  'compat_projection_lineage',
  'scope_protocol_versions',
  'scope_protocol_heads',
  'scoped_source_epoch',
  'scope_protocol_epoch',
  'navigation_epoch',
  'random_pool_epoch',
] as const;
async function publicationSnapshot(database: Pick<PoolClient, 'query'>) {
  const entries = publicationTables.map(
    (name) =>
      `'${name}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM whaleu_ratings.${name} r)`,
  );
  return (
    await database.query<{ state: Record<string, unknown> }>(
      `SELECT jsonb_build_object(${entries.join(',')}) state`,
    )
  ).rows[0]!.state;
}
const causalRejection = (error: unknown) =>
  (error instanceof ApplicationError &&
    [
      'RATING_UNAVAILABLE',
      'RATING_SCOPE_UNAVAILABLE',
      'RATING_SCOPED_CONTEXT_CHANGED',
      'CONTENT_REVIEW_UNAVAILABLE',
    ].includes(error.code)) ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514');
const sqlRejection = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23514';
function gate() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrive, arrived, release, released };
}

/** Only canonical source fixtures are issued here. All catalogs/projections are
 * produced by the original compiler/publisher and all old writes use real HTTP. */
async function activationFixture() {
  const f = await ratingScopedFixture();
  try {
    const actor = f.creator;
    await f.grant(actor, 'developer');
    const legacy = await f.catalog(actor, { count: 0 });
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      legacy.catalogId,
      legacy.categoryId,
      ['global'],
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticOpaqueAdoption(tx, adoption),
    );
    await f.declareAll();
    await f.declareScope('global', {
      categoryIds: [legacy.categoryId],
      targetIds: [],
      legacyCatalogIds: [legacy.catalogId],
    });
    const capability = await f.capability();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const policy = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until)
         VALUES($1,NULL,'general','synthetic-activation-create','synthetic-activation-policy','synthetic-activation-owner',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
        [policy],
      );
      await tx.query(
        "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
        [policy],
      );
    });
    const stage = (phase: 'legacy_only' | 'ready') =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        for (const logical of f.logicalScopeKeys) {
          const prior = (
            await tx.query<{ version_id: string }>(
              'SELECT version_id FROM whaleu_ratings.scope_protocol_heads WHERE logical_scope_key=$1 FOR UPDATE',
              [logical],
            )
          ).rows[0];
          const version = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_ratings.scope_protocol_versions(id,logical_scope_key,phase,previous_version_id,generation,manifest)
           VALUES($1,$2,$3,$4,$5,jsonb_build_object('phase',$3::text,'logicalScopeKey',$2::text))`,
            [version, logical, phase, prior?.version_id ?? null, randomUUID()],
          );
          if (prior)
            await tx.query(
              'UPDATE whaleu_ratings.scope_protocol_heads SET version_id=$2 WHERE logical_scope_key=$1',
              [logical, version],
            );
          else
            await tx.query(
              'INSERT INTO whaleu_ratings.scope_protocol_heads VALUES($1,$2)',
              [logical, version],
            );
        }
      });
    const scopedRead = () =>
      f.requestScopedContext(actor, {
        selector: { kind: 'global' },
        purpose: 'read',
        mode: 'public',
      });
    const prepareM1 = async () => {
      const current = (
        await f.pool.query<{ catalog_id: string; revision: string }>(
          `SELECT h.catalog_id,c.revision FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.categories c ON c.catalog_id=h.catalog_id WHERE h.scope_key='global' AND c.id=$1`,
          [legacy.categoryId],
        )
      ).rows[0]!;
      const intent = {
        clientRequestId: randomUUID(),
        regionId: null,
        categoryId: legacy.categoryId,
        expectedCategoryRevision: current.revision,
        expectedCatalogRevision: current.catalog_id,
        name: 'Legacy M1 competing with activation',
        description: '',
        assetIds: [],
      };
      const prepared = await f
        .auth(request(f.http).post('/v1/ratings/management/prepare'), actor)
        .send(intent);
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      const row = (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.target_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, intent.clientRequestId],
        )
      ).rows[0]!;
      await approveRating(f.pool, canonicalRatingEnvelope(row.envelope));
      return {
        requestId: intent.clientRequestId,
        send: () =>
          f
            .auth(request(f.http).post('/v1/ratings/management/targets'), actor)
            .send({
              ...intent,
              expectedContextRevision: prepared.body.contextRevision,
            }),
      };
    };
    const prepareM3A = async () => {
      const current = await f.categoryContext(actor),
        intent = f.categoryIntent(current, {
          nodes: [
            {
              key: 'activation_race',
              parentKey: null,
              name: 'Legacy M3A competing with activation',
              description: '',
            },
          ],
        }),
        prepared = await f.prepareCategories(actor, intent);
      await f.approveCategories(actor, intent);
      return {
        requestId: intent.clientRequestId,
        send: () => f.commitCategories(actor, intent, prepared.contextRevision),
      };
    };
    return {
      ...f,
      actor,
      legacy,
      capability,
      stage,
      scopedRead,
      prepareM1,
      prepareM3A,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test(
  'M3B G7 staged/dormant readiness cannot be replayed as activation or downgraded after adoption',
  { timeout: 240000 },
  async (t) => {
    const f = await activationFixture();
    t.after(() => f.close());
    await f.stage('legacy_only');
    const initial = await publicationSnapshot(f.pool);
    assert.equal(
      (await f.scopedRead()).body.error.code,
      'RATING_SCOPE_UNAVAILABLE',
    );
    assert.deepEqual(await publicationSnapshot(f.pool), initial);
    await f.stage('ready');
    const ready = (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.scope_protocol_heads ORDER BY logical_scope_key',
      )
    ).rows;
    const dormant = await f.publish();
    assert.equal(dormant.outputs.length, f.scopeKeys.length);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.scope_protocol_heads ORDER BY logical_scope_key',
        )
      ).rows,
      ready,
    );
    assert.equal(
      (await f.scopedRead()).body.error.code,
      'RATING_SCOPE_UNAVAILABLE',
    );
    const baseline = await publicationSnapshot(f.pool);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('SELECT whaleu_ratings.activate_rating_scopes($1)', [
          dormant.releaseId,
        ]),
      ),
      sqlRejection,
    );
    assert.deepEqual(await publicationSnapshot(f.pool), baseline);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_ratings.scope_protocol_versions(id,logical_scope_key,phase,previous_version_id,generation,release_id,capability_source_id,capability_source_revision,manifest)
       SELECT $1,h.logical_scope_key,'ready',h.version_id,$2,$3,$4,$5,jsonb_build_object('phase','ready','logicalScopeKey',h.logical_scope_key) FROM whaleu_ratings.scope_protocol_heads h WHERE h.logical_scope_key='global'`,
          [
            id,
            randomUUID(),
            dormant.releaseId,
            f.capability.id,
            f.capability.revision,
          ],
        );
        await tx.query(
          "UPDATE whaleu_ratings.scope_protocol_heads SET version_id=$1 WHERE logical_scope_key='global'",
          [id],
        );
      }),
      sqlRejection,
    );
    assert.deepEqual(
      await publicationSnapshot(f.pool),
      baseline,
      'Ready cannot claim a prior release/capability, even with an exact predecessor',
    );

    const activation = await f.publish({ activate: true });
    const adopted = await publicationSnapshot(f.pool);
    assert.notEqual(activation.releaseId, dormant.releaseId);
    const protocols = (
      await f.pool.query<{
        phase: string;
        previous_version_id: string;
        release_id: string;
        capability_source_id: string;
      }>(
        'SELECT v.* FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id ORDER BY h.logical_scope_key',
      )
    ).rows;
    assert.equal(protocols.length, ready.length);
    for (const [index, value] of protocols.entries()) {
      assert.equal(value.phase, 'adopted');
      assert.equal(value.previous_version_id, ready[index]!.version_id);
      assert.equal(value.release_id, activation.releaseId);
      assert.equal(value.capability_source_id, f.capability.id);
    }
    assert.equal((await f.scopedRead()).status, 200);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('SELECT whaleu_ratings.activate_rating_scopes($1)', [
          activation.releaseId,
        ]),
      ),
      sqlRejection,
    );
    assert.deepEqual(
      await publicationSnapshot(f.pool),
      adopted,
      'Even the last genuine activation cannot be replayed in another transaction',
    );
    for (const phase of ['ready', 'legacy_only'] as const) {
      await assert.rejects(f.stage(phase), sqlRejection);
      assert.deepEqual(
        await publicationSnapshot(f.pool),
        adopted,
        `Adopted cannot downgrade to ${phase}; tentative rows and all epochs roll back`,
      );
    }
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.scope_protocol_heads SET version_id=$1 WHERE logical_scope_key=$2',
          [ready[0]!.version_id, ready[0]!.logical_scope_key],
        ),
      ),
      sqlRejection,
    );
    assert.deepEqual(await publicationSnapshot(f.pool), adopted);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "DELETE FROM whaleu_ratings.scope_protocol_heads WHERE logical_scope_key='global'",
        ),
      ),
      sqlRejection,
    );
    assert.deepEqual(await publicationSnapshot(f.pool), adopted);
  },
);

test(
  'M3B G7 activation wins the actual management lock race and both old M1/M3A commands roll back',
  { timeout: 240000 },
  async (t) => {
    const f = await activationFixture();
    t.after(() => f.close());
    await f.stage('ready');
    await f.publish();
    const m1 = await f.prepareM1(),
      m3a = await f.prepareM3A(),
      observer = observeDirectoryQueries(f.app),
      barrier = gate(),
      oldAttempts = gate();
    let waiting = 0,
      activationPid: number | undefined,
      activated: Awaited<ReturnType<typeof publicationSnapshot>> | undefined;
    observer.setBeforeHook(async ({ sql }) => {
      if (
        sql ===
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))"
      ) {
        waiting++;
        if (waiting === 2) oldAttempts.arrive();
      }
    });
    const activation = withCommunityScopeWriter(f.pool, async (tx) => {
      await f.publish({ activate: true }, tx);
      activationPid = (
        await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      activated = await publicationSnapshot(tx);
      barrier.arrive();
      await barrier.released;
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let commands: Promise<request.Response[]> | undefined;
    try {
      await Promise.race([
        barrier.arrived,
        activation.then((result) => {
          throw new Error(
            `Activation did not reach its real complete tentative publication: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      commands = Promise.all([
        m1.send().then((r) => r),
        m3a.send().then((r) => r),
      ]);
      await Promise.race([
        oldAttempts.arrived,
        commands.then(() => {
          throw new Error(
            'Both real old commands must attempt the policy lock while activation holds it',
          );
        }),
      ]);
      const limit = performance.now() + 3000;
      let blocked = 0;
      while (blocked < 2 && performance.now() < limit) {
        blocked = (
          await f.pool.query<{ blocked: number }>(
            "SELECT count(DISTINCT pid)::int blocked FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1::integer=ANY(pg_blocking_pids(pid))",
            [activationPid],
          )
        ).rows[0]!.blocked;
        if (blocked < 2) await delay(10);
      }
      assert.equal(
        blocked,
        2,
        'Both real old transactions must wait behind the unpublished activation, with no replaced query results',
      );
      barrier.release();
      const committed = await activation;
      assert.equal(committed.ok, true, JSON.stringify(committed));
      const responses = await commands;
      for (const response of responses) {
        assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
      }
      assert.ok(activated);
      assert.deepEqual(
        await publicationSnapshot(f.pool),
        activated,
        'No old request, target, category, catalog/head, protocol or epoch may survive after activation won',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=ANY($2::uuid[])',
            [f.actor.accountId, [m1.requestId, m3a.requestId]],
          )
        ).rowCount,
        0,
      );
    } finally {
      barrier.release();
      await activation;
      await commands;
      observer.restore();
    }
  },
);

for (const operation of ['M1', 'M3A'] as const)
  test(
    `M3B G7 real legacy ${operation} wins the lock race; dormant coverage cannot erase the new legacy head during activation`,
    { timeout: 240000 },
    async (t) => {
      const f = await activationFixture();
      t.after(() => f.close());
      await f.stage('ready');
      const dormant = await f.publish();
      const command =
          operation === 'M1' ? await f.prepareM1() : await f.prepareM3A(),
        observer = observeDirectoryQueries(f.app),
        barrier = gate();
      let expected: Awaited<ReturnType<typeof publicationSnapshot>> | undefined,
        legacyPid: number | undefined;
      observer.setHook(async ({ sql }, tx) => {
        if (sql !== 'SET CONSTRAINTS ALL IMMEDIATE') return;
        observer.setHook(null);
        legacyPid = (
          await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        expected = await publicationSnapshot(tx);
        barrier.arrive();
        await barrier.released;
      });
      const legacy = command.send().then((response) => response);
      let activating:
        Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        await Promise.race([
          barrier.arrived,
          legacy.then((response) => {
            throw new Error(
              `Legacy command did not reach its genuine deferred final boundary: ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        activating = f.publish({ activate: true }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const limit = performance.now() + 3000;
        let blocked = false;
        while (!blocked && performance.now() < limit) {
          blocked = (
            await f.pool.query<{ blocked: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1::integer=ANY(pg_blocking_pids(pid))) blocked",
              [legacyPid],
            )
          ).rows[0]!.blocked;
          if (!blocked) await delay(10);
        }
        assert.equal(
          blocked,
          true,
          'Activation must wait on the real old writer, not observe an uncommitted or fabricated catalog',
        );
        barrier.release();
        const completed = await legacy;
        assert.equal(completed.status, 200, JSON.stringify(completed.body));
        assert.equal(completed.body.outcome, 'applied');
        const outcome = await activating;
        assert.equal(
          outcome.ok,
          false,
          'Activation must not overwrite new legacy categories/targets using dormant old source coverage',
        );
        if (outcome.ok) assert.fail();
        assert.ok(causalRejection(outcome.error), String(outcome.error));
        assert.ok(expected);
        assert.deepEqual(
          await publicationSnapshot(f.pool),
          expected,
          'Failed activation must roll back all tentative scoped/compat/legacy/protocol rows and epochs while retaining the winning old command',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scoped_releases WHERE id<>$1',
              [dormant.releaseId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await f.scopedRead()).body.error.code,
          'RATING_SCOPE_UNAVAILABLE',
        );
      } finally {
        barrier.release();
        await legacy;
        await activating;
        observer.restore();
      }
    },
  );
