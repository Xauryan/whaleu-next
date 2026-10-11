import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import request from 'supertest';
import sharp from 'sharp';
import {
  studentEvidenceFixture,
  readyVerificationEvidenceImage,
  verificationEvidenceMediaOk as ok,
} from '../support/student-evidence-fixture.js';
import type { StudentEvidenceFixture } from '../support/student-evidence-fixture.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  verificationEvidenceDescriptorSchema,
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
} from '../../src/media/contracts-verification-evidence.js';
import { VerificationEvidenceMediaService } from '../../src/verification/evidence/facade.js';
import { MediaDeliveryBudgetPool } from '../../src/media/delivery-budget.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
const own = '/v1/me/student-verification',
  prefix = '/v3/media/verification-evidence';
const picture = () =>
  sharp({
    create: { width: 60, height: 48, channels: 3, background: '#7291a2' },
  })
    .png()
    .toBuffer();
const auth = (actor: SessionCredentials) => `Bearer ${actor.accessToken}`;
async function grant(
  f: StudentEvidenceFixture,
  actor: SessionCredentials,
  role = 'school_admin',
  region: string | null = f.scope.home.regionId,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-evidence-review')",
      [id, actor.accountId, role, region],
    ),
  );
  return id;
}
async function submit(
  f: StudentEvidenceFixture,
  actor: SessionCredentials,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    reserved = await request(http)
      .post(`${own}/applications`)
      .set('Authorization', auth(actor))
      .send({ clientRequestId: randomUUID(), campusId: f.scope.home.campusId });
  ok(reserved);
  const media = await readyVerificationEvidenceImage(
    f,
    actor,
    reserved.body.applicationId,
    reserved.body.revision,
    bytes,
  );
  if (media.status.status !== 'ready_unbound')
    assert.fail('Expected exact current processed evidence');
  const sent = await request(http)
    .post(`${own}/applications/${reserved.body.applicationId}/submit`)
    .set('Authorization', auth(actor))
    .send({
      clientRequestId: randomUUID(),
      expectedRevision: reserved.body.revision,
      evidence: {
        protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
        kind: 'verification-evidence-upload',
        assetId: media.status.assetId,
      },
    });
  ok(sent);
  const descriptorResponse = await request(http)
    .get(`${prefix}/applications/${reserved.body.applicationId}/descriptor`)
    .set('Authorization', auth(actor))
    .query({ revision: reserved.body.revision });
  ok(descriptorResponse);
  const descriptor = verificationEvidenceDescriptorSchema.parse(
    descriptorResponse.body,
  );
  return {
    id: reserved.body.applicationId as string,
    revision: sent.body.revision as number,
    descriptor,
    media,
    path: `${prefix}/applications/${descriptor.applicationId}/bindings/${descriptor.bindingId}/display-v1`,
  };
}
/** The real storage adapter pauses before returning its exact stream. All
 * mutations commit through real PostgreSQL owner tables while no source byte
 * has been read. No owner, authorization, ledger or delivery implementation is mocked. */
