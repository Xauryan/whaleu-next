import { ErrandGroupEnrollment } from '../../src/notifications/errand-group/enrollment.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  errandGroupFixture,
  DurableSyntheticGroupSender,
} from '../support/errand-group-runtime.js';
import {
  approveErrand,
  revokeErrandReview,
} from '../support/errand-review-fixtures.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { publishErrandSchema } from '../../src/errands/contracts.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ErrandGroupWorker } from '../../src/notifications/errand-group/worker.js';
import {
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import {
  withCommunityScopeWriter,
  appendTopologyRevision,
} from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  errandMediaFixture,
  createErrandMediaDraft,
  readyErrandImage,
  publishErrandImages,
} from '../support/media/errand-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import sharp from 'sharp';

type Fixture = Awaited<ReturnType<typeof errandGroupFixture>>;
async function publish(
  f: Fixture,
  patch: Record<string, unknown> = {},
  reviewOptions: Parameters<typeof approveErrand>[2] = {},
) {
  const actor = await f.actor();
  const body = publishErrandSchema.parse({
    clientRequestId: randomUUID(),
    targetRegionId: f.scope.related.regionId,
    title: 'Synthetic group order',
    publicText: 'Never transmit public body',
    privateText: 'SECRET private instructions',
    expectedTimeText: 'Tomorrow',
    reward: '12.34567890123456789',
    publisherContacts: { wechat: 'SECRET_contact', phone: '12345678901' },
    publicAssetIds: [],
    privateAssetIds: [],
    ...patch,
  });
  const scope = await f.db.transaction(
    async (tx) => {
      await lockSafetyPolicy(tx);
      return f.app
        .get(ErrandAccessService)
        .scope(actor.accountId, body.targetRegionId, tx);
    },
    { isolationLevel: 'read committed' },
  );
  const approval = await approveErrand(
    f.pool,
    {
      version: 1,
      accountId: actor.accountId,
      purpose: 'publish_errand',
      title: body.title,
      publicText: body.publicText,
      privateText: body.privateText,
      expectedTimeText: body.expectedTimeText,
      reward: body.reward,
      publisherContacts: body.publisherContacts,
      publicAssetIds: [],
      privateAssetIds: [],
      scope,
    },
    reviewOptions,
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/errands')
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.outcome, 'applied', JSON.stringify(response.body));
  const row = (
    await f.pool.query(
      'SELECT * FROM whaleu_notifications.errand_group_publications WHERE order_id=$1',
      [response.body.orderId],
    )
  ).rows[0];
  assert.ok(row);
  f.setTime(row.published_at.getTime());
  return {
    actor,
    body,
    approval,
    id: response.body.orderId as string,
    revision: response.body.revision as string,
    publishedAt: row.published_at.getTime() as number,
  };
}
function destinations(f: Fixture) {
  return {
    one: f.authority.add(f.scope.related.regionId, 'errand', 'errand:one'),
    two: f.authority.add(f.scope.related.regionId, 'errand', 'errand:two'),
    forum: f.authority.add(f.scope.related.regionId, 'forum', 'forum:one'),
  };
}

/** A claimed row is not necessarily a send: the real 100ms permit can expire
 * during final proofs/COMMIT. Only that explicit, pre-dispatch retry is allowed
 * here; unknown outcomes, source failures and exhausted budgets must fail. */
