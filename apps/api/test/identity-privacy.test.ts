import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { ActiveGrant } from '../src/authorization/contracts.js';
import type { CommunityContentIdentityService } from '../src/community/content-identity.service.js';
import type { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { IdentityAuditRepository } from '../src/identity-privacy/identity-audit.repository.js';
import type { IdentityAuditEntry } from '../src/identity-privacy/identity-audit.repository.js';
import { IdentityPrivacyService } from '../src/identity-privacy/identity-privacy.service.js';
import type { PrivateIdentityRepository } from '../src/identity-privacy/private-identity.repository.js';
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const target = { kind: 'post', id: randomUUID() } as const;
const accountId = randomUUID(),
  sessionId = randomUUID(),
  ownerId = randomUUID();
const grant: ActiveGrant = {
  id: randomUUID(),
  role: 'developer',
  operatingRegionId: null,
};
function fixture() {
  let commits = 0,
    rollbacks = 0,
    ownerReads = 0,
    checks = 0;
  const audits: IdentityAuditEntry[] = [];
  const state = {
    grants: [grant] as ActiveGrant[],
    expireOnRecheck: false,
    auditFails: false,
    commitFails: false,
    sourceFails: false,
  };
  const client = {} as PoolClient;
  const database = {
    transaction: async <T>(
      operation: (transaction: PoolClient) => Promise<T>,
    ) => {
      try {
        const result = await operation(client);
        if (state.commitFails) throw new Error('synthetic COMMIT failure');
        commits++;
        return result;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  } as DatabaseService;
  const identity = {
    session: async () => ({
      accountId,
      sessionId,
      expiresAt: 1000,
      refreshExpiresAt: 2000,
    }),
  } as unknown as IdentityService;
  const authorization = {
    grants: async () => {
      checks++;
      return state.expireOnRecheck && checks > 1 ? [] : state.grants;
    },
  } as unknown as AuthorizationService;
  const owners = {
    resolve: async () => {
      ownerReads++;
      return {
        accountId: ownerId,
        authorMode: 'anonymous',
        operatingRegionId: null,
      };
    },
  } as unknown as CommunityContentIdentityService;
  const identities = {
    resolve: async () => {
      if (state.sourceFails) throw new Error('private payload must not escape');
      return {
        accountId: ownerId,
        nickname: 'PrivateNickname',
        avatar: null,
        studentNumber: '00004721',
        studentNumberStatus: 'verified',
      };
    },
  } as unknown as PrivateIdentityRepository;
  const audit = {
    append: async (entries: IdentityAuditEntry[]) => {
      if (state.auditFails)
        throw new ApplicationError('IDENTITY_AUDIT_UNAVAILABLE');
      audits.push(...entries);
    },
  } as IdentityAuditRepository;
  return {
    state,
    audits,
    committed: () => commits,
    rolledBack: () => rollbacks,
    ownerReads: () => ownerReads,
    service: new IdentityPrivacyService(
      database,
      identity,
      authorization,
      owners,
      identities,
      audit,
    ),
  };
}

test('identity result returns after committed metadata-only audit; source owner is authoritative', async () => {
  const f = fixture();
  const result = await f.service.view(
    'synthetic-token',
    { targets: [target] },
    randomUUID(),
  );
  assert.equal(f.committed(), 1);
  assert.equal(result.items[0]?.status, 'available');
  assert.equal(f.audits.length, 1);
  assert.deepEqual(f.audits[0]?.fields, [
    'accountId',
    'nickname',
    'studentNumber',
  ]);
  const ledger = JSON.stringify(f.audits);
  for (const secret of [
    ownerId,
    'PrivateNickname',
    '00004721',
    'synthetic-token',
  ])
    assert.equal(ledger.includes(secret), false);
});

test('ordinary, school and super admins are denied before content lookup, with committed audit', async () => {
  for (const grants of [
    [],
    [{ ...grant, role: 'school_admin', operatingRegionId: randomUUID() }],
    [{ ...grant, role: 'super_admin' }],
  ] as ActiveGrant[][]) {
    const f = fixture();
    f.state.grants = grants;
    await assert.rejects(
      f.service.view('synthetic', { targets: [target] }, randomUUID()),
      errorIs('AUTHORIZATION_REQUIRED'),
    );
    assert.equal(f.committed(), 1);
    assert.equal(f.ownerReads(), 0);
    assert.equal(f.audits[0]?.outcome, 'denied');
  }
});

test('audit insert or COMMIT failure cannot return identity values', async () => {
  const auditFailure = fixture();
  auditFailure.state.auditFails = true;
  await assert.rejects(
    auditFailure.service.view('synthetic', { targets: [target] }, randomUUID()),
    errorIs('IDENTITY_AUDIT_UNAVAILABLE'),
  );
  assert.equal(auditFailure.committed(), 0);
  assert.equal(auditFailure.rolledBack(), 1);
  const commitFailure = fixture();
  commitFailure.state.commitFails = true;
  await assert.rejects(
    commitFailure.service.view(
      'synthetic',
      { targets: [target] },
      randomUUID(),
    ),
    /COMMIT/,
  );
  assert.equal(commitFailure.committed(), 0);
});

test('expiry is rechecked after source resolution and prevents any disclosure', async () => {
  const f = fixture();
  f.state.expireOnRecheck = true;
  await assert.rejects(
    f.service.view('synthetic', { targets: [target] }, randomUUID()),
    errorIs('AUTHORIZATION_REQUIRED'),
  );
  assert.equal(f.committed(), 1);
  assert.equal(f.audits[0]?.outcome, 'denied');
  assert.deepEqual(f.audits[0]?.fields, []);
});

test('failed source yields safe unavailable error and committed attempt metadata', async () => {
  const f = fixture();
  f.state.sourceFails = true;
  await assert.rejects(
    f.service.view('synthetic', { targets: [target] }, randomUUID()),
    errorIs('IDENTITY_VIEW_UNAVAILABLE'),
  );
  assert.equal(f.committed(), 1);
  assert.equal(f.audits[0]?.outcome, 'unavailable');
  assert.deepEqual(f.audits[0]?.fields, []);
});

test('audit must insert exactly one metadata row per target, including silent trigger suppression', async () => {
  const repository = new IdentityAuditRepository();
  const entry: IdentityAuditEntry = {
    batchId: randomUUID(),
    actorAccountId: accountId,
    sessionId,
    grantId: grant.id,
    requestId: randomUUID(),
    target,
    outcome: 'disclosed',
    fields: ['accountId'],
  };
  for (const rowCount of [0, null]) {
    const transaction = {
      query: async () => ({ rows: [], rowCount }),
    } as unknown as PoolClient;
    await assert.rejects(
      repository.append([entry], transaction),
      errorIs('IDENTITY_AUDIT_UNAVAILABLE'),
    );
  }
});
