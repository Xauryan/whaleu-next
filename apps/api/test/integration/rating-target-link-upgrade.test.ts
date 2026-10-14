import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
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
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    assert.equal(await snapshot(), before);
    await f.restartApp();
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
