import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { writeRatingApproval } from '../support/rating-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { prepareLegacyBoundaryRequest } from '../support/rating-legacy-boundary-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';

test('subscription SQL causality, immutable epochs, independent coverage and same-transaction history', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor();
  const c = await f.catalog(a, { count: 8 });
  const capture = f.app.get(RatingEffectsCapture);
  const transaction = <T>(fn: (tx: PoolClient) => Promise<T>) =>
    inTransaction(
      f.pool,
      async (tx) => {
        await lockSafetyPolicy(tx);
        return fn(tx);
      },
      { isolationLevel: 'read committed' },
    );
  async function change(
    tx: PoolClient,
    target: string,
    actor: string,
    subscribed: boolean,
  ) {
    await tx.query(
      'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
      [target],
    );
    const before = (
      await tx.query<{
        baseline: string;
        revision: string;
        subscribed: boolean;
        head: string | null;
        occurred_at: string;
      }>(
        `SELECT s.id baseline,coalesce(m.revision,s.id) revision,coalesce(m.subscribed,false) subscribed,m.last_transition_id head,${ratingIso('coalesce(m.updated_at,s.baseline_at)')} occurred_at FROM whaleu_ratings.subscription_baselines s LEFT JOIN whaleu_ratings.subscription_memberships m ON m.target_id=s.target_id AND m.account_id=$2 WHERE s.target_id=$1`,
        [target, actor],
      )
    ).rows[0]!;
    const key = randomUUID();
    const targetRevision = (
      await tx.query<{ revision: string }>(
        'SELECT revision FROM whaleu_ratings.targets WHERE id=$1',
        [target],
      )
    ).rows[0]!.revision;
    await prepareLegacyBoundaryRequest(tx, actor, 'set_target_subscription', {
      clientRequestId: key,
      targetId: target,
      regionId: c.regionId,
      expectedTargetRevision: targetRevision,
      expectedSubscriptionRevision: before.revision,
      subscribed,
    });
    const outcome = before.subscribed === subscribed ? 'noop' : 'applied';
    if (outcome === 'noop')
      await tx.query(
        'INSERT INTO whaleu_ratings.subscription_noop_observations(account_id,request_id,target_id,baseline_id,anchor_transition_id,subscribed,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          actor,
          key,
          target,
          before.baseline,
          before.head,
          subscribed,
          before.revision,
          before.occurred_at,
        ],
      );
    else {
      if (before.head)
        await tx.query(
          'UPDATE whaleu_ratings.subscription_memberships SET subscribed=$3,request_id=$4,expected_revision=$5 WHERE target_id=$1 AND account_id=$2',
          [target, actor, subscribed, key, before.revision],
        );
      else
        await tx.query(
          'INSERT INTO whaleu_ratings.subscription_memberships(target_id,account_id,subscribed,request_id,expected_revision) VALUES($1,$2,$3,$4,$5)',
          [target, actor, subscribed, key, before.revision],
        );
      const source = (
        await tx.query<{
          id: string;
          target_id: string;
          account_id: string;
          request_id: string;
          delta: 1 | -1;
          target_order: string;
          occurred_at: string;
        }>(
          `SELECT id,target_id,account_id,request_id,delta,target_order::text,${ratingIso('occurred_at')} occurred_at FROM whaleu_ratings.subscription_transitions WHERE account_id=$1 AND request_id=$2`,
          [actor, key],
        )
      ).rows[0]!;
      await capture.captureSubscription(tx, source);
    }
    const final =
      outcome === 'noop'
        ? before
        : (
            await tx.query<{ revision: string; occurred_at: string }>(
              `SELECT revision,${ratingIso('updated_at')} occurred_at FROM whaleu_ratings.subscription_memberships WHERE target_id=$1 AND account_id=$2`,
              [target, actor],
            )
          ).rows[0]!;
    const receipt = {
      requestId: key,
      operation: 'set_target_subscription',
      outcome,
      targetId: target,
      subscribed,
      revision: final.revision,
      occurredAt: final.occurred_at,
    };
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [actor, key, JSON.stringify(receipt)],
    );
    return receipt;
  }
  async function fault(
    table: string,
    event: string,
    action: () => Promise<void>,
    onlyActor?: string,
  ) {
    await f.pool.query(
      `CREATE FUNCTION whaleu_ratings.synthetic_subscription_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${onlyActor ? `IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE id=NEW.head_transition_id AND account_id='${onlyActor}'::uuid) THEN RETURN NEW;END IF;` : ''} RETURN NULL; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER a_synthetic_subscription_fault BEFORE ${event} ON whaleu_ratings.${table} FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_subscription_fault()`,
    );
    try {
      await action();
    } finally {
      await f.pool.query(
        `DROP TRIGGER a_synthetic_subscription_fault ON whaleu_ratings.${table}`,
      );
      await f.pool.query(
        'DROP FUNCTION whaleu_ratings.synthetic_subscription_fault()',
      );
    }
  }
  await t.test(
    'three real transitions and noops in one transaction retain exact historical receipts and epochs',
    async () => {
      const target = c.targets[0]!.id;
      const receipts = await transaction(async (tx) => {
        const zero = await change(tx, target, a.accountId, false);
        const on = await change(tx, target, a.accountId, true);
        const noop = await change(tx, target, a.accountId, true);
        const off = await change(tx, target, a.accountId, false);
        const re = await change(tx, target, a.accountId, true);
        const other = await change(tx, target, b.accountId, true);
        return { zero, on, noop, off, re, other };
      });
      assert.equal(receipts.zero.outcome, 'noop');
      assert.equal(receipts.noop.occurredAt, receipts.on.occurredAt);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT delta,target_order::text FROM whaleu_ratings.subscription_transitions WHERE target_id=$1 ORDER BY target_order',
            [target],
          )
        ).rows,
        [
          { delta: 1, target_order: '1' },
          { delta: -1, target_order: '2' },
          { delta: 1, target_order: '3' },
          { delta: 1, target_order: '4' },
        ],
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count FROM whaleu_ratings.subscription_states WHERE target_id=$1',
            [target],
          )
        ).rows[0].count,
        2,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.subscription_epochs WHERE target_id=$1',
            [target],
          )
        ).rowCount,
        3,
      );
    },
  );
  await t.test(
    'savepoint rollback removes order, epoch, XP work and request without sequence holes',
    async () => {
      const target = c.targets[1]!.id;
      const rolled = await transaction(async (tx) => {
        await tx.query('SAVEPOINT event');
        const r = await change(tx, target, a.accountId, true);
        await tx.query('ROLLBACK TO SAVEPOINT event');
        await tx.query('RELEASE SAVEPOINT event');
        await change(tx, target, b.accountId, true);
        return r;
      });
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.requests WHERE request_id=$1',
            [rolled.requestId],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT target_order::text,account_id FROM whaleu_ratings.subscription_transitions WHERE target_id=$1',
            [target],
          )
        ).rows,
        [{ target_order: '1', account_id: b.accountId }],
      );
    },
  );
  await t.test(
    'suppressed initial count projection cannot be hidden by a later actor transition',
    async () => {
      const target = c.targets[2]!.id;
      let firstCaptured = false;
      await fault(
        'subscription_states',
        'UPDATE',
        async () => {
          await assert.rejects(
            transaction(async (tx) => {
              await change(tx, target, a.accountId, true);
              firstCaptured = true;
              await change(tx, target, b.accountId, true);
            }),
            /Subscription|duplicate key/,
          );
        },
        a.accountId,
      );
      assert.equal(firstCaptured, true);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count FROM whaleu_ratings.subscription_states WHERE target_id=$1',
            [target],
          )
        ).rows[0].count,
        0,
      );
    },
  );
  await t.test(
    'suppressed noninitial projection cannot fork count history',
    async () => {
      const target = c.targets[3]!.id;
      await transaction((tx) => change(tx, target, a.accountId, true));
      let firstCaptured = false;
      await fault(
        'subscription_states',
        'UPDATE',
        async () => {
          await assert.rejects(
            transaction(async (tx) => {
              await change(tx, target, a.accountId, false);
              firstCaptured = true;
              await change(tx, target, b.accountId, true);
            }),
            /Subscription|duplicate key/,
          );
        },
        a.accountId,
      );
      assert.equal(firstCaptured, true);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count FROM whaleu_ratings.subscription_states WHERE target_id=$1',
            [target],
          )
        ).rows[0].count,
        1,
      );
    },
  );
  await t.test(
    'raw rewrites and forged stream/noop receipts are rejected',
    async () => {
      const target = c.targets[0]!.id;
      for (const sql of [
        'UPDATE whaleu_ratings.subscription_states SET count=count+1 WHERE target_id=$1',
        'UPDATE whaleu_ratings.subscription_streams SET last_order=last_order+1 WHERE target_id=$1',
        'DELETE FROM whaleu_ratings.subscription_memberships WHERE target_id=$1',
        'UPDATE whaleu_ratings.subscription_epochs SET start_order=start_order+1 WHERE target_id=$1',
        'DELETE FROM whaleu_ratings.subscription_epoch_closures WHERE target_id=$1',
      ]) {
        await assert.rejects(
          transaction((tx) => tx.query(sql, [target])),
          /Subscription|immutable/,
        );
      }
      await assert.rejects(
        transaction((tx) =>
          tx.query(
            "SELECT whaleu_ratings.next_subscription_order($1,'subscription',$2)",
            [target, randomUUID()],
          ),
        ),
        /Subscription/,
      );
      await assert.rejects(
        transaction(async (tx) => {
          const key = randomUUID();
          const targetRevision = (
            await tx.query<{ revision: string }>(
              'SELECT revision FROM whaleu_ratings.targets WHERE id=$1',
              [target],
            )
          ).rows[0]!.revision;
          const revision = randomUUID();
          await prepareLegacyBoundaryRequest(
            tx,
            a.accountId,
            'set_target_subscription',
            {
              clientRequestId: key,
              targetId: target,
              regionId: c.regionId,
              expectedTargetRevision: targetRevision,
              expectedSubscriptionRevision: revision,
              subscribed: false,
            },
          );
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              a.accountId,
              key,
              JSON.stringify({
                requestId: key,
                operation: 'set_target_subscription',
                outcome: 'noop',
                targetId: target,
                subscribed: false,
                revision,
                occurredAt: '2026-10-09T00:00:00Z',
              }),
            ],
          );
          // Exercise the original missing-noop-observation guard first; the
          // new selector witness is valid and cannot mask this counterexample.
          await tx.query(
            'SET CONSTRAINTS whaleu_ratings.rating_subscription_request_causal IMMEDIATE',
          );
        }),
        /noop/,
      );
    },
  );
  await t.test(
    'missing epoch and stream advances roll back the entire causal write',
    async () => {
      for (const table of ['subscription_epochs', 'subscription_streams']) {
        const target = c.targets[table === 'subscription_epochs' ? 4 : 5]!.id;
        await fault(
          table,
          table === 'subscription_epochs' ? 'INSERT' : 'UPDATE',
          async () => {
            await assert.rejects(
              transaction((tx) => change(tx, target, a.accountId, true)),
              /Subscription|foreign key/,
            );
          },
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE target_id=$1',
              [target],
            )
          ).rowCount,
          0,
        );
      }
    },
  );
  await t.test(
    'historical target has unknown membership and no writable zero or empty audience claim',
    async () => {
      const old = await f.catalog(a, { baseline: false }),
        target = old.targets[0]!;
      const response = await f.auth(
        request(f.http).get(`/v1/ratings/targets/${target.id}/subscription`),
        a,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: 'unavailable' });
      const key = randomUUID();
      const changed = await f
        .auth(
          request(f.http).put(`/v1/ratings/targets/${target.id}/subscription`),
          a,
        )
        .send({
          clientRequestId: key,
          regionId: null,
          expectedTargetRevision: target.revision,
          expectedSubscriptionRevision: randomUUID(),
          subscribed: true,
        });
      assert.equal(changed.status, 503);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.requests WHERE request_id=$1',
            [key],
          )
        ).rowCount,
        0,
      );
      const root = await f.publish(a, old, target);
      const source = (
        await f.pool.query(
          'SELECT s.captured_coverage,s.baseline_id FROM whaleu_ratings.subscription_fanout_sources s WHERE root_id=$1',
          [root.id],
        )
      ).rows[0];
      assert.deepEqual(source, {
        captured_coverage: 'unknown',
        baseline_id: null,
      });
    },
  );
  await t.test(
    'future-effective source and late cutover forgery never yield known zero',
    async () => {
      const targetId = randomUUID(),
        revision = randomUUID(),
        sourceId = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const envelope = canonicalRatingEnvelope({
          version: 1,
          accountId: a.accountId,
          purpose: 'publish_rating_target',
          clientRequestId: randomUUID(),
          targetId,
          targetRevision: revision,
          categoryId: c.categoryId,
          categoryRevision: c.categoryRevision,
          catalogRevision: c.catalogId,
          scope: { regionId: null },
          assetIds: [],
          name: 'Future source',
          description: '',
        });
        const approval = await writeRatingApproval(tx, envelope);
        await tx.query(
          "INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted','future-fixture','future-policy',clock_timestamp()+interval '1 day')",
          [sourceId, targetId],
        );
        await tx.query(
          "INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope) VALUES($1,$2,$3,$4,NULL,$5,'Future source','',true,$6::jsonb)",
          [
            targetId,
            revision,
            c.categoryId,
            a.accountId,
            sourceId,
            canonicalJson(envelope),
          ],
        );
        await tx.query(
          "INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('target',$1,1,$2,$3,'publish_rating_target',1,$4,$5::jsonb,$6::jsonb)",
          [
            targetId,
            approval.decisionId,
            a.accountId,
            approval.digest,
            canonicalJson(envelope),
            canonicalJson(envelope.scope),
          ],
        );
      });
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.subscription_baselines WHERE target_id=$1',
            [targetId],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        transaction((tx) =>
          tx.query(
            "INSERT INTO whaleu_ratings.subscription_baselines(id,target_id,kind,activation_id,source_id,target_creation_transaction,baseline_at,coverage) SELECT gen_random_uuid(),c.target_id,'native-activation',a.id,c.source_id,c.creation_transaction,a.activated_at,'complete' FROM whaleu_ratings.target_creations c CROSS JOIN whaleu_ratings.subscription_activations a WHERE c.target_id=$1",
            [targetId],
          ),
        ),
        /Subscription/,
      );
    },
  );
});
