import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingCategoryFixture,
  ratingCategoryPrefix as prefix,
} from '../support/rating-category-fixture.js';
import {
  withCommunityScopeWriter,
  appendTopologyRevision,
} from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';

test(
  'M3A category final deadlines roll back the entire released catalog set after a real deferred SQL wait',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    for (const mode of [
      'review_consume',
      'review_visibility',
      'grant',
      'topology',
      'token',
      'preparation',
    ] as const)
      await t.test(mode, async () => {
        const actor = await f.actor();
        await f.grant(actor, 'super_admin');
        if (mode === 'topology')
          await appendTopologyRevision(f.pool, f.scope.topology, {
            validUntil: Date.now() + 2000,
          });
        if (mode === 'grant')
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference,valid_from) VALUES(gen_random_uuid(),$1,'developer',$1,'synthetic-category-future-grant',clock_timestamp()+interval '2 seconds')",
              [actor.accountId],
            ),
          );
        const current = await f.categoryContext(actor),
          intent = f.categoryIntent(current, {
            nodes: [
              {
                key: 'root',
                parentKey: null,
                name: `Deferred ${mode}`,
                description: '',
              },
            ],
          });
        if (mode === 'preparation')
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
            [actor.sessionId],
          );
        const prepared = await f.prepareCategories(actor, intent);
        if (mode === 'preparation')
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '10 minutes' WHERE session_id=$1",
            [actor.sessionId],
          );
        await f.approveCategories(
          actor,
          intent,
          mode === 'review_consume'
            ? { consumeUntil: new Date(Date.now() + 2000) }
            : mode === 'review_visibility'
              ? { visibilityUntil: new Date(Date.now() + 2000) }
              : {},
        );
        const beforeHeads = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
          )
        ).rows;
        const beforeEpoch = (
          await f.pool.query(
            'SELECT n.epoch::text navigation,p.epoch::text pool,b.epoch::text binding FROM whaleu_ratings.navigation_epoch n CROSS JOIN whaleu_ratings.random_pool_epoch p CROSS JOIN whaleu_community.rating_review_binding_epoch b',
          )
        ).rows;
        let installed = false,
          tentative = false;
        const observer = observeDirectoryQueries(f.app);
        try {
          await f.pool
            .query(`CREATE FUNCTION whaleu_ratings.synthetic_category_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$;
        CREATE CONSTRAINT TRIGGER synthetic_category_wait AFTER INSERT ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='create_categories') EXECUTE FUNCTION whaleu_ratings.synthetic_category_wait()`);
          installed = true;
          if (mode === 'token')
            await f.pool.query(
              "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
              [actor.sessionId],
            );
          observer.setHook(async ({ sql }, tx) => {
            if (sql.includes('SELECT whaleu_ratings.category_command_publish('))
              tentative = (
                await tx.query<{ ready: boolean }>(
                  `SELECT EXISTS(SELECT 1 FROM whaleu_ratings.category_command_transitions WHERE actor_account_id=$1 AND request_id=$2)
          AND (SELECT count(*) FROM whaleu_ratings.category_release_catalogs WHERE release_id=(SELECT release_id FROM whaleu_ratings.category_command_preparations WHERE account_id=$1 AND request_id=$2))=4 ready`,
                  [actor.accountId, intent.clientRequestId],
                )
              ).rows[0]!.ready;
          });
          const started = Date.now(),
            response = await f.commitCategories(
              actor,
              intent,
              prepared.contextRevision,
            );
          assert.ok(
            Date.now() - started >= 2300,
            'A real deferred wait must follow tentative publication',
          );
          assert.ok(
            tentative,
            'All affected catalog manifests existed before finalization',
          );
          assert.ok(response.status >= 400, JSON.stringify(response.body));
          assert.equal(response.body.outcome, undefined);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, intent.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.category_command_transitions WHERE actor_account_id=$1 AND request_id=$2',
                [actor.accountId, intent.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
              )
            ).rows,
            beforeHeads,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT n.epoch::text navigation,p.epoch::text pool,b.epoch::text binding FROM whaleu_ratings.navigation_epoch n CROSS JOIN whaleu_ratings.random_pool_epoch p CROSS JOIN whaleu_community.rating_review_binding_epoch b',
              )
            ).rows,
            beforeEpoch,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.category_command_preparations WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, intent.clientRequestId],
              )
            ).rowCount,
            1,
          );
        } finally {
          observer.restore();
          if (installed)
            await f.pool.query(
              'DROP TRIGGER synthetic_category_wait ON whaleu_ratings.requests;DROP FUNCTION whaleu_ratings.synthetic_category_wait()',
            );
          if (mode === 'topology')
            await appendTopologyRevision(f.pool, f.scope.topology);
        }
      });
  },
);

test(
  'M3A concurrent global and regional category commands preserve exact all-scope CAS',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const actor = await f.actor();
    await f.grant(actor, 'super_admin');
    await f.createCategories(actor);
    for (const firstScope of [null, f.scope.home.regionId]) {
      const global = f.categoryIntent(await f.categoryContext(actor), {
          nodes: [
            {
              key: 'root',
              parentKey: null,
              name: 'Concurrent global category',
              description: '',
            },
          ],
        }),
        local = f.categoryIntent(
          await f.categoryContext(actor, f.scope.home.regionId),
          {
            nodes: [
              {
                key: 'root',
                parentKey: null,
                name: 'Concurrent local category',
                description: '',
              },
            ],
          },
        );
      const a = await f.prepareCategories(actor, global),
        b = await f.prepareCategories(actor, local);
      await f.approveCategories(actor, global);
      await f.approveCategories(actor, local);
      const ordered =
        firstScope === null
          ? ([
              [global, a],
              [local, b],
            ] as const)
          : ([
              [local, b],
              [global, a],
            ] as const);
      let reach!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
          reach = resolve;
        }),
        held = new Promise<void>((resolve) => {
          release = resolve;
        });
      const observer = observeDirectoryQueries(f.app);
      let captured = false;
      observer.setHook(async ({ sql }) => {
        if (
          !captured &&
          sql.includes('SELECT whaleu_ratings.category_command_publish(')
        ) {
          captured = true;
          reach();
          await held;
        }
      });
      let first!: request.Response, second!: request.Response;
      const firstRequest = f
        .commitCategories(actor, ordered[0][0], ordered[0][1].contextRevision)
        .then((value) => value);
      let secondRequest: Promise<request.Response> | undefined;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reached,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error('Expected actual category publication barrier'),
                  ),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        secondRequest = f
          .commitCategories(actor, ordered[1][0], ordered[1][1].contextRevision)
          .then((value) => value);
        release();
        [first, second] = await Promise.all([firstRequest, secondRequest]);
      } finally {
        release();
        await Promise.allSettled([
          firstRequest,
          ...(secondRequest ? [secondRequest] : []),
        ]);
        observer.restore();
      }
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.outcome, 'applied');
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.code, 'RATING_CATEGORY_CONTEXT_CHANGED');
      assert.deepEqual(
        (
          await f.auth(
            request(f.http).get(
              `${prefix}/requests/${ordered[0][0].clientRequestId}`,
            ),
            actor,
          )
        ).body,
        first.body,
      );
    }
  },
);
