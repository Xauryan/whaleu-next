import type { RuntimeConfig } from '../../src/config/config.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import {
  studentEvidenceFixture,
  readyVerificationEvidenceImage,
  verificationEvidenceMediaOk as ok,
} from '../support/student-evidence-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { revokeAssertion } from '../../src/verification/revocation.js';
import { StudentVerificationNotices } from '../../src/verification/student/notices.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { ownerFingerprint } from '../../src/database/required-owner-proof.js';
import {
  PhoneBindingService,
  PHONE_CONSENT,
} from '../../src/verification/phone-binding.service.js';
import type { PhoneAuthorizationProof } from '../../src/verification/wechat-phone-provider.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
const root = '/v1/me/student-verification',
  review = '/v1/student-verification-review';
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
test(
  'real student applications, private evidence, scoped decisions and independent ledger writers',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#4a8a73' },
    })
      .png()
      .toBuffer();
    let phone = async (): Promise<PhoneAuthorizationProof> => ({
      appId: 'wx0000000000000000',
      authorizedAt: Date.now(),
    });
    const f = await studentEvidenceFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      undefined,
      { phoneProvider: { exchange: () => phone() } },
    );
    t.after(() => f.close());
    const http = f.app.getHttpServer(),
      owner = await f.actor(),
      admin = await f.actor(),
      other = await f.actor(),
      developer = await f.actor();
    const grant = async (
      actor: SessionCredentials,
      role = 'school_admin',
      region: string | null = f.scope.home.regionId,
      lifetimeSeconds: number | null = null,
    ) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,$3,$4,$2,'synthetic-student-test',CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 second' END)",
          [id, actor.accountId, role, region, lifetimeSeconds],
        ),
      );
      return id;
    };
    await grant(admin);
    await grant(other, 'school_admin', f.scope.foreign.regionId);
    await grant(developer, 'developer', null);
    const post = async (
      actor: SessionCredentials,
      path: string,
      body: unknown,
    ) =>
      request(http)
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body as object);
    const get = async (actor: SessionCredentials, path: string) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const summary = async (actor: SessionCredentials) => {
      const r = await get(actor, '/v1/me/verification');
      ok(r);
      return r.body;
    };
    const prepare = async (actor: SessionCredentials) => {
      const r = await post(actor, `${root}/applications`, {
        clientRequestId: randomUUID(),
        campusId: f.scope.home.campusId,
      });
      ok(r);
      const media = await readyVerificationEvidenceImage(
        f,
        actor,
        r.body.applicationId,
        r.body.revision,
        bytes,
      );
      assert.equal(media.status.status, 'ready_unbound');
      if (media.status.status !== 'ready_unbound') throw Error('media');
      return {
        receipt: r.body,
        evidence: {
          protocol: 'verification-evidence-media-v1',
          kind: 'verification-evidence-upload',
          assetId: media.status.assetId,
        },
      };
    };
    const submit = async (actor: SessionCredentials) => {
      const app = await prepare(actor),
        input = {
          clientRequestId: randomUUID(),
          expectedRevision: app.receipt.revision,
          evidence: app.evidence,
        };
      const r = await post(
        actor,
        `${root}/applications/${app.receipt.applicationId}/submit`,
        input,
      );
      ok(r);
      return { id: r.body.applicationId, revision: r.body.revision, input };
    };
    const decision = (
      actor: SessionCredentials,
      id: string,
      input: unknown,
      region = f.scope.home.regionId,
    ) =>
      post(
        actor,
        `${review}/regions/${region}/applications/${id}/decision`,
        input,
      );
    await t.test(
      'native login is unverified; pending never issues affiliation, typed payload rejects spoofing',
      async () => {
        assert.deepEqual(await summary(owner), {
          affiliation: { status: 'unverified' },
          studentNumber: { status: 'unverified' },
          phone: { status: 'unverified' },
          application: { status: 'none' },
        });
        const forged = await post(owner, `${root}/applications`, {
          clientRequestId: randomUUID(),
          campusId: f.scope.home.campusId,
          actorId: admin.accountId,
        });
        ok(forged, 400);
      },
    );
    let app = await submit(owner);
    await t.test(
      'pending exact retry and request mismatch; only current scoped reviewers read evidence',
      async () => {
        assert.equal((await summary(owner)).affiliation.status, 'unverified');
        assert.equal((await summary(owner)).application.status, 'pending');
        const retry = await post(
          owner,
          `${root}/applications/${app.id}/submit`,
          app.input,
        );
        ok(retry);
        assert.equal(retry.body.revision, app.revision);
        ok(
          await post(owner, `${root}/applications/${app.id}/submit`, {
            ...app.input,
            expectedRevision: 99,
          }),
          409,
        );
        ok(
          await get(
            other,
            `${review}/regions/${f.scope.home.regionId}/applications/${app.id}`,
          ),
          403,
        );
        ok(
          await get(
            developer,
            `${review}/regions/${f.scope.home.regionId}/applications`,
          ),
          403,
        );
        const own = await get(owner, `${root}/applications/${app.id}`);
        ok(own);
        assert.equal(own.body.evidenceRevision, 1);
        const base = `/v3/media/verification-evidence/applications/${app.id}`;
        const descriptor = await get(
          admin,
          `${base}/descriptor?revision=1&reviewRegionId=${f.scope.home.regionId}`,
        );
        ok(descriptor);
        assert.ok(
          !JSON.stringify(descriptor.body).match(
            /bucket|locator|https?:|sourceObject/,
          ),
        );
        ok(
          await get(
            other,
            `${base}/descriptor?revision=1&reviewRegionId=${f.scope.home.regionId}`,
          ),
          403,
        );
        await request(http).get(`${base}/descriptor?revision=1`).expect(401);
        const listed = await get(admin, `${root}/notices`);
        ok(listed);
        assert.equal(listed.body.items.length, 1);
        assert.equal(listed.body.items[0].kind, 'student_auth');
      },
    );
    await t.test(
      'reject requires nonempty reason, exact old decision cannot turn approved, immediate new attempt',
      async () => {
        ok(
          await decision(admin, app.id, {
            clientRequestId: randomUUID(),
            expectedRevision: app.revision,
            decision: 'rejected',
            reason: '  ',
          }),
          400,
        );
        const input = {
          clientRequestId: randomUUID(),
          expectedRevision: app.revision,
          decision: 'rejected',
          reason: '请提供可判断学校归属的材料',
        };
        ok(await decision(admin, app.id, input));
        ok(await decision(admin, app.id, input));
        ok(
          await decision(admin, app.id, {
            ...input,
            decision: 'approved',
            reason: undefined,
          }),
          409,
        );
        assert.equal((await summary(owner)).affiliation.status, 'unverified');
        assert.equal((await summary(owner)).application.status, 'rejected');
        const old = app.id;
        app = await submit(owner);
        assert.notEqual(app.id, old);
        assert.equal(
          (await get(owner, `${root}/applications/${old}`)).body.state,
          'rejected',
        );
      },
    );
    await t.test(
      'actual provider-wait phone and approval both succeed without losing independent facts',
      async () => {
        const entered = deferred<void>(),
          proof = deferred<PhoneAuthorizationProof>();
        phone = () => {
          entered.resolve();
          return proof.promise;
        };
        const service = f.app.get(PhoneBindingService),
          key = randomUUID();
        await service.reserve(owner.accessToken, key, null);
        const binding = service.authorize(
          owner.accessToken,
          key,
          'synthetic-single-use-code',
        );
        await entered.promise;
        const input = {
          clientRequestId: randomUUID(),
          expectedRevision: app.revision,
          decision: 'approved',
        };
        ok(await decision(admin, app.id, input));
        proof.resolve({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now(),
        });
        assert.equal((await binding).state, 'verified');
        assert.deepEqual(await summary(owner), {
          affiliation: { status: 'verified' },
          studentNumber: { status: 'unverified' },
          phone: { status: 'verified' },
          application: { status: 'none' },
        });
        const ledger = (
          await f.pool.query(
            'SELECT a.* FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1',
            [owner.accountId],
          )
        ).rows[0];
        assert.equal(ledger.method, 'document_review');
        assert.equal(ledger.issuer_institution_id, f.scope.institutionId);
        assert.equal(
          ledger.source_issuer_institution_id,
          f.scope.institutionId,
        );
        assert.equal(ledger.expiry_kind, 'policy_exempt');
        assert.equal(ledger.student_number, null);
        ok(
          await get(
            admin,
            `/v3/media/verification-evidence/applications/${app.id}/descriptor?revision=1&reviewRegionId=${f.scope.home.regionId}`,
          ),
          403,
        );
        ok(
          await post(owner, `${root}/applications`, {
            clientRequestId: randomUUID(),
            campusId: f.scope.home.campusId,
          }),
          409,
        );
      },
    );
    await t.test(
      'original authorized revoke primitive remains valid and approved history prevents self-service renewal',
      async () => {
        const head = (
          await f.pool.query(
            'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
            [owner.accountId],
          )
        ).rows[0];
        await inTransaction(f.pool, (tx) =>
          revokeAssertion(tx, {
            accountId: owner.accountId,
            actorAccountId: admin.accountId,
            operationId: randomUUID(),
            fact: 'affiliation',
            expectedRevision: head.revision,
            reasonCode: 'synthetic_revoke',
          }),
        );
        assert.equal((await summary(owner)).affiliation.status, 'revoked');
        assert.equal((await get(owner, root)).body.canApply, false);
        ok(
          await post(owner, `${root}/applications`, {
            clientRequestId: randomUUID(),
            campusId: f.scope.home.campusId,
          }),
          409,
        );
      },
    );
    await t.test(
      'self-review denied and two distinct review keys have only one durable winner',
      async () => {
        const applicant = await f.actor();
        await grant(applicant);
        const a = await submit(applicant);
        const command = () => ({
          clientRequestId: randomUUID(),
          expectedRevision: a.revision,
          decision: 'approved',
        });
        ok(await decision(applicant, a.id, command()), 403);
        const results = await Promise.all([
          decision(admin, a.id, command()),
          decision(admin, a.id, command()),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_verification.student_decisions WHERE application_id=$1',
              [a.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'known restricted reviewer cannot poison recipient fanout; rejection notice stays minimal',
      async () => {
        const restricted = await f.actor(),
          applicant = await f.actor();
        await grant(restricted);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
            [restricted.accountId],
          ),
        );
        const a = await submit(applicant);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_notifications.student_notices WHERE application_id=$1 AND recipient_account_id=$2',
              [a.id, restricted.accountId],
            )
          ).rows[0].n,
          0,
        );
        const input = {
          clientRequestId: randomUUID(),
          expectedRevision: a.revision,
          decision: 'rejected',
          reason: '重新提交学校材料',
        };
        ok(await decision(admin, a.id, input));
        const notices = await get(applicant, `${root}/notices`);
        ok(notices);
        assert.equal(notices.body.items[0].kind, 'auth_result');
        assert.equal('reason' in notices.body.items[0], false);
      },
    );
    await t.test(
      'review and owner withdrawal race has exactly one winner and no partial issuance',
      async () => {
        const applicant = await f.actor(),
          a = await submit(applicant);
        const results = await Promise.all([
          decision(admin, a.id, {
            clientRequestId: randomUUID(),
            expectedRevision: a.revision,
            decision: 'approved',
          }),
          post(applicant, `${root}/applications/${a.id}/withdraw`, {
            clientRequestId: randomUUID(),
            expectedRevision: a.revision,
          }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const row = (await get(applicant, `${root}/applications/${a.id}`)).body;
        assert.ok(['approved', 'withdrawn'].includes(row.state));
        assert.equal(
          (await summary(applicant)).affiliation.status,
          row.state === 'approved' ? 'verified' : 'unverified',
        );
      },
    );
    await t.test(
      'review grant expiry during final deferred work rolls back decision, affiliation, notice and receipt together',
      async () => {
        const applicant = await f.actor(),
          a = await submit(applicant),
          expiring = await f.actor();
        await grant(expiring, 'school_admin', f.scope.home.regionId, 1);
        const notices = f.app.get(StudentVerificationNotices),
          original = notices.record.bind(notices),
          key = randomUUID();
        notices.record = async (row, tx) => {
          await original(row, tx);
          if (row.id === a.id && row.state === 'approved')
            await tx.query('SELECT pg_sleep(1.2)');
        };
        try {
          const r = await decision(expiring, a.id, {
            clientRequestId: key,
            expectedRevision: a.revision,
            decision: 'approved',
          });
          ok(r, 503);
        } finally {
          notices.record = original;
        }
        assert.equal(
          (await summary(applicant)).affiliation.status,
          'unverified',
        );
        assert.equal(
          (await get(applicant, `${root}/applications/${a.id}`)).body.state,
          'pending',
        );
        for (const table of ['student_decisions', 'student_requests'])
          assert.equal(
            (
              await f.pool.query(
                `SELECT count(*)::int n FROM whaleu_verification.${table} WHERE client_request_id=$1`,
                [key],
              )
            ).rows[0].n,
            0,
          );
      },
    );
    await t.test(
      'same phone pointer mutation and a revoked claimed session still reject late provider proofs',
      async () => {
        const who = await f.actor(),
          service = f.app.get(PhoneBindingService);
        phone = async () => ({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now(),
        });
        const first = randomUUID();
        await service.reserve(who.accessToken, first, null);
        assert.equal(
          (
            await service.authorize(
              who.accessToken,
              first,
              'synthetic-first-phone',
            )
          ).state,
          'verified',
        );
        const entered = deferred<void>(),
          proof = deferred<PhoneAuthorizationProof>();
        phone = () => {
          entered.resolve();
          return proof.promise;
        };
        const next = randomUUID();
        await service.reserve(who.accessToken, next, null);
        const active = service.authorize(
          who.accessToken,
          next,
          'synthetic-next-phone',
        );
        await entered.promise;
        const head = (
          await f.pool.query(
            'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
            [who.accountId],
          )
        ).rows[0];
        await inTransaction(f.pool, (tx) =>
          revokeAssertion(tx, {
            accountId: who.accountId,
            actorAccountId: admin.accountId,
            operationId: randomUUID(),
            fact: 'phone',
            expectedRevision: head.revision,
            reasonCode: 'synthetic_concurrent_revoke',
          }),
        );
        proof.resolve({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now(),
        });
        assert.equal((await active).state, 'unknown');
        assert.equal((await summary(who)).phone.status, 'revoked');
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_verification.phone_proofs WHERE request_id=$1',
              [next],
            )
          ).rows[0].n,
          0,
        );
        const other = await f.actor(),
          entered2 = deferred<void>(),
          proof2 = deferred<PhoneAuthorizationProof>();
        phone = () => {
          entered2.resolve();
          return proof2.promise;
        };
        const key = randomUUID();
        await service.reserve(other.accessToken, key, null);
        const late = service.authorize(
          other.accessToken,
          key,
          'synthetic-revoked-session',
        );
        const rejected = assert.rejects(late);
        await entered2.promise;
        await f.app.get(IdentityService).logout(other.accessToken);
        proof2.resolve({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now(),
        });
        await rejected;
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_verification.phone_proofs WHERE request_id=$1',
              [key],
            )
          ).rows[0].n,
          0,
        );
        const stale = await f.actor(),
          staleKey = randomUUID();
        phone = async () => ({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now() - 600000,
        });
        await service.reserve(stale.accessToken, staleKey, null);
        assert.equal(
          (
            await service.authorize(
              stale.accessToken,
              staleKey,
              'synthetic-stale-proof',
            )
          ).state,
          'unknown',
        );
        assert.equal((await summary(stale)).phone.status, 'unverified');
      },
    );
    await t.test(
      'original-key cancellation fences payload changes and restricted owners retain minimal draft recovery',
      async () => {
        const who = await f.app.get(IdentityService).login(randomUUID()),
          input = {
            clientRequestId: randomUUID(),
            campusId: f.scope.home.campusId,
          },
          requestHash = ownerFingerprint(['reserve', input]);
        const cancelled = await post(
          who,
          `${root}/requests/${input.clientRequestId}/cancel`,
          { requestHash },
        );
        ok(cancelled);
        assert.equal(cancelled.body.state, 'cancelled');
        const replay = await post(who, `${root}/applications`, input);
        ok(replay, 409);
        assert.equal(replay.body.error.code, 'STUDENT_VERIFICATION_CANCELLED');
        const mismatch = await post(who, `${root}/applications`, {
          ...input,
          campusId: f.scope.foreign.campusId,
        });
        ok(mismatch, 409);
        assert.equal(mismatch.body.error.code, 'STUDENT_VERIFICATION_CONFLICT');
        const draftInput = {
            clientRequestId: randomUUID(),
            campusId: f.scope.home.campusId,
          },
          draft = await post(who, `${root}/applications`, draftInput);
        ok(draft);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
            [who.accountId],
          ),
        );
        const recovered = await get(
          who,
          `${root}/requests/${draftInput.clientRequestId}`,
        );
        ok(recovered);
        assert.equal(recovered.body.state, 'recorded');
        const withdrawn = await post(
          who,
          `${root}/applications/${draft.body.applicationId}/withdraw`,
          {
            clientRequestId: randomUUID(),
            expectedRevision: draft.body.revision,
          },
        );
        ok(withdrawn);
        assert.equal(withdrawn.body.state, 'withdrawn');
        const uncertain = randomUUID();
        ok(
          await post(who, `${root}/requests/${uncertain}/cancel`, {
            requestHash: 'a'.repeat(64),
          }),
        );
        assert.equal(
          (await get(who, `${root}/requests/${uncertain}`)).body.state,
          'cancelled',
        );
      },
    );
    await t.test(
      'legacy no-head phone-only bind retains unknown affiliation and number',
      async () => {
        phone = async () => ({
          appId: 'wx0000000000000000',
          authorizedAt: Date.now(),
        });
        // Native enrollment is creation-only. Use a distinct legitimate app identity with enrollment disabled via the existing test fixture service.
        const { IdentityRepository } =
          await import('../../src/identity/identity.repository.js');
        const { DatabaseService } =
          await import('../../src/database/database.js');
        const { APP_CONFIG } = await import('../../src/config/config.js');
        const { mintToken, hashToken } =
          await import('../../src/identity/tokens.js');
        const repo = new IdentityRepository(f.app.get(DatabaseService), {
          ...f.app.get<RuntimeConfig>(APP_CONFIG),
          NATIVE_VERIFICATION_ENROLLMENT: 'disabled',
        });
        const token = mintToken('access');
        await repo.createSession(
          {
            provider: 'wechat',
            appId: 'wx0000000000000000',
            subject: randomUUID(),
          },
          {
            access: hashToken(token),
            refresh: hashToken(mintToken('refresh')),
          },
        );
        const service = f.app.get(PhoneBindingService),
          key = randomUUID();
        await service.reserve(token, key, null);
        assert.equal(
          (await service.authorize(token, key, 'synthetic-legacy-code')).state,
          'verified',
        );
        const r = await request(http)
          .get('/v1/me/verification')
          .set('Authorization', `Bearer ${token}`);
        ok(r);
        assert.equal(r.body.affiliation.status, 'unavailable');
        assert.equal(r.body.studentNumber.status, 'unavailable');
        assert.equal(r.body.phone.status, 'verified');
      },
    );
    assert.equal(PHONE_CONSENT, 'wechat-phone-verification-v1');
  },
);