async function confirmDiscoveredGroups(
  f: Fixture,
  count: number,
  worker = f.groups,
) {
  const initial = (await f.rows()).rows;
  assert.equal(initial.length, count);
  const identities = (rows: typeof initial) =>
    rows.map((r) => [
      r.id,
      r.event_id,
      r.stage,
      r.destination_id,
      r.idempotency_key,
    ]);
  // The repository suppresses retryable deliveries at attempt eight. This is
  // the existing delivery budget, not an open-ended retry-until-green loop.
  for (let round = 0; round <= 8; round++) {
    const rows = (await f.rows()).rows;
    assert.deepEqual(identities(rows), identities(initial));
    const remaining = rows.filter((r) => r.status !== 'confirmed');
    if (!remaining.length) {
      assert.equal(await worker.runOne(), false);
      const receipts = await f.pool.query(
        'SELECT delivery_id,idempotency_key FROM whaleu_notifications.errand_group_receipts ORDER BY delivery_id',
      );
      assert.deepEqual(
        receipts.rows,
        rows
          .map((r) => ({
            delivery_id: r.id,
            idempotency_key: r.idempotency_key,
          }))
          .sort((a, b) => a.delivery_id.localeCompare(b.delivery_id)),
      );
      return;
    }
    assert.ok(round < 8, `Delivery budget exhausted: ${JSON.stringify(rows)}`);
    for (const row of remaining) {
      assert.ok(
        (row.status === 'pending' &&
          row.reason === null &&
          row.attempts === 0) ||
          (row.status === 'retryable' && row.reason === 'permit_expired'),
        JSON.stringify(row),
      );
      assert.ok(row.attempts < 8, JSON.stringify(row));
      assert.equal(row.lease_until, null);
    }
    // Advance only the synthetic business scheduler to persisted due times.
    // Real authorization, lease and process-local permit clocks stay intact.
    f.setTime(
      Math.max(
        f.runtime.now(),
        ...remaining.map((r) => r.next_attempt_at.getTime()),
      ),
    );
    for (let n = 0; n < remaining.length; n++)
      assert.equal(await worker.runOne(), true);
    assert.equal(await worker.runOne(), false);
  }
}