async function afterStorageOpen(
  f: StudentEvidenceFixture,
  actor: SessionCredentials,
  path: string,
  query: Record<string, string | number>,
  mutate: () => Promise<unknown>,
) {
  const original = f.storage.openExact.bind(f.storage);
  let releasedBytes = 0,
    source: Readable | undefined,
    quiet = Promise.resolve(),
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.storage.openExact = async (...args) => {
    const result = await original(...args);
    source = result.stream;
    source.pause();
    quiet = finished(source).catch(() => undefined);
    source.on('data', (chunk: Buffer) => {
      releasedBytes += chunk.length;
    });
    entered();
    await gate;
    return result;
  };
  const delivery = request(f.app.getHttpServer())
    .get(path)
    .set('Authorization', auth(actor))
    .query(query)
    .then((value) => value);
  try {
    await Promise.race([
      reached,
      delivery.then(() =>
        assert.fail('Delivery must reach exact storage gate'),
      ),
    ]);
    assert.equal(releasedBytes, 0);
    await mutate();
  } finally {
    release();
    f.storage.openExact = original;
  }
  const response = await delivery;
  await quiet;
  assert.notEqual(response.status, 200);
  assert.equal(releasedBytes, 0);
  assert.equal(source?.destroyed, true);
  assert.ok(!Buffer.isBuffer(response.body));
  assert.equal(response.headers['cache-control'], 'private, no-store');
  return response;
}
test(
  'private evidence real owner/reviewer bytes and post-open authority races emit zero unauthorized bytes',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await studentEvidenceFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const owner = await f.actor(),
      reviewer = await f.actor(),
      foreign = await f.actor(),
      developer = await f.actor();
    let reviewerGrant = await grant(f, reviewer);
    await grant(f, foreign, 'school_admin', f.scope.foreign.regionId);
    await grant(f, developer, 'developer', null);
    const app = await submit(f, owner, bytes),
      http = f.app.getHttpServer(),
      self = { revision: 1 },
      management = { revision: 1, reviewRegionId: f.scope.home.regionId };
    await t.test(
      'only applicant and genuine scoped reviewer receive inline re-encoded private no-store bytes',
      async () => {
        for (const [actor, query] of [
          [owner, self],
          [reviewer, management],
        ] as const) {
          const result = await request(http)
            .get(app.path)
            .set('Authorization', auth(actor))
            .query(query);
          ok(result);
          assert.ok(Buffer.isBuffer(result.body));
          assert.equal(result.headers['cache-control'], 'private, no-store');
          assert.equal(result.headers['vary'], 'Authorization');
          assert.equal(result.headers['content-disposition'], 'inline');
          assert.equal(result.headers['accept-ranges'], 'none');
          assert.equal(result.headers['content-range'], undefined);
          assert.equal(result.headers['location'], undefined);
          assert.equal(
            Number(result.headers['content-length']),
            result.body.length,
          );
          const info = await sharp(result.body).metadata();
          assert.equal(info.width, 60);
          assert.equal(info.height, 48);
          assert.equal(info.exif, undefined);
        }
        for (const [actor, query] of [
          [foreign, management],
          [developer, management],
          [reviewer, self],
          [reviewer, { revision: 1, reviewRegionId: f.scope.foreign.regionId }],
        ] as const)
          assert.notEqual(
            (
              await request(http)
                .get(app.path)
                .set('Authorization', auth(actor))
                .query(query)
            ).status,
            200,
          );
        await request(http).get(app.path).query(self).expect(401);
        assert.ok(
          !JSON.stringify(app.descriptor).match(
            /imageUrl|bucket|locator|https?:|signedUrl|object|assetId/,
          ),
        );
        for (const query of [
          { revision: 2 },
          { revision: 1, imageUrl: 'https://example.invalid' },
        ])
          assert.notEqual(
            (
              await request(http)
                .get(app.path)
                .set('Authorization', auth(owner))
                .query(query)
            ).status,
            200,
          );
      },
    );
    await t.test(
      'Range is rejected before storage and invalid material DTOs cannot become bindings',
      async () => {
        const original = f.storage.openExact.bind(f.storage);
        let opens = 0;
        f.storage.openExact = async (...args) => {
          opens++;
          return original(...args);
        };
        try {
          assert.notEqual(
            (
              await request(http)
                .get(app.path)
                .set('Authorization', auth(owner))
                .set('Range', 'bytes=0-1')
                .query(self)
            ).status,
            200,
          );
          assert.equal(opens, 0);
        } finally {
          f.storage.openExact = original;
        }
        await request(http)
          .post(`${own}/applications/${app.id}/submit`)
          .set('Authorization', auth(owner))
          .send({
            clientRequestId: randomUUID(),
            expectedRevision: app.revision,
            evidence: { imageUrl: 'https://example.invalid/material' },
          })
          .expect(400);
      },
    );
    await t.test(
      'reviewer grant revoked while exact storage is opening emits zero bytes',
      async () => {
        await afterStorageOpen(f, reviewer, app.path, management, () =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [reviewerGrant],
            ),
          ),
        );
        reviewerGrant = await grant(f, reviewer);
      },
    );
    await t.test(
      'reviewer access token expires during storage-open pause and emits zero bytes',
      async () => {
        await afterStorageOpen(f, reviewer, app.path, management, async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE session_id=$1",
              [reviewer.sessionId],
            ),
          );
          await sleep(150);
        });
      },
    );
    await t.test(
      'applicant account blocked during storage-open pause emits zero bytes',
      async () => {
        await afterStorageOpen(f, owner, app.path, self, () =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [owner.accountId],
            ),
          ),
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
            [owner.accountId],
          ),
        );
      },
    );
    const safety = async (state: 'allow' | 'revoked') =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        const event = randomUUID();
        const head = (
          await tx.query<{ revision: string }>(
            'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
            [
              app.media.status.status === 'ready_unbound'
                ? app.media.status.assetId
                : null,
            ],
          )
        ).rows[0]!;
        const revision = Number(head.revision) + 1;
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,$3,$4,a.manifest_digest,a.policy_revision,'synthetic-student-evidence',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a WHERE a.id=$2`,
          [
            event,
            app.media.status.status === 'ready_unbound'
              ? app.media.status.assetId
              : null,
            revision,
            state,
          ],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
          [
            app.media.status.status === 'ready_unbound'
              ? app.media.status.assetId
              : null,
            revision,
            event,
          ],
        );
      });
    await t.test(
      'current material Safety revocation during storage-open pause emits zero bytes',
      async () => {
        await afterStorageOpen(f, owner, app.path, self, () =>
          safety('revoked'),
        );
        await safety('allow');
      },
    );
    await t.test(
      'campus deactivation during storage-open pause emits zero bytes',
      async () => {
        await afterStorageOpen(f, owner, app.path, self, () =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [f.scope.home.campusId],
            ),
          ),
        );
      },
    );
  },
);

test(
  'immutable evidence TTL does not extend with new configuration; expiry closes pending and enrolls quiet cleanup',
  { timeout: 180000 },
  async (t) => {
    const bytes = await picture(),
      retention = {
        policyRef: 'synthetic-short-evidence-v1',
        evidenceTtlSeconds: 20,
        cleanupEnabled: true,
      },
      f = await studentEvidenceFixture(
        [{ sha256: sha256(bytes), verdict: 'allow' }],
        retention,
      );
    t.after(() => f.close());
    const owner = await f.actor(),
      app = await submit(f, owner, bytes),
      http = f.app.getHttpServer();
    const original = (
      await f.pool.query<{
        expires_at: string;
        scope_expires_at: string;
        policy: string;
        exact: boolean;
      }>(
        `SELECT e.evidence_expires_at::text expires_at,s.evidence_expires_at::text scope_expires_at,e.evidence_policy_ref policy,(s.evidence_expires_at=e.evidence_expires_at AND e.evidence_expires_at=a.evidence_expires_at) exact FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_verification.student_applications a ON a.id=e.application_id JOIN whaleu_media.assets m ON m.id=e.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=m.resource_id WHERE e.application_id=$1`,
        [app.id],
      )
    ).rows[0]!;
    assert.equal(original.exact, true);
    assert.equal(original.expires_at, original.scope_expires_at);
    assert.equal(original.policy, retention.policyRef);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_media.verification_evidence_scopes SET evidence_expires_at=evidence_expires_at+interval '1 day' WHERE application_id=$1",
          [app.id],
        ),
      ),
    );
    const newConfig = new VerificationEvidenceMediaService(
      f.evidence.database,
      f.evidence.identity,
      f.evidence.access,
      {
        ...f.evidence.runtime!,
        retention: {
          policyRef: 'synthetic-future-policy-v2',
          evidenceTtlSeconds: 3600,
          cleanupEnabled: false,
        },
      },
      new MediaDeliveryBudgetPool(),
    );
    const current = await newConfig.descriptor(owner.accessToken, {
      applicationId: app.id,
      revision: 1,
      reviewRegionId: null,
    });
    assert.equal(current.bindingId, app.descriptor.bindingId);
    const remaining = (
      await f.pool.query<{ milliseconds: number }>(
        `SELECT greatest(0,ceil(extract(epoch FROM(evidence_expires_at-clock_timestamp()))*1000))::integer milliseconds FROM whaleu_media.verification_evidence_bindings WHERE application_id=$1`,
        [app.id],
      )
    ).rows[0]!.milliseconds;
    await afterStorageOpen(f, owner, app.path, { revision: 1 }, () =>
      sleep(remaining + 20),
    );
    await assert.rejects(
      newConfig.descriptor(owner.accessToken, {
        applicationId: app.id,
        revision: 1,
        reviewRegionId: null,
      }),
    );
    const expired = await request(http)
      .get(`${own}/applications/${app.id}`)
      .set('Authorization', auth(owner));
    ok(expired);
    assert.equal(expired.body.state, 'expired');
    assert.equal(expired.body.evidenceAvailable, false);
    const stored = (
      await f.pool.query<{
        expires_at: string;
        policy: string;
        detached: boolean;
        state: string;
      }>(
        `SELECT e.evidence_expires_at::text expires_at,e.evidence_policy_ref policy,b.detached_at IS NOT NULL detached,i.state FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id JOIN whaleu_media.assets a ON a.id=e.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE e.application_id=$1`,
        [app.id],
      )
    ).rows[0]!;
    assert.equal(stored.expires_at, original.expires_at);
    assert.equal(stored.policy, retention.policyRef);
    assert.equal(stored.detached, true);
    assert.equal(stored.state, 'cleanup_pending');
    const held = (
      await f.pool.query<{
        id: string;
        state: string;
        not_before: string;
        future: boolean;
      }>(
        `SELECT c.id,c.state,c.not_before::text,c.not_before>clock_timestamp() future FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id WHERE coalesce(a.intent_id,o.intent_id,d.intent_id)=$1 ORDER BY c.id`,
        [app.media.status.intentId],
      )
    ).rows;
    assert.ok(held.length >= 3);
    assert.ok(held.every((row) => row.future && row.state === 'pending'));
    const previouslyDeleted = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM whaleu_media.cleanup_obligations WHERE state='deleted'",
      )
    ).rows.map((row) => row.id);
    const cleanup = await new SyntheticMediaCleanup(f.pool, f.storage).runOne();
    assert.ok(cleanup === 'idle' || cleanup === 'deleted');
    // Whole collector idleness is not the retention guarantee: ingress-scratch is
    // independently queued at upload admission with not_before=now, and an already
    // retired native writer permits confirming that scratch's exact absence.
    const afterHeld = (
      await f.pool.query<{ id: string; state: string; not_before: string }>(
        `SELECT id,state,not_before::text FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [held.map((row) => row.id)],
      )
    ).rows;
    assert.deepEqual(
      afterHeld,
      held.map(({ id, state, not_before }) => ({ id, state, not_before })),
      'every retained original/derived/variant obligation must preserve its quiet hold unchanged',
    );
    const newlyDeleted = (
      await f.pool.query<{
        id: string;
        reason: string;
        writer_state: string;
        intent_id: string;
      }>(
        `SELECT c.id,c.reason,w.state writer_state,o.intent_id FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id LEFT JOIN whaleu_media.object_attempts o ON o.id=w.object_attempt_id WHERE c.state='deleted' AND NOT(c.id=ANY($1::uuid[]))`,
        [previouslyDeleted],
      )
    ).rows;
    assert.equal(newlyDeleted.length, cleanup === 'deleted' ? 1 : 0);
    for (const removed of newlyDeleted) {
      assert.equal(removed.reason, 'ingress-scratch');
      assert.equal(removed.writer_state, 'retired');
      assert.equal(removed.intent_id, app.media.status.intentId);
      assert.ok(!held.some((row) => row.id === removed.id));
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.verification_evidence_retirements WHERE application_id=$1',
          [app.id],
        )
      ).rowCount,
      1,
    );
    const fresh = await request(http)
      .post(`${own}/applications`)
      .set('Authorization', auth(owner))
      .send({ clientRequestId: randomUUID(), campusId: f.scope.home.campusId });
    ok(fresh);
    assert.notEqual(fresh.body.applicationId, app.id);
    assert.equal(fresh.body.state, 'draft');
    const recovered = await request(http)
      .get(`${prefix}/upload-requests/${app.media.input.clientRequestId}`)
      .set('Authorization', auth(owner));
    ok(recovered);
    assert.equal(recovered.body.status.status, 'bound_history');
    assert.equal(recovered.body.status.attachmentState, 'detached');
    const summary = await request(http)
      .get('/v1/me/verification')
      .set('Authorization', auth(owner));
    ok(summary);
    assert.equal(summary.body.affiliation.status, 'unverified');
    assert.equal(summary.body.application.status, 'none');
  },
);

test(
  'campus region remap during private storage open returns zero bytes and cannot issue an affiliation',
  { timeout: 60000 },
  async (t) => {
    const bytes = await picture(),
      f = await studentEvidenceFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const owner = await f.actor(),
      reviewer = await f.actor();
    await grant(f, reviewer);
    const app = await submit(f, owner, bytes),
      http = f.app.getHttpServer();
    await afterStorageOpen(f, owner, app.path, { revision: 1 }, () =>
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
          [f.scope.home.campusId, f.scope.foreign.regionId],
        ),
      ),
    );
    const decision = await request(http)
      .post(
        `/v1/student-verification-review/regions/${f.scope.home.regionId}/applications/${app.id}/decision`,
      )
      .set('Authorization', auth(reviewer))
      .send({
        clientRequestId: randomUUID(),
        expectedRevision: app.revision,
        decision: 'approved',
      });
    assert.notEqual(decision.status, 200);
    const state = await request(http)
      .get('/v1/me/verification')
      .set('Authorization', auth(owner));
    ok(state);
    assert.equal(state.body.affiliation.status, 'unverified');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_verification.student_decisions WHERE application_id=$1',
          [app.id],
        )
      ).rows[0].n,
      0,
    );
  },
);
