import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { PendingExperienceStore } from '../src/experience/pending';
import {
  ExperienceController,
  initialExperienceView,
} from '../src/experience/controller';
import type { SignInReceipt } from '../src/experience/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  appearance,
  at,
  noticeId,
  otherAccount,
  receipt,
  recordId,
  requestId,
  setup,
  summary,
  unknownSummary,
} from './experience-helpers';
const error = (code: string, status = 409) =>
  new ClientError('business', 'safe', { httpStatus: status, serverCode: code });
const pending = (
  s: ReturnType<typeof setup>,
  operation: 'sign_in' | 'appearance' = 'sign_in',
) => s.runtime.pending.load(wireCredentials().accountId, operation);

test('GET page load never mutates, known zero differs from baseline unknown, no fake empty lifetime claims', async () => {
  const s = setup();
  await s.controller.load();
  assert.equal(s.view().balanceLabel, '0');
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'signIn'),
    false,
  );
  assert.equal(s.storage.data.size, 0);
  s.gateway.currentSummary = unknownSummary();
  s.gateway.currentAppearance = appearance({
    coverage: 'partial',
    titles: appearance().titles.map((t) => ({ ...t, earnedAt: null })),
  });
  s.gateway.currentRecords = {
    items: [],
    nextCursor: null,
    coverage: 'partial',
  };
  await s.controller.load();
  assert.match(s.view().balanceLabel, /基准未确认/);
  assert.match(s.view().recordsCoverage, /空列表不代表/);
  assert.equal(s.view().appearance?.titles[0]?.earnedAt, null);
  assert.equal(s.view().titleKey, null);
  assert.equal(s.view().previewTitle, '当前未显示头衔');
  s.runtime.dispose();
});
test('foreground calls coalesce an explicit POST; repeat refresh and same server day cannot double award or use global UTC', async () => {
  const s = setup(),
    late = deferred<SignInReceipt>();
  s.gateway.signInImpl = () => late.promise;
  const a = s.runtime.foreground(),
    b = s.runtime.foreground();
  await flush();
  assert.equal(s.gateway.calls.filter((c) => c.method === 'signIn').length, 1);
  assert.ok(pending(s));
  assert.equal(s.ids(), 1);
  late.resolve(receipt());
  await Promise.all([a, b]);
  assert.equal(pending(s), null);
  await s.runtime.foreground();
  assert.equal(s.gateway.calls.filter((c) => c.method === 'signIn').length, 1);
  // No local clock participates. Only a new authoritative server day permits a fresh command.
  s.gateway.currentSummary = summary({ serverDay: '2030-01-02' });
  s.gateway.signInImpl = async (i) =>
    receipt({ requestId: i.requestId, rewardDay: '2030-01-02' });
  await s.runtime.foreground();
  assert.equal(s.gateway.calls.filter((c) => c.method === 'signIn').length, 2);
  s.runtime.dispose();
});
test('pending/baseline failures never succeed and foreground cannot automatically replace or retry frozen intent across midnight', async () => {
  for (const code of [
    'EXPERIENCE_PENDING',
    'EXPERIENCE_BASELINE_UNAVAILABLE',
  ]) {
    const s = setup();
    s.gateway.signInImpl = async () => {
      throw error(code);
    };
    await s.runtime.foreground();
    const original = pending(s);
    assert.ok(original);
    assert.equal(
      s.gateway.calls.filter((c) => c.method === 'signIn').length,
      1,
    );
    s.gateway.currentSummary = summary({ serverDay: '2026-10-09' });
    await s.runtime.foreground();
    await s.runtime.foreground();
    assert.deepEqual(pending(s), original);
    assert.equal(s.ids(), 1);
    assert.equal(
      s.gateway.calls.filter((c) => c.method === 'signIn').length,
      1,
    );
    await s.controller.load();
    assert.equal(s.view().signInPending, true);
    await s.controller.recover('sign_in', true);
    assert.deepEqual(pending(s), original);
    assert.match(
      s.view().error,
      code === 'EXPERIENCE_PENDING' ? /前面的经验变动/ : /历史经验基准/,
    );
    s.runtime.dispose();
  }
});
test('unknown baseline automatic read does not invent zero, a grant or a successful sign-in', async () => {
  const s = setup();
  s.gateway.currentSummary = unknownSummary();
  await s.runtime.foreground();
  assert.equal(s.ids(), 0);
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'signIn'),
    false,
  );
  assert.equal(s.storage.data.size, 0);
  s.runtime.dispose();
});
test('exact sign-in request survives response loss/midnight and receipt lookup, missing receipt never releases it', async () => {
  const s = setup();
  s.gateway.signInImpl = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  await assert.rejects(s.runtime.signIn());
  const original = pending(s)!;
  s.gateway.receiptImpl = async () => {
    throw error('EXPERIENCE_REQUEST_NOT_FOUND', 404);
  };
  await assert.rejects(s.runtime.recover('sign_in'));
  assert.deepEqual(pending(s), original);
  s.gateway.currentSummary = summary({ serverDay: '2026-10-09' });
  s.gateway.signInImpl = async (i) => {
    assert.equal(i.requestId, original.intent.requestId);
    return receipt({ requestId: i.requestId });
  };
  const recovered = await s.runtime.recover('sign_in', true);
  assert.equal(recovered.operation, 'sign_in');
  assert.equal(
    recovered.operation === 'sign_in' && recovered.rewardDay,
    '2026-10-08',
  );
  assert.equal(pending(s), null);
  s.runtime.dispose();
});
test('separate journals allow undated owned title and base color while unknown sign-in remains blocked', async () => {
  const s = setup();
  s.gateway.currentSummary = unknownSummary();
  s.gateway.currentAppearance = appearance({
    coverage: 'partial',
    titles: appearance().titles.map((t) => ({ ...t, earnedAt: null })),
  });
  s.gateway.signInImpl = async () => {
    throw error('EXPERIENCE_BASELINE_UNAVAILABLE');
  };
  await s.controller.load();
  await s.controller.signIn();
  assert.ok(pending(s));
  s.controller.chooseTitle('level_1');
  s.controller.chooseColor(0);
  await s.controller.saveAppearance();
  await flush();
  assert.ok(pending(s));
  assert.equal(pending(s, 'appearance'), null);
  assert.equal(s.gateway.currentAppearance.titleKey, 'level_1');
  assert.equal(s.gateway.currentAppearance.colorId, 0);
  s.runtime.dispose();
});
test('retained equipped high color survives unrelated title edit after downgrade; another locked color and unowned title cannot be selected', async () => {
  const s = setup();
  s.gateway.currentAppearance = appearance({
    colorId: 25,
    titleKey: 'default_jingxiaoyu',
    revision: '3',
  });
  await s.controller.load();
  s.controller.chooseColor(24);
  assert.equal(s.view().colorId, 25);
  s.controller.chooseTitle('level_29');
  assert.equal(s.view().titleKey, 'default_jingxiaoyu');
  s.controller.chooseTitle('level_1');
  await s.controller.saveAppearance();
  await flush();
  assert.equal(s.gateway.currentAppearance.colorId, 25);
  assert.equal(s.gateway.currentAppearance.titleKey, 'level_1');
  assert.equal(s.view().colors.find((c) => c.id === 25)?.retained, true);
  s.runtime.dispose();
});
test('explicit independent clear has exact null payload; definitive appearance rejection receipt alone releases journal', async () => {
  const s = setup();
  s.gateway.currentAppearance = appearance({ colorId: 1, titleKey: 'level_1' });
  await s.controller.load();
  s.controller.chooseTitle(null);
  s.gateway.selectAppearanceImpl = async (i) => {
    assert.equal(i.titleKey, null);
    assert.equal(i.colorId, 1);
    return {
      requestId: i.requestId,
      operation: 'appearance',
      outcome: 'rejected',
      code: 'EXPERIENCE_APPEARANCE_CONFLICT',
    };
  };
  await s.controller.saveAppearance();
  await flush();
  assert.equal(pending(s, 'appearance'), null);
  assert.match(s.view().receiptStatus, /其他操作中改变/);
  s.runtime.dispose();
});
test('persist/readback failure and corrupt/foreign records stop first dispatch; operation and origin lanes remain independent', async () => {
  for (const mode of ['write', 'readback', 'corrupt']) {
    const s = setup();
    if (mode === 'write') s.storage.failWrite = true;
    else if (mode === 'readback') s.storage.set = () => undefined;
    else
      s.storage.data.set(
        `whaleu.experience.pending.v1:https://api.example.invalid:${wireCredentials().accountId}:sign_in`,
        {
          version: 1,
          accountId: otherAccount,
          intent: { operation: 'sign_in', requestId },
        },
      );
    await assert.rejects(s.runtime.signIn());
    assert.equal(
      s.gateway.calls.some((c) => c.method === 'signIn'),
      false,
    );
    s.runtime.dispose();
  }
  const s = setup();
  const store = new PendingExperienceStore(
    s.storage,
    'https://other.example.invalid',
  );
  s.runtime.pending.freeze({
    version: 1,
    accountId: wireCredentials().accountId,
    intent: { operation: 'sign_in', requestId },
  });
  assert.equal(store.load(wireCredentials().accountId, 'sign_in'), null);
  assert.equal(s.runtime.pending.load(otherAccount, 'sign_in'), null);
  assert.equal(
    s.runtime.pending.load(wireCredentials().accountId, 'appearance'),
    null,
  );
  s.runtime.dispose();
});
test('double manual clicks coalesce one persisted request and credential refresh does not spawn another foreground command', async () => {
  const s = setup(),
    late = deferred<SignInReceipt>();
  s.gateway.signInImpl = () => late.promise;
  const a = s.runtime.signIn(),
    b = s.runtime.signIn();
  await flush();
  assert.equal(s.ids(), 1);
  assert.equal(s.gateway.calls.filter((c) => c.method === 'signIn').length, 1);
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.resolve(receipt());
  await Promise.all([a, b]);
  assert.equal(s.gateway.calls.filter((c) => c.method === 'signIn').length, 1);
  s.runtime.dispose();
});
test('same tick cancellation and account switch during random ID await prevent persistence/dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const p = s.runtime.signIn(cancel);
  cancel.cancel();
  await assert.rejects(p);
  assert.equal(s.storage.data.size, 0);
  assert.equal(s.gateway.calls.length, 0);
  s.runtime.dispose();
  const t = setup(),
    id = deferred<string>();
  Object.defineProperty(t.runtime, 'newRequestId', { value: () => id.promise });
  const q = t.runtime.signIn();
  await flush();
  t.sessions.completeLogin(t.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherAccount,
  });
  id.resolve(requestId);
  await assert.rejects(q);
  assert.equal(t.storage.data.size, 0);
  assert.equal(t.gateway.calls.length, 0);
  t.runtime.dispose();
});
test('hide/Back/cancel and account or same-account session replacement reject late completion and preserve original journal', async () => {
  for (const mode of ['cancel', 'page', 'app', 'account', 'relogin'] as const) {
    const s = setup(),
      late = deferred<SignInReceipt>();
    await s.controller.load();
    s.gateway.signInImpl = () => late.promise;
    const p = s.controller.signIn();
    await flush();
    const original = pending(s);
    assert.ok(original);
    if (mode === 'cancel') s.controller.cancel();
    else if (mode === 'page') s.controller.dispose();
    else if (mode === 'app') s.runtime.hide();
    else
      s.sessions.completeLogin(
        s.sessions.beginLogin(),
        mode === 'account'
          ? { ...wireCredentials('b'), accountId: otherAccount }
          : wireCredentials('b'),
      );
    late.resolve(receipt());
    await p;
    await flush();
    assert.deepEqual(pending(s), original);
    assert.equal(s.view().summary, null);
    assert.equal(s.view().receiptStatus, '');
    let view = initialExperienceView();
    if (mode === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
    const reopened = new ExperienceController(s.runtime, (v) => {
      view = v;
    });
    await reopened.load();
    assert.equal(view.signInPending, true);
    assert.equal(
      s.gateway.calls.filter((c) => c.method === 'signIn').length,
      1,
    );
    reopened.dispose();
    s.runtime.dispose();
  }
});
test('delayed old-token auth failure cannot erase refreshed credentials or a new account', async () => {
  for (const change of ['refresh', 'account']) {
    const s = setup(),
      late = deferred<SignInReceipt>();
    s.gateway.signInImpl = () => late.promise;
    const p = s.runtime.signIn();
    await flush();
    if (change === 'refresh')
      s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherAccount,
      });
    late.reject(
      new ClientError('auth-required', 'synthetic', { httpStatus: 401 }),
    );
    await assert.rejects(p);
    assert.equal(
      s.sessions.snapshot().credentials?.accessToken,
      wireCredentials('b').accessToken,
    );
    assert.ok(pending(s));
    s.runtime.dispose();
  }
});
test('metadata refresh cannot reopen a closed unlock; failed acknowledgement does not rollback credit', async () => {
  const s = setup();
  s.gateway.currentUnlocks = {
    items: [
      {
        noticeId,
        fromLevel: 1,
        toLevel: 3,
        titleKeys: ['level_3'],
        colorIds: [11],
        createdAt: at,
      },
    ],
  };
  await s.controller.load();
  assert.equal(s.view().unlocks.length, 1);
  s.gateway.acknowledgeImpl = async () => {
    throw new ClientError('network', 'synthetic');
  };
  await s.controller.closeUnlock(noticeId);
  assert.equal(s.view().unlocks.length, 0);
  assert.deepEqual(s.view().acknowledgementIds, [noticeId]);
  await s.controller.load();
  assert.equal(s.view().unlocks.length, 0);
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'signIn'),
    false,
  );
  s.gateway.acknowledgeImpl = async (id) => ({
    noticeId: id,
    acknowledged: true,
  });
  await s.controller.closeUnlock(noticeId);
  assert.deepEqual(s.view().acknowledgementIds, []);
  s.runtime.dispose();
});
test('undated records remain visible and keyset continuation rejects repeated/private data', async () => {
  const s = setup();
  const row = {
    recordId,
    action: 'publish' as const,
    nominalDelta: null,
    appliedDelta: null,
    balanceAfter: null,
    outcome: 'historical' as const,
    occurredAt: null,
    appliedAt: null,
    recordedAt: at,
  };
  s.gateway.currentRecords = {
    items: [row],
    nextCursor: 'cursor_one',
    coverage: 'partial',
  };
  await s.controller.load();
  assert.match(s.view().records[0]!.dateLabel, /日期不可用/);
  s.gateway.currentRecords = {
    items: [{ ...row, recordId: otherAccount }],
    nextCursor: null,
    coverage: 'partial',
  };
  await s.controller.moreRecords();
  assert.equal(s.view().records.length, 2);
  assert.equal(s.view().hasMore, false);
  s.runtime.dispose();
});
test('terminal appearance lookup never overwrites newer current selection with historical receipt', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.chooseTitle('level_1');
  s.gateway.selectAppearanceImpl = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  await s.controller.saveAppearance();
  const saved = pending(s, 'appearance')!;
  assert.equal(saved.intent.operation, 'appearance');
  s.gateway.receiptImpl = async () => ({
    requestId: saved.intent.requestId,
    operation: 'appearance',
    outcome: 'applied',
    titleKey: 'level_1',
    colorId: null,
    revision: '1',
  });
  s.gateway.currentAppearance = appearance({
    titleKey: 'default_jingxiaoyu',
    revision: '2',
  });
  await s.controller.recover('appearance');
  await flush();
  assert.equal(s.view().appearance?.titleKey, 'default_jingxiaoyu');
  assert.equal(pending(s, 'appearance'), null);
  s.runtime.dispose();
});
test('malformed/mismatching terminal receipt and generic conflict never release appearance intent', async () => {
  for (const mode of ['mismatch', 'conflict']) {
    const s = setup();
    s.gateway.selectAppearanceImpl = async (i) => {
      if (mode === 'conflict') throw error('EXPERIENCE_REQUEST_CONFLICT');
      return {
        requestId: i.requestId,
        operation: 'appearance',
        outcome: 'applied',
        titleKey: 'default_jingxiaoyu',
        colorId: null,
        revision: '1',
      };
    };
    await assert.rejects(
      s.runtime.selectAppearance({
        titleKey: 'level_1',
        colorId: null,
        expectedRevision: '0',
      }),
    );
    assert.ok(pending(s, 'appearance'));
    s.runtime.dispose();
  }
});
test('unrelated foreground sign-in settlement cannot discard an unsaved title/color selection', async () => {
  const s = setup(),
    late = deferred<SignInReceipt>();
  s.gateway.signInImpl = () => late.promise;
  const automatic = s.runtime.foreground();
  await flush();
  await s.controller.load();
  s.controller.chooseTitle('level_1');
  s.controller.chooseColor(3);
  assert.equal(s.view().appearanceDirty, true);
  late.resolve(receipt());
  await automatic;
  await flush();
  assert.equal(s.view().titleKey, 'level_1');
  assert.equal(s.view().colorId, 3);
  assert.equal(s.view().appearanceDirty, true);
  assert.match(s.view().status, /完成或取消当前外观选择/);
  s.controller.cancelSelection();
  await flush();
  assert.equal(s.view().appearanceDirty, false);
  s.runtime.dispose();
});
test('failed closed-notice acknowledgement remains retryable after page hide/reopen without reopening notice', async () => {
  const s = setup();
  s.gateway.currentUnlocks = {
    items: [
      {
        noticeId,
        fromLevel: 1,
        toLevel: 3,
        titleKeys: ['level_3'],
        colorIds: [11],
        createdAt: at,
      },
    ],
  };
  await s.controller.load();
  s.gateway.acknowledgeImpl = async () => {
    throw new ClientError('network', 'synthetic');
  };
  await s.controller.closeUnlock(noticeId);
  s.controller.dispose();
  let view = initialExperienceView();
  const reopened = new ExperienceController(s.runtime, (v) => {
    view = v;
  });
  await reopened.load();
  assert.equal(view.unlocks.length, 0);
  assert.deepEqual(view.acknowledgementIds, [noticeId]);
  s.gateway.acknowledgeImpl = async (id) => ({
    noticeId: id,
    acknowledged: true,
  });
  await reopened.closeUnlock(noticeId);
  assert.deepEqual(view.acknowledgementIds, []);
  reopened.dispose();
  s.runtime.dispose();
});
test('cancelled page does not silently reopen after an independent foreground command settles', async () => {
  const s = setup(),
    late = deferred<SignInReceipt>();
  await s.controller.load();
  s.gateway.signInImpl = () => late.promise;
  const p = s.runtime.foreground();
  await flush();
  s.controller.cancel();
  late.resolve(receipt());
  await p;
  await flush();
  assert.equal(s.view().summary, null);
  assert.equal(s.view().loaded, false);
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  s.runtime.dispose();
});
test('remaining daily tasks precede completed tasks with stable order and unknown counters stay unknown', async () => {
  const s = setup();
  s.gateway.currentSummary = summary({
    tasks: summary().tasks.map((t) =>
      t.action === 'publish'
        ? { ...t, rewardedCount: 1, remaining: 0, grossPositiveAwarded: '10' }
        : t,
    ),
  });
  await s.controller.load();
  assert.deepEqual(
    s.view().tasks.map((t) => t.action),
    [
      'comment',
      'like_save',
      'received_like_save',
      'received_comment',
      'publish',
    ],
  );
  s.gateway.currentSummary = unknownSummary();
  await s.controller.load();
  assert.equal(s.view().tasks[0]?.action, 'publish');
  assert.ok(s.view().tasks.every((t) => /尚未确认/.test(t.progress)));
  s.runtime.dispose();
});
