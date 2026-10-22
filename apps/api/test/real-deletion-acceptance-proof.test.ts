import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  acceptedRequestReceipt,
  authenticatePreparationCapability,
} from '../src/account-deletion/real/request-repository.js';
import {
  REAL_DELETION_CONSENT,
  acceptDeletionSchema,
} from '../src/account-deletion/real/contracts.js';
import {
  preparationIntentHash,
  preparationRecoveryHash,
} from '../src/account-deletion/real/recovery.js';
import { ApplicationError } from '../src/http/application-error.js';
import { retainAcceptanceSession } from '../src/account-deletion/real/acceptance-proof.js';
import { preparationCatalogBody } from '../src/account-deletion/real/catalog.js';
import { requestCatalogBody } from '../src/account-deletion/real/request-catalog.js';
import {
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
} from '../src/identity/session-epoch-contract.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

test('acceptance locks and final fact retain detached original scope despite caller mutation during schema await', async () => {
  const input = {
    requestId: '10000000-0000-4000-8000-000000000001',
    accountId: '10000000-0000-4000-8000-000000000002',
    expectedGeneration: '0',
    accessHash: 'a'.repeat(64),
  };
  const original = { ...input },
    session = '10000000-0000-4000-8000-000000000003';
  let mutated = false;
  const reads: { sql: string; values: unknown[] | undefined }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      reads.push({ sql, values });
      if (!mutated) {
        mutated = true;
        input.requestId = '20000000-0000-4000-8000-000000000001';
        input.accountId = '20000000-0000-4000-8000-000000000002';
        input.expectedGeneration = '7';
        input.accessHash = 'b'.repeat(64);
        await Promise.resolve();
      }
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config(')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: [{ locked: true }] };
      if (sql.includes('-schema-metadata-v1')) {
        const request = sql.includes('real-request'),
          body = request ? requestCatalogBody : preparationCatalogBody;
        const signature = {
          invoker: true,
          sql: true,
          config: ['search_path=pg_catalog'],
          scalar: true,
          safe: true,
        };
        return {
          rows: [
            {
              catalogFunction: { ...signature, stable: true, body },
              marker: {
                ...signature,
                immutable: true,
                sameOwner: true,
                body: `SELECT '${JSON.stringify(request ? { version: 1, protocol: 'real-account-deletion-request-v1', migration: '0182_real_deletion_request_authority.sql', admission: 'separate_owner_required', catalog: 'f'.repeat(64) } : { version: 2, protocol: 'real-account-deletion-preparation-v2', migration: '0182_real_deletion_request_authority.sql', acceptance: 'unavailable', catalog: 'f'.repeat(64) })}'::jsonb`,
              },
            },
          ],
        };
      }
      if (sql.includes('_catalog() catalog'))
        return { rows: [{ catalog: 'f'.repeat(64) }] };
      if (sql.includes('identity-session-epoch-schema'))
        return {
          rows: [
            {
              qualified: true,
              body_hashes: [
                sessionEpochAccountBody,
                sessionEpochIssuedBody,
                sessionEpochMarkerBody,
              ].map((v) => createHash('sha256').update(v).digest('hex')),
            },
          ],
        };
      if (sql.includes('SELECT s.id session_id'))
        return { rows: [{ session_id: session }] };
      if (sql.includes('current_epoch'))
        return {
          rows: [
            {
              account_id: original.accountId,
              session_id: session,
              generation: '0',
              current_epoch: '0',
              issued_epoch: '0',
              status: 'active',
              lifecycle: 'active',
              revoked: false,
              live: true,
              token_until: '2099-01-01 00:00:00.000001+00',
              absolute_until: '2099-01-02 00:00:00.000001+00',
            },
          ],
        };
      if (sql.includes('FOR UPDATE NOWAIT') || sql.includes('FOR SHARE NOWAIT'))
        return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(client);
  try {
    const fact = await retainAcceptanceSession(client, input);
    assert.deepEqual(fact, {
      ...original,
      sessionId: session,
      previousEpoch: '0',
      nextEpoch: '1',
    });
    assert(Object.isFrozen(fact));
    for (const read of reads.filter((r) => r.sql.includes('FOR UPDATE NOWAIT')))
      assert.deepEqual(read.values, [original.accountId]);
    assert(!JSON.stringify(reads).includes(input.accountId));
    assert(!JSON.stringify(reads).includes(input.accessHash));
  } finally {
    clearTransactionDeadlines(client);
  }
});

test('accepted receipt unit: full strict AcceptDeletion binds only the four intent fields and separately verifies secret', async () => {
  const intent = {
    version: 1 as const,
    intentId: '10000000-0000-4000-8000-000000000001',
    expectedGeneration: '0',
    consent: REAL_DELETION_CONSENT,
  };
  const account = '10000000-0000-4000-8000-000000000002';
  const secret = 'wu_dr_' + Buffer.alloc(32, 17).toString('base64url');
  const command = acceptDeletionSchema.parse({
    ...intent,
    recoverySecret: secret,
    code: 'unit-provider-code',
  });
  // The hash API deliberately stays strict. The repository must project intent,
  // not make this lower-level API silently accept codes or capabilities.
  assert.throws(
    () => preparationIntentHash(command),
    (error: unknown) => error instanceof Error && error.name === 'ZodError',
  );
  const prepared = {
    intent_id: intent.intentId,
    account_id: account,
    base_generation: '0',
    next_generation: '1',
    current: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: new Date('2026-01-01T00:15:00Z'),
    expires_at_exact: '2026-01-01 00:15:00+00',
    consent: intent.consent,
    intent_hash: preparationIntentHash(intent),
    recovery_hash: preparationRecoveryHash(account, intent, secret),
  };
  const date = new Date('2026-01-01T00:00:00Z');
  const stored = {
    id: intent.intentId,
    account_id: account,
    generation: '1',
    previous_epoch: '0',
    revoked_epoch: '1',
    intent_hash: prepared.intent_hash,
    recovery_hash: prepared.recovery_hash,
    phase: 'cooling',
    revision: '1',
    prepared_at: date,
    preparation_expires_at: date,
    accepted_at: date,
    cancel_before: date,
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config(')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: [{ locked: true }] };
      if (sql.includes('-schema-metadata-v1')) {
        const request = sql.includes('real-request');
        const signature = {
          invoker: true,
          sql: true,
          config: ['search_path=pg_catalog'],
          scalar: true,
          safe: true,
        };
        return {
          rows: [
            {
              catalogFunction: {
                ...signature,
                stable: true,
                body: request ? requestCatalogBody : preparationCatalogBody,
              },
              marker: {
                ...signature,
                immutable: true,
                sameOwner: true,
                body: `SELECT '${JSON.stringify(request ? { version: 1, protocol: 'real-account-deletion-request-v1', migration: '0182_real_deletion_request_authority.sql', admission: 'separate_owner_required', catalog: 'f'.repeat(64) } : { version: 2, protocol: 'real-account-deletion-preparation-v2', migration: '0182_real_deletion_request_authority.sql', acceptance: 'unavailable', catalog: 'f'.repeat(64) })}'::jsonb`,
              },
            },
          ],
        };
      }
      if (sql.includes('_catalog() catalog'))
        return { rows: [{ catalog: 'f'.repeat(64) }] };
      if (sql.includes('SELECT r.*'))
        return { rows: values?.[0] === intent.intentId ? [stored] : [] };
      if (sql.includes('SELECT p.*'))
        return {
          rows: values?.[0] === intent.intentId ? [{ ...prepared }] : [],
        };
      if (sql.includes('FOR SHARE NOWAIT')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const run = async (input: unknown) => {
    startTransactionDeadlines(client);
    try {
      return await acceptedRequestReceipt(client, input);
    } finally {
      clearTransactionDeadlines(client);
    }
  };
  // Read-only unit observation only: models an expired preparation with current
  // false. This does NOT claim natural15-minute expiry was exercised in PG.
  startTransactionDeadlines(client);
  try {
    const capability = await authenticatePreparationCapability(client, command);
    assert(Object.isFrozen(capability));
    assert(!Object.isFrozen(prepared));
    assert.notStrictEqual(capability, prepared);
    assert.equal(capability.current, false);
    assert.equal(capability.expires_at_exact, '2026-01-01 00:15:00+00');
    assert.equal(
      (await acceptedRequestReceipt(client, command))?.phase,
      'cooling',
    );
  } finally {
    clearTransactionDeadlines(client);
  }
  assert.equal((await run(command))?.phase, 'cooling');
  assert.deepEqual(
    await run({ ...command, code: 'different-unused-replay-code' }),
    await run(command),
  );
  const missing = (error: unknown) =>
    error instanceof ApplicationError &&
    error.code === 'REAL_DELETION_SCOPE_UNAVAILABLE';
  await assert.rejects(run({ ...command, expectedGeneration: '1' }), missing);
  await assert.rejects(
    run({
      ...command,
      recoverySecret: 'wu_dr_' + Buffer.alloc(32, 18).toString('base64url'),
    }),
    missing,
  );
  const originalHash = prepared.intent_hash;
  prepared.intent_hash = preparationIntentHash({
    ...intent,
    intentId: '10000000-0000-4000-8000-000000000003',
  });
  await assert.rejects(run(command), missing);
  prepared.intent_hash = originalHash;
  assert.equal(
    await run({ ...command, intentId: '10000000-0000-4000-8000-000000000003' }),
    null,
  );
  for (const altered of [
    { ...command, consent: 'different-consent' },
    { ...command, version: 2 },
    { ...command, authority: true },
  ])
    await assert.rejects(
      run(altered),
      (error: unknown) => error instanceof Error && error.name === 'ZodError',
    );
});
