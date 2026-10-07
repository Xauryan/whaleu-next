import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type {
  IdentityCampusReceipt,
  IdentityCampusState,
} from '../src/identity-campus/contract';
import { PendingIdentityCampusStore } from '../src/identity-campus/pending';
import {
  IdentityCampusController,
  initialIdentityCampusView,
} from '../src/pages/identity-campus/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  campus,
  campusId,
  intent,
  otherCampusId,
  receipt,
  requestId,
  revision,
  setup,
  state,
} from './identity-campus-helpers';

async function ready(s: ReturnType<typeof setup>) {
  await s.controller.load();
  s.controller.choose(campusId);
  s.controller.requestConfirmation();
}
const conflict = () =>
  new ClientError('business', 'safe', {
    httpStatus: 409,
    serverCode: 'IDENTITY_CAMPUS_REVISION_CONFLICT',
  });

test('one/many options and current highlight never auto-save; confirmation includes region and cancel has no write', async () => {
  for (const items of [[campus()], [campus(), campus(otherCampusId)]]) {
    const s = setup();
    s.gateway.stateImpl = async () =>
      state({ options: { status: 'known', items } });
    await s.controller.load();
    assert.equal(s.view().selectedId, '');
    assert.equal(s.view().confirmation, null);
    await s.controller.confirm();
    assert.equal(s.gateway.calls.length, 1);
    s.controller.choose(campusId);
    assert.equal(s.view().confirmation, null);
    s.controller.requestConfirmation();
    assert.deepEqual(s.view().confirmation, campus());
    s.controller.dismissConfirmation();
    await s.controller.confirm();
    assert.equal(s.gateway.calls.length, 1);
    assert.equal(s.storage.data.size, 0);
    s.controller.dispose();
  }
  const s = setup();
  s.gateway.stateImpl = async () =>
    state({
      selection: 'valid',
      reason: 'current',
      selectedCampus: campus(),
      guidance: 'reselect',
    });
  await s.controller.load();
  assert.equal(s.view().selectedId, campusId);
  assert.equal(s.view().confirmation, null);
  assert.equal(s.gateway.calls.length, 1);
});
test('missing history is distinct from known required, zero options and unavailable authority; no new SSO/student-number gate', async () => {
  const s = setup(),
    blocked = {
      canSelect: false,
      expectedStateRevision: null,
      guidance: 'refresh',
    } as const;
  for (const [value, message, eligibility] of [
    [state(), /无法确认当前身份校区记录.*重新选择/, /不会新增学校认证/],
    [
      state({ selection: 'selection_required', reason: 'choice_required' }),
      /请选择身份校区/,
      /不会新增学校认证/,
    ],
    [
      state({ reason: 'inputs_changed', guidance: 'reselect' }),
      /已更新.*重新确认/,
      /不会新增学校认证/,
    ],
    [
      state({ options: { status: 'known', items: [] }, ...blocked }),
      /当前没有可选身份校区/,
      /没有可确认/,
    ],
    [
      state({
        reason: 'topology_unavailable',
        options: { status: 'unavailable', items: [] },
        ...blocked,
      }),
      /暂时无法确认可选校区/,
      /暂时无法确认可选校区/,
    ],
    [
      state({
        writeEligibility: { phone: 'unverified', safety: 'allowed' },
        ...blocked,
      }),
      /当前身份校区记录/,
      /手机号验证未满足/,
    ],
    [
      state({
        writeEligibility: { phone: 'verified', safety: 'restricted' },
        ...blocked,
      }),
      /当前身份校区记录/,
      /账号暂不能更改/,
    ],
    [
      state({
        writeEligibility: { phone: 'unavailable', safety: 'unavailable' },
        ...blocked,
      }),
      /当前身份校区记录/,
      /暂时无法确认保存资格/,
    ],
  ] as const) {
    s.gateway.stateImpl = async () => value;
    await s.controller.load();
    assert.equal(s.view().loaded, true);
    assert.match(s.view().status, message);
    assert.match(s.view().eligibilityMessage, eligibility);
    if (!value.canSelect) {
      s.controller.choose(campusId);
      s.controller.requestConfirmation();
      await s.controller.confirm();
      assert.equal(s.view().confirmation, null);
    }
  }
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'select'),
    false,
  );
});
test('unknown data fails closed even from alternate gateway; status snapshots are never persisted', async () => {
  const s = setup();
  await s.controller.load();
  assert.equal(s.storage.data.size, 0);
  s.gateway.stateImpl = async () =>
    ({
      ...state(),
      role: 'admin',
      phoneNumber: 'private-value',
    }) as IdentityCampusState;
  await s.controller.load();
  assert.equal(s.view().state, null);
  assert.equal(s.view().loaded, false);
  assert.equal(JSON.stringify(s.view()).includes('private-value'), false);
  assert.equal(s.storage.data.size, 0);
});
test('same-campus current confirmation and stale-binding renewal both explicitly submit exact fresh intent, with no forced student number', async () => {
  for (const current of [true, false]) {
    const s = setup();
    s.gateway.stateImpl = async () =>
      current
        ? state({
            selection: 'valid',
            reason: 'current',
            selectedCampus: campus(),
            guidance: 'reselect',
          })
        : state({ reason: 'inputs_changed', guidance: 'reselect' });
    await ready(s);
    s.gateway.selectImpl = async (input) => {
      assert.deepEqual(input, intent());
      assert.deepEqual(s.runtime.pending.load(wireCredentials().accountId), {
        version: 1,
        accountId: wireCredentials().accountId,
        ...intent(),
      });
      return receipt({ outcome: current ? 'unchanged' : 'applied' });
    };
    await s.controller.confirm();
    assert.deepEqual(
      s.gateway.calls.map((c) => c.method),
      ['state', 'select', 'state'],
    );
    assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
    assert.match(
      s.view().receiptStatus,
      current ? /另行确认.*再次点击发送/ : /有效性尚不能确认/,
    );
  }
});
test('persist and readback failure prevents dispatch; corrupt or foreign pending record freezes new selection', async () => {
  for (const mode of ['write', 'readback', 'corrupt'] as const) {
    const s = setup();
    await ready(s);
    if (mode === 'write') s.storage.failWrite = true;
    else if (mode === 'readback') s.storage.set = () => undefined;
    else
      s.storage.data.set(
        `whaleu.identity-campus.pending.v1:https://api.example.invalid:${wireCredentials().accountId}`,
        { version: 1, accountId: otherCampusId, ...intent() },
      );
    await s.controller.confirm();
    assert.equal(
      s.gateway.calls.filter((c) => c.method === 'select').length,
      0,
    );
    assert.match(s.view().error, /本地保存失败/);
    s.controller.dispose();
  }
});
test('double taps freeze one immutable attempt before dispatch and never overwrite its key/version', async () => {
  const s = setup(),
    late = deferred<IdentityCampusReceipt>();
  await ready(s);
  s.gateway.selectImpl = () => late.promise;
  const pending = s.controller.confirm();
  await s.controller.confirm();
  await flush();
  assert.equal(s.gateway.calls.filter((c) => c.method === 'select').length, 1);
  const saved = s.runtime.pending.load(wireCredentials().accountId);
  s.controller.choose(otherCampusId);
  s.controller.requestConfirmation();
  await s.controller.confirm();
  assert.deepEqual(s.runtime.pending.load(wireCredentials().accountId), saved);
  assert.throws(
    () => s.runtime.pending.freeze({ ...saved!, campusId: otherCampusId }),
    { kind: 'storage' },
  );
  assert.throws(
    () =>
      s.runtime.pending.freeze({
        ...saved!,
        expectedStateRevision: `ic1:${'b'.repeat(64)}`,
      }),
    { kind: 'storage' },
  );
  late.resolve(receipt());
  await pending;
  assert.equal(s.view().busy, false);
});
for (const boundary of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account-login',
  'account-switch',
] as const) {
  const interrupt = (s: ReturnType<typeof setup>) => {
    if (boundary === 'cancel') s.controller.cancel();
    else if (boundary === 'dispose') s.controller.dispose();
    else if (boundary === 'app-hide') s.runtime.privateViews.clear();
    else if (boundary === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId:
          boundary === 'account-switch'
            ? otherCampusId
            : wireCredentials().accountId,
      });
  };
  test(`${boundary} before dispatch drops confirmation and cannot save from late request-ID completion`, async () => {
    const s = setup(),
      id = deferred<string>();
    await ready(s);
    const runtime = { ...s.runtime, newRequestId: () => id.promise };
    let view = initialIdentityCampusView();
    s.controller.dispose();
    const controller = new IdentityCampusController(runtime, (next) => {
      view = next;
    });
    await controller.load();
    controller.choose(campusId);
    controller.requestConfirmation();
    const p = controller.confirm();
    await flush();
    interrupt({ ...s, controller });
    id.resolve(requestId);
    await p;
    await flush();
    assert.equal(
      s.gateway.calls.some((c) => c.method === 'select'),
      false,
    );
    assert.equal(view.confirmation, null);
    assert.equal(view.state, null);
    assert.equal(s.storage.data.size, 0);
  });
  test(`${boundary} after dispatch retains original account recovery; late success cannot render or settle`, async () => {
    const s = setup(),
      late = deferred<IdentityCampusReceipt>();
    await ready(s);
    s.gateway.selectImpl = () => late.promise;
    const p = s.controller.confirm();
    await flush();
    const saved = s.runtime.pending.load(wireCredentials().accountId);
    assert.ok(saved);
    interrupt(s);
    assert.equal(s.view().state, null);
    assert.equal(s.view().confirmation, null);
    late.resolve(receipt());
    await p;
    await flush();
    assert.deepEqual(
      s.runtime.pending.load(wireCredentials().accountId),
      saved,
    );
    assert.equal(s.view().loaded, false);
    if (boundary === 'account-switch') {
      await s.controller.recover(true);
      assert.equal(
        s.gateway.calls.filter((c) => c.method === 'select').length,
        1,
      );
    }
    s.controller.dispose();
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
    let view = initialIdentityCampusView();
    const restored = new IdentityCampusController(s.runtime, (next) => {
      view = next;
    });
    const before = s.gateway.calls.length;
    await restored.load();
    assert.equal(view.frozen, true);
    assert.equal(s.gateway.calls.length, before);
    await restored.recover();
    assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
    assert.equal(view.frozen, false);
    restored.dispose();
  });
}
test('unknown outcomes, absent receipt and malformed/mismatched receipts never unlock or rewrite pending intent', async () => {
  const s = setup();
  await ready(s);
  s.gateway.selectImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.confirm();
  const saved = s.runtime.pending.load(wireCredentials().accountId);
  for (const error of [
    new ClientError('http', 'safe', {
      httpStatus: 404,
      serverCode: 'IDENTITY_CAMPUS_REQUEST_NOT_FOUND',
    }),
    new ClientError('http', 'safe', {
      httpStatus: 503,
      serverCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
    }),
    conflict(),
    new ClientError('business', 'safe', {
      httpStatus: 409,
      serverCode: 'IDENTITY_CAMPUS_REQUEST_CONFLICT',
    }),
    new ClientError('auth-expired', 'safe'),
  ]) {
    s.gateway.receiptImpl = async () => {
      throw error;
    };
    await s.controller.recover();
    assert.deepEqual(
      s.runtime.pending.load(wireCredentials().accountId),
      saved,
    );
    assert.equal(s.view().frozen, true);
  }
  for (const raw of [
    { ...receipt(), campusId: otherCampusId },
    { ...receipt(), requestId: otherCampusId },
    { ...receipt(), eventId: 'private' },
  ]) {
    s.gateway.receiptImpl = async () => raw;
    await s.controller.recover();
    assert.deepEqual(
      s.runtime.pending.load(wireCredentials().accountId),
      saved,
    );
    assert.equal(s.view().frozen, true);
  }
  s.gateway.selectImpl = async (input) => {
    assert.deepEqual(input, intent());
    return receipt();
  };
  await s.controller.recover(true);
  assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
  const sends = s.gateway.calls.filter((c) => c.method === 'select');
  assert.deepEqual(sends[0]?.body, sends[1]?.body);
});
test('only definitive exact PUT revision conflict releases old intent and requires fresh explicit confirmation', async () => {
  const s = setup();
  await ready(s);
  s.gateway.selectImpl = async () => {
    throw conflict();
  };
  const next = `ic1:${'b'.repeat(64)}`;
  s.gateway.stateImpl = async () =>
    state({
      expectedStateRevision: next,
      reason: 'inputs_changed',
      guidance: 'reselect',
    });
  await s.controller.confirm();
  assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
  assert.equal(s.view().state?.expectedStateRevision, next);
  assert.equal(s.view().confirmation, null);
  assert.equal(s.view().selectedId, '');
  assert.match(s.view().receiptStatus, /再次明确确认/);
  await s.controller.confirm();
  assert.equal(s.gateway.calls.filter((c) => c.method === 'select').length, 1);
  s.controller.choose(campusId);
  s.controller.requestConfirmation();
  s.gateway.selectImpl = async (input) => {
    assert.equal(input.expectedStateRevision, next);
    return receipt();
  };
  await s.controller.confirm();
});
test('storage removal failure keeps recovery barrier and repeated terminal receipt can settle it later', async () => {
  const s = setup();
  await ready(s);
  s.storage.failRemove = true;
  await s.controller.confirm();
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pending.load(wireCredentials().accountId));
  s.storage.failRemove = false;
  await s.controller.recover();
  assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
});
test('historical success followed by superseded/unavailable/failed current read never masquerades as current authority', async () => {
  for (const mode of ['superseded', 'unavailable', 'error'] as const) {
    const s = setup();
    await ready(s);
    s.gateway.stateImpl = async () => {
      if (mode === 'error') throw new ClientError('network', 'safe');
      return mode === 'superseded'
        ? state({
            selection: 'valid',
            reason: 'current',
            selectedCampus: campus(otherCampusId),
            options: { status: 'known', items: [campus(otherCampusId)] },
            guidance: 'reselect',
          })
        : state({ reason: 'inputs_changed', guidance: 'reselect' });
    };
    await s.controller.confirm();
    assert.equal(s.runtime.pending.load(wireCredentials().accountId), null);
    assert.match(
      s.view().receiptStatus,
      mode === 'superseded'
        ? /之后的选择替代/
        : mode === 'unavailable'
          ? /有效性尚不能确认/
          : /回执不代表当前校区仍有效/,
    );
    if (mode === 'error') assert.equal(s.view().state, null);
  }
});
test('cancelled old status response cannot replace newer status or leak hidden-page data', async () => {
  const s = setup(),
    late = deferred<IdentityCampusState>();
  s.gateway.stateImpl = () => late.promise;
  const old = s.controller.load();
  await flush();
  s.controller.cancel();
  s.gateway.stateImpl = async () =>
    state({ selection: 'selection_required', reason: 'choice_required' });
  await s.controller.load();
  assert.equal(s.view().state?.reason, 'choice_required');
  late.resolve(state());
  await old;
  assert.equal(s.view().state?.reason, 'choice_required');
  s.runtime.privateViews.clear();
  await s.controller.load();
  assert.equal(s.view().state, null);
});
test('account and API-origin scoped journals cannot expose or replace another account intent; no token/authority cache', () => {
  const s = setup(),
    owner = wireCredentials().accountId;
  s.runtime.pending.freeze({ version: 1, accountId: owner, ...intent() });
  assert.equal(s.runtime.pending.load(otherCampusId), null);
  assert.equal(
    new PendingIdentityCampusStore(s.storage, 'https://other.invalid').load(
      owner,
    ),
    null,
  );
  const stored = JSON.stringify([...s.storage.data]);
  assert.equal(stored.includes('accessToken'), false);
  assert.equal(stored.includes('operatingRegion'), false);
  assert.equal(stored.includes('affiliation'), false);
  assert.equal(stored.includes(revision), true);
});
test('logged-out and unconfigured selectors never make status assertions or dispatch requests', async () => {
  const s = setup(false);
  await s.controller.load();
  await s.controller.confirm();
  await s.controller.recover(true);
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.view().state, null);
  let view = initialIdentityCampusView();
  const controller = new IdentityCampusController(
    { ...s.runtime, gateway: undefined },
    (next) => {
      view = next;
    },
  );
  await controller.load();
  assert.match(view.error, /尚未配置/);
});
