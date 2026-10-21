import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { timetableReceiptSchema } from '../../src/personal-timetable/contracts.js';
interface NativeResult {
  event: 'done';
  termId: string;
  entryId: string;
  duplicateId: string;
  cancelledRequestId: string;
  requestIds: string[];
  exchanges: Array<{
    path: string;
    method: string;
    authorized: boolean;
    status: number;
  }>;
  assertions: string[];
}
/** Wait for both the result and ordinary child exit. A result cannot hide open handles. */
function resultOf(child: ChildProcess): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    let result: NativeResult | undefined,
      settled = false;
    const timer = setTimeout(
      () => finish(new Error('Native timetable journey timed out')),
      120_000,
    );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGTERM');
        reject(error);
      } else resolve(result!);
    };
    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('event' in raw))
        return finish(new Error('Invalid native timetable worker result'));
      const value = raw as Record<string, unknown>;
      if (value['event'] === 'error')
        return finish(new Error(String(value['message'])));
      if (value['event'] !== 'done' || result)
        return finish(new Error('Unexpected native timetable worker result'));
      result = raw as NativeResult;
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal || !result)
        finish(
          new Error(
            'Native timetable worker exited without a completed journey',
          ),
        );
      else finish();
    });
  });
}
test(
  'emitted native private timetable pages/components → real HTTP/PostgreSQL CRUD, exact recovery, cancellation and owner isolation',
  { timeout: 240_000 },
  async (t) => {
    const f = await accountAppealsFixture();
    let child: ChildProcess | undefined = undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child?.kill('SIGKILL');
            resolve();
          }, 3000);
          child!.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await f.close();
    });
    const owner = await createRuntimeActor(f.app),
      other = await createRuntimeActor(f.app);
    child = fork(
      fileURLToPath(
        new URL(
          '../support/personal-timetable-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    const result = resultOf(child);
    child.send({ port: f.port, credentials: owner, otherCredentials: other });
    const done = await result;
    assert.equal(done.assertions.length, 11);
    for (const name of [
      'native-term-create',
      'native-term-date-confirm-update',
      'native-entry-create-explicit-odd-weeks',
      'native-detail-copy-overlap-accepted',
      'native-cold-committed-recovery-cancel-race',
      'native-cold-exact-original-retry',
      'native-unknown-original-cancel-fence',
      'native-cross-account-no-private-render',
      'native-entry-delete',
      'native-navigation-failure',
      'native-exact-typed-term-delete',
    ])
      assert.ok(done.assertions.includes(name), name);
    assert.ok(done.exchanges.length > 25);
    assert.ok(
      done.exchanges.every(
        (exchange) =>
          exchange.authorized &&
          exchange.path.startsWith('/v1/me/timetable') &&
          !exchange.path.includes('?'),
      ),
    );
    assert.ok(
      done.exchanges.some(
        (exchange) =>
          exchange.method === 'POST' &&
          exchange.path.endsWith('/cancel') &&
          exchange.status === 200,
      ),
    );
    assert.ok(
      done.exchanges.some(
        (exchange) =>
          exchange.method === 'GET' &&
          exchange.path.endsWith(`/terms/${done.termId}`) &&
          exchange.status === 404,
      ),
    );
    const receipts = (
      await f.pool.query<{
        request_id: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        'SELECT request_id,intent_hash,receipt FROM whaleu_timetable.commands WHERE account_id=$1 ORDER BY request_id',
        [owner.accountId],
      )
    ).rows;
    assert.equal(receipts.length, done.requestIds.length);
    assert.equal(
      new Set(receipts.map((row) => row.request_id)).size,
      receipts.length,
    );
    for (const row of receipts) {
      const receipt = timetableReceiptSchema.parse(row.receipt);
      assert.ok(done.requestIds.includes(receipt.requestId));
      assert.equal(receipt.intentHash, row.intent_hash);
      assert.equal(receipt.termId, done.termId);
      assert.ok(
        !('payload' in receipt) && !('name' in receipt) && !('note' in receipt),
      );
      if (receipt.requestId === done.cancelledRequestId) {
        assert.equal(receipt.outcome, 'cancelled');
        assert.equal(receipt.resultingRevision, null);
      } else assert.equal(receipt.outcome, 'applied');
    }
    const term = (
      await f.pool.query<{
        revision: number;
        name: string | null;
        deleted_at: Date | null;
      }>(
        'SELECT revision,name,deleted_at FROM whaleu_timetable.terms WHERE account_id=$1 AND term_id=$2',
        [owner.accountId, done.termId],
      )
    ).rows[0]!;
    assert.ok(term.deleted_at);
    assert.equal(term.name, null);
    assert.equal(
      term.revision,
      receipts.filter(
        (row) =>
          timetableReceiptSchema.parse(row.receipt).outcome === 'applied',
      ).length,
    );
    const entries = (
      await f.pool.query<{
        entry_id: string;
        name: string | null;
        note: string | null;
        deleted_at: Date | null;
      }>(
        'SELECT entry_id,name,note,deleted_at FROM whaleu_timetable.entries WHERE account_id=$1 AND term_id=$2 ORDER BY entry_id',
        [owner.accountId, done.termId],
      )
    ).rows;
    assert.deepEqual(
      entries.map((row) => row.entry_id).sort(),
      [done.entryId, done.duplicateId].sort(),
    );
    assert.ok(
      entries.every(
        (row) => row.deleted_at && row.name === null && row.note === null,
      ),
    );
    const cross = (
      await f.pool.query<{ n: number }>(
        'SELECT count(*)::integer n FROM whaleu_timetable.commands WHERE account_id=$1',
        [other.accountId],
      )
    ).rows[0]!;
    assert.equal(cross.n, 0);
    await request(f.http)
      .get(`/v1/me/timetable/terms/${done.termId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
    const history = await request(f.http)
      .get(`/v1/me/timetable/requests/${done.cancelledRequestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    assert.equal(history.body.status, 'settled');
    assert.equal(history.body.receipt.outcome, 'cancelled');
    const otherHistory = await request(f.http)
      .get(`/v1/me/timetable/requests/${done.cancelledRequestId}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(200);
    assert.deepEqual(otherHistory.body, {
      status: 'unknown',
      requestId: done.cancelledRequestId,
    });
  },
);
