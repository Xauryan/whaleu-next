import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import request from 'supertest';
import {
  errandRuntimeFixture,
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import { inTransaction, DatabaseService } from '../../src/database/database.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityMaintenance } from '../../src/identity/maintenance.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
const require = createRequire(import.meta.url);
const {
  decodeErrandRestrictionPage,
  decodeErrandRestrictionHistory,
} = require('../../../wechat/src/errands/restriction-contract.ts');
const safetyUnavailable = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'constraint' in error &&
  error.constraint === 'errand_restriction_unavailable';
test(
  'Safety direct-SQL causal boundary rejects stale and after-adoption materialization claims',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    try {
      const actor = await f.actor(),
        subject = await f.actor(),
        grantId = randomUUID();
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'Synthetic causal forgery test')",
        [grantId, actor.accountId],
      );
      const old = await seedErrandFeature(f.pool, subject.accountId, [], {
        validUntil: new Date(Date.now() + 3600000),
      });
      const current = await seedErrandFeature(f.pool, subject.accountId, [], {
        validUntil: new Date(Date.now() + 1800000),
      });
      for (const headFirst of [false, true])
        await t.test(
          headFirst
            ? 'head-first then materialization cannot hide actual predecessor'
            : 'older longer-coverage predecessor cannot renew the current envelope',
          async () => {
            await assert.rejects(
              inTransaction(
                f.pool,
                async (tx) => {
                  await lockSafetyPolicy(tx, true);
                  const command = randomUUID(),
                    snapshot = randomUUID();
                  await tx.query(
                    `INSERT INTO whaleu_safety.errand_restriction_commands(id,actor_id,session_id,grant_id,request_id,kind,operation,subject_id,occurred_at)
 VALUES($1,$2,$3,$4,$5,'global','issue',$6,clock_timestamp())`,
                    [
                      command,
                      actor.accountId,
                      actor.sessionId,
                      grantId,
                      randomUUID(),
                      subject.accountId,
                    ],
                  );
                  await tx.query(
                    `INSERT INTO whaleu_safety.errand_feature_snapshots(id,account_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until,restrictions)
 SELECT $1,account_id,coverage,provenance,source_reference,policy_reference,clock_timestamp(),valid_until,restrictions FROM whaleu_safety.errand_feature_snapshots WHERE id=$2`,
                    [snapshot, old],
                  );
                  if (headFirst)
                    await tx.query(
                      'UPDATE whaleu_safety.errand_feature_heads SET snapshot_id=$2 WHERE account_id=$1',
                      [subject.accountId, snapshot],
                    );
                  await tx.query(
                    'INSERT INTO whaleu_safety.errand_restriction_materializations(snapshot_id,predecessor_snapshot_id,command_id,source_event_id) VALUES($1,$2,$3,$4)',
                    [snapshot, old, command, randomUUID()],
                  );
                },
                { isolationLevel: 'read committed' },
              ),
              safetyUnavailable,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                  [subject.accountId],
                )
              ).rows[0]!.snapshot_id,
              current,
            );
          },
        );
      await t.test(
        'an observed baseline release remains exact, and accepted future heads cannot rewrite or erase it',
        async () => {
          const user = await f.actor();
          const profile = await f
            .auth(request(f.http).patch('/v1/me/profile'), user)
            .send({
              expectedRevision: 0,
              nickname: 'ReleasedBaseline',
            });
          assert.equal(profile.status, 200, JSON.stringify(profile.body));
          const profileId = (
            await f.pool.query(
              'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
              [user.accountId],
            )
          ).rows[0]!.public_id;
          const releasedAt = new Date(Date.now() - 2000),
            baseline = syntheticErrandRestriction('publish', {
              endsAt: new Date(Date.now() - 5000),
              releasedAt,
            });
          await seedErrandFeature(f.pool, user.accountId, [baseline]);
          const issue = await f
            .auth(request(f.http).post('/v1/admin/errand-restrictions'), actor)
            .send({
              clientRequestId: randomUUID(),
              targetProfileId: profileId,
              action: 'accept',
              reason: 'Synthetic accepted mutation',
              duration: { kind: 'permanent' },
            });
          assert.equal(issue.status, 200, JSON.stringify(issue.body));
          assert.equal(
            issue.body.outcome,
            'applied',
            JSON.stringify(issue.body),
          );
          const page = await f
            .auth(request(f.http).get('/v1/admin/errand-restrictions'), actor)
            .query({ targetProfileId: profileId });
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.deepEqual(decodeErrandRestrictionPage(page.body), page.body);
          const history = await f.auth(
            request(f.http).get(
              `/v1/admin/errand-restrictions/${baseline.id}/history`,
            ),
            actor,
          );
          assert.equal(history.status, 200, JSON.stringify(history.body));
          assert.deepEqual(
            decodeErrandRestrictionHistory(history.body),
            history.body,
          );
          const view = page.body.items.find(
            (row: { restrictionId: string }) =>
              row.restrictionId === baseline.id,
          );
          assert.equal(view.state, 'released');
          assert.deepEqual(view.terminal, {
            kind: 'baseline_released',
            effectiveAt: releasedAt.toISOString().replace('Z', '000Z'),
          });
          const snapshot = (
            await f.pool.query(
              'SELECT s.* FROM whaleu_safety.errand_feature_heads h JOIN whaleu_safety.errand_feature_snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
              [user.accountId],
            )
          ).rows[0]!;
          for (const released of [
            null,
            new Date(Date.now() - 1000).toISOString(),
          ])
            await assert.rejects(
              seedErrandFeature(f.pool, user.accountId, [
                ...snapshot.restrictions,
                { ...baseline, releasedAt: released },
              ]),
              safetyUnavailable,
            );
          // Keeping its exact accepted release marker is a coherent future envelope.
          await seedErrandFeature(f.pool, user.accountId, [
            ...snapshot.restrictions,
            baseline,
          ]);
          const next = await f
            .auth(request(f.http).post('/v1/admin/errand-restrictions'), actor)
            .send({
              clientRequestId: randomUUID(),
              targetProfileId: profileId,
              action: 'all',
              reason: 'Synthetic later mutation',
              duration: { kind: 'permanent' },
            });
          assert.equal(next.status, 200, JSON.stringify(next.body));
          assert.equal(next.body.outcome, 'applied', JSON.stringify(next.body));
        },
      );
      await t.test(
        'durable restriction evidence survives original session cleanup and freshly authorized receipt replay',
        async () => {
          const target = await f.actor();
          const named = await f
            .auth(request(f.http).patch('/v1/me/profile'), target)
            .send({ expectedRevision: 0, nickname: 'SessionFixture' });
          assert.equal(named.status, 200, JSON.stringify(named.body));
          const profileId = (
            await f.pool.query(
              'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
              [target.accountId],
            )
          ).rows[0]!.public_id;
          const input = {
            clientRequestId: randomUUID(),
            targetProfileId: profileId,
            action: 'all',
            reason: 'Synthetic durable session metadata',
            duration: { kind: 'permanent' },
          };
          const initial = await f
            .auth(request(f.http).post('/v1/admin/errand-restrictions'), actor)
            .send(input);
          assert.equal(initial.status, 200, JSON.stringify(initial.body));
          assert.equal(
            initial.body.outcome,
            'applied',
            JSON.stringify(initial.body),
          );
          const provider = (
            await f.pool.query<{
              provider: 'wechat';
              app_id: string;
              subject: string;
            }>(
              'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0]!;
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          await f.app.get(IdentityRepository).createSession(
            {
              provider: provider.provider,
              appId: provider.app_id,
              subject: provider.subject,
            },
            {
              access: hashToken(accessToken),
              refresh: hashToken(refreshToken),
            },
          );
          await f.pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp()-interval '2 days',revoke_reason='logout' WHERE id=$1",
            [actor.sessionId],
          );
          const maintenance = new IdentityMaintenance(
            f.app.get(DatabaseService),
          );
          const cleaned = await maintenance.run({
            mode: 'apply',
            retentionDays: 1,
            batchSize: 100,
          });
          assert.equal(cleaned.sessions, 1);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_identity.sessions WHERE id=$1',
                [actor.sessionId],
              )
            ).rowCount,
            0,
          );
          const receipt = await request(f.http)
            .get(
              `/v1/admin/errand-restriction-requests/${input.clientRequestId}`,
            )
            .set('Authorization', `Bearer ${accessToken}`);
          assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
          assert.deepEqual(receipt.body, initial.body);
          const replay = await request(f.http)
            .post('/v1/admin/errand-restrictions')
            .set('Authorization', `Bearer ${accessToken}`)
            .send(input);
          assert.equal(replay.status, 200, JSON.stringify(replay.body));
          assert.deepEqual(replay.body, initial.body);
        },
      );
    } finally {
      await f.close();
    }
  },
);
