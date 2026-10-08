import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  assertReceipt,
  reportIntent,
  viewFixture,
} from '../support/view-component-fixture.js';
import { hashToken } from '../../src/identity/tokens.js';

test(
  'view reporting: real authenticated HTTP, fresh-only aggregate and immutable bounded receipts',
  { timeout: 180000 },
  async (t) => {
    const f = await viewFixture();
    try {
      const author = await f.actor();
      await t.test(
        'fresh publication enrolls in its creation transaction; replay and failed enrollment are atomic',
        async () => {
          const post = await f.publish(author);
          const row = (
            await f.pool.query(
              'SELECT b.*,p.local_creation_transaction::text AS post_xid,b.creation_xid::text AS view_xid,s.count FROM whaleu_post_hotness.view_baselines b JOIN whaleu_post_hotness.view_states s USING(post_id) JOIN whaleu_community.posts p ON p.id=b.post_id WHERE post_id=$1',
              [post.id],
            )
          ).rows[0]!;
          assert.equal(row.count, '0');
          assert.equal(row.opening_count, '0');
          assert.equal(row.owner_id, author.accountId);
          assert.equal(row.source_request_id, post.body.clientRequestId);
          assert.equal(row.view_xid, row.post_xid);
          assert.deepEqual(
            (await f.publication(author, post.body).expect(201)).body,
            post.receipt,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_baselines WHERE post_id=$1',
                [post.id],
              )
            ).rowCount,
            1,
          );
          const body = f.intent('Synthetic failed view enrollment');
          await f.approve(author, body);
          await f.pool.query(
            "CREATE FUNCTION whaleu_maintenance_test.fail_view_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic view enrollment failure'; END $$; CREATE TRIGGER synthetic_view_enrollment_failure BEFORE INSERT ON whaleu_post_hotness.view_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_view_enrollment()",
          );
          try {
            await f.publication(author, body).expect(500);
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_view_enrollment_failure ON whaleu_post_hotness.view_baselines; DROP FUNCTION whaleu_maintenance_test.fail_view_enrollment()',
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                [body.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.report_origins WHERE source_request_id=$1',
                [body.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [body.text],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'authenticated phone-unverified browsing counts, missing/expired/revoked accounts do not',
        async () => {
          const reader = await createRuntimeActor(f.app);
          const facts = await setRuntimeVerification(
            f.pool,
            reader.accountId,
            f.scope.institutionId,
            f.scope.home.regionId,
            'unverified',
            'unverified',
          );
          await appendIdentitySelection(
            f.pool,
            reader.accountId,
            facts,
            f.scope,
          );
          const post = await f.publish(author);
          await f.issue().expect(401);
          const epoch = await f.epoch(reader);
          const input = reportIntent(epoch.epochId, [post.id]);
          await f.report(undefined, input).expect(401);
          assertReceipt(
            (await f.report(reader, input).expect(200)).body,
            input,
            1,
          );
          assert.equal(await f.count(post.id), '1');
          for (const mode of ['expired', 'revoked', 'blocked'] as const) {
            const who = await f.actor();
            const descriptor = await f.epoch(who);
            if (mode === 'expired')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
                [hashToken(who.accessToken)],
              );
            else if (mode === 'revoked')
              await f.identity.revoke(hashToken(who.accessToken));
            else
              await f.pool.query(
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [who.accountId],
              );
            const result = await f.report(
              who,
              reportIntent(descriptor.epochId, [post.id]),
            );
            assert.ok(
              [401, 403].includes(result.status),
              JSON.stringify(result.body),
            );
            assert.equal((await f.receipts(descriptor.epochId)).length, 0);
          }
          assert.equal(await f.count(post.id), '1');
        },
      );
      await t.test(
        'strict wire grammar, 50 repeated events, multiset replay, conflicts and concurrent lost-response recovery',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            a = await f.publish(author),
            b = await f.publish(author);
          const input = reportIntent(epoch.epochId, [a.id, b.id, a.id]);
          for (const invalid of [
            { ...input, version: 2 },
            { ...input, actorId: author.accountId },
            { ...input, epochId: randomUUID().replaceAll('-', '') },
            { ...input, batchId: 'bad' },
            { ...input, postIds: [] },
            { ...input, postIds: Array.from({ length: 51 }, () => a.id) },
            { ...input, kind: 'detail_visit', postIds: [a.id, b.id] },
            { ...input, kind: 'mixed' },
            { ...input, postIds: [1] },
          ])
            await f.report(actor, invalid).expect(400);
          const replies = await Promise.all(
            Array.from({ length: 5 }, () => f.report(actor, input).expect(200)),
          );
          for (const response of replies)
            assertReceipt(response.body, input, 3);
          assert.equal(await f.count(a.id), '2');
          assert.equal(await f.count(b.id), '1');
          assert.deepEqual(
            (
              await f
                .report(actor, {
                  ...input,
                  postIds: [a.id.toUpperCase(), a.id, b.id],
                })
                .expect(200)
            ).body,
            replies[0]!.body,
          );
          await f
            .report(actor, { ...input, postIds: [a.id, b.id] })
            .expect(409);
          const one = reportIntent(epoch.epochId, [a.id]);
          await f.report(actor, one).expect(200);
          await f.report(actor, { ...one, kind: 'detail_visit' }).expect(409);
          const fifty = reportIntent(
            epoch.epochId,
            Array.from({ length: 50 }, () => b.id),
          );
          assertReceipt(
            (await f.report(actor, fifty).expect(200)).body,
            fifty,
            50,
          );
          const other = await f.actor(),
            otherEpoch = await f.epoch(other);
          const independent = { ...input, epochId: otherEpoch.epochId };
          assertReceipt(
            (await f.report(other, independent).expect(200)).body,
            independent,
            3,
          );
          const inaccessible = await f.report(other, input).expect(410);
          assert.equal(
            inaccessible.body.error.code,
            'VIEW_REPORTING_EPOCH_CLOSED',
          );
          assert.equal((await f.receipts(epoch.epochId)).length, 3);
        },
      );
      await t.test(
        'definite denials are private zeroes; list and direct semantics differ; replay retains original result',
        async () => {
          const actor = await f.actor(),
            owner = await f.actor(),
            epoch = await f.epoch(actor),
            post = await f.publish(owner),
            raw = await f.rawUnknown(owner);
          const visible = reportIntent(epoch.epochId, [
            post.id,
            raw,
            randomUUID(),
            post.id,
          ]);
          assertReceipt(
            (await f.report(actor, visible).expect(200)).body,
            visible,
            2,
          );
          assert.equal(await f.count(raw), undefined);
          await f.block(owner.accountId, actor.accountId);
          const list = reportIntent(epoch.epochId, [post.id]);
          assertReceipt(
            (await f.report(actor, list).expect(200)).body,
            list,
            1,
          );
          const detail = reportIntent(epoch.epochId, [post.id], 'detail_visit');
          assertReceipt(
            (await f.report(actor, detail).expect(200)).body,
            detail,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2',
                [actor.accountId, post.id],
              )
            ).rowCount,
            0,
          );
          await f.block(actor.accountId, owner.accountId);
          const denied = reportIntent(epoch.epochId, [
            post.id,
            raw,
            randomUUID(),
          ]);
          assertReceipt(
            (await f.report(actor, denied).expect(200)).body,
            denied,
            0,
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [post.id],
            ),
          );
          assertReceipt(
            (await f.report(actor, visible).expect(200)).body,
            visible,
            2,
          );
          assert.equal(await f.count(post.id), '3');
          assert.equal(await f.count(raw), undefined);
        },
      );
      await t.test(
        'unavailable safety and infrastructure roll back every effect and capacity; same identity recovers',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            a = await f.publish(author),
            b = await f.publish(author);
          const input = reportIntent(epoch.epochId, [a.id, b.id]);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
              [actor.accountId],
            ),
          );
          try {
            await f.report(actor, input).expect(503);
          } finally {
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
                [actor.accountId],
              ),
            );
          }
          assert.equal((await f.receipts(epoch.epochId)).length, 0);
          assert.equal(await f.count(a.id), '0');
          for (const target of ['view_states', 'view_report_receipts']) {
            const before = await f.counters(epoch.epochId);
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_view_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic view effect failure'; END $$; CREATE TRIGGER synthetic_view_effect_failure BEFORE ${target === 'view_states' ? 'UPDATE' : 'INSERT'} ON whaleu_post_hotness.${target} FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_view_effect()`,
            );
            try {
              await f.report(actor, input).expect(503);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_view_effect_failure ON whaleu_post_hotness.${target}; DROP FUNCTION whaleu_maintenance_test.fail_view_effect()`,
              );
            }
            assert.deepEqual(await f.counters(epoch.epochId), before);
            assert.equal((await f.receipts(epoch.epochId)).length, 0);
            assert.equal(await f.count(a.id), '0');
            assert.equal(await f.count(b.id), '0');
          }
          assertReceipt(
            (await f.report(actor, input).expect(200)).body,
            input,
            2,
          );
        },
      );
      await t.test(
        'detail fixed 300-second window, concurrent batches, self views, list independence and side-effect-free GET',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            post = await f.publish(actor);
          const before = await f.snapshot();
          const detail = reportIntent(epoch.epochId, [post.id], 'detail_visit');
          const started = (
            await f.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
          ).rows[0]!.now.getTime();
          const results = await Promise.all([
            f.report(actor, detail).expect(200),
            f
              .report(
                actor,
                reportIntent(epoch.epochId, [post.id], 'detail_visit'),
              )
              .expect(200),
          ]);
          assert.equal(
            results.reduce((n, r) => n + r.body.acceptedCount, 0),
            1,
          );
          const until = (
            await f.pool.query<{ next_allowed_at: Date }>(
              'SELECT next_allowed_at FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2',
              [actor.accountId, post.id],
            )
          ).rows[0]!.next_allowed_at;
          assert.ok(until.getTime() >= started + 300000);
          assert.ok(until.getTime() < Date.now() + 301000);
          const duplicate = reportIntent(
            epoch.epochId,
            [post.id],
            'detail_visit',
          );
          assertReceipt(
            (await f.report(actor, duplicate).expect(200)).body,
            duplicate,
            0,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT next_allowed_at FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2',
                [actor.accountId, post.id],
              )
            ).rows[0]!.next_allowed_at,
            until,
          );
          const list = reportIntent(epoch.epochId, [post.id, post.id]);
          assertReceipt(
            (await f.report(actor, list).expect(200)).body,
            list,
            2,
          );
          assert.equal(await f.count(post.id), '3');
          const after = await f.snapshot();
          for (const [name, rows] of Object.entries(before))
            if (
              !name.startsWith('whaleu_post_hotness.view_') &&
              !name.startsWith('whaleu_runtime.')
            )
              assert.deepEqual(
                after[name],
                rows,
                `${name} cannot be changed by views`,
              );
          for (let i = 0; i < 2; i++)
            await request(f.app.getHttpServer())
              .get(`/v1/community/posts/${post.id}`)
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .expect(200);
          assert.equal(
            await f.count(post.id),
            '3',
            'Fetching a detail is never an implicit view write',
          );
          const columns = (
            await f.pool.query<{ table_name: string; column_name: string }>(
              "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='whaleu_post_hotness' AND table_name LIKE 'view_%' ORDER BY table_name,ordinal_position",
            )
          ).rows;
          const tables = [
            ...new Set(columns.map((row) => row.table_name)),
          ].sort();
          assert.deepEqual(tables, [
            'view_baselines',
            'view_detail_cooldowns',
            'view_report_receipts',
            'view_reporting_epochs',
            'view_states',
          ]);
          assert.equal(
            columns
              .filter((row) => row.table_name === 'view_report_receipts')
              .some((row) =>
                /post|actor|account|timestamp/.test(row.column_name),
              ),
            false,
            'Receipts retain fingerprints only, not per-post browsing histories',
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
