import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { pinCommandSchema } from '../../src/community/post-pins/contracts.js';
import { pinIntentHash } from '../../src/community/post-pins/service.js';
import { relatedSyncRuntimeFixture } from '../support/related-sync-fixtures.js';
import {
  appendTopologyRevision,
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'related management keeps one graph, exact destination slots, pure removal and explicit unsupported Profile boundaries',
  { timeout: 240000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture();
    t.after(() => f.close());
    await setRegionPolicy(f.pool, f.scope.home.regionId, {
      relatedSyncEnabled: true,
      unverifiedCommentEnabled: true,
    });
    const author = await f.actor(),
      peer = await f.actor(),
      a = await f.actor(),
      b = await f.actor({ campusId: f.scope.related.campusId }),
      c = await f.actor({ campusId: f.scope.foreign.campusId }),
      developer = await f.actor(),
      superAdmin = await f.actor();
    type Actor = typeof author;
    const http = f.app.getHttpServer();
    const get = (path: string, actor = author) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const send = (path: string, body: object, actor = author) =>
      request(http)
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const grant = async (actor: Actor, role: string, region: string | null) =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-related-management')",
          [id, actor.accountId, role, region],
        );
        return id;
      });
    await grant(a, 'school_admin', f.scope.home.regionId);
    await grant(b, 'school_admin', f.scope.related.regionId);
    const cGrant = await grant(c, 'school_admin', f.scope.foreign.regionId);
    await grant(developer, 'developer', null);
    await grant(superAdmin, 'super_admin', null);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const region of [f.scope.home, f.scope.related, f.scope.foreign]) {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until) VALUES($1,$2,'regional',$3,'synthetic-related-pin-scope','accepted',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
          [id, region.spaceId, region.regionId],
        );
        await tx.query(
          "INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until) VALUES($1,'accepted_empty','synthetic-related-pin-history',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
          [id],
        );
      }
    });
    const publish = async (
      authorMode: 'named' | 'anonymous' = 'named',
      sync = true,
    ) => {
      const input = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic management ' + randomUUID(),
        authorMode,
        imageAssetIds: [],
        commentsPolicy: 'open',
        ...(sync ? { syncToRelatedCampuses: true } : {}),
      };
      ok(await send('/v1/community/reviews/posts', input));
      await f.decide(author.accountId, input.clientRequestId);
      const r = await send('/v1/community/posts', input);
      ok(r, 201);
      assert.equal(r.body.outcome, 'created');
      return r.body.resourceId as string;
    };
    const child = async (
      postId: string,
      rootId?: string,
      authorMode: 'named' | 'anonymous' = 'named',
    ) => {
      const input = {
        clientRequestId: randomUUID(),
        text: 'Synthetic related child ' + randomUUID(),
        imageAssetIds: [],
        authorMode,
        ...(rootId ? { targetReplyId: null } : {}),
      };
      const path = rootId
        ? `comments/${rootId}/replies`
        : `posts/${postId}/comments`;
      ok(await send(`/v1/community/reviews/${path}`, input, peer));
      await f.decide(peer.accountId, input.clientRequestId);
      const r = await send(`/v1/community/${path}`, input, peer);
      ok(r, 201);
      return {
        kind: rootId ? ('reply' as const) : ('comment' as const),
        id: r.body.resourceId as string,
      };
    };
    const postId = await publish(),
      anonymous = await publish('anonymous'),
      legacy = await publish('named', false);
    const root = await child(postId),
      reply = await child(postId, root.id),
      anonymousRoot = await child(postId, undefined, 'anonymous');
    const pin = (actor: Actor, spaceId: string, extra: object = {}) =>
      send(
        '/v1/community/post-pin-commands',
        {
          clientRequestId: randomUUID(),
          version: 2,
          spaceId,
          postId,
          operation: 'pin',
          ...extra,
        },
        actor,
      );
    const management = (
      actor: Actor,
      target: { kind: string; id: string },
      viewSpaceId: string,
    ) =>
      get(
        `/v1/community/admin-${target.kind === 'post' ? 'post' : 'discussion'}-removal/management`,
        actor,
      ).query({ ...target, version: '3', viewSpaceId });
    const removal = (
      actor: Actor,
      target: { kind: string; id: string },
      viewSpaceId: string,
      targetVersion: string,
      extra: object = {},
    ) =>
      send(
        `/v1/community/admin-${target.kind === 'post' ? 'post' : 'discussion'}-removal/commands`,
        {
          clientRequestId: randomUUID(),
          version: 3,
          viewSpaceId,
          target,
          expectedTargetVersion: targetVersion,
          action: target.kind === 'post' ? 'remove_post' : 'remove_discussion',
          ...extra,
        },
        actor,
      );
    let aPin: string, bPin: string;
    await t.test(
      'A and B slots are independent; developer is allowed only at canonical A; wrong destination cannot unpin',
      async () => {
        const original = await pin(a, f.scope.home.spaceId),
          remote = await pin(b, f.scope.related.spaceId);
        ok(original);
        ok(remote);
        aPin = original.body.pinId;
        bPin = remote.body.pinId;
        assert.notEqual(aPin, bPin);
        assert.equal(
          (
            await get(`/v1/community/posts/${postId}/pin`, developer).query({
              viewSpaceId: f.scope.home.spaceId,
            })
          ).body.canPin,
          true,
        );
        assert.equal(
          (
            await get(`/v1/community/posts/${postId}/pin`, developer).query({
              viewSpaceId: f.scope.related.spaceId,
            })
          ).body.canPin,
          false,
        );
        ok(await pin(developer, f.scope.related.spaceId), 403);
        assert.notEqual((await pin(c, f.scope.foreign.spaceId)).status, 200);
        const wrong = await pin(b, f.scope.related.spaceId, {
          operation: 'unpin',
          pinId: aPin,
        });
        assert.notEqual(wrong.status, 200);
        for (const scope of [f.scope.home, f.scope.related]) {
          const page = await get('/v1/community/post-pins').query({
            spaceId: scope.spaceId,
          });
          ok(page);
          assert.equal(page.body.items[0].post.id, postId);
          assert.equal(page.body.items[0].post.space.id, f.scope.home.spaceId);
          assert.equal(
            page.body.items[0].post.isRelatedCampusSync,
            scope === f.scope.related,
          );
        }
      },
    );
    await t.test(
      'post/comment/reply Profile capabilities are explicitly unavailable from A and B without identity data',
      async () => {
        for (const actor of [a, b])
          for (const target of [{ kind: 'post', id: postId }, root, reply]) {
            for (const [path, capability] of [
              ['profile-moderation', 'canReset'],
              ['profile-avatar-moderation', 'canClearCustomAvatar'],
            ] as const) {
              const response = await get(
                `/v1/community/${path}/management`,
                actor,
              ).query(target);
              ok(response);
              assert.deepEqual(response.body, {
                target,
                [capability]: false,
                availability: 'unavailable',
                blocker: 'related_sync_unsupported',
              });
              const command = {
                clientRequestId: randomUUID(),
                target,
                expectedProfileRevision: 0,
                action:
                  path === 'profile-moderation'
                    ? 'reset_nickname'
                    : 'clear_custom_avatar',
                ...(path === 'profile-avatar-moderation'
                  ? { expectedAppearanceId: randomUUID() }
                  : {}),
              };
              ok(
                await send(`/v1/community/${path}/commands`, command, actor),
                404,
              );
            }
          }
        for (const target of [{ kind: 'post', id: anonymous }, anonymousRoot])
          for (const path of [
            'profile-moderation',
            'profile-avatar-moderation',
          ])
            ok(
              await get(`/v1/community/${path}/management`, b).query(target),
              404,
            );
        for (const actor of [a, b]) {
          const category = await get(
            `/v1/community/posts/${postId}/category-management`,
            actor,
          );
          ok(category);
          assert.equal(category.body.canChange, false);
          assert.deepEqual(category.body.targets, []);
          assert.equal(category.body.blocker, 'related_sync_unsupported');
          ok(
            await send(
              '/v1/community/category-commands',
              {
                clientRequestId: randomUUID(),
                postId,
                expectedRevision: 0,
                targetCategory: 'pets',
              },
              actor,
            ),
            503,
          );
        }
      },
    );
    await t.test(
      'related-only B cannot issue punishment; direct A v2 remains compatible; own post and foreign grants deny',
      async () => {
        const target = { kind: 'post', id: postId };
        ok(
          await get('/v1/community/admin-post-removal/management', b).query({
            ...target,
            version: '2',
          }),
          403,
        );
        const direct = await get(
          '/v1/community/admin-post-removal/management',
          a,
        ).query({ ...target, version: '2' });
        ok(direct);
        assert.ok(direct.body.punishmentOptions);
        const remote = await management(b, target, f.scope.related.spaceId);
        ok(remote);
        assert.equal(remote.body.version, 3);
        assert.equal('punishmentOptions' in remote.body, false);
        assert.notEqual(
          (await management(c, target, f.scope.foreign.spaceId)).status,
          200,
        );
        await grant(author, 'school_admin', f.scope.home.regionId);
        assert.notEqual(
          (await management(author, target, f.scope.home.spaceId)).status,
          200,
        );
        const protectedCommand = {
          clientRequestId: randomUUID(),
          version: 2,
          target,
          expectedTargetVersion: direct.body.targetVersion,
          action: 'remove_post',
          punishment: {
            kind: 'interaction_mute',
            expectedRevision: '0',
            duration: { kind: 'finite', unit: 'hours', value: 1 },
            reason: 'Synthetic protected author',
          },
        };
        assert.notEqual(
          (
            await send(
              '/v1/community/admin-post-removal/commands',
              protectedCommand,
              superAdmin,
            )
          ).status,
          200,
        );
        // Unversioned none-source management is still byte-compatible.
        const old = await get(
          '/v1/community/admin-post-removal/management',
          a,
        ).query({ kind: 'post', id: legacy });
        ok(old);
        assert.deepEqual(Object.keys(old.body).sort(), [
          'canRemove',
          'target',
          'targetVersion',
        ]);
      },
    );
    await t.test(
      'B pure child removals act once, with v3 receipts and no account punishment',
      async () => {
        for (const target of [reply, root]) {
          const view = await management(b, target, f.scope.related.spaceId);
          ok(view);
          const response = await removal(
            b,
            target,
            f.scope.related.spaceId,
            view.body.targetVersion,
          );
          ok(response);
          assert.equal(response.body.outcome, 'applied');
          assert.equal(response.body.version, 3);
          assert.equal(response.body.viewSpaceId, f.scope.related.spaceId);
          assert.equal('punishment' in response.body, false);
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_safety.account_punishments',
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'withdrawal hides B projection, preserves private slot occupancy and allows exact B cleanup only',
      async () => {
        const topology = structuredClone(f.scope.topology);
        topology.regions.find(
          (r) => r.regionId === f.scope.related.regionId,
        )!.groupId = topology.regions.find(
          (r) => r.regionId === f.scope.foreign.regionId,
        )!.groupId;
        await appendTopologyRevision(f.pool, topology);
        const page = await get('/v1/community/post-pins', b).query({
          spaceId: f.scope.related.spaceId,
        });
        ok(page);
        assert.deepEqual(page.body.items, []);
        assert.notEqual((await pin(b, f.scope.related.spaceId)).status, 200);
        assert.notEqual(
          (
            await pin(b, f.scope.related.spaceId, {
              operation: 'read',
              pinId: bPin,
            })
          ).status,
          200,
        );
        const slot = await get('/v1/community/post-pin-slot', b).query({
          spaceId: f.scope.related.spaceId,
        });
        ok(slot);
        assert.equal(slot.body.pin.pinId, bPin);
        assert.equal(slot.body.canUnpin, true);
        ok(
          await pin(b, f.scope.related.spaceId, {
            operation: 'unpin',
            pinId: bPin,
          }),
        );
        const original = await get('/v1/community/post-pin-slot', a).query({
          spaceId: f.scope.home.spaceId,
        });
        ok(original);
        assert.equal(original.body.pin.pinId, aPin);
      },
    );
    await t.test(
      'newly related C can pin old root; source-generation ABA and raw mutations cannot pass final proof',
      async () => {
        const topology = structuredClone(f.scope.topology);
        const homeGroup = topology.regions.find(
          (r) => r.regionId === f.scope.home.regionId,
        )!.groupId;
        const otherGroup = topology.regions.find(
          (r) => r.regionId === f.scope.foreign.regionId,
        )!.groupId;
        topology.regions.find(
          (r) => r.regionId === f.scope.related.regionId,
        )!.groupId = otherGroup;
        topology.regions.find(
          (r) => r.regionId === f.scope.foreign.regionId,
        )!.groupId = homeGroup;
        await appendTopologyRevision(f.pool, topology);
        ok(await pin(c, f.scope.foreign.spaceId));
        const database = f.app.get(DatabaseService),
          original = database.transaction,
          run = original.bind(database);
        let injected = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const raw = tx.query,
              query = raw.bind(tx) as (
                sql: string,
                values?: unknown[],
              ) => Promise<QueryResult>;
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              if (
                !injected &&
                sql.startsWith(
                  'SELECT whaleu_community.admin_post_removal_input_facts',
                )
              ) {
                injected = true;
                await query(
                  'UPDATE whaleu_campus.operating_regions SET is_active=is_active WHERE false',
                );
              }
              return result;
            }) as PoolClient['query'];
            try {
              return await work(tx);
            } finally {
              tx.query = raw;
            }
          }, options);
        try {
          assert.notEqual(
            (
              await management(
                c,
                { kind: 'post', id: postId },
                f.scope.foreign.spaceId,
              )
            ).status,
            200,
          );
        } finally {
          database.transaction = original;
        }
        assert.equal(injected, true);
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_campus.community_distribution_generation SET generation=generation',
          ),
        );
        await assert.rejects(
          f.pool.query(
            'TRUNCATE whaleu_campus.community_distribution_generation',
          ),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
              [postId],
            )
          ).rows[0].deleted_at,
          null,
        );
      },
    );
    await t.test(
      'raw pin and read retain original Review, Safety and Media visibility across ABA and zero-row writes',
      async () => {
        // No DatabaseService transaction or required TypeScript proof participates.
        // The same legal source mutation succeeds before observation and fails
        // after admission, even after all original constraint events were flushed.
        type Change =
          'review_aba' | 'review_zero' | 'safety_zero' | 'media_zero';
        const mutate = async (tx: PoolClient, change: Change) => {
          if (change === 'review_aba') {
            for (const state of ['revoked', 'allow']) {
              await tx.query(
                `WITH changed AS (
                  INSERT INTO whaleu_community.content_approval_events
                    (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
                  SELECT gen_random_uuid(),decision_id,$2,'complete','accepted',
                    'synthetic-related-pin-review','synthetic-append-only-ABA',clock_timestamp()
                  FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1
                  RETURNING id,decision_id)
                 UPDATE whaleu_community.content_approval_heads h SET event_id=changed.id
                 FROM changed WHERE h.decision_id=changed.decision_id`,
                [postId, state],
              );
            }
          } else {
            const statements = {
              review_zero:
                'UPDATE whaleu_community.content_approval_heads SET event_id=event_id WHERE false',
              safety_zero:
                'UPDATE whaleu_safety.blocks SET active=active WHERE false',
              media_zero: 'UPDATE whaleu_media.assets SET id=id WHERE false',
            };
            await tx.query(statements[change]);
          }
          assert.equal(
            (
              await tx.query<{ visible: boolean }>(
                'SELECT whaleu_community.related_pin_visible($1,$2,$3) visible',
                [c.accountId, postId, f.scope.foreign.spaceId],
              )
            ).rows[0]?.visible,
            true,
            'current visibility alone cannot detect this source change',
          );
        };
        for (const operation of ['pin', 'read'] as const) {
          for (const change of [
            'review_aba',
            'review_zero',
            'safety_zero',
            'media_zero',
          ] as const) {
            for (const afterAdmission of [false, true]) {
              const actor = operation === 'pin' ? c : await f.actor();
              const requestId = randomUUID();
              const tx = await f.pool.connect();
              try {
                await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
                await tx.query(
                  "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
                );
                if (!afterAdmission) await mutate(tx, change);
                const source = (
                  await tx.query<{ scope_id: string; pin_id: string }>(
                    `SELECT h.scope_id,h.pin_id FROM whaleu_community.post_pin_heads h
                   JOIN whaleu_community.post_pin_scopes s ON s.id=h.scope_id WHERE s.space_id=$1`,
                    [f.scope.foreign.spaceId],
                  )
                ).rows[0]!;
                const session = (
                  await tx.query<{ session_id: string }>(
                    'SELECT session_id FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                    [hashToken(actor.accessToken)],
                  )
                ).rows[0]!;
                let pinId = source.pin_id;
                let recordedAt: string;
                if (operation === 'pin') {
                  await tx.query(
                    "INSERT INTO whaleu_community.post_pin_closures(pin_id,reason,actor_id,request_id) VALUES($1,'renewed',$2,$3)",
                    [source.pin_id, actor.accountId, requestId],
                  );
                  pinId = randomUUID();
                  const row = (
                    await tx.query<{ pinned_at: Date }>(
                      `INSERT INTO whaleu_community.post_pins
                      (id,scope_id,post_id,actor_id,request_id,level,duration_hours,pinned_at,pinned_until,provenance)
                     SELECT $1,$2,$3,$4,$5,2,24,instant,instant+interval '24 hours','native'
                     FROM (SELECT clock_timestamp() instant) now RETURNING pinned_at`,
                      [
                        pinId,
                        source.scope_id,
                        postId,
                        actor.accountId,
                        requestId,
                      ],
                    )
                  ).rows[0]!;
                  recordedAt = row.pinned_at.toISOString();
                  await tx.query(
                    'UPDATE whaleu_community.post_pin_heads SET pin_id=$1 WHERE scope_id=$2',
                    [pinId, source.scope_id],
                  );
                } else {
                  const row = (
                    await tx.query<{ read_at: Date }>(
                      'INSERT INTO whaleu_community.post_pin_reads(actor_id,pin_id,request_id) VALUES($1,$2,$3) RETURNING read_at',
                      [actor.accountId, pinId, requestId],
                    )
                  ).rows[0]!;
                  recordedAt = row.read_at.toISOString();
                }
                const command = pinCommandSchema.parse({
                  clientRequestId: requestId,
                  version: 2,
                  spaceId: f.scope.foreign.spaceId,
                  operation,
                  postId,
                  ...(operation === 'read' ? { pinId } : {}),
                });
                const receipt = {
                  requestId,
                  operation,
                  postId,
                  outcome: 'applied',
                  pinId,
                  recordedAt,
                };
                await tx.query(
                  `INSERT INTO whaleu_community.post_pin_commands
                   (actor_id,request_id,intent_hash,command,receipt,session_id,scope_id,grant_id)
                   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
                  [
                    actor.accountId,
                    requestId,
                    pinIntentHash(actor.accountId, command),
                    JSON.stringify(command),
                    JSON.stringify(receipt),
                    session.session_id,
                    source.scope_id,
                    operation === 'pin' ? cGrant : null,
                  ],
                );
                // A positive flush proves native rows, receipts and 0136 action
                // proofs are otherwise valid before we make the paired change.
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                if (afterAdmission) {
                  await tx.query('SET CONSTRAINTS ALL DEFERRED');
                  await mutate(tx, change);
                }
                if (afterAdmission) {
                  await assert.rejects(tx.query('COMMIT'), {
                    code: '23514',
                    constraint: 'post_pin_causal',
                  });
                } else {
                  await tx.query('COMMIT');
                }
              } finally {
                await tx.query('ROLLBACK');
                tx.release();
              }
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.post_pin_commands WHERE request_id=$1',
                    [requestId],
                  )
                ).rowCount,
                afterAdmission ? 0 : 1,
              );
              if (afterAdmission) {
                for (const table of [
                  'post_pins',
                  'post_pin_reads',
                  'post_pin_closures',
                ]) {
                  assert.equal(
                    (
                      await f.pool.query(
                        `SELECT 1 FROM whaleu_community.${table} WHERE request_id=$1`,
                        [requestId],
                      )
                    ).rowCount,
                    0,
                    `${operation}/${change} rolls back ${table}`,
                  );
                }
              }
            }
          }
        }
      },
    );
    await t.test(
      'late raw topology zero-row writes cannot outlive pin or removal constraint flushing',
      async () => {
        await f.pool
          .query(`CREATE FUNCTION whaleu_community.related_pin_test_source() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      UPDATE whaleu_campus.operating_regions SET is_active=is_active WHERE false;RETURN NULL;END$$;
      CREATE CONSTRAINT TRIGGER zz_related_pin_test_source AFTER INSERT ON whaleu_community.post_pin_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_pin_test_source()`);
        const key = randomUUID();
        try {
          assert.notEqual(
            (await pin(c, f.scope.foreign.spaceId, { clientRequestId: key }))
              .status,
            200,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_related_pin_test_source ON whaleu_community.post_pin_commands;DROP FUNCTION whaleu_community.related_pin_test_source()',
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_pin_commands WHERE request_id=$1',
              [key],
            )
          ).rowCount,
          0,
        );
        const target = { kind: 'post', id: postId },
          view = await management(c, target, f.scope.foreign.spaceId);
        ok(view);
        const database = f.app.get(DatabaseService),
          original = database.transaction,
          run = original.bind(database);
        let injected = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const raw = tx.query,
              query = raw.bind(tx) as (
                sql: string,
                values?: unknown[],
              ) => Promise<QueryResult>;
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              if (
                !injected &&
                sql.startsWith(
                  'INSERT INTO whaleu_notifications.admin_post_removal_notices',
                )
              ) {
                injected = true;
                await query('SET CONSTRAINTS ALL IMMEDIATE');
                await query(
                  'UPDATE whaleu_campus.operating_regions SET is_active=is_active WHERE false',
                );
              }
              return result;
            }) as PoolClient['query'];
            try {
              return await work(tx);
            } finally {
              tx.query = raw;
            }
          }, options);
        try {
          assert.notEqual(
            (
              await removal(
                c,
                target,
                f.scope.foreign.spaceId,
                view.body.targetVersion,
              )
            ).status,
            200,
          );
        } finally {
          database.transaction = original;
        }
        assert.equal(injected, true);
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
              [postId],
            )
          ).rows[0].deleted_at,
          null,
        );
      },
    );
    await t.test(
      'C pure post removal closes every slot once; original-key receipt survives grant withdrawal',
      async () => {
        const target = { kind: 'post', id: postId },
          view = await management(c, target, f.scope.foreign.spaceId);
        ok(view);
        const key = randomUUID();
        const result = await removal(
          c,
          target,
          f.scope.foreign.spaceId,
          view.body.targetVersion,
          { clientRequestId: key },
        );
        ok(result);
        assert.equal(result.body.outcome, 'applied');
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_events WHERE target_id=$1',
              [postId],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.post_pins p WHERE post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id)',
              [postId],
            )
          ).rows[0].n,
          0,
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
            [cGrant],
          ),
        );
        const recovered = await get(
          `/v1/community/admin-post-removal/requests/${key}`,
          c,
        );
        ok(recovered);
        assert.deepEqual(recovered.body.receipt, result.body);
        const replay = await removal(
          c,
          target,
          f.scope.foreign.spaceId,
          view.body.targetVersion,
          { clientRequestId: key },
        );
        ok(replay);
        assert.deepEqual(replay.body, result.body);
      },
    );
  },
);
