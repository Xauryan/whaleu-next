import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { Cancellation } from '../src/platform/contracts';
import {
  ModerationController,
  type ModerationView,
} from '../src/account-moderation/controller';
import {
  HttpModerationGateway,
  type ModerationGateway,
} from '../src/account-moderation/gateway';
import { PendingModerationStore } from '../src/account-moderation/pending';
import {
  decodeCommand,
  decodePunishment,
  decodeStatus,
  decodeReceipt,
  decodePage,
  matchReceipt,
  type Command,
  type Receipt,
  type PunishmentView,
  type AppealView,
} from '../src/account-moderation/contract';
import {
  setup,
  postId,
  otherId,
  requestId,
  createdAt,
} from './community-helpers';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const punishment = (
  kind: PunishmentView['kind'] = 'interaction_mute',
): PunishmentView => ({
  punishmentId: postId,
  kind,
  revision: '1',
  reason: '合成处罚原因',
  startsAt: createdAt,
  endsAt: null,
  recordedAt: createdAt,
  state: 'active',
  terminal: null,
  canAppeal: true,
  openAppealId: null,
});
const ref = () => ({
  punishmentId: postId,
  kind: 'interaction_mute',
  revision: '1',
});
const command = (): Command =>
  decodeCommand({
    clientRequestId: requestId,
    action: 'submit_appeal',
    punishment: ref(),
    text: '合成私人申诉',
  });
const receipt = (c: Command = command(), cancel = false): Receipt =>
  decodeReceipt({
    requestId: c.clientRequestId,
    action: c.action,
    ...(c.action === 'decide_appeal'
      ? { appealId: c.appealId }
      : { punishment: c.punishment }),
    ...(cancel
      ? { outcome: 'rejected', code: 'SAFETY_MODERATION_CANCELLED' }
      : {
          outcome: 'applied',
          recordedAt: createdAt,
          ...(c.action === 'submit_appeal'
            ? { appealId: otherId, reusedOpenCase: false }
            : {
                eventId: otherId,
                ...(c.action === 'decide_appeal'
                  ? { decision: c.decision }
                  : {}),
              }),
        }),
  });
