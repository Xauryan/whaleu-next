import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { AuthorizationRepository } from '../src/authorization/authorization.repository.js';
import type { ActiveGrant } from '../src/authorization/contracts.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import type { IdentityService } from '../src/identity/identity.service.js';

const actorId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const upperId = '00000000-0000-4000-8000-000000000003';
function authorization(grants: ActiveGrant[]) {
  return new AuthorizationService(
    {} as DatabaseService,
    {} as IdentityService,
    {
      activeGrants: async (accountId: string) => {
        assert.equal(accountId, actorId);
        return grants;
      },
    } as unknown as AuthorizationRepository,
  );
}
const grant = (
  id: string,
  role: ActiveGrant['role'],
  validUntil: number | null = null,
): ActiveGrant => ({
  id,
  role,
  validUntil,
  operatingRegionId: null,
});

test('title maintenance selects exact fresh global grant deterministically without accepting school scope', async () => {
  const developer = grant(targetId, 'developer', 2000);
  const otherDeveloper = grant(upperId, 'developer');
  const superAdmin = grant(actorId, 'super_admin');
  const tx = {} as PoolClient;
  for (const grants of [
    [otherDeveloper, superAdmin, developer],
    [developer, otherDeveloper, superAdmin],
  ]) {
    assert.deepEqual(
      await authorization(grants).requireGlobalTitleMaintenance(actorId, tx),
      developer,
    );
  }
  assert.deepEqual(
    await authorization([superAdmin]).requireGlobalTitleMaintenance(
      actorId,
      tx,
    ),
    superAdmin,
  );
  for (const grants of [
    [],
    [grant(actorId, 'school_admin')],
    [{ ...grant(actorId, 'school_admin'), operatingRegionId: targetId }],
    [{ ...developer, operatingRegionId: targetId }],
  ]) {
    await assert.rejects(
      authorization(grants).requireGlobalTitleMaintenance(actorId, tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'AUTHORIZATION_REQUIRED',
    );
  }
});

test('selected title authority expires after deferred proof waits even when another global grant is unbounded', async () => {
  let now = 1000;
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') now = 2000;
      return { rows: [{ now: new Date(now) }] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    await authorization([
      grant(actorId, 'developer', 2000),
      grant(targetId, 'super_admin'),
    ]).requireGlobalTitleMaintenance(actorId, tx);
    await assert.rejects(
      checkTransactionDeadlines(tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'AUTHORIZATION_UNAVAILABLE',
    );
    assert.deepEqual(statements, [
      'SET CONSTRAINTS ALL IMMEDIATE',
      'SELECT clock_timestamp() AS now',
    ]);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('identity sweep captures DB millisecond boundary and at most one owner plus lookahead without locks', async () => {
  const now = new Date('2026-10-08T00:00:00.123Z');
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: sql.includes('date_trunc')
          ? [{ now }]
          : sql.includes('DESC')
            ? [{ id: upperId }]
            : [{ id: targetId }, { id: upperId }],
      };
    },
  } as unknown as PoolClient;
  const repository = new IdentityRepository({} as DatabaseService);
  const sweep = await repository.beginTitleMaintenanceSweep(tx);
  assert.deepEqual(sweep, { runStartedAt: now, upperAccountId: upperId });
  assert.deepEqual(
    await repository.titleMaintenanceCandidateWindow(
      { ...sweep, cursorAccountId: actorId },
      tx,
    ),
    [targetId, upperId],
  );
  assert.match(
    calls[0]!.sql,
    /date_trunc\('milliseconds', clock_timestamp\(\)\)/,
  );
  assert.match(calls[1]!.sql, /created_at <= \$1 ORDER BY id DESC LIMIT 1/);
  assert.match(calls[2]!.sql, /id > \$1/);
  assert.match(calls[2]!.sql, /id <= \$2::uuid/);
  assert.match(calls[2]!.sql, /created_at <= \$3 ORDER BY id LIMIT 2/);
  assert.deepEqual(calls[2]!.values, [actorId, upperId, now]);
  assert.doesNotMatch(
    calls.map(({ sql }) => sql).join('\n'),
    /FOR (SHARE|UPDATE)|OFFSET|SKIP LOCKED|status/,
  );
  assert.deepEqual(
    await repository.titleMaintenanceCandidateWindow(
      { runStartedAt: now, upperAccountId: null, cursorAccountId: null },
      tx,
    ),
    [],
  );
  assert.equal(calls.length, 3);
});

test('canonical default-title eligibility locks account then one provider proof, rechecks it, and exports boolean only', async () => {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let accountExists = true;
  let providerExists = true;
  let stillEligible = true;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM whaleu_identity.accounts'))
        return {
          rows: accountExists ? [{ id: targetId, status: 'blocked' }] : [],
        };
      if (sql.includes('SELECT app_id'))
        return {
          rows: providerExists
            ? [{ app_id: 'private-app', subject: 'private-subject' }]
            : [],
        };
      return { rows: [{ eligible: stillEligible }] };
    },
  } as unknown as PoolClient;
  const repository = new IdentityRepository({} as DatabaseService);
  assert.equal(
    await repository.canonicalWechatTitleEligibility(targetId, tx),
    true,
  );
  assert.match(calls[0]!.sql, /accounts WHERE id=\$1 FOR SHARE/);
  assert.match(calls[1]!.sql, /provider='wechat'/);
  assert.match(calls[1]!.sql, /ORDER BY app_id, subject LIMIT 1 FOR SHARE/);
  assert.match(calls[2]!.sql, /SELECT EXISTS/);
  assert.deepEqual(calls[2]!.values, [
    targetId,
    'private-app',
    'private-subject',
  ]);
  assert.doesNotMatch(
    calls.map(({ sql }) => sql).join('\n'),
    /FOR UPDATE|INSERT|status|union_subject|SKIP LOCKED/,
  );
  stillEligible = false;
  assert.equal(
    await repository.canonicalWechatTitleEligibility(targetId, tx),
    false,
  );
  providerExists = false;
  calls.length = 0;
  assert.equal(
    await repository.canonicalWechatTitleEligibility(targetId, tx),
    false,
  );
  assert.equal(calls.length, 2);
  accountExists = false;
  calls.length = 0;
  assert.equal(
    await repository.canonicalWechatTitleEligibility(targetId, tx),
    false,
  );
  assert.equal(calls.length, 1);
});
