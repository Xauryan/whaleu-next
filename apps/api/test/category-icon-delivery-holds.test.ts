import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  CategoryIconMediaDeliveryService,
  type CategoryIconMediaDeliveryPlan,
} from '../src/media/category-icon-delivery.js';
import { PostgresCategoryIconDeliveryHolds } from '../src/media/category-icon-delivery-holds.js';
import type { CategoryIconMediaReadRequest } from '../src/media/category-icon-owner-proof.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import { ExactMediaDeliveryService } from '../src/media/delivery.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const bytes = Buffer.from('synthetic-category-delivery-hold');
  const request: CategoryIconMediaReadRequest = {
    categoryId: randomUUID(),
    appearanceId: randomUUID(),
    contextId: randomUUID(),
    contextToken: 'a'.repeat(43),
    requestId: randomUUID(),
    purpose: 'download',
  };
  const plan: CategoryIconMediaDeliveryPlan = {
    categoryId: request.categoryId,
    contextId: request.contextId,
    contextToken: request.contextToken,
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      resourceId: request.appearanceId,
      contentVersion: 1,
    },
    bindingId: randomUUID(),
    principal: {
      kind: 'authenticatedRatings',
      accountId: randomUUID(),
      sessionId: randomUUID(),
    },
    ownerRevision: '1'.repeat(64),
    reviewRevision: '2'.repeat(64),
    manifestDigest: '3'.repeat(64),
    safetyRevision: '1',
    attachmentSetRevision: '4'.repeat(64),
    qualification: {
      releaseId: randomUUID(),
      catalogId: randomUUID(),
      effectiveRevision: randomUUID(),
      identityId: randomUUID(),
      baseSource: { id: randomUUID(), revision: randomUUID() },
      overrideSource: null,
      definitionId: randomUUID(),
      extensionDigest: '5'.repeat(64),
    },
    variant: 'display-v1',
    object: {
      provider: 'local-fixture',
      environment: 'synthetic',
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    mime: 'image/png',
  };
  const events: string[] = [];
  const rows = new Map<string, { identity: string; closed: boolean }>();
  const state = {
    active: 0,
    authorizations: 0,
    closeAttempts: 0,
    failClose: false,
    changeSecond: false,
    beforeFinal: undefined as (() => Promise<void>) | undefined,
  };
  const tx = {
    async query(sql: string, values: unknown[]) {
      const id = values[0] as string;
      const identity = JSON.stringify(values);
      assert.ok(
        !identity.includes(request.contextToken),
        'no stored bearer token',
      );
      if (sql.startsWith('INSERT')) {
        events.push('insert');
        assert.equal(rows.has(id), false, 'request IDs are never reusable');
        rows.set(id, { identity, closed: false });
        return { rows: [{ id }], rowCount: 1 };
      }
      const row = rows.get(id);
      if (sql.startsWith('SELECT')) {
        events.push('require');
        assert.match(sql, /closed_at IS NULL FOR SHARE/);
        return {
          rows: row && !row.closed && row.identity === identity ? [{ id }] : [],
        };
      }
      assert.match(sql, /^UPDATE/);
      assert.match(sql, /SET closed_at=clock_timestamp\(\)/);
      assert.match(sql, /closed_at IS NULL RETURNING id/);
      state.closeAttempts++;
      events.push('close');
      if (state.failClose)
        throw new Error('synthetic close persistence failure');
      if (!row || row.closed || row.identity !== identity) return { rows: [] };
      row.closed = true;
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {
    async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
      state.active++;
      try {
        const result = await run(tx);
        events.push('commit');
        return result;
      } finally {
        state.active--;
      }
    },
  };
  const budget = new MediaDeliveryBudgetPool();
  let provide: () => Promise<{
    bytes: number;
    stream: Readable;
  }> = async () => ({
    bytes: bytes.length,
    stream: Readable.from([bytes]),
  });
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
      assert.equal(state.active, 0, 'provider work stays outside transactions');
      assert.equal(rows.get(request.requestId)?.closed, false);
      events.push('provider');
      return provide();
    },
  };
  const service = new CategoryIconMediaDeliveryService(
    database,
    {
      async authorize() {
        assert.ok(state.active > 0);
        events.push('authorize');
        state.authorizations++;
        if (state.authorizations === 2) await state.beforeFinal?.();
        return state.changeSecond && state.authorizations === 2
          ? { ...plan, reviewRevision: '6'.repeat(64) }
          : plan;
      },
    },
    storage,
    budget,
  );
  return {
    service,
    request,
    plan,
    bytes,
    rows,
    events,
    state,
    database,
    budget,
    tx,
    storage,
    setProvider: (next: typeof provide) => {
      provide = next;
    },
    closed: () => rows.get(request.requestId)?.closed,
  };
}