const appeal = (): AppealView => ({
  appealId: otherId,
  punishment: punishment(),
  text: '合成私人申诉',
  submittedAt: createdAt,
  state: 'pending',
  decision: null,
});
function harness(
  mode:
    | 'status'
    | 'appeal'
    | 'appeal-management'
    | 'punishment-management' = 'appeal',
) {
  const s = setup(),
    storage = new MemoryStorage(),
    sent: { command: Command; cancel: boolean }[] = [];
  const gateway: ModerationGateway = {
    status: async () => ({
      coverage: 'complete',
      effective: 'interaction_mute',
      checkedAt: createdAt,
      current: [punishment()],
    }),
    ownPunishment: async () => punishment(),
    history: async () => ({ items: [punishment()], nextCursor: null }),
    punishments: async () => ({
      items: [
        { ...punishment(), stateVersion: 'a'.repeat(64), canRelease: true },
      ],
      nextCursor: null,
    }),
    punishment: async () => ({
      ...punishment(),
      stateVersion: 'a'.repeat(64),
      canRelease: true,
    }),
    punishmentHistory: async () => ({
      items: [punishment()],
      nextCursor: null,
    }),
    appeals: async () => ({ items: [appeal()], nextCursor: null }),
    appeal: async () => appeal(),
    appealQueue: async () => ({
      items: [{ ...appeal(), stateVersion: 'b'.repeat(64), canDecide: true }],
      nextCursor: null,
    }),
    appealManagement: async () => ({
      ...appeal(),
      stateVersion: 'b'.repeat(64),
      canDecide: true,
    }),
    submit: async (c, _cancel, cancel = false) => {
      sent.push({ command: c, cancel });
      return receipt(c, cancel);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingModerationStore(
    storage,
    'https://synthetic.example',
  );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    accountModeration: gateway,
    pendingAccountModeration: store,
  };
  let view!: ModerationView;
  const make = () =>
    new ModerationController(
      runtime,
      (v) => {
        view = v;
      },
      mode,
    );
  return {
    ...s,
    runtime,
    storage,
    gateway,
    store,
    sent,
    make,
    view: () => view,
  };
}
test('strict contract distinguishes two independently current kinds and rejects foreign fields', () => {
  const mute = punishment(),
    suspension = { ...punishment('access_suspension'), punishmentId: otherId };
  assert.equal(
    decodeStatus({
      coverage: 'complete',
      effective: 'access_suspension',
      checkedAt: createdAt,
      current: [mute, suspension],
    }).current.length,
    2,
  );
  assert.throws(() =>
    decodeStatus({
      coverage: 'complete',
      effective: 'interaction_mute',
      checkedAt: createdAt,
      current: [mute, mute],
    }),
  );
  assert.throws(() => decodePunishment({ ...mute, accountId: otherId }));
  assert.equal(
    decodePage(
      { items: [mute, suspension], nextCursor: null },
      decodePunishment,
    ).items.length,
    2,
  );
  assert.throws(() => decodeCommand({ ...command(), text: ' '.repeat(3) }));
  assert.throws(() => decodeCommand({ ...command(), text: 'a'.repeat(4001) }));
});
test('receipt matching binds action, key, exact punishment lineage and decision', () => {
  matchReceipt(command(), receipt());
  assert.throws(() =>
    matchReceipt(command(), {
      ...receipt(),
      punishment: { ...ref(), revision: '2' },
    } as Receipt),
  );
  assert.throws(() => decodeReceipt({ ...receipt(), accountId: otherId }));
});
test('own appeal saves before submit and delivers private real command shape', async () => {
  const h = harness(),
    c = h.make();
  await c.load({ punishmentId: postId });
  c.setText(' 合成私人申诉 ');
  c.request('submit_appeal');
  await c.submit();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]!.command, command());
  assert.equal(h.store.load(h.accountId), null);
  assert.match(h.view().receiptStatus, /完成/);
});
test('failed storage write prevents transmission', async () => {
  const h = harness(),
    c = h.make();
  await c.load({ punishmentId: postId });
  c.setText('申诉');
  c.request('submit_appeal');
  h.storage.failWrite = true;
  await c.submit();
  assert.equal(h.sent.length, 0);
  assert.equal(h.view().frozen, true);
});
test('lost response restores immutable key across pages and cancellation cannot change payload', async () => {
  const h = harness(),
    c = h.make();
  h.gateway.submit = async (command, _cancel, cancelling = false) => {
    h.sent.push({ command, cancel: cancelling });
    if (!cancelling) throw new ClientError('network', 'lost');
    return receipt(command, true);
  };
  await c.load({ punishmentId: postId });
  c.setText('合成私人申诉');
  c.request('submit_appeal');
  await c.submit();
  c.dispose();
  const next = h.make();
  await next.load({ punishmentId: otherId });
  assert.equal(h.view().frozen, true);
  assert.deepEqual(h.view().pendingCommand, command());
  next.setText('cannot replace');
  next.requestCancellation();
  await next.confirmCancellation();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[0]!.command, h.sent[1]!.command);
  assert.equal(h.sent[1]!.cancel, true);
  assert.equal(h.store.load(h.accountId), null);
});
test('not recorded is not a terminal result; explicit retry retains request and intent', async () => {
  const h = harness(),
    c = h.make();
  h.store.freeze({
    version: 1,
    accountId: h.accountId,
    origin: h.store.origin,
    phase: 'submit',
    command: command(),
  });
  await c.load();
  await c.recover();
  assert.equal(h.view().frozen, true);
  assert.equal(h.sent.length, 0);
  await c.recover(true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]!.command, command());
});
test('admin release binds specific lineage/version and cannot release both kinds', async () => {
  const h = harness('punishment-management'),
    c = h.make();
  await c.load({ punishmentId: postId });
  c.setReason('合成解除理由');
  c.request('release');
  await c.submit();
  const sent = h.sent[0]!.command;
  assert.equal(sent.action, 'release');
  if (sent.action !== 'release') throw Error();
  assert.deepEqual(sent.punishment, ref());
  assert.equal(sent.expectedStateVersion, 'a'.repeat(64));
  assert.equal('accountId' in sent, false);
});
test('super-admin decision uses private appeal reference, chosen result and fresh version', async () => {
  const h = harness('appeal-management'),
    c = h.make();
  await c.load({ appealId: otherId });
  c.setReason('合成处理理由');
  c.request('decide_appeal', 'released');
  await c.submit();
  const sent = h.sent[0]!.command;
  assert.equal(sent.action, 'decide_appeal');
  if (sent.action !== 'decide_appeal') throw Error();
  assert.equal(sent.appealId, otherId);
  assert.equal(sent.decision, 'released');
  assert.equal(sent.expectedStateVersion, 'b'.repeat(64));
});
test('private recovery remains available after current authority has gone', async () => {
  const h = harness('appeal-management'),
    c = h.make();
  h.store.freeze({
    version: 1,
    accountId: h.accountId,
    origin: h.store.origin,
    phase: 'submit',
    command: command(),
  });
  h.gateway.appealQueue = async () => {
    throw Error('authority forbidden');
  };
  h.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
  await c.load();
  await c.recover();
  assert.equal(h.view().frozen, false);
  assert.match(h.view().receiptStatus, /完成/);
});
test('session rotation and page exit suppress late private response', async () => {
  const h = harness(),
    c = h.make(),
    wait = deferred<PunishmentView>();
  h.gateway.ownPunishment = () => wait.promise;
  const pending = c.load({ punishmentId: postId });
  await flush();
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials());
  wait.resolve(punishment());
  await pending;
  assert.equal(h.view().selectedPunishment, null);
  assert.equal(h.view().loaded, false);
  const next = h.make();
  h.gateway.ownPunishment = async () => punishment();
  await next.load({ punishmentId: postId });
  next.dispose();
  assert.equal(h.view().selectedPunishment, null);
});
test('delayed random key cannot persist or send after page exit', async () => {
  const h = harness(),
    key = deferred<string>();
  const runtime = { ...h.runtime, newRequestId: () => key.promise };
  let view!: ModerationView;
  const c = new ModerationController(
    runtime,
    (v) => {
      view = v;
    },
    'appeal',
  );
  await c.load({ punishmentId: postId });
  c.setText('申诉');
  c.request('submit_appeal');
  const pending = c.submit();
  await flush();
  c.dispose();
  key.resolve(requestId);
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.load(h.accountId), null);
  assert.equal(view.frozen, false);
});
test('pending moderation never hides own suspended status; unavailable is not clear', async () => {
  const h = harness('status'),
    c = h.make();
  h.store.freeze({
    version: 1,
    accountId: h.accountId,
    origin: h.store.origin,
    phase: 'cancel',
    command: command(),
  });
  h.gateway.status = async () => ({
    coverage: 'unavailable',
    effective: 'access_suspension',
    checkedAt: createdAt,
    current: [punishment('access_suspension')],
  });
  await c.load();
  assert.equal(h.view().frozen, true);
  assert.equal(h.view().accountStatus?.coverage, 'unavailable');
  assert.equal(h.view().accountStatus?.effective, 'access_suspension');
});
test('origin and original account isolate journals; mismatched recovery cannot settle', () => {
  const h = harness();
  const p = h.store.freeze({
    version: 1,
    accountId: h.accountId,
    origin: h.store.origin,
    phase: 'submit',
    command: command(),
  });
  assert.equal(
    new PendingModerationStore(h.storage, 'https://other.example').load(
      h.accountId,
    ),
    null,
  );
  assert.equal(h.store.load(otherId), null);
  assert.throws(() => h.store.settle(p, { ...receipt(), requestId: otherId }));
  assert.ok(h.store.load(h.accountId));
});
test('real HTTP gateway sends exact API routes and full immutable cancellation; no guest fallback', async () => {
  const h = harness(),
    transport = new ScriptedTransport(),
    api = new ApiClient('https://synthetic.example', transport, h.sessions, {
      refresh: async () => {
        throw Error('no replay');
      },
    }),
    g = new HttpModerationGateway(api),
    cancel = new Cancellation();
  transport.reply({
    coverage: 'complete',
    effective: 'interaction_mute',
    checkedAt: createdAt,
    current: [punishment()],
  });
  await g.status(cancel);
  assert.ok(transport.requests[0]!.url.endsWith('/v1/me/safety/status'));
  transport.reply(receipt());
  await g.submit(command(), cancel);
  assert.ok(
    transport.requests[1]!.url.endsWith('/v1/me/safety/appeal-commands'),
  );
  transport.reply(receipt(command(), true));
  await g.submit(command(), cancel, true);
  assert.ok(
    transport.requests[2]!.url.endsWith('/v1/me/safety/appeal-commands/cancel'),
  );
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply({ state: 'recorded', receipt: receipt() });
  await g.receipt(command(), cancel);
  assert.ok(
    transport.requests[3]!.url.endsWith(
      '/v1/me/safety/appeal-requests/' + requestId,
    ),
  );
  transport.reply({ ...appeal(), appealId: postId });
  await assert.rejects(g.appeal(otherId, cancel));
  assert.ok(transport.requests.every((r) => !!r.headers.Authorization));
});
test('four native pages are registered and use private API controls, not public feedback', () => {
  const app = JSON.parse(
    readFileSync(path.resolve(__dirname, '../src/app.json'), 'utf8'),
  ) as { pages: string[] };
  for (const page of [
    'account-status',
    'safety-appeal',
    'safety-appeal-management',
    'safety-punishment-management',
  ])
    assert.ok(app.pages.includes(`pages/${page}/${page}`));
  const wxml = readFileSync(
    path.resolve(__dirname, '../src/account-moderation/screen.wxml'),
    'utf8',
  );
  assert.match(wxml, /onConfirmCancel/);
  assert.match(wxml, /onRequestRelease/);
  assert.match(wxml, /onRequestDecision/);
  assert.doesNotMatch(wxml, /pages\/feedback/);
});

