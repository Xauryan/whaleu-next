import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareDeletionSchema,
  recoverySecretSchema,
  REAL_DELETION_CONSENT,
  REAL_DELETION_PROTOCOL,
  type RealDeletionReceipt,
} from '../src/account-deletion/real/contracts.js';
import {
  preparationIntentHash,
  preparationRecoveryHash,
  equalRecoveryHash,
  cancellationIntentHash,
} from '../src/account-deletion/real/recovery.js';
import {
  exactReplay,
  requireNewAcceptance,
  requireNewCancellation,
  realDeletionActivation,
} from '../src/account-deletion/real/protocol.js';
import { requireToken } from '../src/identity/tokens.js';
import { createLogger } from '../src/observability/logger.js';
import { loadConfig } from '../src/config/config.js';
import { RealDeletionService } from '../src/account-deletion/real/service.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';

const account = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const secret = 'wu_dr_' + Buffer.alloc(32, 17).toString('base64url'); // deterministic test-only bytes
const intent = {
  version: 1 as const,
  intentId: id,
  expectedGeneration: '0',
  consent: REAL_DELETION_CONSENT,
};
const current = {
  phase: 'prepared' as const,
  credentialCurrent: true,
  generationCurrent: true,
  preparationLive: true,
  coolingBeforeDeadline: true,
  irreversibleAbsent: true,
  revision: '0',
};
const receipt: RealDeletionReceipt = {
  protocol: REAL_DELETION_PROTOCOL,
  intentId: id,
  phase: 'cooling',
  revision: '1',
  preparedAt: '2026-01-01T00:00:00.000Z',
  preparationExpiresAt: '2026-01-01T00:15:00.000Z',
  acceptedAt: '2026-01-01T00:01:00.000Z',
  cancelBefore: '2026-01-08T00:01:00.000Z',
  completedAt: null,
};

