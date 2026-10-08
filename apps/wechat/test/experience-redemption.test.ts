import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { ApiClient } from '../src/api/client';
import { HttpExperienceGateway } from '../src/experience/gateway';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeExperienceCatalog,
  decodeExperienceAppearance,
  decodeExperienceIntent,
  decodeExperienceReceipt,
} from '../src/experience/contract';
import {
  decodeRedemptionCapability,
  decodeRedemptionInput,
  type RedemptionReceipt,
} from '../src/experience/redemption-contract';
import { PendingRedemptionStore } from '../src/experience/redemption-pending';
import { decodePublicExperienceDisplay } from '../src/experience/public-display';
import { ScriptedTransport, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  appearance,
  at,
  catalog,
  otherAccount,
  requestId,
  setup,
  unknownSummary,
} from './experience-helpers';
const canary = 'SYNTHETIC-ONLY-Redemption-Canary';
const granted = (id = requestId): RedemptionReceipt => ({
  requestId: id,
  operation: 'redeem_title',
  outcome: 'granted',
  titleKey: 'redeem_liangchenmeijing',
});
const failure = (serverCode: string) =>
  new ClientError('business', 'safe', { serverCode });
const account = wireCredentials().accountId;
const notFound = async (): Promise<never> => {
  throw failure('EXPERIENCE_REQUEST_NOT_FOUND');
};
function enabled() {
  const s = setup();
  s.gateway.redemptionImpl = async () => ({ status: 'available' });
  return s;
}

