import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { acceptRelatedSyncPolicy } from '../support/related-sync-fixtures.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import {
  appendTopologyRevision,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { schoolPostingCommandHash } from '../../src/school-posting-policy/contracts.js';
import { SchoolPostingPolicyRepository } from '../../src/school-posting-policy/repository.js';

const base = '/v1/me/school-posting-policy';
test(
  'related settings v2 explicit admission, disable after withdrawal, native evidence and exact recovery',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      const admin = await createRuntimeActor(f.app),
        other = await createRuntimeActor(f.app);
      const region = f.scope.home.regionId,
        grant = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        for (const [actor, target, grantId] of [
          [admin, region, grant],
          [other, f.scope.related.regionId, randomUUID()],
        ] as const)
          await tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
          VALUES($1,$2,'school_admin',$3,$2,'Explicit disposable related settings grant')`,
            [grantId, actor.accountId, target],
          );
      });
      const command = (expectedRevision: number, enabled: boolean) => ({
        version: 2 as const,
        clientRequestId: randomUUID(),
        expectedRevision,
        policy: {
          unverifiedPostEnabled: false,
          unverifiedCommentEnabled: true,
          unverifiedCategories: ['discussion' as const],
          relatedSyncEnabled: enabled,
          expiry: { kind: 'policy_exempt' as const },
        },
      });
      const save = (body: object, actor = admin) =>
        request(f.app.getHttpServer())
          .post(`${base}/${region}`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(body);
      const read = () =>
        request(f.app.getHttpServer())
          .get(base)
          .set('Authorization', `Bearer ${admin.accessToken}`);
      await t.test(
        'accepted topology alone does not invent applicability; disabling requires no applicability',
        async () => {
          const unavailable = await save(command(0, true));
          assert.equal(
            unavailable.status,
            503,
            JSON.stringify(unavailable.body),
          );
          assert.equal((await read()).body.revision, 0);
          const disabled = await save(command(0, false));
          assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
          assert.equal((await read()).body.policy.relatedSyncEnabled, false);
        },
      );
      await acceptRelatedSyncPolicy(f.pool, region);
      const enabled = command(1, true);
      let saved: Record<string, unknown>;
      await t.test(
        'fixed origin issuer enables once, exposes flag and cannot overwrite it through legacy v1',
        async () => {
          assert.equal((await save(enabled, other)).status, 403);
          const result = await save(enabled);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          saved = result.body;
          assert.deepEqual((await save(enabled)).body, saved);
          const view = (await read()).body;
          assert.equal(view.editable, true);
          assert.equal(view.policy.relatedSyncEnabled, true);
          const v2 = command(2, false);
          const old = await save({
            clientRequestId: v2.clientRequestId,
            expectedRevision: v2.expectedRevision,
            policy: {
              unverifiedPostEnabled: v2.policy.unverifiedPostEnabled,
              unverifiedCommentEnabled: v2.policy.unverifiedCommentEnabled,
              unverifiedCategories: v2.policy.unverifiedCategories,
              expiry: v2.policy.expiry,
            },
          });
          assert.equal(
            old.body.error?.code,
            'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED',
          );
          const audit = (
            await f.pool.query(
              'SELECT related_command_transaction,related_command_fingerprint,related_enable_fingerprint FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2',
              [admin.accountId, enabled.clientRequestId],
            )
          ).rows[0];
          assert.ok(audit.related_command_transaction);
          assert.match(audit.related_command_fingerprint, /^[a-f0-9]{64}$/);
          assert.match(audit.related_enable_fingerprint, /^[a-f0-9]{64}$/);
          assert.equal(
            (
              await save({
                ...enabled,
                policy: { ...enabled.policy, relatedSyncEnabled: false },
              })
            ).body.error?.code,
            'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
          );
        },
      );
      await t.test(
        'raw command cannot change sources after early constraint flush',
        async () => {
          const records = new SchoolPostingPolicyRepository(),
            raw = command(2, false);
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const previous = await records.current(region, tx, true);
              await records.save(
                {
                  actor: admin.accountId,
                  grantId: grant,
                  regionId: region,
                  previous,
                  command: raw,
                  hash: schoolPostingCommandHash(admin.accountId, region, raw),
                },
                tx,
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'UPDATE whaleu_authorization.role_grants SET approval_reference=approval_reference WHERE id=$1',
                [grant],
              );
            }),
          );
          assert.equal((await read()).body.revision, 2);
        },
      );
      await t.test(
        'withdrawn current relation blocks enabling but permits v2 disable and receipt recovery',
        async () => {
          const topology = structuredClone(f.scope.topology);
          topology.regions.find(
            (r) => r.regionId === f.scope.related.regionId,
          )!.groupId = topology.regions.find(
            (r) => r.regionId === f.scope.foreign.regionId,
          )!.groupId;
          await appendTopologyRevision(f.pool, topology);
          const disabled = await save(command(2, false));
          assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
          assert.equal((await save(command(3, true))).status, 503);
          assert.deepEqual((await save(enabled)).body, saved!);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
              [grant, admin.accountId],
            ),
          );
          assert.deepEqual((await save(enabled)).body, saved!);
          assert.equal((await save(command(3, false))).status, 403);
          const recovered = await request(f.app.getHttpServer())
            .get(`${base}/requests/${enabled.clientRequestId}`)
            .set('Authorization', `Bearer ${admin.accessToken}`);
          assert.deepEqual(recovered.body.receipt, saved!);
        },
      );
    } finally {
      await f.close();
    }
  },
);