test(
  'E4 partial destination failure, durable restart, exact first ACK forum windows and private allowlist',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = destinations(f),
      p = await publish(f);
    const http = f.app.getHttpServer(),
      auth = `Bearer ${p.actor.accessToken}`;
    const profile = await request(http)
      .get('/v1/me/profile')
      .set('Authorization', auth);
    const preference = await request(http)
      .patch('/v1/me/preferences')
      .set('Authorization', auth)
      .send({
        expectedRevision: profile.body.revision,
        preferences: { showErrandGroupNotice: false },
      });
    assert.equal(preference.status, 200, JSON.stringify(preference.body));
    const browse = await request(http)
      .put('/v1/me/campus')
      .set('Authorization', auth)
      .send({
        expectedRevision: preference.body.revision,
        campusId: f.scope.foreign.campusId,
      });
    assert.equal(browse.status, 200, JSON.stringify(browse.body));
    f.sender.actions.set(d.two.id, ['not_accepted']);
    await f.groups.discover();
    const concurrentClaims = await Promise.all([
      f.groups.runOne(),
      f.restart().runOne(),
      f.restart().runOne(),
    ]);
    assert.equal(
      concurrentClaims.filter(Boolean).length,
      2,
      'exactly two distinct rows are claimed; worker arrival order is immaterial',
    );
    let rows = (await f.rows()).rows;
    assert.deepEqual(
      rows.map((r) => r.status),
      ['confirmed', 'retryable'],
    );
    const ack = (
      await f.pool.query(
        'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
      )
    ).rows[0].first_confirmed_at.getTime();
    f.authority.groups.set(d.one.id, { ...d.one, revision: 'r2' });
    f.setTime(p.publishedAt + 1000);
    const restartedSender = new DurableSyntheticGroupSender(
        f.directory,
        f.runtime.now,
      ),
      restarted = f.restart({ ...f.runtime, sender: restartedSender });
    await restarted.discover();
    assert.equal(await restarted.runOne(), true);
    assert.equal(await restarted.runOne(), false);
    assert.equal(restartedSender.attempts.length, 1);
    assert.equal(restartedSender.attempts[0]!.destination.id, d.two.id);
    f.setTime(ack + 900000 - 1);
    await restarted.discover();
    assert.equal(await restarted.runOne(), false);
    f.setTime(ack + 900000);
    await restarted.discover();
    assert.equal(await restarted.runOne(), true);
    rows = (await f.rows()).rows;
    assert.deepEqual(
      rows.map((r) => r.status),
      ['confirmed', 'confirmed', 'confirmed'],
    );
    const payloads = [...f.sender.attempts, ...restartedSender.attempts].map(
      (p) => p.payload,
    );
    assert.equal(payloads[0]!.reward, '12.35');
    assert.equal(payloads[0]!.sourceLabel?.startsWith('跨地区：'), true);
    assert.equal(payloads.at(-1)!.expectedTime, undefined);
    const serialized = JSON.stringify(payloads);
    for (const secret of [
      'SECRET',
      'Never transmit',
      '12345678901',
      'publicText',
      'privateText',
      'publisherContacts',
      'publicMedia',
      'privateMedia',
    ])
      assert.equal(serialized.includes(secret), false, secret);
    const reader = await f.actor();
    const native = payloads[0]!.locator;
    assert.equal(native, `pages/errand-detail/errand-detail?orderId=${p.id}`);
    const detail = await request(f.app.getHttpServer())
      .get(`/v1/errands/${p.id}`)
      .set('Authorization', `Bearer ${reader.accessToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.privateText, undefined);
    assert.equal(detail.body.oppositeContact, undefined);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
        )
      ).rowCount,
      3,
    );
  },
);

test(
  'ACK loss and lost receipt transaction remain unknown; same-key reconciliation does not resend',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(f.scope.related.regionId, 'errand', 'ack:one'),
      p = await publish(f);
    f.sender.actions.set(d.id, ['lose_ack']);
    await f.groups.discover();
    await f.groups.runOne();
    assert.equal((await f.rows()).rows[0].status, 'unknown');
    assert.equal(
      (
        await f.pool.query(
          'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
        )
      ).rows[0].first_confirmed_at,
      null,
    );
    // Reconcile a proven earlier ACK even after 16 minutes, using its original time.
    f.setTime(p.publishedAt + 960001);
    const nextSender = new DurableSyntheticGroupSender(
        f.directory,
        f.runtime.now,
      ),
      next = f.restart({ ...f.runtime, sender: nextSender });
    assert.equal(await next.runOne(), true);
    assert.equal(nextSender.attempts.length, 0);
    assert.equal(nextSender.reconciled.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
    assert.equal(
      (
        await f.pool.query(
          'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
        )
      ).rows[0].first_confirmed_at.getTime(),
      p.publishedAt,
    );

    const p2 = await publish(f);
    await f.groups.discover();
    const original = f.records.confirmed.bind(f.records);
    let lost = false;
    f.records.confirmed = async (...args) => {
      await original(...args);
      if (!lost) {
        lost = true;
        throw Error('Synthetic receipt transaction lost before commit');
      }
    };
    await f.groups.runOne();
    f.records.confirmed = original;
    assert.equal(
      (await f.rows()).rows.find((r) => r.status === 'unknown')?.status,
      'unknown',
    );
    f.setTime(p2.publishedAt + 1000);
    await f.restart().runOne();
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
    assert.equal(
      f.sender.attempts.length,
      2,
      'no resend after accepted provider receipt',
    );
  },
);

test(
  'unknown is never blindly resent, even beyond window; known not accepted must reauthorize',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(
        f.scope.related.regionId,
        'errand',
        'unknown:one',
      ),
      p = await publish(f);
    f.sender.actions.set(d.id, ['unknown']);
    await f.groups.discover();
    await f.groups.runOne();
    f.setTime(p.publishedAt + 1000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'unknown');
    f.sender.unresolved = false;
    const reconcile = f.sender.reconcile.bind(f.sender);
    f.sender.reconcile = async (_key, destinationId) => ({
      status: 'not_accepted',
      key: '0'.repeat(64),
      destinationId,
    });
    f.setTime(p.publishedAt + 4000);
    await f.restart().runOne();
    assert.equal(
      (await f.rows()).rows[0].status,
      'unknown',
      'nonacceptance for another key cannot authorize resend',
    );
    f.sender.reconcile = reconcile;
    f.setTime(p.publishedAt + 12000);
    await f.restart().runOne();
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    await revokeErrandReview(f.pool, p.approval.decisionId);
    f.setTime(p.publishedAt + 24000);
    await f.restart().runOne();
    assert.equal((await f.rows()).rows[0].status, 'suppressed');
    assert.equal(f.sender.attempts.length, 1);
  },
);

test(
  'readiness waits cannot preserve stale source, Review, Safety, region or destination authority',
  { timeout: 180000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(f.scope.related.regionId, 'errand', 'gate:one');
    const mutations: [
      string,
      (p: Awaited<ReturnType<typeof publish>>) => Promise<void>,
    ][] = [
      [
        'Review revoke',
        async (p) => {
          await revokeErrandReview(f.pool, p.approval.decisionId);
        },
      ],
      [
        'Safety feature',
        async (p) => {
          await seedErrandFeature(f.pool, p.actor.accountId, [
            syntheticErrandRestriction('publish'),
          ]);
        },
      ],
      [
        'phone proof',
        async (p) => {
          await f.certify(p.actor.accountId, { phone: 'unverified' });
        },
      ],
      [
        'account lifecycle',
        async (p) => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [p.actor.accountId],
            ),
          );
        },
      ],
      [
        'destination revoke',
        async () => {
          f.authority.groups.delete(d.id);
        },
      ],
      [
        'destination revision',
        async () => {
          f.authority.groups.set(d.id, { ...d, revision: 'changed' });
        },
      ],
      [
        'region inactive',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [f.scope.related.regionId],
            ),
          );
        },
      ],
      [
        'cancel',
        async (p) => {
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/cancel`)
            .set('Authorization', `Bearer ${p.actor.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
      [
        'delete',
        async (p) => {
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/delete`)
            .set('Authorization', `Bearer ${p.actor.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
      [
        'accept',
        async (p) => {
          const a = await f.actor();
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/accept`)
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
              contacts: { wechat: 'synthetic_runner', phone: '' },
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      f.authority.groups.set(d.id, d);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
          [f.scope.related.regionId],
        ),
      );
      const p = await publish(f);
      await f.groups.discover();
      f.sender.beforeReady = () => mutate(p);
      assert.equal(await f.groups.runOne(), true, label);
      f.sender.beforeReady = null;
      const rows = (await f.rows()).rows;
      assert.equal(
        rows.find((r) => r.event_id === rows.at(-1)?.event_id)?.status !==
          'confirmed',
        true,
        label,
      );
      assert.equal(f.sender.attempts.length, 0, label);
    }
  },
);

