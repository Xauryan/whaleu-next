import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { avatarAppearanceId } from '../src/profile/avatar/repository.js';
import {
  avatarCommandSchema,
  avatarCommandHash,
  avatarReviewDigest,
  avatarReviewEnvelopeSchema,
} from '../src/profile/avatar/contracts.js';
import { avatarCurrentSchema } from '../src/profile/avatar/selection-contract.js';
import { requireAvatarCurrent } from '../src/profile/avatar/current-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../src/database/transaction-deadlines.js';

test('Profile command has actor-bound stable identity, shared revision hash and a separate exact Review purpose', () => {
  const actor = randomUUID(),
    request = randomUUID();
  const command = {
    protocol: 'profile-media-v1' as const,
    clientRequestId: request,
    expectedRevision: 0,
    source: { kind: 'clear' as const },
  };
  assert.deepEqual(avatarCommandSchema.parse(command), command);
  assert.equal(
    avatarAppearanceId(actor, request),
    avatarAppearanceId(actor, request),
  );
  assert.notEqual(
    avatarAppearanceId(actor, request),
    avatarAppearanceId(randomUUID(), request),
  );
  assert.notEqual(
    avatarCommandHash(actor, command),
    avatarCommandHash(actor, { ...command, expectedRevision: 1 }),
  );
  assert.notEqual(
    avatarCommandHash(actor, command),
    avatarCommandHash(randomUUID(), command),
  );
  for (const extra of [
    { url: 'https://invalid.test/avatar' },
    { accountId: actor },
    { approved: true },
    { manifestDigest: 'a'.repeat(64) },
  ])
    assert.equal(
      avatarCommandSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  assert.equal(
    avatarCommandSchema.safeParse({
      ...command,
      source: {
        kind: 'custom',
        editId: randomUUID(),
        assetId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
      },
    }).success,
    false,
  );
  const envelope = {
    version: 1 as const,
    purpose: 'select_profile_avatar' as const,
    accountId: actor,
    clientRequestId: request,
    expectedRevision: 0,
    appearanceId: avatarAppearanceId(actor, request),
    previousAppearanceId: null,
    slot: 'avatar' as const,
    source: { kind: 'clear' as const },
  };
  assert.notEqual(
    avatarReviewDigest(envelope),
    avatarCommandHash(actor, command),
  );
  assert.equal(
    avatarReviewEnvelopeSchema.safeParse({
      ...envelope,
      purpose: 'publish_post',
    }).success,
    false,
  );
  assert.equal(
    avatarReviewEnvelopeSchema.safeParse({ ...envelope, slot: 'banner' })
      .success,
    false,
  );
  assert.equal(
    avatarCurrentSchema.safeParse({
      protocol: 'profile-media-v1',
      profileId: null,
      revision: 0,
      avatar: { state: 'none' },
    }).success,
    true,
  );
});

test('Profile final proof retains outer owner facts and checks current pointer/profile/absence after deferred constraints', async () => {
  const actor = randomUUID();
  let revision = 0,
    exists = false,
    pointer = null as null | string;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: [{ locked: true }] };
      if (sql.includes('FROM whaleu_profile.profiles p'))
        return {
          rows: exists
            ? [{ row: { revision }, version: String(revision) }]
            : [],
        };
      if (sql.includes('FROM whaleu_profile.avatar_current'))
        return {
          rows: pointer
            ? [
                {
                  row: { appearance_id: pointer },
                  version: '1',
                  definition: { id: pointer },
                  definition_version: '1',
                },
              ]
            : [],
        };
      if (sql.includes('clock_timestamp()'))
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  let outerValidated = 0;
  const outer = {
    maximumFacts: 1,
    failureCode: 'MEDIA_UNAVAILABLE' as const,
    validate: async (facts: readonly string[]) => {
      assert.deepEqual(facts, ['retained']);
      outerValidated++;
    },
  };
  enableRequiredTransactionProof(tx, outer);
  registerRequiredTransactionFact(tx, outer, 'outer', 'retained');
  await requireAvatarCurrent(actor, tx);
  await checkTransactionDeadlines(tx);
  assert.equal(outerValidated, 1);
  assert.ok(
    calls.indexOf('SET CONSTRAINTS ALL IMMEDIATE') <
      calls.findIndex((sql) =>
        sql.includes('pg_try_advisory_xact_lock_shared'),
      ),
  );
  exists = true;
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await requireAvatarCurrent(actor, tx);
  pointer = randomUUID();
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await requireAvatarCurrent(actor, tx);
  revision++;
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await requireAvatarCurrent(actor, tx);
  revision++;
  await requireAvatarCurrent(actor, tx);
  revision--;
  // Returning to the first value must not erase the second observed state.
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await assert.rejects(requireAvatarCurrent(actor, tx, null, randomUUID()), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  for (let index = 0; index < 128; index++)
    await requireAvatarCurrent(randomUUID(), tx);
  await assert.rejects(requireAvatarCurrent(randomUUID(), tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
});
