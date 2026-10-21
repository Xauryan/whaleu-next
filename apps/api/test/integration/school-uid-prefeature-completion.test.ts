import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import type { IdentityProvider } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { historicalIdentityRepository } from '../support/historical-identity/configure.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ownerFingerprint } from '../../src/database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../src/database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { StudentVerificationAccess } from '../../src/verification/student/access.js';
import { StudentVerificationNotices } from '../../src/verification/student/notices.js';
import {
  lockStudentAccount,
  requireStudentCurrent,
} from '../../src/verification/student/current-proof.js';
import {
  lockStudentLedger,
  appendStudentSnapshot,
} from '../../src/verification/student/ledger.js';
import type { StudentApplicationRow } from '../../src/verification/student/contracts.js';
import { VerificationEvidenceMediaService } from '../../src/verification/evidence/facade.js';
import { VERIFICATION_EVIDENCE_MEDIA_PROTOCOL } from '../../src/media/contracts-verification-evidence.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { applySyntheticInventory } from '../../src/school-uid/inventory.js';
import { syntheticUidInventory } from '../support/school-uid-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  studentEvidenceFixture,
  readyVerificationEvidenceImage,
  verificationEvidenceMediaOk as ok,
} from '../support/student-evidence-fixture.js';

test(
  'pre-feature actual native enrollment and approved student source lazily complete without seeding UID coverage',
  { timeout: 240000 },
  async (t) => {
    const png = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#65878a' },
    })
      .png()
      .toBuffer();
    let historicalPhase = true;
    const f = await studentEvidenceFixture(
      [{ sha256: sha256(png), verdict: 'allow' }],
      undefined,
      {
        maximumMigration: 140,
        configureTestModule(builder, config) {
          if (!historicalPhase) return;
          // Only this test needs canonical native registration at schema140.
          // Keep the real HTTP controller/rate limiter/provider/service, and
          // bind its existing guarded predecessor to the actual student config.
          // The later fixture policy overrides IdentityRepository, not this
          // service. No shared historical default or native ledger is changed.
          builder.overrideProvider(IdentityService).useFactory({
            inject: [IDENTITY_PROVIDER, DatabaseService, APP_CONFIG],
            factory: async (
              provider: IdentityProvider,
              database: DatabaseService,
              installedConfig: RuntimeConfig,
            ) => {
              assert.equal(installedConfig, config);
              assert.equal(
                installedConfig.NATIVE_VERIFICATION_ENROLLMENT,
                'enabled',
              );
              return new IdentityService(
                provider,
                await historicalIdentityRepository(
                  database,
                  installedConfig,
                  140,
                ),
              );
            },
          });
        },
      },
    );
    t.after(() => f.close());
    assert.equal(f.historicalPrefix, 140);
    const historicalService = f.app.get(IdentityService);
    assert.ok(historicalService instanceof IdentityService);
    const reviewer = await f.actor('prefeature-uid-reviewer'),
      student = await f.actor('prefeature-uid-student');
    assert.deepEqual(f.providerExchanges(), {
      identity: 2,
      token: 0,
      phone: 0,
    });
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic-prefeature-uid')",
        [randomUUID(), reviewer.accountId],
      ),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT to_regclass('whaleu_school_uid.account_coverage') relation",
        )
      ).rows[0].relation,
      null,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_verification.native_enrollments WHERE account_id=$1',
          [student.accountId],
        )
      ).rows[0].n,
      1,
    );
    const auth = `Bearer ${student.accessToken}`;
    const reserve = await request(f.app.getHttpServer())
      .post('/v1/me/student-verification/applications')
      .set('Authorization', auth)
      .send({ clientRequestId: randomUUID(), campusId: f.scope.home.campusId });
    ok(reserve);
    const media = await readyVerificationEvidenceImage(
      f,
      student,
      reserve.body.applicationId,
      reserve.body.revision,
      png,
    );
    if (media.status.status !== 'ready_unbound')
      throw new Error('Expected real synthetic-provider-bound evidence');
    const submit = await request(f.app.getHttpServer())
      .post(
        `/v1/me/student-verification/applications/${reserve.body.applicationId}/submit`,
      )
      .set('Authorization', auth)
      .send({
        clientRequestId: randomUUID(),
        expectedRevision: reserve.body.revision,
        evidence: {
          protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
          kind: 'verification-evidence-upload',
          assetId: media.status.assetId,
        },
      });
    ok(submit);
    const applicationId = String(reserve.body.applicationId),
      key = randomUUID();
    const input = {
      clientRequestId: key,
      expectedRevision: Number(submit.body.revision),
      decision: 'approved' as const,
    };
    // Execute the existing pre-0141 review owner protocol while that schema is
    // actually installed. No UID provider, closure or table exists to mock here.
    const approved = await f.app
      .get(DatabaseService)
      .transaction(async (tx) => {
        await lockSafetyPolicy(tx, true);
        const access = f.app.get(StudentVerificationAccess),
          evidenceOwner = f.app.get(VerificationEvidenceMediaService);
        const actor = await access.reviewer(
          reviewer.accessToken,
          f.scope.home.regionId,
          tx,
        );
        await lockStudentAccount(student.accountId, tx);
        const row = await access.row(applicationId, tx, true);
        assert.equal(row.state, 'pending');
        assert.equal(row.revision, input.expectedRevision);
        await access.applicant(row, tx);
        await access.campus(row, tx);
        const evidence = await evidenceOwner.evidenceCurrent(row, tx);
        registerTransactionDeadline(
          tx,
          evidence.expiresAt,
          'MEDIA_UNAVAILABLE',
        );
        const locked = await lockStudentLedger(student.accountId, tx),
          decision = randomUUID(),
          assertion = randomUUID(),
          ids = { snapshot: randomUUID(), event: randomUUID() };
        await tx.query(
          `INSERT INTO whaleu_verification.student_decisions(id,application_id,account_id,actor_account_id,grant_id,client_request_id,expected_revision,decision,reason,institution_id,region_id,evidence_digest,evidence_policy_ref,evidence_expires_at,policy_reference,assertion_id,snapshot_id,event_id,ledger_revision) SELECT $1,$2,$3,$4,$5,$6,$7,'approved',NULL,a.institution_id,a.region_id,$8,a.evidence_policy_ref,a.evidence_expires_at,'student-document-review/v1',$9,$10,$11,$12 FROM whaleu_verification.student_applications a WHERE a.id=$2`,
          [
            decision,
            applicationId,
            student.accountId,
            actor.session.accountId,
            actor.grant.id,
            key,
            input.expectedRevision,
            evidence.manifestDigest,
            assertion,
            ids.snapshot,
            ids.event,
            locked.head.revision + 1,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,verified_at,expiry_kind,previous_assertion_id) SELECT assertion_id,account_id,'affiliation','verified','complete','accepted','document_review','student_decision:'||id::text,policy_reference,account_id,institution_id,institution_id,region_id,decided_at,'policy_exempt',$2 FROM whaleu_verification.student_decisions WHERE id=$1`,
          [decision, locked.prior.affiliation_assertion_id],
        );
        const updated = (
          await tx.query<StudentApplicationRow>(
            "UPDATE whaleu_verification.student_applications SET state='approved',decision_id=$3,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *",
            [applicationId, input.expectedRevision, decision],
          )
        ).rows[0]!;
        await appendStudentSnapshot(
          {
            account: student.accountId,
            actor: actor.session.accountId,
            operationId: key,
            state: 'none',
            decisionId: decision,
            assertionId: assertion,
            ids,
            locked,
          },
          tx,
        );
        await f.app.get(StudentVerificationNotices).record(updated, tx);
        await requireStudentCurrent(applicationId, reviewer.accountId, tx);
        await requireStudentCurrent(applicationId, student.accountId, tx);
        const receipt = {
          requestId: key,
          applicationId,
          revision: updated.revision,
          state: updated.state,
        };
        await tx.query(
          'INSERT INTO whaleu_verification.student_requests(actor_id,client_request_id,application_id,command_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            reviewer.accountId,
            key,
            applicationId,
            ownerFingerprint([
              'decide',
              f.scope.home.regionId,
              applicationId,
              input,
            ]),
            JSON.stringify(receipt),
          ],
        );
        return { decision, assertion };
      });
    const receiptBefore = (
      await f.pool.query(
        'SELECT receipt::text value FROM whaleu_verification.student_requests WHERE actor_id=$1 AND client_request_id=$2',
        [reviewer.accountId, key],
      )
    ).rows[0].value;
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    await assert.rejects(
      historicalService.session(student.accessToken),
      /Historical Identity cannot cross an upgrade/,
    );
    // The replacement must use current Identity, never a prefix140 service.
    historicalPhase = false;
    await f.restartApp();
    assert.equal(f.historicalPrefix, undefined);
    assert.notEqual(f.app.get(IdentityService), historicalService);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
          [student.accountId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.issuance_decisions WHERE student_decision_id=$1',
          [approved.decision],
        )
      ).rows[0].n,
      0,
    );
    const school = {
      institutionId: f.scope.institutionId,
      campusId: f.scope.home.campusId,
      regionId: f.scope.home.regionId,
      schoolCode: '00001',
    };
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_campus.school_identifier_sources(id,title,publisher,url,retrieved_at) VALUES('synthetic-prefeature-uid','Synthetic','Synthetic','https://example.invalid/synthetic',clock_timestamp())",
      );
      await tx.query(
        "INSERT INTO whaleu_campus.school_identifiers(institution_id,school_code,moe_code,five_digit_source_id,moe_source_id,reviewed_by,reviewed_at,review_note) VALUES($1,'00001','4100000001','synthetic-prefeature-uid','synthetic-prefeature-uid','synthetic',clock_timestamp(),'Synthetic prefeature UID completion')",
        [school.institutionId],
      );
      await applySyntheticInventory(
        syntheticUidInventory(school),
        school.institutionId,
        tx,
      );
    });
    const ownProfile = await request(f.app.getHttpServer())
      .get('/v1/me/profile')
      .set('Authorization', auth);
    ok(ownProfile);
    const patch = await request(f.app.getHttpServer())
      .patch('/v1/me/profile')
      .set('Authorization', auth)
      .send({
        expectedRevision: ownProfile.body.revision,
        nickname: '历史认证用户',
      });
    ok(patch);
    const publicProfile = await request(f.app.getHttpServer())
      .get('/v1/me/public-profile-ref')
      .set('Authorization', auth);
    ok(publicProfile);
    const adminAuth = `Bearer ${reviewer.accessToken}`;
    const view = await request(f.app.getHttpServer())
      .get('/v1/admin/school-identities/management')
      .set('Authorization', adminAuth)
      .query({ targetProfileId: publicProfile.body.profileId });
    ok(view);
    assert.equal(view.body.actions.completeUid, true);
    const completed = await request(f.app.getHttpServer())
      .post('/v1/admin/school-identities/commands')
      .set('Authorization', adminAuth)
      .send({
        version: 1,
        action: 'complete_uid',
        clientRequestId: randomUUID(),
        targetProfileId: publicProfile.body.profileId,
        expectedStateVersion: view.body.stateVersion,
      });
    ok(completed);
    assert.equal(completed.body.outcome, 'applied');
    const own = await request(f.app.getHttpServer())
      .get('/v1/me/school-uid')
      .set('Authorization', auth);
    ok(own);
    assert.equal(own.body.uid, '1');
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_school_uid.account_coverage WHERE account_id=$1 AND kind='native_absence'",
          [student.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.issuance_decisions WHERE student_decision_id=$1',
          [approved.decision],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT receipt::text value FROM whaleu_verification.student_requests WHERE actor_id=$1 AND client_request_id=$2',
          [reviewer.accountId, key],
        )
      ).rows[0].value,
      receiptBefore,
    );
  },
);