test('preparation secret has exact canonical32-byte encoding and a distinct token purpose', () => {
  assert.equal(recoverySecretSchema.parse(secret), secret);
  for (const value of [
    secret + '=',
    secret.slice(0, -1),
    secret.replace('wu_dr_', 'wu_a_'),
    secret.slice(0, -1) + 'F',
    'wu_dr_' + Buffer.alloc(31).toString('base64url'),
  ])
    assert.equal(recoverySecretSchema.safeParse(value).success, false);
  assert.throws(() => requireToken(secret, 'access'));
  assert.throws(() => requireToken(secret, 'refresh'));
});
test('strict prepare cannot claim account, authority, provider or lifecycle state', () => {
  assert.equal(
    prepareDeletionSchema.parse({ ...intent, recoverySecret: secret }).intentId,
    id,
  );
  for (const field of [
    'accountId',
    'provider',
    'scope',
    'accepted',
    'coverage',
    'epoch',
  ])
    assert.equal(
      prepareDeletionSchema.safeParse({
        ...intent,
        recoverySecret: secret,
        [field]: true,
      }).success,
      false,
    );
  assert.equal(
    prepareDeletionSchema.safeParse({
      ...intent,
      recoverySecret: secret,
      expectedGeneration: '9223372036854775807',
    }).success,
    false,
  );
});
test('private recovery hash binds exact account, intent and both generations without retaining raw secret', () => {
  const expected = preparationRecoveryHash(account, intent, secret);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert(equalRecoveryHash(expected, expected));
  for (const other of [
    preparationRecoveryHash(
      '10000000-0000-4000-8000-000000000002',
      intent,
      secret,
    ),
    preparationRecoveryHash(
      account,
      { ...intent, intentId: '20000000-0000-4000-8000-000000000002' },
      secret,
    ),
    preparationRecoveryHash(
      account,
      { ...intent, expectedGeneration: '1' },
      secret,
    ),
  ])
    assert(!equalRecoveryHash(expected, other));
  assert(!equalRecoveryHash('x', expected));
  assert.notEqual(expected, preparationIntentHash(intent));
});
test('intent hashes exclude code and private secret; cancellation remains exactcommand/revision', () => {
  const command = {
    intentId: id,
    recoverySecret: secret,
    commandId: '30000000-0000-4000-8000-000000000001',
    expectedRevision: '1',
    action: 'explicitly-cancel-real-account-deletion-v1' as const,
  };
  assert.equal(
    cancellationIntentHash(command),
    cancellationIntentHash({ ...command, recoverySecret: secret + 'x' }),
  );
  assert.notEqual(
    cancellationIntentHash(command),
    cancellationIntentHash({ ...command, expectedRevision: '2' }),
  );
});
test('state-machine unit only: exact accepted/cancelled replay precedes new-execution state checks', () => {
  assert.equal(exactReplay({ intentHash: 'fixed', receipt }, 'fixed'), receipt);
  const cancelled = { ...receipt, phase: 'cancelled' as const };
  assert.equal(
    exactReplay({ intentHash: 'cancel', receipt: cancelled }, 'cancel'),
    cancelled,
  );
  assert.throws(() => exactReplay({ intentHash: 'old', receipt }, 'changed'));
  assert.equal(exactReplay(null, 'fixed'), null);
});
test('state-machine unit only: prepared never cancels and cutoff/irreversibility are database decisions', () => {
  requireNewAcceptance(current);
  assert.throws(() => requireNewCancellation(current, '0'));
  const cooling = { ...current, phase: 'cooling' as const };
  requireNewCancellation(cooling, '0');
  for (const state of [
    { ...cooling, coolingBeforeDeadline: false },
    { ...cooling, irreversibleAbsent: false },
    { ...cooling, generationCurrent: false },
    { ...cooling, credentialCurrent: false },
  ])
    assert.throws(() => requireNewCancellation(state, '0'));
  assert.throws(() => requireNewCancellation(cooling, '1'));
  assert.throws(() =>
    requireNewAcceptance({ ...current, preparationLive: false }),
  );
});
test('new secret fields are redacted at top-level, child and request-body positions', () => {
  let output = '';
  const logger = createLogger('info', {
    write: (value: string) => {
      output += value;
    },
  });
  logger.info({
    recoverySecret: secret,
    replacementSecret: secret,
    nested: { recoverySecret: secret, replacementSecret: secret },
    req: { body: { recoverySecret: secret } },
    code: 'test-platform-code',
  });
  assert(!output.includes(secret));
  assert(!output.includes('test-platform-code'));
  assert(output.includes('[REDACTED]'));
});
test('ordinary default config remains disabled and no environment choice grants acceptance', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://127.0.0.1/whaleu_test',
  });
  assert.equal(config.REAL_ACCOUNT_DELETION_ENTRY, 'disabled');
  assert.throws(() =>
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://127.0.0.1/whaleu_test',
      REAL_ACCOUNT_DELETION_ENTRY: 'enabled',
    }),
  );
  assert.deepEqual(realDeletionActivation(), {
    acceptance: 'unavailable',
    ownerCoverage: 'unproven',
    legacyReaderRetirement: 'unproven',
  });
});
test('disabled real entry does not touch DB or mint credentials', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://127.0.0.1/whaleu_test',
  });
  const service = new RealDeletionService(
    config,
    {} as DatabaseService,
    {} as IdentityService,
  );
  assert.throws(
    () => service.prepare('untrusted', { ...intent, recoverySecret: secret }),
    /Account deletion is unavailable/,
  );
  assert.throws(
    () => service.status({ intentId: id, recoverySecret: secret }),
    /Account deletion is unavailable/,
  );
  await assert.rejects(
    service.accept({ ...intent, recoverySecret: secret, code: 'code' }),
    /Account deletion is unavailable/,
  );
  await assert.rejects(service.cancel({}), /Account deletion is unavailable/);
});
