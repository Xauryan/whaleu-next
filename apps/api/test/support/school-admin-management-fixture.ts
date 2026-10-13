/** Disposable loopback, real AppModule and canonical synthetic source only.
 * No production role seed, provider override or authorization replacement. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
export const schoolAdminPath = '/v1/admin/school-administrators';
export interface SchoolAdminTestCommand {
  clientRequestId: string;
  targetProfileId: string;
  expectedStateVersion: string;
  action: 'appoint' | 'reassign' | 'revoke';
  regionId?: string;
}
export interface SchoolAdminTestManagement {
  target: { profileId: string; displayName: string };
  stateVersion: string;
  currentAssignment: { regionId: string; name: string; status: string } | null;
  eligibility: {
    status: string;
    reason: string | null;
    regions: { id: string; name: string }[];
    defaultRegionId: string | null;
  };
  actions: { appoint: boolean; reassign: boolean; revoke: boolean };
}
export interface SchoolAdminTestGrant {
  id: string;
  operating_region_id: string;
  revoked_at: string | null;
  revoked_by_account_id: string | null;
  [key: string]: unknown;
}
export interface SchoolAdminTestReceipt {
  outcome: 'applied' | 'unchanged' | 'rejected';
  titleGranted?: boolean;
  code?: string;
  [key: string]: unknown;
}
export async function schoolAdminManagementFixture() {
  const f = await directoryRuntimeFixture();
  type BaseActor = Awaited<ReturnType<typeof f.actor>>;
  const actor = async (options: Parameters<typeof f.actor>[0] = {}) => {
    const a = await f.actor(options);
    const profileId = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_profile.profiles(account_id,public_id) VALUES($1,$2)',
        [a.accountId, profileId],
      ),
    );
    return { ...a, profileId };
  };
  const existingActor = async () => {
    const accountId = randomUUID(),
      subject = randomUUID(),
      profileId = randomUUID();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
        accountId,
      ]);
      await tx.query(
        "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-existing-school-admin',$1,$2)",
        [subject, accountId],
      );
      await tx.query(
        'INSERT INTO whaleu_profile.profiles(account_id,public_id) VALUES($1,$2)',
        [accountId, profileId],
      );
      await initializeNativeSafetyAccount(accountId, tx);
    });
    const accessToken = mintToken('access'),
      refreshToken = mintToken('refresh');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: 'wechat',
        appId: 'synthetic-existing-school-admin',
        subject,
      },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
    const facts = await f.certify(accountId);
    return { ...session, accessToken, refreshToken, facts, profileId };
  };
  const grant = async (
    a: BaseActor,
    role: 'school_admin' | 'super_admin' | 'developer' = 'super_admin',
    regionId: string | null = null,
    validity: { from?: Date; until?: Date } = {},
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_authorization.role_grants
      (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at)
      VALUES($1,$2,$3,$4,$2,'synthetic:school-admin-management-fixture',$5,$6)`,
        [
          id,
          a.accountId,
          role,
          regionId,
          validity.from ?? new Date(Date.now() - 60000),
          validity.until ?? null,
        ],
      );
      return id;
    });
  const http = f.app.getHttpServer();
  const managementResponse = (a: BaseActor, targetProfileId: string) =>
    request(http)
      .get(`${schoolAdminPath}/management`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .query({ targetProfileId });
  const management = async (
    a: BaseActor,
    targetProfileId: string,
  ): Promise<SchoolAdminTestManagement> => {
    const response = await managementResponse(a, targetProfileId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.match(String(response.headers['vary']), /Authorization/i);
    return response.body as SchoolAdminTestManagement;
  };
  const send = (a: BaseActor, body: SchoolAdminTestCommand, cancel = false) =>
    request(http)
      .post(`${schoolAdminPath}/commands${cancel ? '/cancel' : ''}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send(body);
  const recovery = (a: BaseActor, id: string) =>
    request(http)
      .get(`${schoolAdminPath}/requests/${id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
  const command = (
    view: SchoolAdminTestManagement,
    action: SchoolAdminTestCommand['action'],
    regionId?: string,
  ): SchoolAdminTestCommand => ({
    clientRequestId: randomUUID(),
    targetProfileId: view.target.profileId,
    expectedStateVersion: view.stateVersion,
    action,
    ...(regionId ? { regionId } : {}),
  });
  const grants = async (a: BaseActor) =>
    (
      await f.pool.query(
        `SELECT to_jsonb(g) value FROM whaleu_authorization.role_grants g WHERE account_id=$1 AND role='school_admin' ORDER BY created_at,id`,
        [a.accountId],
      )
    ).rows.map((r) => r['value'] as SchoolAdminTestGrant);
  const apply = async (
    a: BaseActor,
    targetProfileId: string,
    action: SchoolAdminTestCommand['action'],
    regionId?: string,
  ) => {
    const view = await management(a, targetProfileId),
      body = command(view, action, regionId),
      response = await send(a, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { view, body, receipt: response.body as SchoolAdminTestReceipt };
  };
  return {
    ...f,
    http,
    actor,
    existingActor,
    grant,
    managementResponse,
    management,
    command,
    send,
    recovery,
    grants,
    apply,
  };
}
export type SchoolAdminFixture = Awaited<
  ReturnType<typeof schoolAdminManagementFixture>
>;
export type SchoolAdminActor = Awaited<ReturnType<SchoolAdminFixture['actor']>>;
