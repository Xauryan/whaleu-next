import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingsDiscussionMediaDeliveryService } from '../src/media/ratings-discussion-delivery.js';
import type { RatingsDiscussionMediaDeliveryPlan } from '../src/media/ratings-discussion-delivery.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import type { RatingsDiscussionMediaReadRequest } from '../src/media/ratings-discussion-owner-proof.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';

function fixture(change = false, hold = false) {
  const bytes = Buffer.from('synthetic-ratings-discussion'),
    accountId = randomUUID();
  const request: RatingsDiscussionMediaReadRequest = {
    targetId: randomUUID(),
    rootId: randomUUID(),
    replyId: null,
    subjectRevision: randomUUID(),
    attachmentSetDigest: 'a'.repeat(64),
    requestId: randomUUID(),
    contextId: randomUUID(),
    contextToken: 'a'.repeat(43),
    purpose: 'download',
  };
  const plan: RatingsDiscussionMediaDeliveryPlan = {
    ordinal: 8,
    subjectRevision: request.subjectRevision,
    contextId: request.contextId,
    contextToken: request.contextToken,
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'rating_comment',
      targetId: request.targetId,
      resourceId: request.rootId,
      contentVersion: 1,
    },
    bindingId: randomUUID(),
    principal: {
      kind: 'authenticatedRatings',
      accountId,
      sessionId: randomUUID(),
    },
    ownerRevision: 'a'.repeat(64),
    reviewRevision: 'b'.repeat(64),
    variant: 'display-v1',
    manifestDigest: 'c'.repeat(64),
    safetyRevision: '1',
    object: {
      provider: 'local-fixture',
      environment: 'synthetic',
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    attachmentSetRevision: 'd'.repeat(64),
    bytes: bytes.length,
    mime: 'image/png',
  };
  let active = false,
    checks = 0,
    opened = 0,
    consumed = 0;
  const storage: ImmutableMediaStorage = {
    provider: 'local-fixture',
    environment: 'synthetic',
    async seal() {
      throw new Error('unused');
    },
    async deleteExact() {
      return 'confirmed-absent';
    },
    async openExact() {
      assert.equal(active, false);
      opened++;
      return {
        bytes: bytes.length,
        stream: new Readable({
          read() {
            consumed++;
            if (!hold) {
              this.push(bytes);
              this.push(null);
            }
          },
        }),
      };
    },
  };
  const service = new RatingsDiscussionMediaDeliveryService(
    {
      async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
        active = true;
        try {
          return await run({} as PoolClient);
        } finally {
          active = false;
        }
      },
    },
    {
      async authorize(token, current) {
        assert.equal(active, true);
        assert.equal(token, 'token');
        assert.deepEqual(current, request);
        checks++;
        return change && checks === 2
          ? { ...plan, reviewRevision: 'e'.repeat(64) }
          : plan;
      },
    },
    storage,
    new MediaDeliveryBudgetPool(),
  );
  return {
    service,
    request,
    bindingId: plan.bindingId,
    bytes,
    counts: () => ({ checks, opened, consumed }),
  };
}
test('Ratings discussion exact delivery reauthorizes scope and Review around outside-lock storage', async () => {
  const f = fixture(),
    result = await f.service.open(
      'token',
      f.request,
      f.bindingId,
      8,
      'display-v1',
    );
  assert.equal(f.counts().checks, 2);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.headers['Accept-Ranges'], 'none');
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  result.abort();
});
test('Ratings discussion changed Review withholds all bytes and Range fails before storage', async () => {
  const f = fixture(true);
  await assert.rejects(
    f.service.open('token', f.request, f.bindingId, 8, 'display-v1'),
  );
  assert.deepEqual(f.counts(), { checks: 2, opened: 1, consumed: 0 });
  const range = fixture();
  await assert.rejects(
    range.service.open(
      'token',
      range.request,
      range.bindingId,
      8,
      'display-v1',
      'bytes=0-1',
    ),
  );
  assert.equal(range.counts().opened, 0);
  assert.throws(() =>
    range.service.open('', range.request, range.bindingId, 8, 'display-v1'),
  );
});
test('Ratings discussion uses the shared two-stream authenticated account budget', async () => {
  const f = fixture(false, true);
  const first = await f.service.open(
    'token',
    f.request,
    f.bindingId,
    8,
    'display-v1',
  );
  const second = await f.service.open(
    'token',
    f.request,
    f.bindingId,
    8,
    'display-v1',
  );
  try {
    await assert.rejects(
      f.service.open('token', f.request, f.bindingId, 8, 'display-v1'),
    );
  } finally {
    first.abort();
    second.abort();
  }
});