test('mute and suspension preserve sessions; only Identity blocked is terminal', async () => {
  for (const code of [
    'SAFETY_ACTION_RESTRICTED',
    'SAFETY_ACCESS_SUSPENDED',
    'ACCOUNT_BLOCKED',
  ]) {
    const h = harness(),
      c = h.make(),
      owner = h.sessions.snapshot();
    h.gateway.appeals = async () => {
      throw new ClientError('forbidden', 'synthetic denial', {
        httpStatus: 403,
        serverCode: code,
      });
    };
    await c.load();
    if (code === 'ACCOUNT_BLOCKED')
      assert.equal(h.sessions.snapshot().credentials, null);
    else {
      h.sessions.assertCurrent(owner);
      assert.ok(h.sessions.snapshot().credentials);
      assert.equal(h.view().hasSession, true);
    }
  }
});

test('optional authenticated suspended HTTP never becomes guest or auth replay', async () => {
  const h = harness(),
    transport = new ScriptedTransport();
  let redirects = 0,
    refreshes = 0;
  const api = new ApiClient(
    'https://synthetic.example',
    transport,
    h.sessions,
    {
      refresh: async (ticket) => {
        refreshes++;
        return ticket;
      },
    },
    15000,
    () => {
      redirects++;
    },
  );
  transport.reply({ error: { code: 'SAFETY_ACCESS_SUSPENDED' } }, 403);
  await assert.rejects(
    api.request({
      path: '/v1/posts',
      method: 'GET',
      authentication: 'optional',
      authReplay: 'once',
      successStatus: 200,
      decode: (v) => v,
    }),
    { kind: 'forbidden' },
  );
  assert.equal(redirects, 1);
  assert.equal(refreshes, 0);
  assert.equal(transport.requests.length, 1);
  assert.ok(transport.requests[0]!.headers.Authorization);
  assert.ok(h.sessions.snapshot().credentials);
});
