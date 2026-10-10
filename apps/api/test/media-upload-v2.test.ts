import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { prepareMediaSchema } from '../src/media/contracts.js';
import {
  mediaGrantSchema,
  mediaRequestHash,
  prepareMediaV2Schema,
} from '../src/media/contracts-v2.js';
import type { MediaIngressClaim } from '../src/media/application-v2.js';
import { SyntheticMediaStorage } from './support/media/synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './support/media/synthetic-ingress-storage.js';
import { sha256 } from '../src/media/processing/protocol.js';

const input = () => ({
  clientRequestId: randomUUID(),
  purpose: 'community-post-image',
  draftId: randomUUID(),
  spaceId: randomUUID(),
  slot: 'images',
  ordinal: 0,
  declaration: { mime: 'image/png', bytes: 8, sha256: 'a'.repeat(64) },
});
test('media v2 original-request identity is exact and v1 remains strict', () => {
  const actor = randomUUID(),
    prepare = input();
  assert.equal(prepareMediaV2Schema.safeParse(prepare).success, true);
  assert.equal(prepareMediaSchema.safeParse(prepare).success, false);
  assert.equal(
    prepareMediaV2Schema.safeParse({ ...prepare, path: '/tmp/photo' }).success,
    false,
  );
  const hash = mediaRequestHash(actor, prepare);
  assert.equal(
    hash,
    mediaRequestHash(actor, JSON.parse(JSON.stringify(prepare))),
  );
  for (const changed of [
    {
      ...prepare,
      declaration: { ...prepare.declaration, sha256: 'b'.repeat(64) },
    },
    { ...prepare, draftId: randomUUID() },
    { ...prepare, clientRequestId: randomUUID() },
  ])
    assert.notEqual(hash, mediaRequestHash(actor, changed));
  assert.notEqual(hash, mediaRequestHash(randomUUID(), prepare));
});
test('grant strictly excludes targets/secrets and unsafe bigint numbers', () => {
  const value = {
    version: 1,
    strategy: 'authenticated-multipart-v1',
    intentId: randomUUID(),
    generation: '9223372036854775807',
    grantId: randomUUID(),
    method: 'POST',
    fieldName: 'file',
    maxBytes: 5242880,
    expectedBytes: 8,
    expectedMime: 'image/png',
    expectedSha256: 'a'.repeat(64),
    grantExpiresAt: 1000,
    operationDeadlineAt: 2000,
    serverNow: 1,
  };
  assert.equal(mediaGrantSchema.safeParse(value).success, true);
  for (const changed of [
    { ...value, generation: 1 },
    { ...value, generation: '9223372036854775808' },
    { ...value, url: 'https://other.example' },
    { ...value, headers: {} },
    { ...value, token: 'secret' },
  ])
    assert.equal(mediaGrantSchema.safeParse(changed).success, false);
});
test('fixture streamed exact writes have token-scoped quiescence, never abort/foreign proof', async () => {
  const storage = await SyntheticMediaStorage.create();
  try {
    const ingress = new SyntheticMediaIngressStorage(storage);
    const attemptId = randomUUID(),
      writerToken = randomUUID(),
      bytes = Buffer.from('fixture-stream');
    const claim: MediaIngressClaim = {
      actorAccountId: randomUUID(),
      sessionId: randomUUID(),
      intentId: randomUUID(),
      attemptId,
      generation: '1',
      grantId: randomUUID(),
      writerToken,
      writerInstanceId: ingress.writerInstanceId,
      writerDeadline: Date.now() + 1000,
      expectedBytes: bytes.length,
      expectedMime: 'image/png',
      expectedSha256: sha256(bytes),
      ...ingress.plan(attemptId),
      scratch: ingress.scratch(attemptId, writerToken),
    };
    const signal = new AbortController();
    const result = await ingress.write(
      claim,
      Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
      signal.signal,
    );
    assert.equal(result.sha256, claim.expectedSha256);
    assert.throws(() => ingress.requireStopped({}, claim, {} as PoolClient));
    const proof = await ingress.quiesce(claim);
    ingress.requireStopped(proof, claim, {} as PoolClient);
    await assert.rejects(
      ingress.write(claim, Readable.from([bytes]), signal.signal),
    );
    await assert.rejects(
      ingress.quiesce({ ...claim, writerInstanceId: randomUUID() }),
    );
    assert.equal(await ingress.removeScratch(claim), 'confirmed-absent');
    assert.equal((await storage.measure(claim.staging)).sha256, sha256(bytes));
    // Cleanup only touched scratch; this exact object is available to seal.
  } finally {
    await storage.dispose();
  }
});
