import { extendLiveFixture } from './live-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import {
  studentEvidenceFixture,
  readyVerificationEvidenceImage,
  verificationEvidenceMediaOk as ok,
} from './student-evidence-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { VERIFICATION_EVIDENCE_MEDIA_PROTOCOL } from '../../src/media/contracts-verification-evidence.js';
import {
  withCommunityScopeWriter,
  appendTopologyRevision,
} from './community-scope-fixtures.js';
import { applySyntheticInventory } from '../../src/school-uid/inventory.js';
import type { SchoolUidInventory } from '../../src/school-uid/inventory.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import {
  schoolIdentityManagementSchema,
  schoolIdentityReceiptSchema,
} from '../../src/school-identity/contracts.js';
import type { SchoolIdentityCommand } from '../../src/school-identity/contracts.js';
import { schoolUidSchema } from '../../src/school-uid/contracts.js';
export interface UidSchool {
  institutionId: string;
  campusId: string;
  regionId: string;
  schoolCode: string;
}
export function syntheticUidInventory(
  location: UidSchool,
  floor = '0',
): SchoolUidInventory {
  const d = '1'.repeat(64);
  return {
    format: 'school-uid-inventory/v1',
    classification: 'synthetic',
    sourceInstance:
      'school-uid-integration:' + location.schoolCode + ':' + floor,
    sourceCutoff: '2026-01-01T00:00:00Z',
    snapshotDigest: d,
    schoolCrosswalkDigest: d,
    accountCrosswalkDigest: d,
    reviewerAcceptanceDigest: d,
    writerQuiescenceDigest: d,
    finalDeltaDigest: d,
    schools: [
      {
        sourceSchoolId: location.schoolCode,
        institutionId: location.institutionId,
        schoolCode: location.schoolCode,
        classification: floor === '0' ? 'known_new' : 'reconciled',
        sourceEmptyVerified: floor === '0',
        trustedCeiling: floor,
        ceilingJustificationDigest: d,
        priorAdmittedFloor: '0',
        trustedCounters: [{ type: 'integer', value: floor }],
        counterReset: false,
        unknownHistoryBounded: true,
        reservations: [],
        unresolvedConflicts: [],
      },
    ],
  };
}
export async function schoolUidFixture(
  options: Parameters<typeof studentEvidenceFixture>[2] = {},
) {
  const png = await sharp({
    create: { width: 48, height: 48, channels: 3, background: '#4b8576' },
  })
    .png()
    .toBuffer();
  const f = await studentEvidenceFixture(
    [{ sha256: sha256(png), verdict: 'allow' }],
    undefined,
    options,
  );
  try {
    const home: UidSchool = {
      ...f.scope.home,
      institutionId: f.scope.institutionId,
      schoolCode: '00001',
    };
    const destination: UidSchool = {
      institutionId: randomUUID(),
      campusId: randomUUID(),
      regionId: randomUUID(),
      schoolCode: '00002',
    };
    const deferred: UidSchool = {
      institutionId: randomUUID(),
      campusId: randomUUID(),
      regionId: randomUUID(),
      schoolCode: '00003',
    };
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_campus.school_identifier_sources(id,title,publisher,url,retrieved_at) VALUES('synthetic-school-uid','Synthetic test only','Synthetic test owner','https://example.invalid/synthetic',clock_timestamp())",
      );
      for (const location of [home, destination, deferred]) {
        if (location !== home) {
          await tx.query(
            'INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,$2)',
            [
              location.institutionId,
              'Synthetic UID school ' + location.schoolCode,
            ],
          );
          await tx.query(
            'INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,$2,true)',
            [location.regionId, 'Synthetic UID region ' + location.schoolCode],
          );
          await tx.query(
            "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,$3,'synthetic',true)",
            [
              location.campusId,
              location.institutionId,
              'Synthetic UID campus ' + location.schoolCode,
            ],
          );
          await tx.query(
            'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES($1,$2)',
            [location.campusId, location.regionId],
          );
        }
        await tx.query(
          "INSERT INTO whaleu_campus.school_identifiers(institution_id,school_code,moe_code,five_digit_source_id,moe_source_id,reviewed_by,reviewed_at,review_note) VALUES($1,$2,$3,'synthetic-school-uid','synthetic-school-uid','synthetic-test',clock_timestamp(),'Not production admission')",
          [
            location.institutionId,
            location.schoolCode,
            '41000' + location.schoolCode,
          ],
        );
      }
    });
    const topology = structuredClone(f.scope.topology);
    for (const location of [destination, deferred]) {
      const groupId = randomUUID();
      topology.groups.push({ groupId, coverage: 'complete', isActive: true });
      topology.regions.push({
        regionId: location.regionId,
        institutionId: location.institutionId,
        groupId,
        coverage: 'complete',
        isActive: true,
      });
      topology.assignments.push({
        campusId: location.campusId,
        institutionId: location.institutionId,
        regionId: location.regionId,
        coverage: 'complete',
        isActive: true,
      });
    }
    await appendTopologyRevision(f.pool, topology);
    const admit = (location: UidSchool, floor = '0') =>
      withCommunityScopeWriter(f.pool, (tx) =>
        applySyntheticInventory(
          syntheticUidInventory(location, floor),
          location.institutionId,
          tx,
        ),
      );
    await admit(home);
    await admit(destination);
    const admin = await f.actor('synthetic-school-uid-native-admin');
    const grant = async (actor: SessionCredentials = admin) =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic-school-uid-reviewer')",
          [id, actor.accountId],
        );
        return id;
      });
    const adminGrant = await grant();
    const auth = (a: SessionCredentials) => `Bearer ${a.accessToken}`;
    const profile = async (actor: SessionCredentials) => {
      const before = await request(f.app.getHttpServer())
        .get('/v1/me/profile')
        .set('Authorization', auth(actor));
      ok(before);
      const response = await request(f.app.getHttpServer())
        .patch('/v1/me/profile')
        .set('Authorization', auth(actor))
        .send({
          expectedRevision: before.body.revision,
          nickname: 'UID测试用户',
        });
      ok(response);
      const r = await request(f.app.getHttpServer())
        .get('/v1/me/public-profile-ref')
        .set('Authorization', auth(actor));
      ok(r);
      assert.ok(r.body.profileId);
      return String(r.body.profileId);
    };
    const submit = async (
      actor: SessionCredentials,
      location: UidSchool = home,
    ) => {
      const reserved = await request(f.app.getHttpServer())
        .post('/v1/me/student-verification/applications')
        .set('Authorization', auth(actor))
        .send({ clientRequestId: randomUUID(), campusId: location.campusId });
      ok(reserved);
      const media = await readyVerificationEvidenceImage(
        f,
        actor,
        reserved.body.applicationId,
        reserved.body.revision,
        png,
      );
      assert.equal(media.status.status, 'ready_unbound');
      if (media.status.status !== 'ready_unbound')
        throw Error('Missing evidence');
      const sent = await request(f.app.getHttpServer())
        .post(
          `/v1/me/student-verification/applications/${reserved.body.applicationId}/submit`,
        )
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
      return {
        id: String(reserved.body.applicationId),
        revision: Number(sent.body.revision),
        location,
      };
    };
    const approve = async (
      actor: SessionCredentials,
      application: Awaited<ReturnType<typeof submit>>,
      decision: 'approved' | 'rejected' = 'approved',
    ) => {
      const body = {
        clientRequestId: randomUUID(),
        expectedRevision: application.revision,
        decision,
        ...(decision === 'rejected'
          ? { reason: 'Synthetic rejected test' }
          : {}),
      };
      const response = await request(f.app.getHttpServer())
        .post(
          `/v1/student-verification-review/regions/${application.location.regionId}/applications/${application.id}/decision`,
        )
        .set('Authorization', auth(actor))
        .send(body);
      ok(response);
      return { response, body };
    };
    const management = async (
      actor: SessionCredentials,
      targetProfileId: string,
      campus?: string,
    ) => {
      const response = await request(f.app.getHttpServer())
        .get('/v1/admin/school-identities/management')
        .set('Authorization', auth(actor))
        .query({
          targetProfileId,
          ...(campus ? { destinationCampusId: campus } : {}),
        });
      ok(response);
      return schoolIdentityManagementSchema.parse(response.body);
    };
    const send = (
      actor: SessionCredentials,
      command: SchoolIdentityCommand,
      cancel = false,
    ) =>
      request(f.app.getHttpServer())
        .post(
          '/v1/admin/school-identities/commands' + (cancel ? '/cancel' : ''),
        )
        .set('Authorization', auth(actor))
        .send(command);
    const correct = async (
      actor: SessionCredentials,
      targetProfileId: string,
      campus: string,
    ) => {
      const view = await management(actor, targetProfileId, campus);
      assert.ok(view.destination);
      const command: SchoolIdentityCommand = {
        version: 1,
        action: 'correct_school',
        clientRequestId: randomUUID(),
        targetProfileId,
        expectedStateVersion: view.stateVersion,
        destinationCampusId: campus,
        expectedDestinationVersion: view.destination.destinationVersion,
      };
      const result = await send(actor, command);
      ok(result);
      return {
        command,
        receipt: schoolIdentityReceiptSchema.parse(result.body),
      };
    };
    const own = async (actor: SessionCredentials) => {
      const response = await request(f.app.getHttpServer())
        .get('/v1/me/school-uid')
        .set('Authorization', auth(actor));
      ok(response);
      return schoolUidSchema.parse(response.body);
    };
    return extendLiveFixture(f, {
      png,
      admin,
      adminGrant,
      grant,
      home,
      destination,
      deferred,
      admit,
      profile,
      submit,
      approve,
      management,
      send,
      correct,
      own,
    });
  } catch (error) {
    await f.close();
    throw error;
  }
}
