import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import { MediaDeliveryService } from '../src/media/delivery.js';
import type { InternalMediaDeliveryPlan } from '../src/media/delivery.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';

function setup(
  changeSecond = false,
  failSecond = false,
  changeOtherAttachment = false,
) {
  const bytes = Buffer.from('synthetic-delivery-protocol-bytes');
  const plan: InternalMediaDeliveryPlan = {
    bindingId: randomUUID(),
    parent: {
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: randomUUID(),
      contentVersion: 1,
    },
    viewerAccountId: randomUUID(),
    variant: 'display-v1',
    object: {
      provider: 'local-fixture',
      environment: 'synthetic',
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifestDigest: 'a'.repeat(64),
    safetyRevision: '1',
    attachmentSetRevision: 'b'.repeat(64),
    bytes: bytes.length,
    mime: 'image/png',
  };
  let txActive = false,
    authorizations = 0,
    opened = 0,
    consumed = 0;
  const storage: ImmutableMediaStorage = {
    provider: 'local-fixture',
    environment: 'synthetic',
    async seal() {
      throw new Error('Not used');
    },
    async deleteExact() {
      return 'confirmed-absent';
    },
    async openExact() {
      assert.equal(txActive, false);
      opened++;
      return {
        bytes: bytes.length,
        stream: new Readable({
          read() {
            consumed++;
            this.push(bytes);
            this.push(null);
          },
        }),
      };
    },
  };
  const service = new MediaDeliveryService(
    {
      async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
        txActive = true;
        try {
          return await run({} as PoolClient);
        } finally {
          txActive = false;
        }
      },
    },
    {
      async authorize() {
        assert.equal(txActive, true);
        authorizations++;
        assert.equal(consumed, 0, 'No source bytes before final authority');
        if (authorizations === 2 && failSecond) throw new Error('revoked');
        if (authorizations === 2 && changeOtherAttachment)
          return { ...plan, attachmentSetRevision: 'c'.repeat(64) };
        return authorizations === 2 && changeSecond
          ? { ...plan, safetyRevision: '2' }
          : plan;
      },
    },
    storage,
    new MediaDeliveryBudgetPool(),
  );
  return {
    service,
    plan,
    bytes,
    counts: () => ({ authorizations, opened, consumed }),
  };
}
test('delivery opens storage outside transaction and emits only after second current proof', async () => {
  const f = setup();
  const opened = await f.service.open(
    'synthetic-token',
    f.plan.bindingId,
    'display-v1',
  );
  assert.equal(f.counts().authorizations, 2);
  assert.equal(opened.headers['Cache-Control'], 'private, no-store');
  assert.equal(opened.headers['Vary'], 'Authorization');
  assert.equal(opened.headers['X-Content-Type-Options'], 'nosniff');
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  opened.abort();
});
test('head change or revocation after storage open fails before reading source bytes', async () => {
  for (const [change, fail] of [
    [true, false],
    [false, true],
  ]) {
    const f = setup(change, fail);
    await assert.rejects(
      f.service.open('synthetic-token', f.plan.bindingId, 'display-v1'),
    );
    assert.equal(f.counts().consumed, 0);
  }
});
test('range requests are rejected before authorization or object open', async () => {
  const f = setup();
  await assert.rejects(
    f.service.open(
      'synthetic-token',
      f.plan.bindingId,
      'display-v1',
      'bytes=0-10',
    ),
  );
  assert.deepEqual(f.counts(), { authorizations: 0, opened: 0, consumed: 0 });
});

test('a non-target attachment change after exact object open withholds all target bytes', async () => {
  const f = setup(false, false, true);
  await assert.rejects(
    f.service.open('synthetic-token', f.plan.bindingId, 'display-v1'),
  );
  assert.equal(f.counts().opened, 1);
  assert.equal(f.counts().consumed, 0);
});
