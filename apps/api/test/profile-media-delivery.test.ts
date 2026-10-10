import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import { ExactMediaDeliveryService } from '../src/media/delivery.js';
import type {
  ExactMediaDeliveryPlan,
  AuthorizedMediaStream,
} from '../src/media/delivery.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';

function fixture(
  change: 'none' | 'appearance' | 'principal' | 'review' | 'catalog' = 'none',
  hold = false,
) {
  const bytes = Buffer.from('synthetic-profile-exact-bytes');
  const principal = { kind: 'guest' as const, requestId: randomUUID() };
  const plan = {
    object: {
      provider: 'local-fixture',
      environment: 'synthetic',
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    attachmentSetRevision: 'a'.repeat(64),
    bytes: bytes.length,
    mime: 'image/png' as const,
    principal,
    appearanceId: randomUUID(),
    reviewRevision: '1',
    catalogHash: 'b'.repeat(64),
  };
  let active = false,
    authorizations = 0,
    consumed = 0,
    opened = 0;
  const storage: ImmutableMediaStorage = {
    provider: 'local-fixture',
    environment: 'synthetic',
    async seal() {
      throw new Error('not used');
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
  const service = new ExactMediaDeliveryService(
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
    storage,
    new MediaDeliveryBudgetPool(),
  );
  const authorize = async () => {
    assert.equal(active, true);
    authorizations++;
    assert.equal(consumed, 0);
    if (authorizations === 2) {
      if (change === 'appearance')
        return { ...plan, appearanceId: randomUUID() };
      if (change === 'principal')
        return {
          ...plan,
          principal: {
            kind: 'session' as const,
            accountId: randomUUID(),
            sessionId: randomUUID(),
          },
        };
      if (change === 'review') return { ...plan, reviewRevision: '2' };
      if (change === 'catalog') return { ...plan, catalogHash: 'c'.repeat(64) };
    }
    return plan;
  };
  return {
    service,
    authorize,
    bytes,
    plan,
    counts: () => ({ authorizations, consumed, opened }),
  };
}
test('guest/catalog uses the shared exact-byte engine without forged viewer or binding IDs', async () => {
  const f = fixture();
  assert.equal('viewerAccountId' in f.plan, false);
  assert.equal('bindingId' in f.plan, false);
  const result = await f.service.open(
    f.authorize,
    () => `guest-connection:${randomUUID()}`,
  );
  assert.equal(f.counts().authorizations, 2);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.headers['Vary'], 'Authorization');
  assert.equal(result.headers['Accept-Ranges'], 'none');
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  result.abort();
});
test('appearance/principal/Review/catalog changes between exact-open and final commit withhold all bytes', async () => {
  for (const change of [
    'appearance',
    'principal',
    'review',
    'catalog',
  ] as const) {
    const f = fixture(change);
    await assert.rejects(
      f.service.open(f.authorize, () => `guest:${f.plan.principal.requestId}`),
    );
    assert.deepEqual(f.counts(), { authorizations: 2, consumed: 0, opened: 1 });
  }
});
test('Profile range and unsafe exact plans fail before storage work', async () => {
  const f = fixture();
  await assert.rejects(f.service.open(f.authorize, () => 'guest', 'bytes=0-1'));
  assert.equal(f.counts().opened, 0);
  for (const bad of [
    { bytes: Number.NaN },
    { bytes: 1.5 },
    { bytes: 5242881 },
    { sha256: 'not-a-digest' },
    { attachmentSetRevision: 'short' },
  ]) {
    await assert.rejects(
      f.service.open(
        async () => ({ ...f.plan, ...bad }),
        () => 'guest',
      ),
    );
    assert.equal(f.counts().opened, 0);
  }
});
test('guest concurrent reads enforce both trusted connection and total service budgets', async () => {
  // These streams deliberately never produce bytes. All leases are explicitly
  // aborted so a successful test leaves no live delivery slots or timers.
  const f = fixture('none', true),
    streams: AuthorizedMediaStream[] = [];
  const authorize = async (): Promise<ExactMediaDeliveryPlan> => f.plan;
  try {
    streams.push(await f.service.open(authorize, () => 'guest:connection-1'));
    streams.push(await f.service.open(authorize, () => 'guest:connection-1'));
    await assert.rejects(f.service.open(authorize, () => 'guest:connection-1'));
    for (let index = 2; index < 64; index++)
      streams.push(
        await f.service.open(authorize, () => `guest:connection-${index}`),
      );
    await assert.rejects(
      f.service.open(authorize, () => 'guest:connection-overflow'),
    );
  } finally {
    for (const stream of streams) stream.abort();
  }
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await f.service.open(authorize, () => 'guest:connection-1');
  recovered.abort();
});

test('Community and Profile adapters share app budget, account credits and the global 64-stream bound', async () => {
  const { MediaDeliveryService } = await import('../src/media/delivery.js');
  const pool = new MediaDeliveryBudgetPool(),
    f = fixture('none', true),
    streams: AuthorizedMediaStream[] = [];
  const database = {
    async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
      return run({} as PoolClient);
    },
  };
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
      return { bytes: f.plan.bytes, stream: new Readable({ read() {} }) };
    },
  };
  const account = randomUUID(),
    bindingId = randomUUID();
  const parent = {
    ownerKind: 'community' as const,
    resourceKind: 'post' as const,
    resourceId: randomUUID(),
    contentVersion: 1 as const,
  };
  const otherAccount = randomUUID(),
    community = new MediaDeliveryService(
      database,
      {
        async authorize() {
          return {
            ...f.plan,
            parent,
            bindingId,
            viewerAccountId: otherAccount,
            variant: 'display-v1',
            manifestDigest: 'a'.repeat(64),
            safetyRevision: '1',
          };
        },
      },
      storage,
      pool,
    );
  const stableCommunity = new MediaDeliveryService(
    database,
    {
      async authorize() {
        return {
          ...f.plan,
          parent,
          bindingId,
          viewerAccountId: account,
          variant: 'display-v1',
          manifestDigest: 'a'.repeat(64),
          safetyRevision: '1',
        };
      },
    },
    storage,
    pool,
  );
  const profile = new ExactMediaDeliveryService(database, storage, pool);
  try {
    streams.push(
      await stableCommunity.open('synthetic-session', bindingId, 'display-v1'),
    );
    streams.push(
      await profile.open(
        async () => f.plan,
        () => `account:${account}`,
      ),
    );
    await assert.rejects(
      profile.open(
        async () => f.plan,
        () => `account:${account}`,
      ),
    );
    await assert.rejects(
      stableCommunity.open('synthetic-session', bindingId, 'display-v1'),
    );
    for (let i = 2; i < 64; i++)
      streams.push(
        await profile.open(
          async () => f.plan,
          () => `guest-connection:${i}`,
        ),
      );
    await assert.rejects(
      profile.open(
        async () => f.plan,
        () => 'guest-connection:overflow',
      ),
    );
    // It fails before provider work even when another owner attempts admission.
    await assert.rejects(
      community.open('synthetic-session', bindingId, 'display-v1'),
    );
  } finally {
    for (const stream of streams) stream.abort();
  }
  await new Promise((resolve) => setImmediate(resolve));
  const resumed = await stableCommunity.open(
    'synthetic-session',
    bindingId,
    'display-v1',
  );
  resumed.abort();
});

