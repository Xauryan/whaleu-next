import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { cancelPending, dispatch, recover } from '../src/messaging/commands';
import { PendingMessagingStore, intentHash } from '../src/messaging/pending';
import { createMessagingRuntime } from '../src/messaging/runtime';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { createHash } from 'node:crypto';
import {
  accountId,
  harness,
  otherId,
  receipt,
  sendIntent,
} from './messaging-helpers';
test('DM original journal is account-bound, immutable, one-command bounded and verified before sending', async () => {
  const h = harness(),
    intent = sendIntent();
  const attempt = h.runtime.pending.freeze({ version: 1, accountId, intent });
  assert.throws(() =>
    h.runtime.pending.freeze({
      version: 1,
      accountId,
      intent: sendIntent('改文'),
    }),
  );
  assert.ok(Object.isFrozen(attempt.intent));
  const fresh = harness();
  fresh.storage.failWrite = true;
  await assert.rejects(
    dispatch(fresh.runtime, intent, new Cancellation(), () => undefined),
  );
  assert.equal(fresh.applied.length, 0);
});
test('lost response recovers body-free receipt and never dispatches second message', async () => {
  const h = harness(),
    intent = sendIntent();
  h.gateway.apply = async (raw) => {
    h.applied.push(raw);
    throw new ClientError('network', 'lost');
  };
  await assert.rejects(
    dispatch(h.runtime, intent, new Cancellation(), () => undefined),
  );
  const saved = h.runtime.pending.load(accountId)!;
  assert.ok(saved);
  await recover(h.runtime, saved, false, new Cancellation(), () => undefined);
  assert.equal(h.applied.length, 1);
  assert.equal(h.runtime.pending.load(accountId), null);
});
test('explicit retry first queries original receipt then replays same key and normalized original text only', async () => {
  const h = harness();
  const saved = h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('a\r\nb'),
  });
  h.gateway.receipt = async () => {
    throw new ClientError('business', 'missing', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await assert.rejects(
    recover(h.runtime, saved, false, new Cancellation(), () => undefined),
  );
  assert.equal(h.applied.length, 0);
  await recover(h.runtime, saved, true, new Cancellation(), () => undefined);
  assert.deepEqual(h.applied, [sendIntent('a\nb')]);
});
test('rejected receipts settle original command; conflict and temporary unavailability never rewrite it', async () => {
  const h = harness(),
    saved = h.runtime.pending.freeze({
      version: 1,
      accountId,
      intent: sendIntent(),
    });
  h.gateway.receipt = async () => {
    throw new ClientError('business', 'unavailable', {
      serverCode: 'DM_UNAVAILABLE',
    });
  };
  await assert.rejects(
    recover(h.runtime, saved, true, new Cancellation(), () => undefined),
  );
  assert.equal(h.applied.length, 0);
  h.gateway.receipt = async () => ({
    requestId: saved.intent.clientRequestId,
    operation: 'send',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  await recover(h.runtime, saved, false, new Cancellation(), () => undefined);
  assert.equal(h.runtime.pending.load(accountId), null);
});
test('logout scrubs body but preserves account-isolated commitment; same account relogin can recover', async () => {
  const h = harness();
  const runtime = createMessagingRuntime(
    { sessions: h.sessions },
    h.storage,
    'synthetic',
    h.runtime.newRequestId,
    h.clock,
  );
  const saved = runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('原文必须清除'),
  });
  assert.equal(runtime.pending.load(otherId), null);
  assert.equal(runtime.pending.load(accountId)?.requestId, saved.requestId);
  h.sessions.logout();
  assert.equal(runtime.pending.load(accountId)?.intent, null);
  assert.equal(runtime.pending.load(accountId)?.intentHash, saved.intentHash);
  assert.ok(
    !JSON.stringify([...h.storage.data.values()]).includes('原文必须清除'),
  );
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherId,
  });
  assert.equal(runtime.pending.load(otherId), null);
  assert.equal(runtime.pending.load(accountId)?.requestId, saved.requestId);
  h.sessions.logout();
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials());
  await recover(
    { ...runtime, gateway: h.gateway },
    runtime.pending.load(accountId)!,
    false,
    new Cancellation(),
    () => undefined,
  );
  assert.equal(runtime.pending.load(accountId), null);
});
test('receipt mismatch cannot discard recovery body', () => {
  const store = new PendingMessagingStore(new MemoryStorage(), 'synthetic'),
    saved = store.freeze({ version: 1, accountId, intent: sendIntent() });
  assert.throws(() =>
    store.settle(saved, { ...receipt(saved.intent), requestId: otherId }),
  );
  assert.equal(store.load(accountId)?.intent?.operation, 'send');
});
test('successful original open is recovered even when its source later disappears', async () => {
  const h = harness(),
    intent = {
      operation: 'open' as const,
      clientRequestId: sendIntent().clientRequestId,
      entry: {
        kind: 'reply' as const,
        postId: otherId,
        rootCommentId: accountId,
        replyId: otherId,
      },
      initiationMode: 'anonymous' as const,
    };
  const pending = h.runtime.pending.freeze({ version: 1, accountId, intent });
  h.gateway.apply = async () => {
    throw new ClientError('business', 'source gone', {
      serverCode: 'DM_ENTRY_UNAVAILABLE',
    });
  };
  h.gateway.receipt = async () => receipt(intent);
  const result = await recover(
    h.runtime,
    pending,
    true,
    new Cancellation(),
    () => undefined,
  );
  assert.equal(result.outcome, 'applied');
  assert.equal(h.applied.length, 0);
  assert.equal(h.runtime.pending.load(accountId), null);
});