test(
  'review keyset reaches later valid applications after an expired first page and mixed later-page cleanup',
  { timeout: 180000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#708b79' },
      })
        .png()
        .toBuffer(),
      f = await studentEvidenceFixture(
        [{ sha256: sha256(bytes), verdict: 'allow' }],
        {
          policyRef: 'synthetic-queue-short',
          evidenceTtlSeconds: 5,
          cleanupEnabled: true,
        },
      );
    t.after(() => f.close());
    const http = f.app.getHttpServer(),
      admin = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-queue-keyset')",
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      ),
    );
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      if (i >= 20)
        Object.defineProperty(f.evidence, 'retention', {
          value: Object.freeze({
            policyRef:
              i === 20 ? 'synthetic-queue-long' : 'synthetic-queue-short',
            evidenceTtlSeconds: i === 20 ? 60 : 5,
            cleanupEnabled: true,
          }),
        });
      const who = await f.app.get(IdentityService).login(randomUUID()),
        reserved = await request(http)
          .post(`${root}/applications`)
          .set('Authorization', `Bearer ${who.accessToken}`)
          .send({
            clientRequestId: randomUUID(),
            campusId: f.scope.home.campusId,
          });
      ok(reserved);
      const image = await readyVerificationEvidenceImage(
        f,
        who,
        reserved.body.applicationId,
        1,
        bytes,
      );
      assert.equal(image.status.status, 'ready_unbound');
      if (image.status.status !== 'ready_unbound') throw Error('material');
      const submitted = await request(http)
        .post(`${root}/applications/${reserved.body.applicationId}/submit`)
        .set('Authorization', `Bearer ${who.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          evidence: {
            protocol: 'verification-evidence-media-v1',
            kind: 'verification-evidence-upload',
            assetId: image.status.assetId,
          },
        });
      ok(submitted);
      ids.push(submitted.body.applicationId);
    }
    await new Promise((r) => setTimeout(r, 5100));
    const auth = `Bearer ${admin.accessToken}`,
      path = `${review}/regions/${f.scope.home.regionId}/applications`;
    const first = await request(http).get(path).set('Authorization', auth);
    ok(first);
    assert.deepEqual(first.body.items, []);
    assert.equal(first.body.hasNext, true);
    assert.equal(first.body.nextCursor, ids[19]);
    const second = await request(http)
      .get(path)
      .query({ page: 2, cursor: first.body.nextCursor })
      .set('Authorization', auth);
    ok(second);
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.items[0].id, ids[20]);
    assert.equal(second.body.hasNext, false);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_verification.student_applications WHERE state='expired'",
        )
      ).rows[0].n,
      21,
    );
  },
);
