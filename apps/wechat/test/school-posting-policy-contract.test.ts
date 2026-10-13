import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import { SessionStore } from '../src/auth/session';
import {
  decodePostingPolicyCommand,
  decodePostingPolicyInput,
  decodePostingPolicyView,
  decodePostingPolicyRecovery,
  postingPolicyCategories,
  postingPolicyCommandHash,
  postingPolicyInstant,
  postingPolicyUuid,
} from '../src/school-posting-policy/contract';
import { HttpSchoolPostingPolicyGateway } from '../src/school-posting-policy/gateway';
import { PostingPolicyJournal } from '../src/school-posting-policy/pending';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  postingCommand,
  postingPolicy,
  postingView,
  postingReceipt,
  postingRegion,
  postingOther,
  postingOrigin,
  postingRequest,
  postingRevisionId,
} from './school-posting-policy-helpers';

test('posting policy strictly separates absent, active, expired and unavailable source states', () => {
  const active = postingView({
    revision: 1,
    revisionId: postingRevisionId,
    state: 'active',
    policy: { ...postingPolicy(), effectiveAt: '2026-01-01T00:00:00.000Z' },
  });
  const expired = {
    ...active,
    state: 'expired',
    policy: {
      ...active.policy!,
      expiry: { kind: 'at', validUntil: '2026-02-01T00:00:00.000Z' },
    },
  };
  for (const value of [
    postingView(),
    active,
    expired,
    {
      ...active,
      state: 'unavailable',
      policy: null,
      editable: false,
      blocker: 'untrusted_source',
    },
    { ...active, editable: false, blocker: 'related_sync_unsupported' },
  ])
    assert.deepEqual(decodePostingPolicyView(value), value);
  for (const value of [
    { ...postingView(), editable: false },
    { ...postingView(), policy: active.policy },
    { ...active, revisionId: null },
    {
      ...active,
      state: 'unavailable',
      editable: false,
      blocker: 'untrusted_source',
    },
    { ...active, editable: true, blocker: 'related_sync_unsupported' },
    { ...active, state: 'expired' },
    { ...active, sourceReference: 'private' },
    { ...active, policy: { ...active.policy, relatedSyncEnabled: 'false' } },
  ])
    assert.throws(() => decodePostingPolicyView(value));
});

