import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import { RatingTargetCoverCommandController } from '../src/ratings/target-cover-controller';
import { PendingRatingStore } from '../src/ratings/pending';
import {
  decodeRatingTargetCoverIntent,
  ratingTargetCoverIntentHash,
  type RatingTargetCoverReceipt,
} from '../src/ratings/target-cover-contract';
import type { RatingTargetCoverGateway } from '../src/ratings/target-cover-gateway';
import { deferred, MemoryStorage } from './helpers';
import { accountId, wireCredentials } from './identity-helpers';
import { scopedIntent } from './rating-scoped-helpers';
const intent = () => {
  const old = scopedIntent('create_target_scoped');
  return decodeRatingTargetCoverIntent({
    protocolVersion: 3,
    operation: old.operation,
    context: old.context,
    payload: {
      clientRequestId: old.payload.clientRequestId,
      categoryId: old.payload.categoryId,
      expectedCategoryRevision: old.payload.expectedCategoryRevision,
      name: 'A target',
      description: '',
      cover: { action: 'clear' },
    },
  });
};
function harness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    pending = new PendingRatingStore(storage, 'cover'),
    calls: string[] = [];
  const original = intent();
  const receipt: RatingTargetCoverReceipt = {
    protocolVersion: 3,
    operation: original.operation,
    requestId: original.payload.clientRequestId,
    intentHash: ratingTargetCoverIntentHash(original),
    outcome: 'closed',
    code: 'RATING_CREATION_CANCELLED',
  };
  const missing = async (): Promise<never> => {
    throw new ClientError('business', 'Not recorded', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const gateway: RatingTargetCoverGateway = {
    subscriptions: missing,
    random: missing,
    context: missing,
    detail: missing,
    targets: missing,
    editContext: missing,
    prepare: missing,
    receipt: async () => {
      calls.push('receipt');
      return missing();
    },
    command: async () => {
      calls.push('command');
      return receipt;
    },
    cancel: async () => {
      calls.push('cancel');
      return receipt;
    },
  };
  const controller = new RatingTargetCoverCommandController(
    sessions,
    pending,
    gateway,
    () => undefined,
  );
  return { sessions, pending, controller, gateway, calls, original, receipt };
}
test('v3 retry looks up receipt before original command; read-only recovery not-found retains journal', async () => {
  const h = harness();
  h.pending.freeze({ version: 11, accountId, intent: h.original });
  await h.controller.recover();
  assert.deepEqual(h.calls, ['receipt']);
  assert.equal(h.pending.load(accountId)?.version, 11);
  await h.controller.retry();
  assert.deepEqual(h.calls, ['receipt', 'receipt', 'command']);
  assert.equal(h.pending.load(accountId), null);
  h.controller.dispose();
});
test('late original receipt after logout cannot clear the original actor journal or repaint content', async () => {
  const h = harness(),
    late = deferred<RatingTargetCoverReceipt>();
  h.gateway.receipt = () => late.promise;
  h.pending.freeze({ version: 11, accountId, intent: h.original });
  const work = h.controller.recover();
  h.sessions.logout();
  late.resolve(h.receipt);
  await work;
  assert.equal(h.pending.load(accountId)?.version, 11);
  assert.equal(h.controller.snapshot().requestId, null);
  assert.equal(h.controller.snapshot().status, 'idle');
  h.controller.dispose();
});