test('Category delivery commits an exact durable hold before opening and checks it in the final proof transaction', async () => {
  const f = fixture();
  const delivery = await f.service.open('credential', f.request, 'display-v1');
  assert.deepEqual(f.events.slice(0, 7), [
    'authorize',
    'insert',
    'commit',
    'provider',
    'authorize',
    'require',
    'commit',
  ]);
  assert.equal(f.closed(), false);
  const received: Buffer[] = [];
  for await (const chunk of delivery.stream) received.push(chunk as Buffer);
  await settle();
  assert.deepEqual(Buffer.concat(received), f.bytes);
  assert.equal(f.closed(), true);
  delivery.abort();
  delivery.abort();
  await settle();
  assert.equal(f.state.closeAttempts, 1);
});

test('Category caller deadline does not close a hold for a late provider promise or pending source close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let resolveOpen!: (opened: { bytes: number; stream: Readable }) => void;
  let finishDestroy: ((error?: Error | null) => void) | undefined;
  f.setProvider(
    () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  );
  const rejected = assert.rejects(
    f.service.open('credential', f.request, 'display-v1'),
  );
  await settle();
  assert.equal(f.closed(), false);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(f.closed(), false);
  assert.equal(f.state.closeAttempts, 0);
  resolveOpen({
    bytes: f.bytes.length,
    stream: new Readable({
      read() {
        assert.fail('timed-out source must not emit bytes');
      },
      destroy(_error, done) {
        finishDestroy = done;
      },
    }),
  });
  await settle();
  assert.ok(finishDestroy);
  assert.equal(f.closed(), false, 'destroy requested is not source closed');
  assert.equal(f.state.closeAttempts, 0);
  finishDestroy(null);
  await settle();
  assert.equal(f.closed(), true);
  assert.equal(f.state.closeAttempts, 1);
  assert.equal(f.state.authorizations, 1);
});

test('Category late provider rejection closes only after the provider effect settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let rejectOpen!: (error: Error) => void;
  f.setProvider(
    () =>
      new Promise((_resolve, reject) => {
        rejectOpen = reject;
      }),
  );
  const rejected = assert.rejects(
    f.service.open('credential', f.request, 'display-v1'),
  );
  await settle();
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(f.closed(), false);
  rejectOpen(new Error('synthetic late provider failure'));
  await settle();
  assert.equal(f.closed(), true);
  assert.equal(f.state.closeAttempts, 1);
});

test('Category disconnect waits for physical source close and output close before closing its hold', async () => {
  const f = fixture();
  let finishSource!: (error?: Error | null) => void;
  f.setProvider(async () => ({
    bytes: f.bytes.length,
    stream: new Readable({
      read() {},
      destroy(_error, done) {
        finishSource = done;
      },
    }),
  }));
  const delivery = await f.service.open('credential', f.request, 'display-v1');
  let finishOutput!: (error?: Error | null) => void;
  delivery.stream._destroy = (_error, done) => {
    finishOutput = done;
  };
  delivery.abort();
  assert.equal(f.closed(), false);
  finishSource(null);
  await settle();
  assert.equal(f.closed(), false, 'output lifecycle must also be quiet');
  assert.equal(f.state.closeAttempts, 0);
  finishOutput(null);
  await settle();
  assert.equal(f.closed(), true);
  assert.equal(f.state.closeAttempts, 1);
});

