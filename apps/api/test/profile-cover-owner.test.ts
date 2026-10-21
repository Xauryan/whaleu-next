import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { coverAppearanceId } from '../src/profile/cover/repository.js';
import {
  coverCommandSchema,
  coverCommandHash,
  coverReviewDigest,
  coverReviewEnvelopeSchema,
} from '../src/profile/cover/contracts.js';
import { coverCurrentSchema } from '../src/profile/cover/selection-contract.js';
import { requireCoverCurrent } from '../src/profile/cover/current-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../src/database/transaction-deadlines.js';

test('Profile command has actor-bound stable identity, independent revision hash and a separate exact Review purpose', () => {
  const actor = randomUUID(),
    request = randomUUID();
  const command = {
    protocol: 'profile-cover-v1' as const,
    clientRequestId: request,
    expectedRevision: 0,
    source: { kind: 'clear' as const },
  };
  assert.deepEqual(coverCommandSchema.parse(command), command);
  assert.equal(
    coverAppearanceId(actor, request),
    coverAppearanceId(actor, request),
  );
  assert.notEqual(
    coverAppearanceId(actor, request),
    coverAppearanceId(randomUUID(), request),
  );
  assert.notEqual(
    coverCommandHash(actor, command),
    coverCommandHash(actor, { ...command, expectedRevision: 1 }),
  );
  assert.notEqual(
    coverCommandHash(actor, command),
    coverCommandHash(randomUUID(), command),
  );
  for (const extra of [
    { url: 'https://invalid.test/cover' },
    { accountId: actor },
    { approved: true },
    { manifestDigest: 'a'.repeat(64) },
  ])
    assert.equal(
      coverCommandSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  assert.equal(
    coverCommandSchema.safeParse({
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
    purpose: 'select_profile_cover' as const,
    accountId: actor,
    clientRequestId: request,
    expectedRevision: 0,
    appearanceId: coverAppearanceId(actor, request),
    previousAppearanceId: null,
    slot: 'cover' as const,
    source: { kind: 'clear' as const },
  };
  assert.notEqual(
    coverReviewDigest(envelope),
    coverCommandHash(actor, command),
  );
  assert.equal(
    coverReviewEnvelopeSchema.safeParse({
      ...envelope,
      purpose: 'publish_post',
    }).success,
    false,
  );
  assert.equal(
    coverReviewEnvelopeSchema.safeParse({ ...envelope, slot: 'banner' })
      .success,
    false,
  );
  assert.equal(
    coverCurrentSchema.safeParse({
      protocol: 'profile-cover-v1',
      profileId: null,
      revision: 0,
      cover: { state: 'none' },
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
      if (sql.includes('FROM whaleu_profile.cover_current'))
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
  await requireCoverCurrent(actor, tx);
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
  await requireCoverCurrent(actor, tx);
  pointer = randomUUID();
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await requireCoverCurrent(actor, tx);
  revision++;
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await requireCoverCurrent(actor, tx);
  revision++;
  await requireCoverCurrent(actor, tx);
  revision--;
  // Returning to the first value must not erase the second observed state.
  await assert.rejects(checkTransactionDeadlines(tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  await assert.rejects(requireCoverCurrent(actor, tx, null, randomUUID()), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
  startTransactionDeadlines(tx);
  for (let index = 0; index < 128; index++)
    await requireCoverCurrent(randomUUID(), tx);
  await assert.rejects(requireCoverCurrent(randomUUID(), tx), {
    code: 'MEDIA_UNAVAILABLE',
  });
  clearTransactionDeadlines(tx);
});

test('cover repository replaces current pointer with UPDATE, not conflicting INSERT trigger semantics', async () => {
  const { ProfileCoverRepository } =
    await import('../src/profile/cover/repository.js');
  const actor = randomUUID(),
    id = randomUUID(),
    requestId = randomUUID();
  const envelope = {
    version: 1 as const,
    purpose: 'select_profile_cover' as const,
    accountId: actor,
    clientRequestId: requestId,
    expectedRevision: 1,
    appearanceId: id,
    previousAppearanceId: randomUUID(),
    slot: 'cover' as const,
    source: { kind: 'clear' as const },
  };
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  await new ProfileCoverRepository().replace(
    {
      id,
      actor_id: actor,
      authority: 'self_selection',
      source: { kind: 'clear' },
      envelope,
      digest: coverReviewDigest(envelope),
      binding_id: null,
    },
    tx,
  );
  assert.ok(
    statements.some((sql) =>
      sql.startsWith('UPDATE whaleu_profile.cover_current'),
    ),
  );
  assert.ok(
    !statements.some((sql) =>
      sql.startsWith('INSERT INTO whaleu_profile.cover_current'),
    ),
  );
  assert.ok(!statements.some((sql) => sql.includes('ON CONFLICT')));
});

test('cover hashes and codecs cannot accept avatar authority or catalog assets', async () => {
  const { avatarCommandHash, avatarReviewDigest } =
    await import('../src/profile/avatar/contracts.js');
  const { coverPrepareHash } =
    await import('../src/profile/cover/contracts.js');
  const { profileCoverMediaRequestHash } =
    await import('../src/media/contracts-profile-cover.js');
  const actor = randomUUID(),
    requestId = randomUUID();
  const cover = {
    protocol: 'profile-cover-v1',
    clientRequestId: requestId,
    expectedRevision: 0,
    source: { kind: 'clear' },
  };
  const avatar = { ...cover, protocol: 'profile-media-v1' };
  assert.notEqual(
    coverCommandHash(actor, cover),
    avatarCommandHash(actor, avatar),
  );
  assert.equal(coverCommandSchema.safeParse(avatar).success, false);
  assert.equal(
    coverCommandSchema.safeParse({
      ...cover,
      source: { kind: 'catalog', catalogVersion: 'x', itemId: 'y' },
    }).success,
    false,
  );
  const prepare = {
    protocol: 'profile-cover-v1',
    clientRequestId: requestId,
    expectedRevision: 0,
    slot: 'cover',
    declaration: { mime: 'image/png', bytes: 10, sha256: 'a'.repeat(64) },
  };
  assert.equal(
    coverPrepareHash(actor, prepare),
    profileCoverMediaRequestHash(actor, prepare),
  );
  const envelope = {
    version: 1,
    purpose: 'select_profile_cover',
    accountId: actor,
    clientRequestId: requestId,
    expectedRevision: 0,
    appearanceId: randomUUID(),
    previousAppearanceId: null,
    slot: 'cover',
    source: { kind: 'clear' },
  };
  assert.notEqual(
    coverReviewDigest(envelope),
    avatarReviewDigest({
      ...envelope,
      purpose: 'select_profile_avatar',
      slot: 'avatar',
    }),
  );
  assert.equal(
    coverReviewEnvelopeSchema.safeParse({ ...envelope, slot: 'avatar' })
      .success,
    false,
  );
});

test('cover CAS changes only independent head and rejects stale revision before mutation', async () => {
  const { ProfileCoverRepository } =
    await import('../src/profile/cover/repository.js');
  let revision = 1,
    changed = 0;
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith('SELECT revision FROM whaleu_profile.cover_heads'))
        return { rows: [{ revision }], rowCount: 1 };
      if (sql.startsWith('UPDATE whaleu_profile.cover_heads'))
        return { rows: [{ revision: ++revision }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const repository = new ProfileCoverRepository();
  await assert.rejects(
    repository.updateInTransaction(
      randomUUID(),
      0,
      async () => {
        changed++;
      },
      tx,
    ),
    { code: 'PROFILE_REVISION_CONFLICT' },
  );
  assert.equal(changed, 0);
  const result = await repository.updateInTransaction(
    randomUUID(),
    1,
    async () => {
      changed++;
    },
    tx,
  );
  assert.deepEqual(result, { revision: 2 });
  assert.equal(changed, 1);
  assert.ok(
    !statements.some((sql) => sql.startsWith('UPDATE whaleu_profile.profiles')),
  );
});

test('independent cover head changes invalidate a retained read proof', async () => {
  let head = 0;
  const tx = {
    query: async (sql: string) => {
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
      if (sql.includes('FROM whaleu_profile.cover_heads'))
        return { rows: [{ revision: head, version: String(head) }] };
      if (sql.includes('clock_timestamp()'))
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    await requireCoverCurrent(randomUUID(), tx);
    head++;
    await assert.rejects(checkTransactionDeadlines(tx), {
      code: 'MEDIA_UNAVAILABLE',
    });
  } finally {
    clearTransactionDeadlines(tx);
  }
});
