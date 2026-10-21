import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { ReadingFormattingRuntime } from '../../src/community/reading-formatting/runtime.js';
import { ReadingSourceOwner } from '../../src/community/reading-formatting/source-owner.js';
import { HistoricalReadingFormattingRuntime } from '../support/historical-content-definition/reading-enrollment.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { acceptRelatedSyncPolicy } from '../support/related-sync-fixtures.js';
import { setRegionPolicy } from '../support/community-scope-fixtures.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import {
  HistoricalContentDefinitionRepository,
  historicalTextSourceAbsenceSql,
} from '../support/historical-content-definition/configure.js';

function snapshotDifferenceMessage(before: string, after: string): string {
  const differences: string[] = [];
  let total = 0;
  const describe = (value: unknown): string => {
    if (value === undefined) return '<absent>';
    if (Array.isArray(value)) return `<array length=${value.length}>`;
    if (value !== null && typeof value === 'object')
      return `<object keys=${Object.keys(value).length}>`;
    const text = JSON.stringify(value);
    return text.length <= 160 ? text : `${text.slice(0, 160)}...`;
  };
  const record = (path: string, expected: unknown, actual: unknown) => {
    total += 1;
    if (differences.length < 32)
      differences.push(`${path}: ${describe(expected)} -> ${describe(actual)}`);
  };
  const visit = (expected: unknown, actual: unknown, path: string): void => {
    if (Object.is(expected, actual)) return;
    if (Array.isArray(expected) && Array.isArray(actual)) {
      for (
        let index = 0;
        index < Math.max(expected.length, actual.length);
        index++
      )
        visit(expected[index], actual[index], `${path}[${index}]`);
      return;
    }
    if (
      expected !== null &&
      actual !== null &&
      typeof expected === 'object' &&
      typeof actual === 'object' &&
      !Array.isArray(expected) &&
      !Array.isArray(actual)
    ) {
      const left = expected as Record<string, unknown>;
      const right = actual as Record<string, unknown>;
      for (const key of [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort())
        visit(
          Object.hasOwn(left, key) ? left[key] : undefined,
          Object.hasOwn(right, key) ? right[key] : undefined,
          `${path}[${JSON.stringify(key)}]`,
        );
      return;
    }
    record(path, expected, actual);
  };
  visit(JSON.parse(before), JSON.parse(after), '$');
  return [
    `Whole-row migration snapshot differs at ${total} paths (expected -> actual):`,
    ...differences,
    ...(total > differences.length
      ? [`... ${total - differences.length} additional differences omitted`]
      : []),
  ].join('\n');
}

/** Admission occurs before 0148 exists. Old pending, approved, lost-response and
 * cancel-pending requests keep their original journal/Review protocol on upgrade. */
test(
  'pre0148 v1-v4 in-flight original keys, hashes and reviewed bytes survive additive card migrations',
  { timeout: 300000 },
  async (t) => {
    let patch: Partial<RuntimeConfig> = {};
    const f = await directoryRuntimeFixture(144, {
      createApp: async (config, configurePolicy) => {
        const builder = Test.createTestingModule({
          imports: [AppModule.register({ ...config, ...patch })],
        });
        await configurePolicy(builder);
        return (await builder.compile()).createNestApplication({
          logger: false,
        });
      },
    });
    t.after(() => f.close());
    patch = {
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
      COMMUNITY_RELATED_REVIEW_POLICY_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:synthetic:rating-link-upgrade',
      COMMUNITY_FEEDBACK_SPACE_ID: f.scope.global.spaceId,
    };
    await f.restartApp(144);
    assert.ok(
      f.app.get(ReadingFormattingRuntime) instanceof
        HistoricalReadingFormattingRuntime,
    );
    assert.ok(
      f.app.get(ContentDefinitionRepository) instanceof
        HistoricalContentDefinitionRepository,
    );
    assert.equal(
      (await f.pool.query<{ absent: boolean }>(historicalTextSourceAbsenceSql))
        .rows[0]!.absent,
      true,
    );
    const operator = () =>
      new TextReviewOperator(
        f.app.get(TextReviewRuntime),
        patch.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
    for (const command of [
      'init-policy',
      'init-related-policy',
      'init-feedback',
    ] as const)
      await inTransaction(f.pool, (tx) =>
        operator().run(
          {
            command,
            basis: 'Explicit disposable pre0148 migration acceptance',
          },
          tx,
        ),
      );
    await acceptRelatedSyncPolicy(f.pool, f.scope.home.regionId, {
      reviewPolicyId: patch.COMMUNITY_RELATED_REVIEW_POLICY_ID!,
      issuer: patch.COMMUNITY_TEXT_REVIEW_OPERATOR!,
    });
    await setRegionPolicy(f.pool, f.scope.home.regionId, {
      relatedSyncEnabled: true,
      unverifiedCommentEnabled: true,
    });
    const actor = await f.actor();
    const post = (path: string, body: object) =>
      request(f.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const publish = (body: object) => post('/v1/community/posts', body);
    const decide = async (id: string) => {
      const row = (
        await f.pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, id],
        )
      ).rows[0]!;
      await inTransaction(f.pool, (tx) =>
        operator().run(
          {
            command: 'decide',
            accountId: actor.accountId,
            requestId: id,
            digest: row.digest,
            decision: 'allow',
            basis: 'Explicit exact predecessor pending decision',
          },
          tx,
        ),
      );
    };
    const records: Array<{
      version: number;
      state:
        | 'pending'
        | 'approved'
        | 'response_lost'
        | 'cancel_pending'
        | 'authority_revoked';
      body: ReturnType<typeof publishPostSchema.parse>;
      hash: string;
      digest: string;
      envelope: unknown;
      receipt?: unknown;
    }> = [];
    for (const version of [1, 2, 3, 4])
      for (const state of [
        'pending',
        'approved',
        'response_lost',
        'cancel_pending',
        'authority_revoked',
      ] as const) {
        const body = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId:
            version === 3 ? f.scope.global.spaceId : f.scope.home.spaceId,
          category: version === 3 ? 'feedback' : 'discussion',
          text: `Pre0148 original v${version} ${state}`,
          authorMode: 'named',
          commentsPolicy: 'open',
          imageAssetIds: [],
          ...(version === 2 ? { allowAnonymousDm: false } : {}),
          ...(version === 3
            ? { feedback: { contacts: { wechat: '', qq: '', phone: '' } } }
            : {}),
          ...(version === 4 ? { syncToRelatedCampuses: true } : {}),
        });
        const queued = await post('/v1/community/reviews/posts', body);
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        assert.equal(queued.body.status, 'pending');
        const row = (
          await f.pool.query(
            'SELECT digest,envelope,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, body.clientRequestId],
          )
        ).rows[0]!;
        assert.equal(row.envelope.version, version);
        const hash = publicationHash('publish_post', postIntent(body));
        assert.equal(row.intent_hash, hash);
        if (
          state === 'approved' ||
          state === 'response_lost' ||
          state === 'authority_revoked'
        )
          await decide(body.clientRequestId);
        // A pending client cancellation can already have committed server-side:
        // discard its first response and retry the exact original key after upgrade.
        const receipt =
          state === 'response_lost'
            ? (await publish(body)).body
            : state === 'cancel_pending'
              ? (
                  await post(
                    `/v1/community/reviews/requests/${body.clientRequestId}/cancel`,
                    { operation: 'publish_post', intentHash: hash },
                  )
                ).body
              : undefined;
        if (receipt)
          assert.equal(
            receipt.outcome,
            state === 'cancel_pending' ? 'cancelled' : 'created',
            JSON.stringify(receipt),
          );
        if (version === 1 && state === 'response_lost')
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              new ReadingFormattingRuntime(
                f.app.get(DatabaseService),
                f.app.get(ReadingSourceOwner),
              ).enrollCreated(
                'post',
                (receipt as { resourceId: string }).resourceId,
                body.clientRequestId,
                tx,
              ),
            ),
            { code: '42P01' },
            'The current enrollment owner still fails closed on missing source storage',
          );
        records.push({
          version,
          state,
          body,
          hash,
          digest: row.digest,
          envelope: row.envelope,
          ...(receipt ? { receipt } : {}),
        });
      }
    assert.equal(
      (
        await f.pool.query(
          "SELECT to_regclass('whaleu_community.post_rating_target_links') present",
        )
      ).rows[0].present,
      null,
    );
    const snapshot = async () =>
      canonicalJson(
        (
          await f.pool.query(
            `SELECT jsonb_build_object('posts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.posts p),'requests',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,client_request_id) FROM whaleu_community.publication_requests q),'review',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,client_request_id) FROM whaleu_community.text_review_requests q),'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY content_kind,content_id) FROM whaleu_community.content_approval_bindings b)) value`,
          )
        ).rows[0].value,
      );
    const before = await snapshot();
    const expected = JSON.parse(before) as {
      review: Array<Record<string, unknown>>;
    };
    assert.ok(Array.isArray(expected.review));
    assert.equal(expected.review.length, records.length);
    for (const row of expected.review) {
      assert.equal(
        Object.hasOwn(row, 'text_source_transition_transaction'),
        false,
      );
      // 0175 adds only this nullable cohort observation to these whole rows.
      // Preserve every predecessor field, including all journal/review bytes.
      row['text_source_transition_transaction'] = null;
    }
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT column_name,udt_schema,udt_name,is_nullable,column_default
           FROM information_schema.columns
           WHERE table_schema='whaleu_community'
             AND table_name='text_review_requests'
             AND column_name='text_source_transition_transaction'`,
        )
      ).rows,
      [
        {
          column_name: 'text_source_transition_transaction',
          udt_schema: 'pg_catalog',
          udt_name: 'xid8',
          is_nullable: 'YES',
          column_default: null,
        },
      ],
    );
    const after = await snapshot();
    const expectedAfter = canonicalJson(expected);
    assert.equal(
      after,
      expectedAfter,
      after === expectedAfter
        ? undefined
        : snapshotDifferenceMessage(expectedAfter, after),
    );
    await f.restartApp();
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
    for (const record of records) {
      const row = (
        await f.pool.query(
          'SELECT digest,envelope,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, record.body.clientRequestId],
        )
      ).rows[0]!;
      assert.equal(row.digest, record.digest);
      assert.equal(canonicalJson(row.envelope), canonicalJson(record.envelope));
      assert.equal(row.intent_hash, record.hash);
      assert.equal(
        publicationHash('publish_post', postIntent(record.body)),
        record.hash,
      );
      if (record.state === 'authority_revoked') continue;
      if (record.state === 'cancel_pending') {
        const cancelled = await post(
          `/v1/community/reviews/requests/${record.body.clientRequestId}/cancel`,
          { operation: 'publish_post', intentHash: record.hash },
        );
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.body.outcome, 'cancelled');
        assert.deepEqual(cancelled.body, record.receipt);
        assert.notEqual((await publish(record.body)).status, 201);
        continue;
      }
      if (record.state === 'pending') await decide(record.body.clientRequestId);
      const result = await publish(record.body);
      assert.equal(result.body.outcome, 'created', JSON.stringify(result.body));
      if (record.receipt) assert.deepEqual(result.body, record.receipt);
      assert.deepEqual((await publish(record.body)).body, result.body);
      const binding = (
        await f.pool.query(
          "SELECT envelope_version,envelope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
          [result.body.resourceId],
        )
      ).rows[0]!;
      assert.equal(binding.envelope_version, record.version);
      assert.equal(
        canonicalJson(binding.envelope),
        canonicalJson(record.envelope),
      );
    }
    await f.certify(actor.accountId, { phone: 'unverified' });
    for (const record of records.filter(
      (value) => value.state === 'authority_revoked',
    )) {
      const countsBefore = (
        await f.pool.query(
          `SELECT (SELECT count(*)::int FROM whaleu_community.posts) posts,(SELECT count(*)::int FROM whaleu_community.content_approval_bindings) bindings`,
        )
      ).rows[0];
      const blocked = await publish(record.body);
      assert.equal(blocked.status, 201, JSON.stringify(blocked.body));
      assert.deepEqual(blocked.body, {
        requestId: record.body.clientRequestId,
        operation: 'publish_post',
        outcome: 'rejected',
        code: 'PHONE_VERIFICATION_REQUIRED',
      });
      assert.deepEqual(
        (
          await f.pool.query(
            `SELECT (SELECT count(*)::int FROM whaleu_community.posts) posts,(SELECT count(*)::int FROM whaleu_community.content_approval_bindings) bindings`,
          )
        ).rows[0],
        countsBefore,
      );
      const unchanged = (
        await f.pool.query(
          'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, record.body.clientRequestId],
        )
      ).rows[0];
      assert.equal(unchanged.digest, record.digest);
      assert.equal(
        canonicalJson(unchanged.envelope),
        canonicalJson(record.envelope),
      );
      const cancelled = await post(
        `/v1/community/reviews/requests/${record.body.clientRequestId}/cancel`,
        { operation: 'publish_post', intentHash: record.hash },
      );
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.notEqual((await publish(record.body)).body.outcome, 'created');
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
        )
      ).rows[0].n,
      0,
    );
  },
);
