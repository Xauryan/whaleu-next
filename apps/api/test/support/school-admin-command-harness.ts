/** API-only bridge for existing owner fixtures; target roles are issued by the
 * new command owner, never by the legacy synthetic school-grant shortcut. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
export async function schoolAdminControl(
  f: { pool: Pool; app: INestApplication },
  superActor: { accountId: string; accessToken: string },
  subject: { accountId: string; accessToken: string },
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',$2,'synthetic-school-control-owner')",
      [randomUUID(), superActor.accountId],
    );
    await tx.query(
      'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT(account_id) DO NOTHING',
      [subject.accountId],
    );
  });
  const profileId = (
    await f.pool.query<{ public_id: string }>(
      'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
      [subject.accountId],
    )
  ).rows[0]!.public_id;
  const change = async (
    action: 'appoint' | 'reassign' | 'revoke',
    regionId?: string,
  ) => {
    const view = await request(f.app.getHttpServer())
      .get('/v1/admin/school-administrators/management')
      .set('Authorization', `Bearer ${superActor.accessToken}`)
      .query({ targetProfileId: profileId });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const response = await request(f.app.getHttpServer())
      .post('/v1/admin/school-administrators/commands')
      .set('Authorization', `Bearer ${superActor.accessToken}`)
      .send({
        clientRequestId: randomUUID(),
        targetProfileId: profileId,
        expectedStateVersion: view.body.stateVersion,
        action,
        ...(regionId ? { regionId } : {}),
      });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    return response.body;
  };
  return { profileId, change };
}