test('aborted streams retain shared credits until delayed native source destruction really completes', async () => {
  const pool = new MediaDeliveryBudgetPool(),
    f = fixture('none', true),
    destroyed: ((error: Error | null) => void)[] = [];
  const database = {
    async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
      return run({} as PoolClient);
    },
  };
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
      return {
        bytes: f.plan.bytes,
        stream: new Readable({
          read() {},
          destroy(_error, done) {
            destroyed.push(done);
          },
        }),
      };
    },
  };
  const left = new ExactMediaDeliveryService(database, storage, pool),
    right = new ExactMediaDeliveryService(database, storage, pool);
  const first = await left.open(
      async () => f.plan,
      () => 'account:shared',
    ),
    second = await right.open(
      async () => f.plan,
      () => 'account:shared',
    );
  first.abort();
  second.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyed.length, 2);
  await assert.rejects(
    left.open(
      async () => f.plan,
      () => 'account:shared',
    ),
    'abort is not a source close proof',
  );
  destroyed.shift()!(null);
  await new Promise((resolve) => setImmediate(resolve));
  const next = await right.open(
    async () => f.plan,
    () => 'account:shared',
  );
  first.abort();
  await assert.rejects(
    left.open(
      async () => f.plan,
      () => 'account:shared',
    ),
    'late duplicate abort cannot release another stream',
  );
  next.abort();
  for (const done of destroyed.splice(0)) done(null);
  await new Promise((resolve) => setImmediate(resolve));
});