test('Category final proof change withholds bytes and waits for source closure before releasing its original hold', async () => {
  const f = fixture();
  f.state.changeSecond = true;
  let finishDestroy!: (error?: Error | null) => void;
  f.setProvider(async () => ({
    bytes: f.bytes.length,
    stream: new Readable({
      read() {
        assert.fail('changed proof must not consume staged bytes');
      },
      destroy(_error, done) {
        finishDestroy = done;
      },
    }),
  }));
  await assert.rejects(f.service.open('credential', f.request, 'display-v1'));
  assert.equal(f.closed(), false);
  assert.equal(f.state.closeAttempts, 0);
  finishDestroy(null);
  await settle();
  assert.equal(f.closed(), true);
});

test('Category timeout during final authorization retains its hold until setup and source are both quiet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let finishFinal!: () => void;
  f.state.beforeFinal = () =>
    new Promise<void>((resolve) => {
      finishFinal = resolve;
    });
  const source = new Readable({
    read() {
      assert.fail('setup is not committed');
    },
  });
  f.setProvider(async () => ({ bytes: f.bytes.length, stream: source }));
  const rejected = assert.rejects(
    f.service.open('credential', f.request, 'display-v1'),
  );
  await settle();
  assert.equal(f.state.authorizations, 2);
  t.mock.timers.tick(30_000);
  await rejected;
  await settle();
  assert.equal(source.closed, true);
  assert.equal(f.closed(), false, 'a pending final proof is still setup work');
  assert.equal(f.state.closeAttempts, 0);
  finishFinal();
  await settle();
  assert.equal(f.closed(), true);
  assert.equal(f.state.closeAttempts, 1);
});

test('Category durable close failure stays open and never becomes a timeout or duplicate-abort success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.state.failClose = true;
  const delivery = await f.service.open('credential', f.request, 'display-v1');
  for await (const _chunk of delivery.stream) {
    void _chunk; // Consume synthetic bytes without retaining them.
  }
  await settle();
  assert.equal(f.state.closeAttempts, 1);
  assert.equal(f.closed(), false);
  t.mock.timers.tick(300_000);
  delivery.abort();
  await settle();
  assert.equal(f.closed(), false);
  assert.equal(f.state.closeAttempts, 1);
  const holds = new PostgresCategoryIconDeliveryHolds(f.database);
  await assert.rejects(holds.closeQuiet(f.request, f.plan));
  assert.equal(f.closed(), false);
});

test('Category hold is closed when admission fails before any provider effect starts', async () => {
  const f = fixture();
  const key = `account:${f.plan.principal.accountId}`;
  const releaseOne = f.budget.acquire(key),
    releaseTwo = f.budget.acquire(key);
  try {
    await assert.rejects(f.service.open('credential', f.request, 'display-v1'));
    await settle();
    assert.equal(f.events.includes('provider'), false);
    assert.equal(f.closed(), true);
    assert.equal(f.state.closeAttempts, 1);
  } finally {
    releaseOne();
    releaseTwo();
  }
});

test('Category range rejection creates no hold and no provider effect', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.open('credential', f.request, 'display-v1', 'bytes=0-1'),
  );
  assert.equal(f.rows.size, 0);
  assert.deepEqual(f.events, []);
});

test('generic exact delivery without the optional hook still requires only its two owner authorizations', async () => {
  const f = fixture();
  let authorizations = 0;
  const service = new ExactMediaDeliveryService(
    f.database,
    {
      ...f.storage,
      async openExact() {
        return { bytes: f.bytes.length, stream: Readable.from([f.bytes]) };
      },
    },
    f.budget,
  );
  const delivery = await service.open(
    async () => {
      authorizations++;
      return f.plan;
    },
    () => 'account:generic',
  );
  const received: Buffer[] = [];
  for await (const chunk of delivery.stream) received.push(chunk as Buffer);
  delivery.abort();
  await settle();
  assert.deepEqual(Buffer.concat(received), f.bytes);
  assert.equal(authorizations, 2);
  assert.equal(f.rows.size, 0);
  assert.equal(f.state.closeAttempts, 0);
});