test('minimal commitment never reconstructs a missing body; explicit safe cancel fences late original', async () => {
  const h = harness(),
    intent = sendIntent();
  h.runtime.pending.freeze({ version: 1, accountId, intent });
  h.runtime.pending.scrubBodies();
  const saved = h.runtime.pending.load(accountId)!;
  h.gateway.receipt = async () => {
    throw new ClientError('business', 'missing', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await assert.rejects(
    recover(h.runtime, saved, true, new Cancellation(), () => undefined),
    /原文已清除/,
  );
  assert.equal(h.applied.length, 0);
  assert.equal(h.runtime.pending.load(accountId)?.requestId, saved.requestId);
  let terminal: ReturnType<typeof receipt> | null = null;
  h.gateway.cancel = async (requestId, operation, hash) => {
    assert.equal(hash, saved.intentHash);
    terminal = {
      requestId,
      operation,
      outcome: 'rejected',
      code: 'DM_COMMAND_CANCELLED',
    };
    return { outcome: 'cancelled', receipt: terminal };
  };
  h.gateway.apply = async (original) => terminal ?? receipt(original);
  const cancelled = await cancelPending(
    h.runtime,
    saved,
    new Cancellation(),
    () => undefined,
  );
  assert.equal(cancelled.outcome, 'cancelled');
  assert.deepEqual(
    await h.gateway.apply(intent, new Cancellation()),
    cancelled.receipt,
  );
  assert.equal(h.runtime.pending.load(accountId), null);
});
test('cancel after committed lost response returns actual old receipt, never a false cancellation', async () => {
  const h = harness(),
    intent = sendIntent();
  h.runtime.pending.freeze({ version: 1, accountId, intent });
  h.runtime.pending.scrubBodies();
  const saved = h.runtime.pending.load(accountId)!;
  h.gateway.cancel = async () => ({
    outcome: 'already_terminal',
    receipt: receipt(intent),
  });
  const result = await cancelPending(
    h.runtime,
    saved,
    new Cancellation(),
    () => undefined,
  );
  assert.equal(result.outcome, 'already_terminal');
  assert.equal(result.receipt.outcome, 'applied');
  assert.equal(h.runtime.pending.load(accountId), null);
});
test('v1 journal migrates its original key and exact hash before body scrubbing', () => {
  const storage = new MemoryStorage(),
    intent = sendIntent('legacy original');
  storage.set('whaleu.private-messages.pending.v1:synthetic', {
    version: 1,
    accountId,
    intent,
  });
  const store = new PendingMessagingStore(storage, 'synthetic');
  store.scrubBodies();
  const saved = store.load(accountId)!;
  assert.equal(saved.requestId, intent.clientRequestId);
  assert.equal(saved.intent, null);
  assert.equal(saved.intentHash, intentHash(intent));
  assert.equal(
    storage.get('whaleu.private-messages.pending.v1:synthetic'),
    undefined,
  );
  const payload = {
    operation: 'send',
    intent: {
      clientRequestId: intent.clientRequestId,
      conversationId: '55555555-5555-4555-8555-555555555555',
      text: 'legacy original',
    },
  };
  const canonical = `{"intent":${JSON.stringify(payload.intent)},"operation":"send"}`;
  assert.equal(
    saved.intentHash,
    createHash('sha256')
      .update('whaleu:dm:v1\n' + canonical)
      .digest('hex'),
  );
});
test('bounded registry never evicts an unresolved account to accept another command', () => {
  const store = new PendingMessagingStore(new MemoryStorage(), 'synthetic');
  const accounts = Array.from(
    { length: 9 },
    (_, i) => `${String(i + 1).padStart(8, '0')}-1234-4123-8123-123456789abc`,
  );
  for (const accountId of accounts.slice(0, 8)) {
    store.freeze({ version: 1, accountId, intent: sendIntent() });
    store.scrubBodies();
  }
  assert.throws(() =>
    store.freeze({ version: 1, accountId: accounts[8]!, intent: sendIntent() }),
  );
  for (const accountId of accounts.slice(0, 8))
    assert.ok(store.load(accountId));
});
test('unconfigured startup still scrubs legacy private body without losing original request commitment', () => {
  const h = harness();
  h.sessions.logout();
  const original = sendIntent('旧配置的私密正文');
  h.storage.set('whaleu.private-messages.pending.v1:synthetic', {
    version: 1,
    accountId,
    intent: original,
  });
  const runtime = createMessagingRuntime(
    { sessions: h.sessions },
    h.storage,
    'synthetic',
    h.runtime.newRequestId,
    h.clock,
  );
  assert.equal(runtime.gateway, undefined);
  assert.equal(
    runtime.pending.load(accountId)?.requestId,
    original.clientRequestId,
  );
  assert.equal(runtime.pending.load(accountId)?.intent, null);
  assert.equal(
    runtime.pending.load(accountId)?.intentHash,
    intentHash(original),
  );
  assert.ok(
    !JSON.stringify([...h.storage.data.values()]).includes('旧配置的私密正文'),
  );
});