test('exact-open rejection and failed final proof release acquired app credits without admitting stale bytes', async () => {
  const pool = new MediaDeliveryBudgetPool(),
    f = fixture('none', true),
    database = {
      async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
        return run({} as PoolClient);
      },
    };
  let rejectOpen = true,
    calls = 0;
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
      if (rejectOpen) throw new Error('synthetic exact-open failed');
      return { bytes: f.plan.bytes, stream: new Readable({ read() {} }) };
    },
  };
  const service = new ExactMediaDeliveryService(database, storage, pool);
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      service.open(
        async () => f.plan,
        () => 'account:errors',
      ),
    );
  rejectOpen = false;
  await assert.rejects(
    service.open(
      async () => {
        if (++calls === 2) throw new Error('synthetic final proof failed');
        return f.plan;
      },
      () => 'account:errors',
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const first = await service.open(
      async () => f.plan,
      () => 'account:errors',
    ),
    second = await service.open(
      async () => f.plan,
      () => 'account:errors',
    );
  first.abort();
  second.abort();
});

test('unresolved exact-open timeouts keep credits until the late result or rejection actually settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('none', true),
    pool = new MediaDeliveryBudgetPool(),
    pending: {
      resolve: (value: { bytes: number; stream: Readable }) => void;
      reject: (error: Error) => void;
    }[] = [];
  const database = {
    async transaction<T>(run: (tx: PoolClient) => Promise<T>) {
      return run({} as PoolClient);
    },
  };
  let hold = true;
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
      return hold
        ? await new Promise<{ bytes: number; stream: Readable }>(
            (resolve, reject) => pending.push({ resolve, reject }),
          )
        : { bytes: f.plan.bytes, stream: new Readable({ read() {} }) };
    },
  };
  const service = new ExactMediaDeliveryService(database, storage, pool),
    other = new ExactMediaDeliveryService(database, storage, pool);
  const first = assert.rejects(
      service.open(
        async () => f.plan,
        () => 'account:pending',
      ),
    ),
    second = assert.rejects(
      other.open(
        async () => f.plan,
        () => 'account:pending',
      ),
    );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  t.mock.timers.tick(30000);
  await Promise.all([first, second]); // Caller deadlines settle before either provider effect does.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    other.open(
      async () => f.plan,
      () => 'account:pending',
    ),
  );
  assert.equal(
    pending.length,
    2,
    'timeout cannot permit a third unresolved provider open',
  );
  pending[0]!.resolve({
    bytes: f.plan.bytes,
    stream: new Readable({
      read() {
        throw new Error('Timed-out source must never be consumed');
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  hold = false;
  const next = await other.open(
    async () => f.plan,
    () => 'account:pending',
  );
  next.abort();
  pending[1]!.reject(new Error('late provider failure'));
  await new Promise((resolve) => setImmediate(resolve));
  const last = await service.open(
    async () => f.plan,
    () => 'account:pending',
  );
  last.abort();
});
