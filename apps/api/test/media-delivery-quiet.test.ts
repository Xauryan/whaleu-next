import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ApplicationError } from '../src/http/application-error.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import { ExactMediaDeliveryService } from '../src/media/delivery.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';
import { observeMediaDeliveryBudget } from './support/media/delivery-budget-observer.js';

function capacity(pool: MediaDeliveryBudgetPool) {
  const leases: (() => void)[] = [];
  let unavailable = false;
  try {
    for (let index = 0; index < 64; index++)
      leases.push(pool.acquire(`quiet-proof:${index}`));
  } catch (error) {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.code, 'MEDIA_UNAVAILABLE');
    unavailable = true;
  } finally {
    for (const release of leases) release();
  }
  return { acquired: leases.length, unavailable };
}

test(
  'HTTP and output completion retain the real credit until delayed native source close, then all 64 credits recover',
  { timeout: 15000 },
  async (t) => {
    const pool = new MediaDeliveryBudgetPool();
    const observed = observeMediaDeliveryBudget(pool);
    const bytes = Buffer.from('synthetic-delayed-source-close');
    const plan = {
      object: {
        provider: 'local-fixture',
        environment: 'synthetic',
        bucket: 'synthetic',
        key: 'delayed-close',
        version: 'one',
      },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      attachmentSetRevision: 'a'.repeat(64),
      bytes: bytes.length,
      mime: 'image/png' as const,
    };
    let source!: Readable;
    let output!: Readable;
    let releaseSourceClose: (() => void) | undefined;
    let notifyOutputClose!: () => void;
    const outputClosed = new Promise<void>((resolve) => {
      notifyOutputClose = resolve;
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
        source = new Readable({
          read() {
            this.push(bytes);
            this.push(null);
          },
          destroy(error, done) {
            // Model asynchronous native file closure without a timing sleep.
            releaseSourceClose = () => done(error);
          },
        });
        return { bytes: bytes.length, stream: source };
      },
    };
    const delivery = new ExactMediaDeliveryService(
      { transaction: (run) => run({} as PoolClient) },
      storage,
      pool,
    );
    const failures: unknown[] = [];
    const server = createServer(async (_request, response) => {
      try {
        const opened = await delivery.open(
          async () => plan,
          () => 'account:delayed-close',
        );
        output = opened.stream;
        output.once('close', notifyOutputClose);
        response.once('close', opened.abort);
        try {
          for (const [key, value] of Object.entries(opened.headers))
            response.setHeader(key, value);
          await pipeline(opened.stream, response);
        } finally {
          opened.abort();
        }
      } catch (error) {
        failures.push(error);
        response.destroy();
      }
    });
    t.after(() => {
      releaseSourceClose?.();
      server.closeAllConnections();
      server.close();
      observed.restore();
    });
    const response = await request(server).get('/');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, bytes);
    await outputClosed;
    assert.equal(output.closed, true);
    assert.equal(source.destroyed, true);
    assert.equal(source.closed, false);
    assert.deepEqual(observed.activeKeys(), ['account:delayed-close']);
    // The previous immediate full-capacity assertion fails in this valid state.
    assert.deepEqual(capacity(pool), { acquired: 63, unavailable: true });
    let quiet = false;
    const waiting = observed.waitForQuiet().then(() => {
      quiet = true;
    });
    await Promise.resolve();
    assert.equal(quiet, false, 'Output close alone is not physical quiet');
    assert.ok(releaseSourceClose);
    releaseSourceClose();
    releaseSourceClose = undefined;
    await waiting;
    assert.equal(source.closed, true);
    assert.equal(output.closed, true);
    assert.deepEqual(observed.activeKeys(), []);
    assert.deepEqual(capacity(pool), { acquired: 64, unavailable: false });
    assert.deepEqual(failures, []);
  },
);

test('quiet deadline fails closed without releasing or forgetting an active real lease', async (t) => {
  const pool = new MediaDeliveryBudgetPool();
  const observed = observeMediaDeliveryBudget(pool);
  const release = pool.acquire('account:still-open');
  t.after(() => {
    release();
    observed.restore();
  });
  await assert.rejects(
    observed.waitForQuiet(10),
    /Media delivery did not become physically quiet.*account:still-open/,
  );
  assert.deepEqual(observed.activeKeys(), ['account:still-open']);
  assert.deepEqual(capacity(pool), { acquired: 63, unavailable: true });
  release();
  release();
  await observed.waitForQuiet();
  assert.deepEqual(observed.activeKeys(), []);
  assert.deepEqual(capacity(pool), { acquired: 64, unavailable: false });
});

test('a new acquisition during a quiet barrier rejects rather than reporting quiet', async (t) => {
  const pool = new MediaDeliveryBudgetPool();
  const observed = observeMediaDeliveryBudget(pool);
  const first = pool.acquire('account:first');
  const waiting = assert.rejects(
    observed.waitForQuiet(),
    /New Media delivery started during quiet barrier/,
  );
  const second = pool.acquire('account:late');
  t.after(() => {
    first();
    second();
    observed.restore();
  });
  first();
  await waiting;
  assert.deepEqual(observed.activeKeys(), ['account:late']);
  assert.deepEqual(capacity(pool), { acquired: 63, unavailable: true });
  second();
  await observed.waitForQuiet();
  assert.deepEqual(observed.activeKeys(), []);
  assert.deepEqual(capacity(pool), { acquired: 64, unavailable: false });
});

test('failed real acquisition creates no phantom observed lease', async (t) => {
  const pool = new MediaDeliveryBudgetPool();
  const observed = observeMediaDeliveryBudget(pool);
  const first = pool.acquire('account:at-limit');
  const second = pool.acquire('account:at-limit');
  t.after(() => {
    first();
    second();
    observed.restore();
  });
  assert.throws(
    () => pool.acquire('account:at-limit'),
    (error) =>
      error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE',
  );
  assert.deepEqual(observed.activeKeys(), [
    'account:at-limit',
    'account:at-limit',
  ]);
  assert.deepEqual(capacity(pool), { acquired: 62, unavailable: true });
  first();
  second();
  await observed.waitForQuiet();
  assert.deepEqual(observed.activeKeys(), []);
  assert.deepEqual(capacity(pool), { acquired: 64, unavailable: false });
});