test('commands preserve category order and exact UTC bytes without granting feedback, trading, sync or anonymous access', () => {
  assert.equal(postingPolicyCategories.length, 9);
  for (const key of ['feedback', 'trading', 'unknown'])
    assert.throws(() =>
      decodePostingPolicyInput({
        ...postingPolicy(),
        unverifiedCategories: [key],
      }),
    );
  assert.throws(() =>
    decodePostingPolicyInput({
      ...postingPolicy(),
      unverifiedCategories: ['pets', 'pets'],
    }),
  );
  for (const key of [
    'relatedSyncEnabled',
    'authorMode',
    'phoneVerified',
    'reviewApproved',
    'sourceReference',
  ])
    assert.throws(() =>
      decodePostingPolicyInput({ ...postingPolicy(), [key]: true }),
    );
  for (const value of [
    '2026-02-30T00:00:00Z',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01',
    '2026-01-01T24:00:00Z',
  ])
    assert.throws(() => postingPolicyInstant(value));
  assert.equal(
    postingPolicyInstant('2027-01-01T00:00:00Z'),
    '2027-01-01T00:00:00Z',
  );
  assert.equal(
    postingPolicyInstant('2027-01-01T00:00:00.000Z'),
    '2027-01-01T00:00:00.000Z',
  );
  const actor = wireCredentials().accountId,
    command = decodePostingPolicyCommand(postingCommand());
  const canonical = `{"actorId":"${actor}","command":{"clientRequestId":"${postingRequest}","expectedRevision":0,"policy":{"expiry":{"kind":"policy_exempt"},"unverifiedCategories":["discussion","pets"],"unverifiedCommentEnabled":false,"unverifiedPostEnabled":true}},"regionId":"${postingRegion}"}`;
  assert.equal(
    postingPolicyCommandHash(actor, postingRegion, command),
    createHash('sha256')
      .update('whaleu-school-posting-policy-command:v1\n' + canonical)
      .digest('hex'),
  );
  assert.notEqual(
    postingPolicyCommandHash(actor, postingRegion, command),
    postingPolicyCommandHash(actor, postingRegion, {
      ...command,
      policy: {
        ...command.policy,
        unverifiedCategories: ['pets', 'discussion'],
      },
    }),
  );
  assert.ok(
    Object.isFrozen(command) &&
      Object.isFrozen(command.policy) &&
      Object.isFrozen(command.policy.expiry) &&
      Object.isFrozen(command.policy.unverifiedCategories),
  );
  assert.throws(() =>
    decodePostingPolicyCommand({
      ...command,
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.throws(() =>
    decodePostingPolicyRecovery({
      state: 'recorded',
      requestId: postingOther,
      receipt: postingReceipt(),
    }),
  );
});

test('durable journal is actor/origin scoped, refuses replacement, and requires exact original receipt or cancellation', () => {
  const storage = new MemoryStorage(),
    journal = new PostingPolicyJournal(storage, postingOrigin),
    actor = wireCredentials().accountId;
  const pending = journal.write(actor, postingRegion, postingCommand());
  assert.ok(Object.isFrozen(pending));
  assert.deepEqual(
    journal.write(actor, postingRegion, postingCommand()),
    pending,
  );
  assert.equal(journal.read(postingOther), null);
  assert.equal(
    new PostingPolicyJournal(storage, 'https://other-school.invalid').read(
      actor,
    ),
    null,
  );
  assert.throws(() =>
    journal.write(actor, postingRegion, {
      ...postingCommand(),
      expectedRevision: 1,
    }),
  );
  for (const receipt of [
    { ...postingReceipt(), requestHash: '0'.repeat(64) },
    { ...postingReceipt(), regionId: postingOther },
    { ...postingReceipt(), revision: 2 },
    { ...postingReceipt(), requestId: postingOther },
  ])
    assert.throws(() => journal.settle(pending, receipt));
  assert.throws(() =>
    journal.cancel(pending, postingOther, pending.requestHash),
  );
  assert.throws(() => journal.cancel(pending, postingRequest, '0'.repeat(64)));
  storage.failRemove = true;
  assert.throws(() => journal.settle(pending, postingReceipt()));
  assert.ok(journal.read(actor));
  storage.failRemove = false;
  journal.cancel(pending, postingRequest, pending.requestHash);
  assert.equal(journal.read(actor), null);
  journal.write(actor, postingRegion, postingCommand());
  const key = [...storage.data.keys()][0]!;
  storage.data.set(key, {
    ...pending,
    command: { ...pending.command, expectedRevision: 9 },
  });
  assert.throws(() => journal.read(actor));
  assert.equal(storage.data.has(key), true);
});

test('native HTTP gateway uses authenticated dedicated paths, refuses cross-scope receipts and never replays writes after auth expiry', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient(postingOrigin, transport, sessions, {
    refresh: async () => {
      refreshes++;
      throw new Error('Unexpected refresh');
    },
  });
  const gateway = new HttpSchoolPostingPolicyGateway(api),
    cancel = new Cancellation();
  transport.reply(postingView());
  await gateway.management(null, cancel);
  assert.equal(
    transport.requests[0]!.url,
    `${postingOrigin}/v1/me/school-posting-policy`,
  );
  transport.reply(postingView());
  await gateway.management(postingRegion, cancel);
  assert.equal(
    new URL(transport.requests[1]!.url).searchParams.get('regionId'),
    postingRegion,
  );
  transport.reply(postingReceipt());
  await gateway.save(postingRegion, postingCommand(), cancel);
  assert.deepEqual(transport.requests[2]!.body, postingCommand());
  assert.equal(transport.requests[2]!.method, 'POST');
  assert.ok(transport.requests[2]!.headers.Authorization);
  transport.reply({ ...postingReceipt(), regionId: postingOther });
  await assert.rejects(gateway.save(postingRegion, postingCommand(), cancel));
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(gateway.save(postingRegion, postingCommand(), cancel));
  assert.equal(refreshes, 0);
  transport.reply({ state: 'not_recorded', requestId: postingOther });
  await assert.rejects(gateway.recover(postingRequest, cancel));
  transport.reply({
    state: 'cancelled',
    requestId: postingRequest,
    requestHash: postingReceipt().requestHash,
  });
  await gateway.cancel(postingRequest, postingReceipt().requestHash, cancel);
  assert.deepEqual(transport.requests[transport.requests.length - 1]!.body, {
    requestHash: postingReceipt().requestHash,
  });
});

test('posting policy rejects uppercase UUID spelling without changing original actor, region or request bytes', () => {
  const lower = 'abcdef12-abcd-4abc-8abc-abcdef123456',
    upper = lower.toUpperCase();
  assert.equal(postingPolicyUuid(lower), lower);
  assert.throws(() => postingPolicyUuid(upper));
  assert.throws(() =>
    decodePostingPolicyCommand({ ...postingCommand(), clientRequestId: upper }),
  );
  assert.throws(() =>
    decodePostingPolicyView({
      ...postingView(),
      context: { ...postingView().context, regionId: upper },
    }),
  );
  assert.throws(() =>
    postingPolicyCommandHash(upper, postingRegion, postingCommand()),
  );
  assert.throws(() =>
    postingPolicyCommandHash(
      wireCredentials().accountId,
      upper,
      postingCommand(),
    ),
  );
  assert.throws(() =>
    decodePostingPolicyRecovery({ state: 'not_recorded', requestId: upper }),
  );
});
