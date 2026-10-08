import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { ErrandNotificationsFacade } from '../../src/notifications/errand.facade.js';
import { SafetyErrandManagementFacade } from '../../src/safety/errand-management/facade.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import type {
  ErrandRestrictionAction,
  ErrandRestrictionDuration,
} from '../../src/safety/errand-management/contracts.js';
const invalid = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23514';
test(
  'Safety SQL intent/effect and durable obligation corroboration on managed owner transactions',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    try {
      const actor = await f.actor(),
        target = await f.actor(),
        other = await f.actor();
      const profile = await f
        .auth(request(f.http).patch('/v1/me/profile'), target)
        .send({ expectedRevision: 0, nickname: 'IntentFixture' });
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      const profileId = (
        await f.pool.query(
          'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
          [target.accountId],
        )
      ).rows[0]!.public_id;
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'Synthetic intent binding test')",
        [randomUUID(), actor.accountId],
      );
      const safety = f.app.get(SafetyErrandManagementFacade),
        access = f.app.get(ErrandAccessService),
        authorization = f.app.get(AuthorizationService),
        notices = f.app.get(ErrandNotificationsFacade);
      const body = (requestId: string) => ({
        clientRequestId: requestId,
        targetProfileId: profileId,
        action: 'all' as const,
        reason: 'Exact canonical reason',
        duration: { kind: 'permanent' as const },
      });
      const digest = (command: unknown) =>
        createHash('sha256')
          .update(
            'whaleu:errand-restriction-command:v1\n' +
              canonicalJson({ operation: 'issue', intent: { command } }),
          )
          .digest('hex');
      const heads = async () =>
        (
          await f.pool.query(
            'SELECT account_id,snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',
            [[target.accountId, other.accountId]],
          )
        ).rows;
      const before = await heads();
      for (const scenario of [
        'wrong_target',
        'wrong_action',
        'wrong_reason',
        'wrong_duration',
        'missing_notice',
        'missing_receipt',
      ] as const)
        await t.test(scenario, async () => {
          const requestId = randomUUID(),
            command = body(requestId);
          await assert.rejects(
            inTransaction(
              f.pool,
              async (tx) => {
                const session = await access.common(
                    actor.accessToken,
                    tx,
                    true,
                  ),
                  grant = await authorization.requireGlobalErrandManagement(
                    actor.accountId,
                    tx,
                  );
                const context = {
                  actorId: actor.accountId,
                  sessionId: session.sessionId,
                  grantId: grant.id,
                  requestId,
                  kind: 'global' as const,
                  operation: 'issue' as const,
                };
                await safety.beginGlobalRequest(
                  context,
                  digest(command),
                  { command },
                  tx,
                );
                const subjectId =
                  scenario === 'wrong_target'
                    ? other.accountId
                    : target.accountId;
                await authorization.requireUnprotectedErrandTarget(
                  subjectId,
                  tx,
                );
                const action: ErrandRestrictionAction =
                  scenario === 'wrong_action' ? 'publish' : 'all';
                const duration: ErrandRestrictionDuration =
                  scenario === 'wrong_duration'
                    ? { kind: 'finite', unit: 'hours', value: 1 }
                    : { kind: 'permanent' };
                const result = await safety.issue(
                  context,
                  {
                    subjectId,
                    action,
                    reason:
                      scenario === 'wrong_reason'
                        ? 'Changed reason'
                        : command.reason,
                    duration,
                  },
                  tx,
                );
                if (scenario !== 'missing_notice')
                  await notices.recordFeature(result.notice, tx);
                if (scenario !== 'missing_receipt')
                  await safety.finishGlobalRequest(
                    actor.accountId,
                    requestId,
                    {
                      requestId,
                      operation: 'issue',
                      outcome: 'applied',
                      restrictionId: result.restrictionId,
                      eventId: result.eventId,
                      occurredAt: result.occurredAt,
                    },
                    tx,
                  );
                await access.recheck(actor.accessToken, tx);
              },
              { isolationLevel: 'read committed' },
            ),
            invalid,
          );
          assert.deepEqual(await heads(), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_requests WHERE request_id=$1',
                [requestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=ANY($1::uuid[])',
                [[target.accountId, other.accountId]],
              )
            ).rowCount,
            0,
          );
        });
      await t.test(
        'immutable rejected request cannot acquire a later command without an applied receipt',
        async () => {
          const requestId = randomUUID(),
            command = body(requestId);
          await inTransaction(
            f.pool,
            async (tx) => {
              const session = await access.common(actor.accessToken, tx, true),
                grant = await authorization.requireGlobalErrandManagement(
                  actor.accountId,
                  tx,
                );
              await safety.beginGlobalRequest(
                {
                  actorId: actor.accountId,
                  sessionId: session.sessionId,
                  grantId: grant.id,
                  requestId,
                  kind: 'global',
                  operation: 'issue',
                },
                digest(command),
                { command },
                tx,
              );
              await safety.finishGlobalRequest(
                actor.accountId,
                requestId,
                {
                  requestId,
                  operation: 'issue',
                  outcome: 'rejected',
                  code: 'ERRAND_RESTRICTION_TARGET_PROTECTED',
                },
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
          await assert.rejects(
            inTransaction(
              f.pool,
              async (tx) => {
                const session = await access.common(
                    actor.accessToken,
                    tx,
                    true,
                  ),
                  grant = await authorization.requireGlobalErrandManagement(
                    actor.accountId,
                    tx,
                  );
                await authorization.requireUnprotectedErrandTarget(
                  target.accountId,
                  tx,
                );
                const result = await safety.issue(
                  {
                    actorId: actor.accountId,
                    sessionId: session.sessionId,
                    grantId: grant.id,
                    requestId,
                    kind: 'global',
                    operation: 'issue',
                  },
                  {
                    subjectId: target.accountId,
                    action: 'all',
                    reason: command.reason,
                    duration: command.duration,
                  },
                  tx,
                );
                await notices.recordFeature(result.notice, tx);
              },
              { isolationLevel: 'read committed' },
            ),
            invalid,
          );
          assert.deepEqual(await heads(), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT receipt FROM whaleu_safety.errand_restriction_requests WHERE request_id=$1',
                [requestId],
              )
            ).rows[0]!.receipt.outcome,
            'rejected',
          );
        },
      );
      await t.test(
        'a committed delete-only scoped request cannot acquire a later optional restriction',
        async () => {
          const order = await f.publish(target),
            requestId = randomUUID();
          const deleted = await f
            .auth(
              request(f.http).post(`/v1/admin/errands/${order.id}/delete`),
              actor,
            )
            .send({
              clientRequestId: requestId,
              expectedRevision: order.revision,
              deleteReason: 'Synthetic delete only',
              publisherRestriction: null,
            });
          assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
          assert.equal(
            deleted.body.outcome,
            'applied',
            JSON.stringify(deleted.body),
          );
          await assert.rejects(
            inTransaction(
              f.pool,
              async (tx) => {
                const session = await access.common(
                    actor.accessToken,
                    tx,
                    true,
                  ),
                  selected = await authorization.requireErrandManagement(
                    actor.accountId,
                    f.scope.home.regionId,
                    tx,
                  );
                await authorization.requireUnprotectedErrandTarget(
                  target.accountId,
                  tx,
                );
                const result = await safety.issue(
                  {
                    actorId: actor.accountId,
                    sessionId: session.sessionId,
                    grantId: selected.grant.id,
                    requestId,
                    kind: 'order',
                    operation: 'admin_delete',
                    orderId: order.id,
                    targetRegionId: f.scope.home.regionId,
                  },
                  {
                    subjectId: target.accountId,
                    action: 'all',
                    reason: 'Forbidden appended restriction',
                    duration: { kind: 'permanent' },
                  },
                  tx,
                );
                await notices.recordFeature(result.notice, tx);
              },
              { isolationLevel: 'read committed' },
            ),
            invalid,
          );
          assert.deepEqual(await heads(), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_commands WHERE request_id=$1',
                [requestId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'a valid event with OVERRIDING SYSTEM VALUE cannot conceal sourceVersion advancement',
        async () => {
          await inTransaction(
            f.pool,
            async (tx) => {
              const session = await access.common(actor.accessToken, tx, true),
                grant = await authorization.requireGlobalErrandManagement(
                  actor.accountId,
                  tx,
                ),
                requestId = randomUUID(),
                command = body(requestId);
              const context = {
                actorId: actor.accountId,
                sessionId: session.sessionId,
                grantId: grant.id,
                requestId,
                kind: 'global' as const,
                operation: 'issue' as const,
              };
              await safety.beginGlobalRequest(
                context,
                digest(command),
                { command },
                tx,
              );
              await authorization.requireUnprotectedErrandTarget(
                target.accountId,
                tx,
              );
              const previous = BigInt(await safety.sourceVersion(tx));
              const original = tx.query,
                run = original.bind(tx) as (
                  sql: string,
                  values?: unknown[],
                ) => Promise<QueryResult>;
              let overrideAttempted = false;
              tx.query = ((sql: string, values?: unknown[]) => {
                if (
                  sql.includes(
                    'errand_restriction_events(id,restriction_id,kind,command_id,effective_at,recorded_at,reason)',
                  ) &&
                  sql.includes("'issued'")
                ) {
                  overrideAttempted = true;
                  sql = sql
                    .replace(
                      'errand_restriction_events(id,',
                      'errand_restriction_events(sequence,id,',
                    )
                    .replace(' VALUES(', ' OVERRIDING SYSTEM VALUE VALUES(1,');
                }
                return run(sql, values);
              }) as PoolClient['query'];
              let result;
              try {
                result = await safety.issue(
                  context,
                  {
                    subjectId: target.accountId,
                    action: 'all',
                    reason: command.reason,
                    duration: command.duration,
                  },
                  tx,
                );
              } finally {
                tx.query = original;
              }
              assert.equal(overrideAttempted, true);
              const sequence = BigInt(
                (
                  await tx.query(
                    'SELECT sequence::text FROM whaleu_safety.errand_restriction_events WHERE id=$1',
                    [result.eventId],
                  )
                ).rows[0]!.sequence,
              );
              assert.ok(sequence > previous);
              assert.notEqual(sequence, 1n);
              assert.ok(BigInt(await safety.sourceVersion(tx)) > previous);
              await notices.recordFeature(result.notice, tx);
              await safety.finishGlobalRequest(
                actor.accountId,
                requestId,
                {
                  requestId,
                  operation: 'issue',
                  outcome: 'applied',
                  restrictionId: result.restrictionId,
                  eventId: result.eventId,
                  occurredAt: result.occurredAt,
                },
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