test(
  'default AppModule has no enrollment, no worker egress, and old events cannot be adopted',
  { timeout: 120000 },
  async (t) => {
    const f = await errandMediaFixture([
      { sha256: '0'.repeat(64), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const groups = f.app.get(ErrandGroupWorker);
    assert.deepEqual(await groups.inspect(), {
      enabled: false,
      deliveries: [],
    });
    assert.equal(await groups.discover(), 0);
    assert.equal(await groups.runOne(), false);
    const actor = await f.actor(),
      draft = await createErrandMediaDraft(f, actor),
      p = await publishErrandImages(f, actor, draft, []);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_notifications.errand_group_publications(event_id,order_id,target_region_id,published_at) SELECT t.id,o.id,o.target_region_id,o.created_at FROM whaleu_errands.transitions t JOIN whaleu_errands.orders o ON o.id=t.order_id WHERE o.id=$1 AND t.operation='publish'`,
          [p.id],
        );
      }),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'text-only group payload still applies E3 whole private image-set gate after readiness',
  { timeout: 120000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#354f80' },
    })
      .png()
      .toBuffer();
    const f = await errandGroupFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    f.authority.add(f.scope.home.regionId, 'errand', 'media:one');
    const a = await f.actor(),
      draft = await createErrandMediaDraft(f, a),
      image = await readyErrandImage(f, a, draft, 'private0', bytes),
      p = await publishErrandImages(f, a, draft, [image.fact]);
    f.setTime(
      (
        await f.pool.query(
          'SELECT created_at FROM whaleu_errands.orders WHERE id=$1',
          [p.id],
        )
      ).rows[0].created_at.getTime(),
    );
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,h.revision+1,'revoked',a.manifest_digest,a.policy_revision,'errand-group-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
          [id, image.fact.assetId],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1',
          [image.fact.assetId, id],
        );
      });
    };
    await f.groups.runOne();
    assert.equal(f.sender.attempts.length, 0);
    assert.equal((await f.rows()).rows[0].status, 'suppressed');
  },
);

test(
  'lease fencing survives restart while old readiness is paused; old prepared send cannot escape',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'lease:one');
    const p = await publish(f);
    await f.groups.discover();
    let arrived!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => (arrived = r)),
      resume = new Promise<void>((r) => (release = r));
    f.sender.beforeReady = async () => {
      arrived();
      await resume;
    };
    const old = f.groups.runOne();
    await waiting;
    await f.pool.query(
      "UPDATE whaleu_notifications.errand_group_deliveries SET lease_until=clock_timestamp()-interval '1 second'",
    );
    assert.equal(
      await f.restart().runOne(),
      true,
      'restart reconciles the abandoned durable unknown key',
    );
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    release();
    await old;
    f.sender.beforeReady = null;
    assert.equal(
      f.sender.attempts.length,
      0,
      'lost fence prevents stale prepared egress',
    );
    f.setTime(p.publishedAt + 4000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
    const attempts = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY fence',
      )
    ).rows;
    assert.deepEqual(
      attempts.map((r) => r.operation),
      ['send', 'reconcile', 'send'],
    );
    assert.equal(new Set(attempts.map((r) => r.idempotency_key)).size, 1);
  },
);

test(
  'optional shortlink failures use native locator; readiness uses real authorization deadlines and closed permits',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'link:one');
    const p = await publish(f);
    await f.groups.discover();
    const shortlinkWorker = f.restart({
      ...f.runtime,
      shortlinks: {
        resolve: async (nativeLocator) => ({
          nativeLocator,
          locator: 'https://unverified.invalid/?token=secret',
        }),
      },
    });
    await shortlinkWorker.runOne();
    assert.equal(
      f.sender.attempts[0]!.payload.locator,
      `pages/errand-detail/errand-detail?orderId=${p.id}`,
    );
    const p2 = await publish(f);
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await seedErrandFeature(f.pool, p2.actor.accountId, [], {
        validUntil: new Date(Date.now() + 100),
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await f.groups.runOne();
    f.sender.beforeReady = null;
    assert.equal(
      f.sender.attempts.length,
      1,
      'real PG expiry cannot be extended by synthetic business clock',
    );
    const p3 = await publish(f);
    await f.groups.discover();
    f.sender.preparedExpiresAt = performance.now() - 1;
    await f.groups.runOne();
    f.sender.preparedExpiresAt = null;
    const row = (await f.rows()).rows.find(
      (r) => r.reason === 'permit_expired',
    );
    assert.ok(row);
    assert.equal(row.status, 'retryable');
    assert.equal(f.sender.attempts.length, 1);
    f.setTime(p3.publishedAt + 1000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 2);
  },
);

test(
  'missing destination coverage, inspection and outside-window claims never emit or backfill',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const p = await publish(f);
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), false);
    f.authority.add(f.scope.related.regionId, 'errand', 'window:one');
    f.authority.unavailable = true;
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), false);
    f.authority.unavailable = false;
    await f.groups.discover();
    const before = JSON.stringify((await f.rows()).rows);
    await f.groups.inspect();
    assert.equal(
      JSON.stringify((await f.rows()).rows),
      before,
      'inspection does not claim, write or send',
    );
    f.setTime(p.publishedAt + 960001);
    assert.equal(await f.groups.runOne(), true);
    assert.equal((await f.rows()).rows[0].status, 'expired');
    assert.equal(f.sender.attempts.length, 0);
    const p2 = await publish(f);
    await f.groups.discover();
    f.setTime(p2.publishedAt + 960000);
    await f.groups.runOne();
    assert.equal(
      f.sender.attempts.length,
      1,
      'inclusive sixteen minute boundary',
    );
    f.authority.add(f.scope.related.regionId, 'forum', 'window:forum');
    f.setTime(p2.publishedAt + 960000 + 1800000);
    await f.groups.discover();
    await f.groups.runOne();
    assert.equal(
      f.sender.attempts.length,
      2,
      'inclusive thirty minutes after first ACK',
    );
  },
);

test(
  'first durable ACK CAS freezes its acceptance time across inverse ACK order and late reconciliation',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = destinations(f),
      p = await publish(f);
    await f.groups.discover();
    // Force the original acceptance with lost ACK to happen before the second one.
    await f.pool.query(
      'UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at=$2 WHERE destination_id=$1',
      [d.two.id, new Date(p.publishedAt + 60000)],
    );
    f.sender.actions.set(d.one.id, ['lose_ack']);
    await f.groups.runOne();
    await f.pool.query(
      'UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at=$2 WHERE destination_id=$1',
      [d.one.id, new Date(p.publishedAt + 120000)],
    );
    f.setTime(p.publishedAt + 60000);
    await f.groups.runOne();
    const frozen = (
      await f.pool.query(
        'SELECT first_confirmed_at,first_confirmed_delivery_id FROM whaleu_notifications.errand_group_publications',
      )
    ).rows[0];
    assert.equal(frozen.first_confirmed_at.getTime(), p.publishedAt + 60000);
    const first = (await f.rows()).rows.find(
      (r) => r.id === frozen.first_confirmed_delivery_id,
    );
    assert.equal(first.destination_id, d.two.id);
    f.setTime(p.publishedAt + 120000);
    await f.restart().runOne();
    const after = (
      await f.pool.query(
        'SELECT first_confirmed_at,first_confirmed_delivery_id FROM whaleu_notifications.errand_group_publications',
      )
    ).rows[0];
    assert.deepEqual(
      after,
      frozen,
      'earlier external ACK does not move an already durable forum anchor',
    );
    const times = (
      await f.pool.query(
        'SELECT confirmed_at FROM whaleu_notifications.errand_group_receipts ORDER BY confirmed_at',
      )
    ).rows.map((r) => r.confirmed_at.getTime());
    assert.deepEqual(times, [p.publishedAt, p.publishedAt + 60000]);
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_notifications.errand_group_publications SET first_confirmed_at=$1',
        [new Date(p.publishedAt)],
      ),
    );
    f.setTime(p.publishedAt + 900000);
    await f.groups.discover();
    assert.equal(
      await f.groups.runOne(),
      false,
      'mathematical earliest ACK must not trigger forum early',
    );
    f.setTime(p.publishedAt + 960000);
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), true);
  },
);

test(
  'late first proven ACK records expired forum without backfill; future and impossible ACK timestamps stay unknown',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const one = f.authority.add(f.scope.related.regionId, 'errand', 'late:one');
    f.authority.add(f.scope.related.regionId, 'forum', 'late:forum');
    const p = await publish(f);
    await f.groups.discover();
    f.sender.actions.set(one.id, ['lose_ack']);
    await f.groups.runOne();
    f.setTime(p.publishedAt + 31 * 60000);
    await f.restart().runOne();
    await f.groups.discover();
    const expired = (await f.rows()).rows.find((r) => r.stage === 'forum');
    assert.equal(expired.status, 'expired');
    assert.equal(await f.groups.runOne(), false);
    assert.equal(f.sender.attempts.length, 1);
    const originalPrepare = f.sender.prepare.bind(f.sender);
    for (const offset of [
      1,
      -1,
      Number.NaN,
      'wrong-key',
      'wrong-destination',
    ] as const) {
      const next = await publish(f);
      await f.groups.discover();
      f.sender.prepare = async (key, destination) => {
        const prepared = await originalPrepare(key, destination);
        return {
          ...prepared,
          dispatch: (permit) => {
            const ack = prepared.dispatch(permit);
            return ack.status === 'confirmed'
              ? {
                  ...ack,
                  confirmedAt:
                    next.publishedAt +
                    (typeof offset === 'number' ? offset : 0),
                  key: offset === 'wrong-key' ? '0'.repeat(64) : ack.key,
                  destinationId:
                    offset === 'wrong-destination'
                      ? 'synthetic:wrong'
                      : ack.destinationId,
                }
              : ack;
          },
        };
      };
      await f.groups.runOne();
      const enrolled = (
        await f.pool.query(
          'SELECT * FROM whaleu_notifications.errand_group_publications WHERE order_id=$1',
          [next.id],
        )
      ).rows[0];
      assert.equal(enrolled.first_confirmed_at, null);
      assert.equal(
        (
          await f.pool.query(
            'SELECT status FROM whaleu_notifications.errand_group_deliveries WHERE event_id=$1',
            [enrolled.event_id],
          )
        ).rows[0].status,
        'unknown',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_notifications.errand_group_receipts r JOIN whaleu_notifications.errand_group_deliveries d ON d.id=r.delivery_id WHERE d.event_id=$1',
            [enrolled.event_id],
          )
        ).rowCount,
        0,
      );
      // Keep unresolved cases outside later test scheduling; no blind send occurs.
      await f.pool.query(
        "UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at='infinity' WHERE event_id=$1",
        [enrolled.event_id],
      );
    }
    f.sender.prepare = originalPrepare;
  },
);

test(
  'actual Review and Safety deadlines are checked after final waits before any synthetic dispatch',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'deadline:one');
    const source = f.source.current.bind(f.source);
    const until = new Date(Date.now() + 2500);
    await publish(f, {}, { visibilityUntil: until });
    await f.groups.discover();
    f.source.current = async (...args) => {
      const payload = await source(...args);
      await args[2].query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',
        [until],
      );
      return payload;
    };
    await f.groups.runOne();
    f.source.current = source;
    assert.equal(
      f.sender.attempts.length,
      0,
      'ordinary transaction callback result is not itself permission to send',
    );
    const p = await publish(f);
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await seedErrandFeature(f.pool, p.actor.accountId, [], {
        validUntil: new Date(Date.now() + 500),
      });
    };
    f.source.current = async (...args) => {
      const payload = await source(...args);
      await args[2].query('SELECT pg_sleep(0.6)');
      return payload;
    };
    await f.groups.runOne();
    f.source.current = source;
    f.sender.beforeReady = null;
    assert.equal(f.sender.attempts.length, 0);
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'suppressed'),
      true,
    );
  },
);

test(
  'publication replay and rollback cannot duplicate or orphan group enrollment',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const p = await publish(f);
    const replay = await request(f.app.getHttpServer())
      .post('/v1/errands')
      .set('Authorization', `Bearer ${p.actor.accessToken}`)
      .send(p.body);
    assert.equal(replay.body.orderId, p.id);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      1,
    );
    const enrollment = f.app.get(ErrandGroupEnrollment),
      original = enrollment.record.bind(enrollment);
    enrollment.record = async (...args) => {
      await original(...args);
      throw Error('Synthetic failure after enrollment');
    };
    await assert.rejects(publish(f));
    enrollment.record = original;
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_errands.orders')).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_errands.transitions WHERE operation='publish'",
        )
      ).rowCount,
      1,
    );
  },
);

test(
  'slow final proof expires process-local permit and bounded preparation cannot emit after timeout',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'bounded:one');
    const p = await publish(f);
    await f.groups.discover();
    const original = f.source.current.bind(f.source);
    const proof: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        await new Promise((r) => setTimeout(r, 150));
      },
    };
    f.source.current = async (...args) => {
      const payload = await original(...args);
      enableRequiredTransactionProof(args[2], proof);
      registerRequiredTransactionFact(
        args[2],
        proof,
        'slow-final-proof',
        'slow-final-proof',
      );
      return payload;
    };
    await f.groups.runOne();
    f.source.current = original;
    assert.equal((await f.rows()).rows[0].reason, 'permit_expired');
    assert.equal(f.sender.attempts.length, 0);
    f.setTime(p.publishedAt + 1000);
    let release!: () => void;
    f.sender.beforeReady = () => new Promise<void>((r) => (release = r));
    await f.groups.runOne();
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    assert.equal(f.sender.attempts.length, 0);
    release();
    f.sender.beforeReady = null;
    f.setTime(p.publishedAt + 4000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
  },
);

test(
  'discovery commits bounded per-publication proof budgets: nine regions × sixteen destinations and one unknown scope',
  { timeout: 180000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const extra = Array.from({ length: 7 }, () => randomUUID());
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const id of extra)
        await tx.query(
          'INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,$2,true)',
          [id, 'Synthetic delivery region ' + id.slice(0, 8)],
        );
    });
    const topology = {
      ...f.scope.topology,
      regions: [
        ...f.scope.topology.regions,
        ...extra.map((regionId) => ({
          regionId,
          institutionId: f.scope.institutionId,
          groupId: f.scope.topology.regions[0]!.groupId,
          coverage: 'complete' as const,
          isActive: true,
        })),
      ],
    };
    f.scope.topologySnapshotId = await appendTopologyRevision(f.pool, topology);
    f.scope.topology = topology;
    const regions = [
        f.scope.home.regionId,
        f.scope.related.regionId,
        f.scope.foreign.regionId,
        ...extra,
      ],
      unknown = regions[0]!;
    assert.equal(regions.length, 10);
    for (const [r, region] of regions.entries()) {
      for (let n = 0; n < 16; n++)
        f.authority.add(region, 'errand', `batch:${r}:${n}`);
      await publish(f, { targetRegionId: region });
    }
    const resolve = f.authority.destinations.bind(f.authority);
    f.authority.destinations = async (...args) => {
      if (args[0] === unknown)
        throw Error('Synthetic authority coverage unknown');
      return resolve(...args);
    };
    assert.equal(
      await f.groups.discover(),
      144,
      'one unknown scope cannot roll back nine complete sources',
    );
    assert.equal((await f.rows()).rows.length, 144);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications WHERE last_scanned_at IS NOT NULL',
        )
      ).rowCount,
      10,
    );
    // Deterministically reproduce the old false assumption that 144 claims
    // imply 144 sends. Advance the monotonic clock only in the last registered
    // final proof, after source checks but before COMMIT/dispatch.
    const monotonicNow = performance.now.bind(performance);
    let elapsed = 0;
    const clock = t.mock.method(
      performance,
      'now',
      () => monotonicNow() + elapsed,
    );
    const original = f.source.current.bind(f.source);
    const expirePermit: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        elapsed += 101;
      },
    };
    const source = t.mock.method(
      f.source,
      'current',
      async (...args: Parameters<typeof original>) => {
        const payload = await original(...args);
        enableRequiredTransactionProof(args[2], expirePermit);
        registerRequiredTransactionFact(
          args[2],
          expirePermit,
          'expire',
          'expire',
        );
        return payload;
      },
    );
    for (let n = 0; n < 2; n++) assert.equal(await f.groups.runOne(), true);
    source.mock.restore();
    // Retain the monotonic offset until this test ends; never rewind a permit.
    t.after(() => clock.mock.restore());
    const expired = (await f.rows()).rows.filter((r) => r.status !== 'pending');
    assert.equal(expired.length, 2);
    assert.equal(
      f.sender.attempts.length,
      0,
      'expired permits cannot dispatch',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
        )
      ).rowCount,
      0,
    );
    for (const row of expired) {
      assert.equal(row.status, 'retryable');
      assert.equal(row.reason, 'permit_expired');
      assert.equal(row.attempts, 1);
      assert.equal(row.next_attempt_at.getTime(), f.runtime.now() + 1000);
    }
    for (let n = 2; n < 144; n++) assert.equal(await f.groups.runOne(), true);
    assert.equal(await f.groups.runOne(), false);
    // The frozen business clock cannot claim either scheduled retry yet.
    const firstPass = (await f.rows()).rows;
    assert.equal(firstPass.filter((r) => r.status === 'pending').length, 0);
    assert.equal(
      f.sender.attempts.length,
      firstPass.filter((r) => r.status === 'confirmed').length,
    );
    for (const row of expired) {
      const current = firstPass.find((r) => r.id === row.id)!;
      assert.equal(current.status, 'retryable');
      assert.equal(current.attempts, 1);
    }
    await confirmDiscoveredGroups(f, 144);
    assert.equal(f.sender.attempts.length, 144);
    assert.equal(new Set(f.sender.attempts.map((p) => p.key)).size, 144);
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.id)).size,
      144,
    );
    assert.deepEqual(
      f.sender.attempts.map((p) => p.destination.id).sort(),
      [...f.authority.groups.values()]
        .filter((d) => d.targetRegionId !== unknown)
        .map((d) => d.id)
        .sort(),
    );
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.targetRegionId)).size,
      9,
    );
    assert.equal(
      f.sender.attempts.some((p) => p.destination.targetRegionId === unknown),
      false,
    );
    f.authority.destinations = resolve;
    await f.groups.discover();
    assert.equal(
      (await f.rows()).rows.length,
      160,
      'recovered exact scope is neither truncated nor duplicated',
    );
    await confirmDiscoveredGroups(f, 160, f.restart());
    assert.equal(f.sender.attempts.length, 160);
    assert.equal(new Set(f.sender.attempts.map((p) => p.key)).size, 160);
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.id)).size,
      160,
    );
    assert.deepEqual(
      f.sender.attempts.map((p) => p.destination.id).sort(),
      [...f.authority.groups.keys()].sort(),
    );
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
  },
);
