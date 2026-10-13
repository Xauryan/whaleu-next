import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import {
  withCommunityScopeWriter,
  setRegionPolicy,
} from '../support/community-scope-fixtures.js';
import { schoolPostingCommandHash } from '../../src/school-posting-policy/contracts.js';
import { RegionalCommunityPolicyService } from '../../src/campus/community-policy/regional-community-policy.service.js';
import { inTransaction } from '../../src/database/database.js';
const base = '/v1/me/school-posting-policy';
test(
  'school posting original ledger, exact authority, CAS, receipt/cancel, expiry and unresolved source boundaries',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      const admin = await createRuntimeActor(f.app),
        member = await f.actor({ affiliation: 'unverified' }),
        developer = await createRuntimeActor(f.app),
        superAdmin = await createRuntimeActor(f.app);
      const region = f.scope.home.regionId,
        grant = randomUUID(),
        http = f.app.getHttpServer();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        for (const [actor, role, target, id] of [
          [admin, 'school_admin', region, grant],
          [developer, 'developer', null, randomUUID()],
          [superAdmin, 'super_admin', null, randomUUID()],
        ] as const)
          await tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic school policy acceptance')`,
            [id, actor.accountId, role, target],
          );
      });
      const command = (expectedRevision: number, enabled = true) => ({
        clientRequestId: randomUUID(),
        expectedRevision,
        policy: {
          unverifiedPostEnabled: enabled,
          unverifiedCommentEnabled: enabled,
          unverifiedCategories: ['discussion' as const],
          expiry: { kind: 'policy_exempt' as const },
        },
      });
      const read = (actor = admin, target?: string) =>
        request(http)
          .get(base)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .query(target ? { regionId: target } : {});
      const save = (input: object, actor = admin, target = region) =>
        request(http)
          .post(`${base}/${target}`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(input);
      const recover = (requestId: string, actor = admin) =>
        request(http)
          .get(`${base}/requests/${requestId}`)
          .set('Authorization', `Bearer ${actor.accessToken}`);
      const cancel = (requestId: string, hash: string, actor = admin) =>
        request(http)
          .post(`${base}/requests/${requestId}/cancel`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ requestHash: hash });
      const resolver = new RegionalCommunityPolicyService();
      let revision = 0;
      const first = command(0);
      let firstReceipt: unknown;
      await t.test(
        'no configuration is unavailable to actual consumer; true school grant is fixed, developer and member do not manage',
        async () => {
          assert.equal((await request(http).get(base)).status, 401);
          assert.equal(
            (await read(member)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.equal(
            (await read(developer)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.equal((await read(superAdmin)).status, 400);
          assert.equal((await read(superAdmin, region)).status, 200);
          assert.equal(
            (await read(admin, f.scope.foreign.regionId)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          const view = await read();
          assert.equal(view.status, 200, JSON.stringify(view.body));
          assert.equal(view.body.state, 'unconfigured');
          assert.equal(view.body.revision, 0);
          assert.equal(view.body.policy, null);
          assert.deepEqual(
            await inTransaction(f.pool, (tx) => resolver.resolve(region, tx)),
            { status: 'unavailable' },
          );
          assert.equal((await save(first, member)).status, 403);
          assert.equal((await save(first, developer)).status, 403);
        },
      );
      await t.test(
        'explicit admin writes the original consumer ledger once; exact replay, owner receipt and changed-key-content fencing',
        async () => {
          const result = await save(first);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          firstReceipt = result.body;
          revision = 1;
          assert.deepEqual((await save(first)).body, firstReceipt);
          assert.deepEqual(
            (await recover(first.clientRequestId)).body.receipt,
            firstReceipt,
          );
          assert.equal(
            (await recover(first.clientRequestId, member)).body.state,
            'not_recorded',
          );
          assert.equal(
            (
              await save({
                ...first,
                policy: { ...first.policy, unverifiedCommentEnabled: false },
              })
            ).body.error.code,
            'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
          );
          const policy = await inTransaction(f.pool, (tx) =>
            resolver.resolve(region, tx),
          );
          assert.equal(policy.status, 'known');
          if (policy.status === 'known') {
            assert.equal(policy.revisionId, result.body.revisionId);
            assert.equal(policy.unverifiedPostEnabled, true);
            assert.equal(policy.unverifiedCommentEnabled, true);
            assert.deepEqual(policy.unverifiedCategories, ['discussion']);
            assert.equal(policy.relatedSyncEnabled, false);
          }
          const audit = (
            await f.pool.query(
              'SELECT actor_id,grant_id,command,revision_id FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2',
              [admin.accountId, first.clientRequestId],
            )
          ).rows;
          assert.equal(audit.length, 1);
          assert.equal(audit[0].grant_id, grant);
          assert.deepEqual(audit[0].command, first);
        },
      );
      await t.test(
        'two different CAS commands serialize with exactly one winner, never a silent overwrite',
        async () => {
          const candidates = [
              command(revision, false),
              command(revision, true),
            ],
            results = await Promise.all(candidates.map((c) => save(c)));
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            results.find((r) => r.status === 409)!.body.error.code,
            'SCHOOL_POSTING_POLICY_REVISION_CONFLICT',
          );
          revision++;
        },
      );
      await t.test(
        'cancel fence wins before write, saved receipt wins after write, and save/cancel race has one outcome',
        async () => {
          const cancelled = command(revision),
            hash = schoolPostingCommandHash(admin.accountId, region, cancelled);
          assert.equal(
            (await cancel(cancelled.clientRequestId, hash)).body.state,
            'cancelled',
          );
          assert.equal(
            (await save(cancelled)).body.error.code,
            'SCHOOL_POSTING_POLICY_CANCELLED',
          );
          assert.equal(
            (await cancel(cancelled.clientRequestId, '0'.repeat(64))).body.error
              .code,
            'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
          );
          const firstHash = schoolPostingCommandHash(
            admin.accountId,
            region,
            first,
          );
          assert.deepEqual(
            (await cancel(first.clientRequestId, firstHash)).body.receipt,
            firstReceipt,
          );
          const racing = command(revision),
            racingHash = schoolPostingCommandHash(
              admin.accountId,
              region,
              racing,
            ),
            results = await Promise.all([
              save(racing),
              cancel(racing.clientRequestId, racingHash),
            ]);
          if (results[0]!.status === 200) {
            revision++;
            assert.equal(results[1]!.body.state, 'recorded');
            assert.deepEqual(results[1]!.body.receipt, results[0]!.body);
          } else {
            assert.equal(
              results[0]!.body.error.code,
              'SCHOOL_POSTING_POLICY_CANCELLED',
            );
            assert.equal(results[1]!.body.state, 'cancelled');
          }
        },
      );
      await t.test(
        'ordinary consumer still requires phone and known unverified affiliation; unsupported categories are rejected',
        async () => {
          const phone = await f.actor({
              affiliation: 'unverified',
              phone: 'unverified',
            }),
            unknown = await f.actor({ affiliation: 'unavailable' });
          for (const [actor, code] of [
            [phone, 'PHONE_VERIFICATION_REQUIRED'],
            [unknown, 'COMMUNITY_UNAVAILABLE'],
          ] as const) {
            const result = await request(http)
              .post('/v1/community/posts')
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                spaceId: f.scope.home.spaceId,
                category: 'discussion',
                text: 'Synthetic strict policy boundary',
                authorMode: 'named',
                imageAssetIds: [],
                commentsPolicy: 'open',
              });
            assert.equal(
              result.body.error?.code ?? result.body.code,
              code,
              JSON.stringify(result.body),
            );
          }
          assert.equal(
            (
              await save({
                ...command(revision),
                policy: { ...first.policy, unverifiedCategories: ['trading'] },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await save({
                ...command(revision),
                policy: { ...first.policy, relatedSyncEnabled: true },
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        'expired accepted policy is unavailable to consumers, then explicitly republished as new administrator evidence',
        async () => {
          await setRegionPolicy(f.pool, region, {
            unverifiedPostEnabled: true,
            unverifiedCommentEnabled: true,
            unverifiedCategories: ['discussion'],
            validUntil: Date.now() - 1000,
          });
          revision++;
          assert.equal((await read()).body.state, 'expired');
          assert.deepEqual(
            await inTransaction(f.pool, (tx) => resolver.resolve(region, tx)),
            { status: 'unavailable' },
          );
          const expired = (await read()).body.revisionId;
          const input = {
            ...command(revision),
            policy: {
              ...first.policy,
              expiry: {
                kind: 'at',
                validUntil: new Date(Date.now() + 3600000).toISOString(),
              },
            },
          };
          assert.equal((await save(input)).status, 200);
          revision++;
          const prior = (
            await f.pool.query(
              'SELECT previous_revision_id FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2',
              [admin.accountId, input.clientRequestId],
            )
          ).rows[0];
          assert.equal(prior.previous_revision_id, expired);
          assert.equal(
            (
              await save({
                ...command(revision),
                policy: {
                  ...first.policy,
                  expiry: {
                    kind: 'at',
                    validUntil: new Date(Date.now() - 1000).toISOString(),
                  },
                },
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        'unknown evidence stays read-only; enabled sync is explicit in updated management and legacy writes cannot overwrite it',
        async () => {
          await setRegionPolicy(f.pool, f.scope.related.regionId, {
            provenanceState: 'unknown',
          });
          let view = await read(superAdmin, f.scope.related.regionId);
          assert.equal(view.body.state, 'unavailable');
          assert.equal(view.body.blocker, 'untrusted_source');
          assert.equal(view.body.editable, false);
          assert.equal(
            (await save(command(1), superAdmin, f.scope.related.regionId)).body
              .error.code,
            'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED',
          );
          await setRegionPolicy(f.pool, f.scope.foreign.regionId, {
            relatedSyncEnabled: true,
            unverifiedCategories: ['discussion'],
          });
          view = await read(superAdmin, f.scope.foreign.regionId);
          assert.equal(view.body.blocker, null);
          assert.equal(view.body.editable, true);
          assert.equal(view.body.policy.relatedSyncEnabled, true);
          assert.equal(
            (await save(command(1), superAdmin, f.scope.foreign.regionId)).body
              .error.code,
            'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED',
          );
        },
      );
      await t.test(
        'immutable audit refuses changed receipt and unaudited claimed school revision',
        async () => {
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_community.region_policy_commands SET receipt=receipt WHERE actor_id=$1',
              [admin.accountId],
            ),
          );
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                `INSERT INTO whaleu_community.region_policy_revisions(id,region_id,revision,coverage_state,provenance_state,source_reference,policy_reference,unverified_post_enabled,unverified_comment_enabled,unverified_categories,related_sync_enabled,effective_at,expiry_kind,valid_until,school_admin_publication_transaction) VALUES($1,$2,$3,'complete','accepted','forged','whaleu:school-posting-policy:v1',true,true,ARRAY['discussion'],false,clock_timestamp(),'policy_exempt',NULL,pg_current_xact_id())`,
                [randomUUID(), region, revision + 1],
              );
            }),
          );
          assert.equal((await read()).body.revision, revision);
        },
      );
      await t.test(
        'already expired grants and grant/policy expiry after deferred work all fail closed without a revision',
        async () => {
          const expired = await createRuntimeActor(f.app),
            expiring = await createRuntimeActor(f.app),
            policyExpiryRequestId = randomUUID();
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic already expired authority',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,
              [randomUUID(), expired.accountId, region],
            );
          });
          assert.equal(
            (await save(command(revision), expired)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          await f.pool.query(
            `CREATE FUNCTION whaleu_community.test_school_posting_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id='${expiring.accountId}'::uuid OR NEW.client_request_id='${policyExpiryRequestId}'::uuid THEN PERFORM pg_sleep(2); END IF; RETURN NULL; END $$`,
          );
          await f.pool.query(
            `CREATE CONSTRAINT TRIGGER test_school_posting_deferred_wait AFTER INSERT ON whaleu_community.region_policy_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.test_school_posting_deferred_wait()`,
          );
          try {
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic short-lived authority',clock_timestamp()+interval '1500 milliseconds')`,
                [randomUUID(), expiring.accountId, region],
              ),
            );
            const result = await save(command(revision), expiring);
            assert.equal(
              result.body.error.code,
              'AUTHORIZATION_UNAVAILABLE',
              JSON.stringify(result.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.region_policy_commands WHERE actor_id=$1',
                  [expiring.accountId],
                )
              ).rowCount,
              0,
            );
            assert.equal((await read()).body.revision, revision);
            const expiresDuringCommit = {
              ...command(revision),
              clientRequestId: policyExpiryRequestId,
              policy: {
                ...first.policy,
                expiry: {
                  kind: 'at',
                  validUntil: new Date(Date.now() + 1500).toISOString(),
                },
              },
            };
            const timed = await save(expiresDuringCommit);
            assert.equal(
              timed.body.error.code,
              'SCHOOL_POSTING_POLICY_UNAVAILABLE',
              JSON.stringify(timed.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2',
                  [admin.accountId, policyExpiryRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal((await read()).body.revision, revision);
          } finally {
            await f.pool.query(
              'DROP TRIGGER test_school_posting_deferred_wait ON whaleu_community.region_policy_commands',
            );
            await f.pool.query(
              'DROP FUNCTION whaleu_community.test_school_posting_deferred_wait()',
            );
          }
        },
      );
      await t.test(
        'revocation and inactive target block fresh management; historical owner receipt is retained',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
              [grant, admin.accountId],
            ),
          );
          assert.equal(
            (await save(command(revision))).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.equal(
            (await read()).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.deepEqual(
            (await recover(first.clientRequestId)).body.receipt,
            firstReceipt,
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [region],
            ),
          );
          assert.equal(
            (await save(command(revision), superAdmin)).body.error.code,
            'COMMUNITY_SCOPE_UNAVAILABLE',
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
