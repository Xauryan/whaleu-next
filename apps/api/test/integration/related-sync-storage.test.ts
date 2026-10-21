import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import request from 'supertest';
import {
  assertRelatedSyncRuntimeWiring,
  relatedSyncRuntimeFixture,
} from '../support/related-sync-fixtures.js';
import {
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import { ReadingFormattingRuntime } from '../../src/community/reading-formatting/runtime.js';
import { HistoricalReadingFormattingRuntime } from '../support/historical-content-definition/reading-enrollment.js';
import {
  HistoricalContentDefinitionRepository,
  historicalTextSourceAbsenceSql,
} from '../support/historical-content-definition/configure.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { mediaActorScope } from '../../src/community/media/owner.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { parseTopology } from '../../src/campus/community-policy/fact-validation.js';

const checkViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23514';
const exactEnvelope = (value: unknown) => {
  try {
    return canonicalJson(canonicalEnvelope(value)) === canonicalJson(value);
  } catch {
    return false;
  }
};

test(
  'related native storage retains immutable source, generation observations and two-way causal publication',
  { timeout: 240000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture();
    try {
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
        unverifiedCommentEnabled: true,
      });
      const actor = await f.actor(),
        commenter = await f.actor({ campusId: f.scope.related.campusId });
      const auth = `Bearer ${actor.accessToken}`,
        childAuth = `Bearer ${commenter.accessToken}`;
      const postInput = (sync: boolean) => ({
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: `Synthetic ${sync ? 'related' : 'legacy'} storage root`,
        authorMode: 'named',
        commentsPolicy: 'open',
        imageAssetIds: [] as string[],
        ...(sync ? { syncToRelatedCampuses: true } : {}),
      });
      const submit = (input: object) =>
        request(f.app.getHttpServer())
          .post('/v1/community/reviews/posts')
          .set('Authorization', auth)
          .send(input);
      const publish = (input: object) =>
        request(f.app.getHttpServer())
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(input);
      const create = async (input: ReturnType<typeof postInput>) => {
        const pending = await submit(input);
        assert.equal(pending.status, 200, JSON.stringify(pending.body));
        await f.decide(actor.accountId, input.clientRequestId);
        const result = await publish(input);
        assert.equal(
          result.body.outcome,
          'created',
          JSON.stringify(result.body),
        );
        const row = (
          await f.pool.query<{
            envelope: EffectiveContentEnvelope;
            decision_id: string;
            digest: string;
          }>(
            "SELECT envelope,decision_id,digest FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
            [result.body.resourceId],
          )
        ).rows[0]!;
        return {
          input,
          receipt: result.body,
          id: result.body.resourceId as string,
          ...row,
        };
      };
      const legacy = await create(postInput(false)),
        root = await create(postInput(true));
      const childInput = () => ({
        clientRequestId: randomUUID(),
        text: 'Synthetic canonical child',
        authorMode: 'named',
        imageAssetIds: [],
      });
      const createChild = async (postId: string) => {
        const input = childInput();
        const pending = await request(f.app.getHttpServer())
          .post(`/v1/community/reviews/posts/${postId}/comments`)
          .set('Authorization', childAuth)
          .send(input);
        assert.equal(pending.status, 200, JSON.stringify(pending.body));
        await f.decide(commenter.accountId, input.clientRequestId);
        const result = await request(f.app.getHttpServer())
          .post(`/v1/community/posts/${postId}/comments`)
          .set('Authorization', childAuth)
          .send(input);
        assert.equal(
          result.body.outcome,
          'created',
          JSON.stringify(result.body),
        );
        const row = (
          await f.pool.query<{
            envelope: EffectiveContentEnvelope;
            digest: string;
          }>(
            "SELECT envelope,digest FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1",
            [result.body.resourceId],
          )
        ).rows[0]!;
        return {
          input,
          receipt: result.body,
          id: result.body.resourceId as string,
          ...row,
        };
      };
      const legacyChild = await createChild(legacy.id),
        relatedChild = await createChild(root.id);

      await t.test(
        'legacy none root and child keep old digest domains and exact false/omitted replay',
        async () => {
          assert.equal(legacy.envelope.version, 1);
          assert.equal(legacy.envelope.scope.sync, 'none');
          assert.equal(legacyChild.envelope.version, 1);
          assert.equal(legacyChild.envelope.scope.sync, 'none');
          assert.equal(legacy.digest, approvalDigest(legacy.envelope));
          assert.equal(
            legacyChild.digest,
            approvalDigest(legacyChild.envelope),
          );
          assert.deepEqual((await publish(legacy.input)).body, legacy.receipt);
          assert.deepEqual(
            (await publish({ ...legacy.input, syncToRelatedCampuses: false }))
              .body,
            legacy.receipt,
          );
          assert.deepEqual(
            (
              await request(f.app.getHttpServer())
                .post(`/v1/community/posts/${legacy.id}/comments`)
                .set('Authorization', childAuth)
                .send(legacyChild.input)
            ).body,
            legacyChild.receipt,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
                [legacy.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(relatedChild.envelope.version, 4);
          assert.equal(relatedChild.envelope.scope.sync, 'inherited_related');
        },
      );

      await t.test(
        'canonical SQL and JS reject malformed/null fields, poll sentinel drift and formation byte normalization',
        async () => {
          const base = JSON.parse(JSON.stringify(root.envelope)) as Record<
            string,
            unknown
          >;
          const poll = {
            kind: 'poll',
            question: 'Synthetic options',
            selectionMode: 'single',
            options: ['A', 'B', '吃瓜🍉'],
          };
          const formation = {
            kind: 'formation',
            capacity: 2,
            theme: 'Synthetic',
            contacts: { wechat: 'synthetic', qq: '', phone: '' },
            contactSharing: 'members_v1',
          };
          const candidates: unknown[] = [
            base,
            { ...base, component: poll },
            { ...base, component: formation },
            { ...base, purpose: null },
            { ...base, authorMode: null },
            { ...base, category: null },
            {
              ...base,
              purpose: 'publish_reply',
              postId: root.id,
              rootCommentId: null,
            },
            { ...base, allowAnonymousDm: 'true' },
            { ...base, images: null },
            { ...base, unexpected: true },
            { ...base, scope: { ...root.envelope.scope, unexpected: true } },
            { ...base, component: { ...poll, options: ['吃瓜🍉', 'A', 'B'] } },
            { ...base, component: { ...poll, options: ['A', '吃瓜🍉'] } },
            { ...base, component: { ...poll, options: ['A', 'A'] } },
            { ...base, component: { ...poll, question: null } },
            { ...base, component: { ...poll, selectionMode: null } },
            { ...base, component: { ...formation, contactSharing: null } },
            { ...base, component: { ...formation, theme: '  trimmed  ' } },
            {
              ...base,
              component: {
                ...formation,
                contacts: { ...formation.contacts, wechat: ' 前后空白 ' },
              },
            },
            {
              ...base,
              component: {
                ...formation,
                contacts: { ...formation.contacts, wechat: '鲸'.repeat(34) },
              },
            },
            { ...base, component: { ...formation, theme: '鲸'.repeat(13) } },
            { ...base, component: { ...formation, capacity: 21 } },
          ];
          for (const candidate of candidates) {
            const expected = exactEnvelope(candidate);
            const row = (
              await f.pool.query<{ valid: boolean }>(
                'SELECT whaleu_community.related_sync_envelope_valid($1::jsonb) AS valid',
                [JSON.stringify(candidate)],
              )
            ).rows[0]!;
            assert.equal(row.valid, expected, JSON.stringify(candidate));
          }
        },
      );

      await t.test(
        'SQL UUID syntax matches the existing strict parser and whitespace provenance never issues authority',
        async () => {
          for (const value of [
            randomUUID(),
            randomUUID().toUpperCase(),
            '00000000-0000-0000-0000-000000000000',
            'ffffffff-ffff-ffff-ffff-ffffffffffff',
            '10000000-0000-0000-0000-000000000001',
            '10000000-0000-f000-8000-000000000001',
            null,
            4,
          ]) {
            assert.equal(
              (
                await f.pool.query(
                  'SELECT whaleu_community.related_sync_uuid($1::jsonb) AS valid',
                  [JSON.stringify(value)],
                )
              ).rows[0].valid,
              z.uuid().safeParse(value).success,
            );
          }
          for (const whitespace of ['\t', '\u00a0', '\ufeff']) {
            const rollback = new Error('Synthetic provenance rollback');
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                const eventId = randomUUID();
                await tx.query(
                  `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
            VALUES($1,$2,'allow','complete','accepted',$3,'Explicit synthetic provenance probe',clock_timestamp())`,
                  [eventId, root.decision_id, whitespace],
                );
                await tx.query(
                  'UPDATE whaleu_community.content_approval_heads SET event_id=$2 WHERE decision_id=$1',
                  [root.decision_id, eventId],
                );
                assert.equal(
                  (
                    await tx.query(
                      'SELECT whaleu_community.related_sync_review_current($1) AS current',
                      [root.decision_id],
                    )
                  ).rows[0].current,
                  false,
                );
                const id = randomUUID();
                const revision =
                  (
                    await tx.query<{ revision: number }>(
                      "SELECT revision FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
                    )
                  ).rows[0]!.revision + 1;
                await tx.query(
                  `INSERT INTO whaleu_campus.community_topology_snapshots(id,revision,topology,coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
            VALUES($1,$2,$3::jsonb,'complete','accepted',clock_timestamp(),'policy_exempt',NULL,$4,'Explicit synthetic provenance probe')`,
                  [id, revision, JSON.stringify(f.scope.topology), whitespace],
                );
                await tx.query(
                  "UPDATE whaleu_campus.community_topology_heads SET revision=$1,snapshot_id=$2 WHERE scope_key='community'",
                  [revision, id],
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT whaleu_campus.community_distribution_group($1)->>'status' status",
                      [f.scope.home.regionId],
                    )
                  ).rows[0].status,
                  'unavailable',
                );
                throw rollback;
              }),
              (error: unknown) => error === rollback,
            );
          }
        },
      );

      await t.test(
        'SQL and TS reject null, omitted and boolean coverage on every topology edge',
        async () => {
          for (const target of [
            'group',
            'origin',
            'member',
            'assignment',
          ] as const)
            for (const coverage of [null, undefined, false]) {
              const topology = JSON.parse(JSON.stringify(f.scope.topology)) as {
                groups: Record<string, unknown>[];
                regions: Record<string, unknown>[];
                assignments: Record<string, unknown>[];
              };
              const origin = topology.regions.find(
                (region) => region['regionId'] === f.scope.home['regionId'],
              )!;
              const entry =
                target === 'group'
                  ? topology.groups.find(
                      (group) => group['groupId'] === origin['groupId'],
                    )!
                  : target === 'origin'
                    ? origin
                    : target === 'member'
                      ? topology.regions.find(
                          (region) =>
                            region['regionId'] === f.scope.related['regionId'],
                        )!
                      : topology.assignments.find(
                          (assignment) =>
                            assignment['campusId'] === f.scope.home['campusId'],
                        )!;
              if (coverage === undefined) delete entry['coverage'];
              else entry['coverage'] = coverage;
              assert.equal(parseTopology(topology), null);
              const rollback = new Error(
                'Synthetic topology mutation rollback',
              );
              await assert.rejects(
                withCommunityScopeWriter(f.pool, async (tx) => {
                  assert.equal(
                    (
                      await tx.query(
                        'SELECT whaleu_campus.community_distribution_topology_valid($1::jsonb) AS valid',
                        [JSON.stringify(topology)],
                      )
                    ).rows[0].valid,
                    false,
                  );
                  const id = randomUUID();
                  const revision =
                    (
                      await tx.query<{ revision: number }>(
                        "SELECT revision FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
                      )
                    ).rows[0]!.revision + 1;
                  await tx.query(
                    `INSERT INTO whaleu_campus.community_topology_snapshots(id,revision,topology,coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
            VALUES($1,$2,$3::jsonb,'complete','accepted',clock_timestamp(),'policy_exempt',NULL,'Synthetic malformed edge test','Synthetic explicit test')`,
                    [id, revision, JSON.stringify(topology)],
                  );
                  await tx.query(
                    "UPDATE whaleu_campus.community_topology_heads SET revision=$1,snapshot_id=$2 WHERE scope_key='community'",
                    [revision, id],
                  );
                  assert.equal(
                    (
                      await tx.query(
                        "SELECT whaleu_campus.community_distribution_group($1)->>'status' AS status",
                        [f.scope.home['regionId']],
                      )
                    ).rows[0].status,
                    'unavailable',
                    `${target}:${String(coverage)}`,
                  );
                  assert.equal(
                    (
                      await tx.query(
                        'SELECT whaleu_community.related_sync_enable_allowed($1) AS allowed',
                        [f.scope.home['regionId']],
                      )
                    ).rows[0].allowed,
                    false,
                  );
                  assert.equal(
                    (
                      await tx.query(
                        'SELECT whaleu_community.related_sync_envelope_admitted($1::jsonb) AS allowed',
                        [JSON.stringify(root.envelope)],
                      )
                    ).rows[0].allowed,
                    false,
                  );
                  throw rollback;
                }),
                (error: unknown) => error === rollback,
              );
            }
        },
      );

      await t.test(
        'SQL intent hashes reproduce native property order and require exact explicit opt-in',
        async () => {
          const components = [
            { kind: 'none' },
            {
              kind: 'poll',
              question: 'Synthetic order',
              selectionMode: 'multiple',
              options: ['A', 'B', '吃瓜🍉'],
            },
            {
              kind: 'formation',
              capacity: 4,
              theme: 'Synthetic',
              contacts: { wechat: 'test', qq: '1234', phone: '10000' },
              contactSharing: 'members_v1',
            },
          ];
          for (const component of components)
            for (const authorMode of ['named', 'anonymous'] as const) {
              for (const consent of authorMode === 'named'
                ? [null, false, true]
                : [null]) {
                const envelope = canonicalEnvelope({
                  ...root.envelope,
                  authorMode,
                  component,
                  allowAnonymousDm: consent,
                });
                const input = publishPostSchema.parse({
                  ...root.input,
                  authorMode,
                  component,
                  ...(consent === null ? {} : { allowAnonymousDm: consent }),
                });
                const expected = publicationHash(
                  'publish_post',
                  postIntent(input),
                );
                const actual = (
                  await f.pool.query<{ hash: string }>(
                    'SELECT whaleu_community.related_sync_post_intent_hash($1::jsonb) AS hash',
                    [JSON.stringify(envelope)],
                  )
                ).rows[0]!.hash;
                assert.equal(
                  actual,
                  expected,
                  JSON.stringify({ component, authorMode, consent }),
                );
                const omitted = publicationHash(
                  'publish_post',
                  postIntent({ ...input, syncToRelatedCampuses: false }),
                );
                assert.notEqual(actual, omitted);
              }
            }
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_post_intent_hash($1::jsonb) AS hash',
                [JSON.stringify(legacy.envelope)],
              )
            ).rows[0].hash,
            null,
          );
        },
      );

      await t.test(
        'native binding and accepted applicability reject change, deletion and truncation',
        async () => {
          for (const [table, key, value] of [
            ['post_distribution_bindings', 'post_id', root.id],
            ['related_sync_policies', 'id', f.applicability.policyId],
          ] as const) {
            for (const sql of [
              `UPDATE whaleu_community.${table} SET ${key}=${key} WHERE ${key}=$1`,
              `DELETE FROM whaleu_community.${table} WHERE ${key}=$1`,
            ])
              await assert.rejects(f.pool.query(sql, [value]), checkViolation);
            await assert.rejects(
              f.pool.query(`TRUNCATE whaleu_community.${table} CASCADE`),
              checkViolation,
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_binding_valid($1) AS valid',
                [root.id],
              )
            ).rows[0].valid,
            true,
          );
        },
      );

      await t.test(
        'ordinary none writers keep shared Safety gates and distinct transaction-owned generation slots',
        async () => {
          const source = `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)
            SELECT $1::uuid,$2::uuid,$3::uuid,'Zero-row old-none writer','named' WHERE false`;
          const stateSql = `SELECT slot,generation::text AS generation
            FROM whaleu_community.related_sync_actor_generation ORDER BY slot`;
          const fingerprintSql = `SELECT whaleu_community.related_sync_generation_fingerprint('actor') AS fingerprint`;
          type Slot = { slot: number; generation: string };
          const before = (await f.pool.query<Slot>(stateSql)).rows;
          const fingerprint = (
            await f.pool.query<{ fingerprint: string }>(fingerprintSql)
          ).rows[0]!.fingerprint;
          assert.match(fingerprint, /^[a-f0-9]{64}$/);
          const clients = [await f.pool.connect(), await f.pool.connect()];
          try {
            // Both shared gates are held before either writer starts. Any hidden
            // exclusive upgrade necessarily waits on the other real transaction.
            await Promise.all(
              clients.map(async (tx) => {
                await tx.query('BEGIN');
                await tx.query("SET LOCAL lock_timeout='250ms'");
                await tx.query("SET LOCAL statement_timeout='2s'");
                await lockSafetyPolicy(tx);
              }),
            );
            const outcomes = await Promise.allSettled(
              clients.map(async (tx) => {
                const result = await tx.query(source, [
                  randomUUID(),
                  legacy.id,
                  actor.accountId,
                ]);
                assert.equal(result.rowCount, 0);
                const rows = (await tx.query<Slot>(stateSql)).rows;
                const changed = rows.filter(
                  (row) =>
                    before.find((old) => old.slot === row.slot)?.generation !==
                    row.generation,
                );
                assert.equal(
                  changed.length,
                  1,
                  'One source statement advances only its transaction-owned slot',
                );
                assert.ok(changed[0]!.slot >= 0);
                assert.ok(BigInt(changed[0]!.generation) >= 1n);
                assert.notEqual(
                  (await tx.query<{ fingerprint: string }>(fingerprintSql))
                    .rows[0]!.fingerprint,
                  fingerprint,
                );
                const owned = (
                  await tx.query<{
                    slot: number;
                  }>(`SELECT objid::integer AS slot FROM pg_locks
                WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
                AND classid=1464356124::oid AND objsubid=2 ORDER BY objid`)
                ).rows;
                assert.deepEqual(
                  owned,
                  [{ slot: changed[0]!.slot }],
                  'The source owner, not the test, retained this transaction slot',
                );
                return { slot: changed[0]!.slot, rows };
              }),
            );
            for (const outcome of outcomes) {
              if (outcome.status === 'rejected') throw outcome.reason;
            }
            assert.equal(outcomes[0]!.status, 'fulfilled');
            assert.equal(outcomes[1]!.status, 'fulfilled');
            if (
              outcomes[0]!.status !== 'fulfilled' ||
              outcomes[1]!.status !== 'fulfilled'
            )
              throw new Error(
                'Both ordinary writers must finish while both shared gates remain held',
              );
            const firstOutcome = outcomes[0]!.value,
              secondOutcome = outcomes[1]!.value;
            assert.notEqual(firstOutcome.slot, secondOutcome.slot);
            const first = clients[0]!;
            await first.query('SAVEPOINT generation_probe');
            await first.query(source, [
              randomUUID(),
              legacy.id,
              actor.accountId,
            ]);
            const advanced = (await first.query<Slot>(stateSql)).rows;
            assert.equal(
              BigInt(
                advanced.find((row) => row.slot === firstOutcome.slot)!
                  .generation,
              ),
              BigInt(
                firstOutcome.rows.find((row) => row.slot === firstOutcome.slot)!
                  .generation,
              ) + 1n,
            );
            await first.query('ROLLBACK TO SAVEPOINT generation_probe');
            assert.deepEqual(
              (await first.query<Slot>(stateSql)).rows,
              firstOutcome.rows,
              'Savepoint rollback restores the exact vector, including any lazy insertion',
            );
          } finally {
            for (const tx of clients) {
              try {
                await tx.query('ROLLBACK');
              } finally {
                tx.release();
              }
            }
          }
          assert.deepEqual((await f.pool.query<Slot>(stateSql)).rows, before);
          assert.equal(
            (await f.pool.query<{ fingerprint: string }>(fingerprintSql))
              .rows[0]!.fingerprint,
            fingerprint,
            'Neither rolled-back zero-row source write may survive in generation metadata',
          );
        },
      );

      await t.test(
        'all lazy generation sources are savepoint-atomic and recheck both INSERT and UPDATE',
        async () => {
          for (const [kind, table, source] of [
            [
              'distribution',
              'whaleu_campus.community_distribution_generation',
              'whaleu_campus.operating_regions',
            ],
            [
              'applicability',
              'whaleu_community.related_sync_applicability_generation',
              'whaleu_community.related_sync_policy_heads',
            ],
            [
              'admission',
              'whaleu_community.related_sync_admission_generation',
              'whaleu_community.region_policy_heads',
            ],
            [
              'view',
              'whaleu_community.related_sync_view_generation',
              'whaleu_community.spaces',
            ],
            [
              'actor',
              'whaleu_community.related_sync_actor_generation',
              'whaleu_community.root_comments',
            ],
          ] as const) {
            const read = async (tx: Pick<PoolClient, 'query'>) => ({
              rows: (
                await tx.query<{ slot: number; generation: string }>(
                  `SELECT slot,generation::text AS generation FROM ${table} ORDER BY slot`,
                )
              ).rows,
              fingerprint: (
                await tx.query<{ fingerprint: string }>(
                  'SELECT whaleu_community.related_sync_generation_fingerprint($1) AS fingerprint',
                  [kind],
                )
              ).rows[0]!.fingerprint,
            });
            const before = await read(f.pool);
            const triggerNames =
              kind === 'distribution' || kind === 'view'
                ? ['related_management_recheck', 'related_sync_recheck']
                : ['related_sync_recheck'];
            const triggers = (
              await f.pool.query<{
                tgname: string;
                events: number;
                tgdeferrable: boolean;
                tginitdeferred: boolean;
              }>(
                `SELECT tgname,tgtype::integer AS events,tgdeferrable,tginitdeferred
              FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=ANY($2::text[]) AND NOT tgisinternal ORDER BY tgname`,
                [table, triggerNames],
              )
            ).rows;
            assert.deepEqual(
              triggers,
              triggerNames.map((tgname) => ({
                tgname,
                events: 21,
                tgdeferrable: true,
                tginitdeferred: true,
              })),
              `${kind}: every publication and management recheck must cover the first lazy INSERT as well as UPDATE`,
            );
            const tx = await f.pool.connect();
            try {
              await tx.query('BEGIN');
              await lockSafetyPolicy(tx);
              await tx.query('SAVEPOINT first_source_write');
              const changed = await tx.query(
                `DELETE FROM ${source} WHERE false`,
              );
              assert.equal(changed.rowCount, 0);
              assert.notEqual((await read(tx)).fingerprint, before.fingerprint);
              await tx.query('ROLLBACK TO SAVEPOINT first_source_write');
              assert.deepEqual(await read(tx), before);
              await tx.query(`DELETE FROM ${source} WHERE false`);
              assert.notEqual((await read(tx)).fingerprint, before.fingerprint);
            } finally {
              try {
                await tx.query('ROLLBACK');
              } finally {
                tx.release();
              }
            }
            assert.deepEqual(
              await read(f.pool),
              before,
              `${kind}: complete rollback retains neither slot nor increment`,
            );
          }
        },
      );

      await t.test(
        'the real final view fence rejects an uncommitted source writer even before its slot is visible',
        async () => {
          const reader = await f.pool.connect(),
            writer = await f.pool.connect();
          try {
            for (const tx of [reader, writer]) {
              await tx.query('BEGIN');
              await tx.query("SET LOCAL lock_timeout='250ms'");
              await tx.query("SET LOCAL statement_timeout='2s'");
            }
            // Spaces already require the original catalog writer's exclusive
            // Safety gate. This raw owner-proof reader intentionally takes no
            // competing Safety lock, so the later NOWAIT table fence is tested.
            await lockSafetyPolicy(writer, true);
            const fingerprintSql = `SELECT whaleu_community.related_sync_generation_fingerprint('view') AS fingerprint`;
            const original = (
              await reader.query<{ fingerprint: string }>(fingerprintSql)
            ).rows[0]!.fingerprint;
            assert.equal(
              (
                await writer.query(
                  'DELETE FROM whaleu_community.spaces WHERE false',
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (await reader.query<{ fingerprint: string }>(fingerprintSql))
                .rows[0]!.fingerprint,
              original,
              'A foreign transaction must not observe an uncommitted lazy slot/increment',
            );
            await reader.query('SAVEPOINT final_fence');
            await assert.rejects(
              reader.query(
                'SELECT whaleu_community.related_sync_view_assert($1)',
                [original],
              ),
              (error: unknown) =>
                error instanceof Error &&
                'code' in error &&
                error.code === '55P03' &&
                /could not obtain lock on relation/.test(error.message),
            );
            await reader.query('ROLLBACK TO SAVEPOINT final_fence');
            await writer.query('ROLLBACK');
            assert.equal(
              (await reader.query<{ fingerprint: string }>(fingerprintSql))
                .rows[0]!.fingerprint,
              original,
            );
            await reader.query(
              'SELECT whaleu_community.related_sync_view_assert($1)',
              [original],
            );
          } finally {
            for (const tx of [reader, writer]) {
              try {
                await tx.query('ROLLBACK');
              } finally {
                tx.release();
              }
            }
          }
        },
      );

      await t.test(
        'all owner generations reject direct reset, increment, deletion and truncate',
        async () => {
          for (const table of [
            'whaleu_campus.community_distribution_generation',
            'whaleu_community.related_sync_applicability_generation',
            'whaleu_community.related_sync_admission_generation',
            'whaleu_community.related_sync_view_generation',
          ]) {
            const before = (
              await f.pool.query<{ generation: string }>(
                `SELECT slot,generation::text FROM ${table} ORDER BY slot`,
              )
            ).rows;
            for (const sql of [
              `UPDATE ${table} SET generation=0`,
              `UPDATE ${table} SET generation=generation+1`,
              `DELETE FROM ${table}`,
              `TRUNCATE ${table}`,
              `UPDATE ${table} SET generation=generation WHERE false`,
              `DELETE FROM ${table} WHERE false`,
              `INSERT INTO ${table}(slot,generation) SELECT 0,1 WHERE false`,
            ])
              await assert.rejects(f.pool.query(sql), checkViolation);
            assert.deepEqual(
              (
                await f.pool.query<{ slot: number; generation: string }>(
                  `SELECT slot,generation::text FROM ${table} ORDER BY slot`,
                )
              ).rows,
              before,
            );
          }
        },
      );

      await t.test(
        'zero-row source writes still invalidate the original observation, without refreshing it away',
        async () => {
          for (const source of [
            'whaleu_campus.community_topology_heads',
            'whaleu_campus.community_topology_snapshots',
            'whaleu_campus.operating_regions',
            'whaleu_community.related_sync_policy_heads',
            'whaleu_community.related_sync_policies',
            'whaleu_community.region_policy_heads',
            'whaleu_community.spaces',
          ]) {
            let observedChange = false;
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                const original = (
                  await tx.query<{ fingerprint: string }>(
                    'SELECT whaleu_community.related_sync_observation() AS fingerprint',
                  )
                ).rows[0]!.fingerprint;
                await tx.query(`DELETE FROM ${source} WHERE false`);
                const after = (
                  await tx.query<{ fingerprint: string }>(
                    'SELECT whaleu_community.related_sync_observation() AS fingerprint',
                  )
                ).rows[0]!.fingerprint;
                assert.notEqual(after, original, source);
                observedChange = true;
                await tx.query(
                  'SELECT whaleu_community.related_sync_observation_assert($1)',
                  [original],
                );
              }),
              checkViolation,
            );
            assert.equal(
              observedChange,
              true,
              `${source} must reach the original observation assertion`,
            );
          }
        },
      );

      await t.test(
        'source head TRUNCATE advances the source observation and remains unavailable, not known empty',
        async () => {
          let observedTruncate = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const original = (
                await tx.query<{ fingerprint: string }>(
                  'SELECT whaleu_community.related_sync_observation() AS fingerprint',
                )
              ).rows[0]!.fingerprint;
              await tx.query('TRUNCATE whaleu_campus.community_topology_heads');
              const group = (
                await tx.query<{ value: { status: string } }>(
                  'SELECT whaleu_campus.community_distribution_group($1) AS value',
                  [f.scope.home.regionId],
                )
              ).rows[0]!.value;
              assert.equal(group.status, 'unavailable');
              observedTruncate = true;
              await tx.query(
                'SELECT whaleu_community.related_sync_observation_assert($1)',
                [original],
              );
            }),
            checkViolation,
          );
          assert.equal(observedTruncate, true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_binding_valid($1) AS valid',
                [root.id],
              )
            ).rows[0].valid,
            true,
          );
        },
      );

      const insertDecision = async (
        tx: PoolClient,
        envelope: EffectiveContentEnvelope,
        policyId: string,
      ) => {
        const decisionId = randomUUID(),
          eventId = randomUUID(),
          digest = approvalDigest(envelope);
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_decisions
        (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'allow','complete','accepted','synthetic:storage:raw-writer','Explicit adversarial fixture decision',clock_timestamp(),clock_timestamp()+interval '1 hour','durable')`,
          [
            decisionId,
            envelope.accountId,
            envelope.purpose,
            envelope.version,
            digest,
            JSON.stringify(envelope),
            policyId,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
        VALUES($1,$2,'allow','complete','accepted','synthetic:storage:raw-writer','Explicit adversarial fixture event',clock_timestamp())`,
          [eventId, decisionId],
        );
        await tx.query(
          'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
          [decisionId, eventId],
        );
        return {
          decisionId,
          digest,
          version: envelope.version,
          envelope,
        } satisfies AcceptedApproval;
      };

      await t.test(
        'issuance-only definition reconstruction cannot become a retained-read or rebinding bypass',
        async () => {
          const definitions = f.app.get(ContentDefinitionRepository);
          await inTransaction(f.pool, async (tx) => {
            const retained = await definitions.current(
              'post',
              root.id,
              root.envelope.scope,
              tx,
            );
            assert.equal(retained.kind, 'allow');
            if (retained.kind === 'allow')
              assert.deepEqual(retained.value.envelope, root.envelope);
            assert.deepEqual(
              await definitions.newRelatedRoot(
                root.id,
                root.envelope.scope,
                tx,
              ),
              { kind: 'unavailable' },
              'A committed existing bound root cannot enter same-transaction issuance',
            );
            assert.deepEqual(
              await definitions.newRelatedRoot(
                legacy.id,
                root.envelope.scope,
                tx,
              ),
              { kind: 'unavailable' },
            );
          });
          let finalizationAttempted = false;
          const freshId = randomUUID();
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const envelope = canonicalEnvelope({
                ...root.envelope,
                text: 'Synthetic unbound related issuance reconstruction',
              });
              const accepted = await insertDecision(
                tx,
                envelope,
                f.relatedReviewPolicyId,
              );
              await tx.query(
                `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm)
              VALUES($1,$2,$3,'discussion',$4,'named','open',4,NULL)`,
                [freshId, envelope.spaceId, envelope.accountId, envelope.text],
              );
              assert.deepEqual(
                await definitions.current('post', freshId, envelope.scope, tx),
                { kind: 'unavailable' },
                'An unbound new root must remain unavailable to the ordinary current reader',
              );
              const issuing = await definitions.newRelatedRoot(
                freshId,
                envelope.scope,
                tx,
              );
              assert.equal(issuing.kind, 'allow');
              if (issuing.kind === 'allow')
                assert.deepEqual(issuing.value.envelope, envelope);
              assert.deepEqual(
                await definitions.current('post', freshId, envelope.scope, tx),
                { kind: 'unavailable' },
                'Issuance reconstruction cannot mint or cache retained read authority',
              );
              await f.app
                .get(ApprovalRepository)
                .bind(accepted, 'post', freshId, tx);
              assert.deepEqual(
                await definitions.newRelatedRoot(freshId, envelope.scope, tx),
                { kind: 'unavailable' },
                'Even one already-inserted approval binding closes the issuance-only seam',
              );
              assert.deepEqual(
                await definitions.current('post', freshId, envelope.scope, tx),
                { kind: 'unavailable' },
                'Approval alone does not replace the mandatory native distribution binding',
              );
              finalizationAttempted = true;
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
            (error: unknown) =>
              checkViolation(error) &&
              error instanceof Error &&
              /Related root lacks atomic native publication/.test(
                error.message,
              ),
          );
          assert.equal(
            finalizationAttempted,
            true,
            'Issuance and approval-only probes must reach actual SQL finalization',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE id=$1',
                [freshId],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'reverse root ancestry invariant rejects a fully matching v1 child approval under a v4 root',
        async () => {
          const childId = randomUUID();
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const envelope = canonicalEnvelope(
                JSON.parse(
                  JSON.stringify({
                    ...root.envelope,
                    version: 1,
                    allowAnonymousDm: undefined,
                    purpose: 'publish_comment',
                    postId: root.id,
                    text: 'Synthetic downgrade attempt',
                    scope: mediaActorScope(root.envelope.scope),
                  }),
                ),
              );
              const accepted = await insertDecision(
                tx,
                envelope,
                f.legacyReviewPolicyId,
              );
              await tx.query(
                "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'named')",
                [childId, root.id, actor.accountId, envelope.text],
              );
              await f.app
                .get(ApprovalRepository)
                .bind(accepted, 'comment', childId, tx);
            }),
            (error: unknown) =>
              checkViolation(error) &&
              error instanceof Error &&
              /Related child cannot downgrade to v1|inherited native approval/.test(
                error.message,
              ),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1',
                [childId],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'v4 inherited envelope cannot attach to a none root or claim a different parent binding',
        async () => {
          const candidate = canonicalEnvelope({
            ...relatedChild.envelope,
            postId: legacy.id,
            scope: {
              ...relatedChild.envelope.scope,
              sync: 'inherited_related',
              parentDistribution: {
                postId: legacy.id,
                decisionId: root.decision_id,
                digest: root.digest,
              },
            },
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_envelope_admitted($1::jsonb) AS allowed',
                [JSON.stringify(candidate)],
              )
            ).rows[0].allowed,
            false,
          );
          const changed = canonicalEnvelope({
            ...relatedChild.envelope,
            scope: {
              ...relatedChild.envelope.scope,
              sync: 'inherited_related',
              parentDistribution: {
                postId: root.id,
                decisionId: randomUUID(),
                digest: root.digest,
              },
            },
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_envelope_admitted($1::jsonb) AS allowed',
                [JSON.stringify(changed)],
              )
            ).rows[0].allowed,
            false,
          );
        },
      );

      await t.test(
        'matching-looking strings, GUCs and historical requests cannot manufacture a native root binding',
        async () => {
          const columns =
            'post_id,original_space_id,original_region_id,topology_snapshot_id,publication_group_id,publication_members,publication_members_digest,sync_policy_id,scope,decision_id,digest,account_id,client_request_id,intent_hash';
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                "SELECT set_config('whaleu.related_sync_native_publication','accepted',true)",
              );
              await tx.query(
                `INSERT INTO whaleu_community.post_distribution_bindings(${columns}) SELECT $2,original_space_id,original_region_id,topology_snapshot_id,publication_group_id,publication_members,publication_members_digest,sync_policy_id,scope,decision_id,digest,account_id,client_request_id,intent_hash FROM whaleu_community.post_distribution_bindings WHERE post_id=$1`,
                [root.id, legacy.id],
              );
            }),
            checkViolation,
          );
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_community.post_distribution_bindings(${columns},admission_fingerprint) SELECT post_id,original_space_id,original_region_id,topology_snapshot_id,publication_group_id,publication_members,publication_members_digest,sync_policy_id,scope,decision_id,digest,account_id,client_request_id,intent_hash,admission_fingerprint FROM whaleu_community.post_distribution_bindings WHERE post_id=$1`,
                [root.id],
              ),
            ),
            checkViolation,
          );
          await assert.rejects(
            f.pool.query(
              "UPDATE whaleu_community.publication_requests SET receipt=jsonb_set(receipt,'{resourceId}',to_jsonb($3::text)) WHERE account_id=$1 AND client_request_id=$2",
              [actor.accountId, root.input.clientRequestId, legacy.id],
            ),
          );
        },
      );

      await t.test(
        'even a real pending exact approval plus forged success receipt cannot omit required distribution',
        async () => {
          const input = postInput(true),
            postId = randomUUID();
          assert.equal((await submit(input)).status, 200);
          await f.decide(actor.accountId, input.clientRequestId);
          const queued = (
            await f.pool.query<{
              envelope: EffectiveContentEnvelope;
              decision_id: string;
              digest: string;
            }>(
              'SELECT envelope,decision_id,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, input.clientRequestId],
            )
          ).rows[0]!;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const created = (
                await tx.query<{ published_at: Date }>(
                  `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm)
          VALUES($1,$2,$3,'discussion',$4,'named','open',4,NULL) RETURNING published_at`,
                  [postId, input.spaceId, actor.accountId, input.text],
                )
              ).rows[0]!.published_at;
              await f.app.get(ApprovalRepository).bind(
                {
                  decisionId: queued.decision_id,
                  digest: queued.digest,
                  version: 4,
                  envelope: queued.envelope,
                },
                'post',
                postId,
                tx,
              );
              await tx.query(
                'UPDATE whaleu_community.publication_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
                [
                  actor.accountId,
                  input.clientRequestId,
                  JSON.stringify({
                    requestId: input.clientRequestId,
                    operation: 'publish_post',
                    outcome: 'created',
                    resourceId: postId,
                    createdAt: created.toISOString(),
                  }),
                ],
              );
            }),
            checkViolation,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE id=$1',
                [postId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                [actor.accountId, input.clientRequestId],
              )
            ).rows[0].receipt,
            null,
          );
        },
      );

      await t.test(
        'a pending command whose hash omits opt-in cannot issue even a fully matching native binding',
        async () => {
          const input = postInput(true),
            postId = randomUUID();
          assert.equal((await submit(input)).status, 200);
          await f.decide(actor.accountId, input.clientRequestId);
          const queued = (
            await f.pool.query<{
              envelope: EffectiveContentEnvelope;
              decision_id: string;
              digest: string;
            }>(
              'SELECT envelope,decision_id,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, input.clientRequestId],
            )
          ).rows[0]!;
          const forgedHash = publicationHash(
            'publish_post',
            postIntent(
              publishPostSchema.parse({
                ...input,
                syncToRelatedCampuses: false,
              }),
            ),
          );
          const forgedRequestId = randomUUID();
          let attemptedBinding = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm)
          VALUES($1,$2,$3,'discussion',$4,'named','open',4,NULL)`,
                [postId, input.spaceId, actor.accountId, input.text],
              );
              const approval = {
                decisionId: queued.decision_id,
                digest: queued.digest,
                version: 4 as const,
                envelope: queued.envelope,
              };
              await f.app
                .get(ApprovalRepository)
                .bind(approval, 'post', postId, tx);
              // Keep the legitimate queue immutable. The raw writer instead gives a
              // forged new ledger and binding the SAME opt-out hash. That equality
              // alone must never prove the native explicit-opt-in intent.
              await tx.query(
                "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation) VALUES($1,$2,$3,'publish_post')",
                [actor.accountId, forgedRequestId, forgedHash],
              );
              attemptedBinding = true;
              await f.app.get(CommunityDistributionService).bind(
                postId,
                {
                  clientRequestId: forgedRequestId,
                  operation: 'publish_post',
                  intentHash: forgedHash,
                },
                approval,
                tx,
              );
            }),
            checkViolation,
          );
          assert.equal(attemptedBinding, true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
                [postId],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'an unavailable current applicability head blocks new roots without erasing bound history or inherited children',
        async () => {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const policyId = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_community.related_sync_policies
          (id,policy_key,version,operating_region_id,categories,author_modes,component_kinds,images_allowed,anonymous_dm_allowed,review_policy_revision_id,coverage,provenance,issuer,provenance_ref,valid_from)
          SELECT $2,policy_key,version+1,operating_region_id,categories,author_modes,component_kinds,images_allowed,anonymous_dm_allowed,review_policy_revision_id,'missing','unknown',issuer,'Explicit synthetic applicability withdrawal',clock_timestamp()
          FROM whaleu_community.related_sync_policies WHERE id=$1`,
              [f.applicability.policyId, policyId],
            );
            await tx.query(
              'UPDATE whaleu_community.related_sync_policy_heads SET revision=revision+1,policy_id=$2 WHERE operating_region_id=$1',
              [f.scope.home.regionId, policyId],
            );
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_enable_allowed($1) AS allowed',
                [f.scope.home.regionId],
              )
            ).rows[0].allowed,
            false,
          );
          assert.notEqual((await submit(postInput(true))).status, 200);
          assert.deepEqual((await publish(root.input)).body, root.receipt);
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_binding_valid($1) AS valid',
                [root.id],
              )
            ).rows[0].valid,
            true,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_distribution_view_allowed($1,$2) AS allowed',
                [root.id, f.scope.related.spaceId],
              )
            ).rows[0].allowed,
            true,
          );
          const child = await createChild(root.id);
          assert.equal(child.envelope.version, 4);
          assert.equal(
            (
              await request(f.app.getHttpServer())
                .get(`/v1/community/posts/${root.id}`)
                .set('Authorization', childAuth)
            ).status,
            200,
          );
          assert.deepEqual(
            (await publish({ ...legacy.input, syncToRelatedCampuses: false }))
              .body,
            legacy.receipt,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'exact max137 app publishes real legacy roots and children, then full upgrade rebuild retains receipts and owners',
  { timeout: 240000 },
  async () => {
    let patch: Partial<RuntimeConfig> = {};
    const f = await directoryRuntimeFixture(137, {
      createApp: async (config, configurePolicy) => {
        const builder = Test.createTestingModule({
          imports: [AppModule.register(Object.freeze({ ...config, ...patch }))],
        });
        await configurePolicy(builder);
        return (await builder.compile()).createNestApplication({
          logger: false,
        });
      },
    });
    try {
      const policyId = randomUUID(),
        issuer = 'synthetic:related-upgrade:operator';
      patch = {
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_POLICY_ID: policyId,
        COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_OPERATOR: issuer,
      };
      await f.restartApp(137);
      assert.ok(
        f.app.get(ReadingFormattingRuntime) instanceof
          HistoricalReadingFormattingRuntime,
      );
      assert.ok(
        f.app.get(ContentDefinitionRepository) instanceof
          HistoricalContentDefinitionRepository,
      );
      assert.equal(
        (
          await f.pool.query<{ absent: boolean }>(
            historicalTextSourceAbsenceSql,
          )
        ).rows[0]!.absent,
        true,
      );
      const historicalOwner = f.app.get(CommunityDistributionService);
      assert.notEqual(
        Object.getPrototypeOf(historicalOwner),
        CommunityDistributionService.prototype,
      );
      const operator = new TextReviewOperator(
        f.app.get(TextReviewRuntime),
        issuer,
      );
      await inTransaction(f.pool, (tx) =>
        operator.run(
          {
            command: 'init-policy',
            basis: 'Explicit synthetic predecessor Review',
          },
          tx,
        ),
      );
      const actor = await f.actor(),
        auth = `Bearer ${actor.accessToken}`;
      const decide = async (clientRequestId: string) => {
        const row = (
          await f.pool.query<{ digest: string }>(
            'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, clientRequestId],
          )
        ).rows[0]!;
        await inTransaction(f.pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: actor.accountId,
              requestId: clientRequestId,
              digest: row.digest,
              decision: 'allow',
              basis: 'Explicit synthetic exact legacy decision',
            },
            tx,
          ),
        );
      };
      const input = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: 'Real legacy predecessor root',
        authorMode: 'named',
        commentsPolicy: 'open',
        imageAssetIds: [],
      };
      const post = (body: object) =>
        request(f.app.getHttpServer())
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(body);
      const queued = await request(f.app.getHttpServer())
        .post('/v1/community/reviews/posts')
        .set('Authorization', auth)
        .send(input);
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      await decide(input.clientRequestId);
      const root = await post(input);
      assert.equal(root.body.outcome, 'created', JSON.stringify(root.body));
      const childInput = {
        clientRequestId: randomUUID(),
        text: 'Real legacy predecessor child',
        authorMode: 'named',
        imageAssetIds: [],
      };
      const child = () =>
        request(f.app.getHttpServer())
          .post(`/v1/community/posts/${root.body.resourceId}/comments`)
          .set('Authorization', auth)
          .send(childInput);
      const childQueued = await request(f.app.getHttpServer())
        .post(`/v1/community/reviews/posts/${root.body.resourceId}/comments`)
        .set('Authorization', auth)
        .send(childInput);
      assert.equal(childQueued.status, 200, JSON.stringify(childQueued.body));
      await decide(childInput.clientRequestId);
      const childReceipt = await child();
      assert.equal(
        childReceipt.body.outcome,
        'created',
        JSON.stringify(childReceipt.body),
      );
      const snapshot = async () =>
        (
          await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'posts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM whaleu_community.posts p),
      'comments',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM whaleu_community.root_comments c),
      'bindings',(SELECT jsonb_agg(to_jsonb(b)-ARRAY['related_actor_fingerprint','related_actor_transaction'] ORDER BY b.content_kind,b.content_id) FROM whaleu_community.content_approval_bindings b),
      'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.account_id,r.client_request_id) FROM whaleu_community.publication_requests r)) AS value`)
        ).rows[0]!.value;
      assert.equal(
        (
          await f.pool.query(
            "SELECT to_regclass('whaleu_community.post_distribution_bindings') AS present",
          )
        ).rows[0].present,
        null,
      );
      assert.notEqual(
        (
          await request(f.app.getHttpServer())
            .post('/v1/community/reviews/posts')
            .set('Authorization', auth)
            .send({
              ...input,
              clientRequestId: randomUUID(),
              syncToRelatedCampuses: true,
            })
        ).status,
        200,
      );
      const before = await snapshot();
      await runMigrations(
        f.pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const upgradedLegacy = (
        await f.pool.query<{
          count: number;
          fingerprints_null: boolean;
          transactions_null: boolean;
        }>(`SELECT count(*)::integer AS count,
        bool_and(related_actor_fingerprint IS NULL) AS fingerprints_null,
        bool_and(related_actor_transaction IS NULL) AS transactions_null
        FROM whaleu_community.content_approval_bindings WHERE envelope_version<>4`)
      ).rows[0]!;
      assert.deepEqual(
        upgradedLegacy,
        { count: 2, fingerprints_null: true, transactions_null: true },
        'The additive actor-proof columns stay SQL NULL for both real predecessor bindings',
      );
      assert.deepEqual(
        await snapshot(),
        before,
        'Additive migration must retain every legacy root, child, approval and receipt byte',
      );
      await assert.rejects(
        inTransaction(f.pool, (tx) =>
          historicalOwner.resolveView(
            {
              id: f.scope.home.spaceId,
              name: 'Synthetic',
              kind: 'regional',
              operatingRegionId: f.scope.home.regionId,
              isActive: true,
            },
            tx,
          ),
        ),
        { code: 'COMMUNITY_UNAVAILABLE' },
      );
      await f.restartApp();
      assertRelatedSyncRuntimeWiring(f.app);
      assert.equal(
        f.app.get(ReadingFormattingRuntime).constructor,
        ReadingFormattingRuntime,
      );
      assert.ok(
        f.app.get(ContentDefinitionRepository) instanceof
          ContentDefinitionRepository,
      );
      assert.equal(
        f.app.get(ContentDefinitionRepository) instanceof
          HistoricalContentDefinitionRepository,
        false,
      );
      assert.deepEqual((await post(input)).body, root.body);
      assert.deepEqual(
        (await post({ ...input, syncToRelatedCampuses: false })).body,
        root.body,
      );
      assert.deepEqual((await child()).body, childReceipt.body);
      assert.equal(
        (
          await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${root.body.resourceId}`)
            .set('Authorization', auth)
        ).status,
        200,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.post_distribution_bindings',
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      await f.close();
    }
  },
);
