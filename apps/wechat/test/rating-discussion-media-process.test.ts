import { intent as legacyIntent } from './ratings-helpers';
import { replyIntent } from './ratings-r2a-helpers';
import { subscriptionIntent } from './ratings-r2c-helpers';
import { adminIntent } from './ratings-r3a-helpers';
import { creationIntent } from './ratings-management-helpers';
import { ownerIntent } from './rating-owner-management-helpers';
import { editingIntent } from './rating-owner-editing-helpers';
import { categoryCreationIntent } from './category-management-helpers';
import { managementIntent } from './category-scoped-helpers';
import { scopedIntent } from './rating-scoped-helpers';
import { decodeRatingTargetCoverIntent } from '../src/ratings/target-cover-contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discussionProcessFixture } from './support/discussion-media-process-fixtures';
import type { DiscussionBatchStatus } from '../src/ratings/discussion-media-wire';
import type { RatingDiscussionMediaReceipt } from '../src/ratings/discussion-media-contract';
test('SIGKILL at original two-key boundaries reconnects distinct native processes to an authoritative synthetic server', async () => {
  const directory = await mkdtemp(
      join(tmpdir(), 'ratings-discussion-process-'),
    ),
    fixture = discussionProcessFixture(),
    protocol = 'ratings-discussion-media-v1';
  let stage = '',
    batch: DiscussionBatchStatus | null = null,
    receipt: RatingDiscussionMediaReceipt | null = null,
    fenced = false;
  const calls: string[] = [],
    commits = { count: 0 };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        request.headers.authorization,
        'Bearer synthetic-process-access',
      );
      const path = request.url!;
      calls.push(`${request.method} ${path}`);
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      let value: unknown;
      if (
        path ===
        `/v4/ratings/discussion/receipts/${fixture.intent.payload.clientRequestId}`
      ) {
        if (!receipt) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                code: 'REQUEST_NOT_FOUND',
                message: 'Synthetic absence',
                requestId: fixture.intent.payload.clientRequestId,
              },
            }),
          );
          return;
        }
        value = receipt;
      } else if (
        path ===
          `/v4/ratings/discussion/requests/${fixture.intent.payload.clientRequestId}/cancel` ||
        path === '/v4/ratings/discussion/cancel'
      ) {
        assert.equal(request.method, 'POST');
        if (!receipt)
          receipt = {
            protocolVersion: 4,
            requestId: fixture.intent.payload.clientRequestId,
            operation: fixture.intent.operation,
            intentHash: fixture.receipt.intentHash,
            outcome: 'closed',
            code: 'RATING_CREATION_CANCELLED',
          };
        value = receipt;
      } else if (
        path ===
        `/v3/media/ratings-discussion/batch-requests/${fixture.initial.identity.batchRequestId}/cancel`
      ) {
        assert.equal(body.identityHash, fixture.initial.identityHash);
        fenced = true;
        if (batch && batch.state !== 'consumed')
          batch = { ...batch, state: 'cancelled' };
        value = batch
          ? {
              protocol,
              batchRequestId: fixture.initial.identity.batchRequestId,
              serverNow: 1000,
              state: 'recorded',
              status: batch,
            }
          : {
              protocol,
              batchRequestId: fixture.initial.identity.batchRequestId,
              serverNow: 1000,
              state: 'cancelled_before_prepare',
              identityHash: fixture.initial.identityHash,
            };
      } else if (
        path ===
        `/v3/media/ratings-discussion/batch-requests/${fixture.initial.identity.batchRequestId}`
      ) {
        value = batch
          ? {
              protocol,
              batchRequestId: fixture.initial.identity.batchRequestId,
              serverNow: 1000,
              state: 'recorded',
              status: batch,
            }
          : fenced
            ? {
                protocol,
                batchRequestId: fixture.initial.identity.batchRequestId,
                serverNow: 1000,
                state: 'cancelled_before_prepare',
                identityHash: fixture.initial.identityHash,
              }
            : {
                protocol,
                batchRequestId: fixture.initial.identity.batchRequestId,
                serverNow: 1000,
                state: 'not_recorded',
              };
      } else if (
        path ===
        `/v3/media/ratings-discussion/batches/${fixture.sealed.batchId}`
      )
        value = batch;
      else if (
        path ===
        `/v3/media/ratings-discussion/batches/${fixture.sealed.batchId}/cancel`
      ) {
        assert.ok(batch);
        batch = { ...batch, state: 'cancelled' };
        value = batch;
      } else if (
        path.startsWith('/v3/media/ratings-discussion/upload-requests/')
      ) {
        const member = fixture.sealed.members.find((m) =>
          path.endsWith(m.clientRequestId),
        );
        assert.ok(member);
        const index = fixture.sealed.members.indexOf(member);
        const common = {
          protocol,
          batchId: fixture.sealed.batchId,
          memberId: member.memberId,
          intentId: fixture.batch.members[index]!.intentId,
          requestId: member.clientRequestId,
          requestHash: member.requestHash,
          serverNow: 1000,
        };
        const status =
          stage === 'prepare-unknown'
            ? {
                ...common,
                status: 'prepared',
                operationDeadlineAt: 1,
                upload: 'reconcile_needed',
              }
            : {
                ...common,
                status: 'ready_unbound',
                assetId: member.assetId,
                manifestDigest: member.manifestDigest,
                bindBefore: 99999999999999,
                mediaProof: 'current',
              };
        value = {
          protocol,
          requestId: member.clientRequestId,
          serverNow: 1000,
          state: 'recorded',
          requestHash: member.requestHash,
          status,
        };
      } else
        throw new Error(
          `Unexpected publication/transfer/context request ${request.method} ${path}`,
        );
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'SYNTHETIC_UNEXPECTED_REQUEST',
            message: String(error),
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const run = async (
    mode: string,
    path: string,
    legacyVersion?: number,
    legacyValue?: unknown,
    options: Record<string, unknown> = {},
  ) => {
    const child = fork(
      join(__dirname, 'support/native-rating-discussion-process.mjs'),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    child.stderr?.resume();
    try {
      const result = await new Promise<{
        event: string;
        message?: string;
        retainedKeys?: number;
      }>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Synthetic child checkpoint timeout')),
          15000,
        );
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== null && code !== 0)
            reject(new Error(`Child exited ${code}`));
        });
        child.once('message', (value) => {
          clearTimeout(timeout);
          resolve(
            value as { event: string; message?: string; retainedKeys?: number },
          );
        });
        child.send({
          mode,
          stage,
          path,
          server: endpoint,
          legacyVersion,
          legacyValue,
          ...options,
        });
      });
      assert.equal(
        result.event,
        mode === 'write' ? 'durable' : 'recovered',
        result.message,
      );
      return result;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exited;
      }
    }
  };
  try {
    for (stage of [
      'batch-persisted',
      'prepare-unknown',
      'seal-persisted',
      'command-frozen',
      'applied-before-receipt',
      'native-completion-pending',
      'opaque-account-switch',
      'opaque-partial-scrub',
    ]) {
      calls.length = 0;
      receipt = null;
      fenced = false;
      batch =
        stage === 'batch-persisted'
          ? null
          : stage === 'prepare-unknown'
            ? {
                ...fixture.batch,
                state: 'editing',
                sealedPlan: null,
                sealedPlanDigest: null,
              }
            : fixture.batch;
      const applied =
        stage === 'applied-before-receipt' ||
        stage === 'native-completion-pending';
      if (applied) {
        receipt = fixture.receipt;
        batch = fixture.consumed;
        commits.count++;
      }
      const count = commits.count,
        path = join(directory, `${stage}.json`);
      await run('write', path);
      calls.length = 0;
      await run('recover', path);
      // Even a durable local receipt is reobserved before media in a fresh
      // process. No context/grant/upload or new command is allowed.
      assert.equal(
        calls[0],
        `GET /v4/ratings/discussion/receipts/${fixture.intent.payload.clientRequestId}`,
      );
      assert.equal(commits.count, count);
      assert.ok(
        !calls.some((call) =>
          /\/contexts|\/grant|\/uploads\/|\/commit|\/prepare/.test(call),
        ),
      );
    }
    // A and B were observed in the killed writer; neither opaque key could be
    // persisted. A fresh process with A's identical credentials must still
    // treat surviving full bytes as opaque obligations, even if writes fail.
    stage = 'opaque-both-scrub-failed';
    batch = fixture.batch;
    receipt = null;
    fenced = false;
    calls.length = 0;
    const bothFailedPath = join(directory, `${stage}.json`);
    await run('write', bothFailedPath);
    const residual = await readFile(bothFailedPath, 'utf8');
    assert.match(residual, /"phase":"command"/);
    assert.match(residual, /"context"/);
    calls.length = 0;
    const retry = await run('recover', bothFailedPath, undefined, undefined, {
      action: 'retry',
      expectedSettled: false,
      cancelAfterRecovery: false,
      requireOpaque: true,
      blockScrubWrites: true,
    });
    assert.equal(retry.retainedKeys, 2);
    assert.equal(await readFile(bothFailedPath, 'utf8'), residual);
    assert.deepEqual(calls, [
      `GET /v4/ratings/discussion/receipts/${fixture.intent.payload.clientRequestId}`,
    ]);
    assert.equal(receipt, null);
    assert.equal(fenced, false);
    assert.equal(batch.state, 'sealed');
    // Only the next explicit user cancellation may close the original owner
    // hash and batch key. A retry never means cancellation or fresh publication.
    calls.length = 0;
    await run('recover', bothFailedPath, undefined, undefined, {
      action: 'cancel',
      expectedSettled: true,
    });
    assert.equal(
      calls[0],
      `GET /v4/ratings/discussion/receipts/${fixture.intent.payload.clientRequestId}`,
    );
    assert.ok(
      calls.includes(
        `POST /v4/ratings/discussion/requests/${fixture.intent.payload.clientRequestId}/cancel`,
      ),
    );
    assert.ok(
      calls.includes(
        `POST /v3/media/ratings-discussion/batch-requests/${fixture.initial.identity.batchRequestId}/cancel`,
      ),
    );
    assert.ok(
      !calls.some((call) =>
        /\/contexts|\/grant|\/uploads\/|\/commit|\/prepare/.test(call),
      ),
    );
    const base = scopedIntent('create_target_scoped');
    const { assetIds: _assets, ...coverPayload } = base.payload as Extract<
      typeof base,
      { operation: 'create_target_scoped' }
    >['payload'];
    assert.deepEqual(_assets, []);
    const cover = decodeRatingTargetCoverIntent({
      protocolVersion: 3,
      operation: 'create_target_scoped',
      context: base.context,
      payload: { ...coverPayload, cover: { action: 'clear' } },
    });
    const historical = [
      legacyIntent(),
      replyIntent(),
      subscriptionIntent(),
      adminIntent(),
      creationIntent(),
      ownerIntent(),
      editingIntent(),
      categoryCreationIntent(),
      scopedIntent(),
      managementIntent(),
      cover,
    ];
    for (let version = 1; version <= 11; version++) {
      stage = `old-valid-${version}`;
      calls.length = 0;
      await run('legacy', join(directory, `${stage}.json`), version, {
        version,
        accountId: fixture.actor,
        intent: historical[version - 1],
      });
      assert.deepEqual(calls, []);
    }
    for (let version = 1; version <= 11; version++) {
      stage = `old-corrupt-${version}`;
      calls.length = 0;
      await run('legacy', join(directory, `${stage}.json`), version);
      assert.deepEqual(calls, []);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