test('exact 17 reviewed title tuples, independent unknown level and undated limited ownership', () => {
  const c = catalog();
  assert.equal(c.titles.length, 17);
  decodeExperienceCatalog(c);
  for (const titles of [
    c.titles.slice(0, 16),
    [...c.titles, c.titles[0]],
    c.titles.map((t) =>
      t.kind === 'limited' ? { ...t, name: 'invented' } : t,
    ),
    c.titles.map((t) => (t.kind === 'limited' ? { ...t, kind: 'special' } : t)),
  ])
    assert.throws(() => decodeExperienceCatalog({ ...c, titles }));
  const title = c.titles[16]!;
  const owned = appearance({
    coverage: 'partial',
    titles: [{ ...title, earnedAt: null, recordedAt: at }],
    titleKey: title.key,
  });
  assert.equal(decodeExperienceAppearance(owned).titles[0]!.earnedAt, null);
  const display = decodePublicExperienceDisplay({
    title: { status: 'known', value: { key: title.key, name: title.name } },
    color: { status: 'known', value: null },
    level: { status: 'unavailable', value: null },
  });
  assert.equal(display.title.value?.name, '良辰美景');
});
test('strict secret input and receipts; raw codes cannot enter generic intent decoder', () => {
  for (const code of [
    '',
    '\0',
    'a\n',
    '\u0085',
    '\ud800',
    '鲸'.repeat(43),
    'x'.repeat(129),
  ])
    assert.throws(() => decodeRedemptionInput({ requestId, code }));
  for (const code of [' A a ', 'x'.repeat(128), '鲸'.repeat(42)])
    assert.equal(decodeRedemptionInput({ requestId, code }).code, code);
  assert.throws(() =>
    decodeRedemptionInput({ requestId, code: canary, ownerId: account }),
  );
  assert.throws(() =>
    decodeExperienceIntent({
      operation: 'redeem_title',
      requestId,
      code: canary,
    }),
  );
  decodeExperienceReceipt(granted());
  for (const bad of [
    { ...granted(), titleKey: 'level_1' },
    { ...granted(), code: canary },
    { ...granted(), outcome: 'invalid' },
    { requestId, operation: 'redeem_title', outcome: 'rejected', code: canary },
  ])
    assert.throws(() => decodeExperienceReceipt(bad));
  assert.throws(() =>
    decodeRedemptionCapability({ status: 'available', codes: [] }),
  );
});
test('unavailable capability never accepts a guess or saves a handle; UI has no working submit', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.setRedemptionCode(canary);
  await s.controller.redeemTitle();
  assert.equal(s.view().redemptionCode, '');
  assert.equal(s.view().redemptionStatus, 'unavailable');
  await assert.rejects(s.runtime.redeemTitle(canary));
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'redeemTitle'),
    false,
  );
  assert.equal(s.storage.data.size, 0);
  s.runtime.dispose();
});
test('coalesced POST and recovery share one in-flight result, handle stores only identity, no code/hash', async () => {
  const s = enabled(),
    late = deferred<RedemptionReceipt>();
  s.gateway.redeemTitleImpl = () => late.promise;
  const first = s.runtime.redeemTitle(canary),
    second = s.runtime.redeemTitle('different');
  await flush();
  const recovery = s.runtime.recoverRedemption();
  await flush();
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'redeemTitle').length,
    1,
  );
  assert.equal(s.gateway.calls.filter((c) => c.method === 'receipt').length, 0);
  assert.deepEqual(s.runtime.pending.redemption.load(account), {
    version: 1,
    origin: 'https://api.example.invalid',
    accountId: account,
    operation: 'redeem_title',
    requestId,
  });
  assert.equal(JSON.stringify([...s.storage.data]).includes(canary), false);
  late.resolve(granted());
  await Promise.all([first, second, recovery]);
  assert.equal(s.runtime.pending.redemption.load(account), null);
  s.runtime.dispose();
});
test('lost reply recovers by GET while unavailable, without code and without auto-equip', async () => {
  const s = enabled();
  s.gateway.redeemTitleImpl = async () => {
    throw new ClientError('network', 'safe');
  };
  await assert.rejects(s.runtime.redeemTitle(canary));
  s.gateway.redemptionImpl = async () => ({ status: 'unavailable' });
  s.gateway.receiptImpl = async () => granted();
  assert.deepEqual(await s.runtime.recoverRedemption(), granted());
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'redeemTitle').length,
    1,
  );
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'selectAppearance'),
    false,
  );
  s.runtime.dispose();
});
test('404 retains handle; reentry queries before retry, uses original ID and exact bytes', async () => {
  const s = enabled();
  s.gateway.redeemTitleImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await assert.rejects(s.runtime.redeemTitle(canary));
  s.gateway.receiptImpl = notFound;
  await assert.rejects(
    s.runtime.recoverRedemption(),
    (e) =>
      e instanceof ClientError &&
      e.details.serverCode === 'EXPERIENCE_REDEMPTION_REENTRY_REQUIRED',
  );
  assert.ok(s.runtime.pending.redemption.load(account));
  s.gateway.redeemTitleImpl = async (input) => {
    assert.equal(input.requestId, requestId);
    assert.equal(input.code, '  Exact Reentry  ');
    return granted();
  };
  await s.runtime.recoverRedemption('  Exact Reentry  ');
  assert.equal(s.ids(), 1);
  const methods = s.gateway.calls.map((c) => c.method);
  const posted = methods.lastIndexOf('redeemTitle');
  assert.deepEqual(methods.slice(posted - 2, posted + 1), [
    'receipt',
    'redemption',
    'redeemTitle',
  ]);
  s.runtime.dispose();
});
test('storage failures block dispatch, namespace/account scopes and malformed handles fail closed', async () => {
  const s = enabled();
  s.storage.failWrite = true;
  await assert.rejects(s.runtime.redeemTitle(canary));
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'redeemTitle'),
    false,
  );
  s.storage.failWrite = false;
  s.runtime.pending.redemption.freeze(account, requestId);
  assert.equal(
    new PendingRedemptionStore(s.storage, 'https://other.example.invalid').load(
      account,
    ),
    null,
  );
  assert.equal(s.runtime.pending.redemption.load(otherAccount), null);
  const key = [...s.storage.data.keys()][0]!;
  s.storage.data.set(key, {
    ...s.runtime.pending.redemption.load(account),
    code: canary,
  });
  assert.throws(() => s.runtime.pending.redemption.load(account));
  s.runtime.dispose();
});
test('hide/back/logout/account change clear input; stale replies preserve original handle and cannot repaint', async () => {
  for (const change of ['hide', 'back', 'logout', 'switch'] as const) {
    const s = enabled();
    await s.controller.load();
    s.controller.setRedemptionCode(canary);
    if (change === 'hide') s.runtime.hide();
    else if (change === 'back') s.controller.dispose();
    else if (change === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('other'),
        accountId: otherAccount,
      });
    assert.equal(s.view().redemptionCode, '');
    s.runtime.dispose();
  }
  const s = enabled(),
    late = deferred<RedemptionReceipt>();
  s.gateway.redeemTitleImpl = () => late.promise;
  const pending = s.runtime.redeemTitle(canary);
  await flush();
  s.runtime.hide();
  await assert.rejects(pending);
  late.resolve(granted());
  await flush();
  assert.ok(s.runtime.pending.redemption.load(account));
  assert.equal(JSON.stringify([...s.storage.data]).includes(canary), false);
  s.gateway.receiptImpl = notFound;
  await assert.rejects(s.runtime.recoverRedemption());
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'redeemTitle').length,
    1,
  );
  s.runtime.dispose();
});
test('terminal rejection clears handle, nonterminal errors and conflicts preserve it', async () => {
  for (const code of [
    'EXPERIENCE_REDEMPTION_INVALID',
    'EXPERIENCE_TITLE_ALREADY_OWNED',
  ] as const) {
    const s = enabled();
    s.gateway.redeemTitleImpl = async (input) => ({
      requestId: input.requestId,
      operation: 'redeem_title',
      outcome: 'rejected',
      code,
    });
    await s.runtime.redeemTitle(canary);
    assert.equal(s.runtime.pending.redemption.load(account), null);
    s.runtime.dispose();
  }
  for (const code of [
    'EXPERIENCE_REDEMPTION_RATE_LIMITED',
    'EXPERIENCE_REDEMPTION_UNAVAILABLE',
    'EXPERIENCE_REQUEST_CONFLICT',
  ]) {
    const s = enabled();
    s.gateway.redeemTitleImpl = async () => {
      throw failure(code);
    };
    await assert.rejects(s.runtime.redeemTitle(canary));
    assert.ok(s.runtime.pending.redemption.load(account));
    s.runtime.dispose();
  }
});
test('success refreshes limited inventory, keeps unknown balance, dates and dirty appearance choices', async () => {
  const s = enabled();
  s.gateway.currentSummary = unknownSummary();
  s.gateway.currentAppearance = appearance({
    coverage: 'partial',
    titles: appearance().titles.map((t) => ({ ...t, earnedAt: null })),
  });
  await s.controller.load();
  s.controller.chooseTitle('level_1');
  s.controller.chooseColor(1);
  s.gateway.redeemTitleImpl = async () => {
    s.gateway.currentAppearance = {
      ...s.gateway.currentAppearance,
      titles: [
        ...s.gateway.currentAppearance.titles,
        { ...catalog().titles[16]!, earnedAt: at, recordedAt: at },
      ],
    };
    return granted();
  };
  s.controller.setRedemptionCode(canary);
  await s.controller.redeemTitle();
  await flush();
  assert.equal(s.view().balanceLabel, '历史经验基准未确认');
  assert.equal(s.view().titleGroups[0]?.label, '限定头衔');
  assert.equal(s.view().titleKey, 'level_1');
  assert.equal(s.view().colorId, 1);
  assert.equal(s.view().appearance?.titleKey, null);
  assert.equal(s.view().appearance?.titles[0]?.earnedAt, null);
  assert.match(s.view().receiptStatus, /良辰美景/);
  s.runtime.dispose();
});
test('gateway routes code only in first-party POST body and never auth-replays capability, receipt or redemption', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpExperienceGateway(
    new ApiClient('https://api.example.invalid', transport, s.sessions, {
      refresh: async () => {
        refreshes++;
        return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  transport.reply(granted());
  await gateway.redeemTitle({ requestId, code: canary }, new Cancellation());
  assert.equal(
    transport.requests[0]?.url,
    'https://api.example.invalid/v1/me/experience/redemptions',
  );
  assert.deepEqual(transport.requests[0]?.body, { requestId, code: canary });
  for (const work of [
    () => gateway.redemption(new Cancellation()),
    () => gateway.receipt(requestId, new Cancellation()),
    () => gateway.redeemTitle({ requestId, code: canary }, new Cancellation()),
  ]) {
    transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    await assert.rejects(work);
  }
  assert.equal(refreshes, 0);
  assert.equal(transport.requests.length, 4);
  s.runtime.dispose();
});

test('session replacement during redemption suppresses stale settlement and recovery is owner-only', async () => {
  const s = enabled(),
    late = deferred<RedemptionReceipt>();
  s.gateway.redeemTitleImpl = () => late.promise;
  const attempt = s.runtime.redeemTitle(canary);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('other'),
    accountId: otherAccount,
  });
  await assert.rejects(attempt);
  late.resolve(granted());
  await flush();
  assert.ok(s.runtime.pending.redemption.load(account));
  assert.equal(s.runtime.pending.redemption.load(otherAccount), null);
  await assert.rejects(s.runtime.recoverRedemption());
  assert.equal(s.gateway.calls.filter((c) => c.method === 'receipt').length, 0);
  assert.equal(s.view().appearance, null);
  s.runtime.dispose();
});
test('restart persists only handle and wrong receipt/removal failure cannot erase recovery', async () => {
  const s = enabled();
  s.gateway.redeemTitleImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await assert.rejects(s.runtime.redeemTitle(canary));
  const restarted = new PendingRedemptionStore(
    s.storage,
    'https://api.example.invalid',
  );
  assert.equal(restarted.load(account)?.requestId, requestId);
  const handle = restarted.load(account)!;
  assert.throws(() =>
    restarted.settle(handle, granted('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
  );
  assert.ok(restarted.load(account));
  s.storage.failRemove = true;
  assert.throws(() => restarted.settle(handle, granted()));
  assert.ok(restarted.load(account));
  s.storage.failRemove = false;
  restarted.settle(handle, granted());
  assert.equal(restarted.load(account), null);
  s.runtime.dispose();
});
test('cancel before dispatch prevents code POST; late capability never dispatches after hide', async () => {
  const s = enabled(),
    late = deferred<{ status: 'available' }>();
  s.gateway.redemptionImpl = () => late.promise;
  const attempt = s.runtime.redeemTitle(canary);
  await flush();
  s.runtime.hide();
  await assert.rejects(attempt);
  late.resolve({ status: 'available' });
  await flush();
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'redeemTitle'),
    false,
  );
  assert.equal(s.storage.data.size, 0);
  s.runtime.dispose();
});
