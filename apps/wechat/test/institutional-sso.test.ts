import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { Cancellation, type HttpRequest } from '../src/platform/contracts';
import {
  InstitutionalController,
  type InstitutionalView,
  type InstitutionalRuntime,
} from '../src/verification/institutional-controller';
import {
  decodeInstitutionalCapability,
  decodeInstitutionalCommand,
  decodeInstitutionalReceipt,
  institutionalCommandHash,
  institutionalConsent,
  institutionalPurpose,
  type InstitutionalCapability,
  type InstitutionalReceipt,
  type InstitutionalCommand,
} from '../src/verification/institutional-contract';
import {
  HttpInstitutionalGateway,
  type InstitutionalGateway,
} from '../src/verification/institutional-gateway';
import {
  PendingInstitutionalStore,
  institutionalPhases,
} from '../src/verification/institutional-pending';
import {
  UnavailableInstitutionalNativePort,
  type InstitutionalNativePort,
  type InstitutionalNativeResult,
} from '../src/verification/institutional-port';
import { deferred, flush, MemoryStorage } from './helpers';
import { wireCredentials, accountId } from './identity-helpers';
const id = '12345678-1234-4123-8123-123456789aaa';
const nextId = '12345678-1234-4123-8123-123456789bbb';
const campus = '12345678-1234-4123-8123-123456789ccc';
const otherCampus = '12345678-1234-4123-8123-123456789ddd';
const origin = 'https://api.synthetic.invalid';
const version = 'a'.repeat(64);
const command: InstitutionalCommand = {
  requestId: id,
  campusId: campus,
  capabilityVersion: version,
  consent: institutionalConsent,
};
const capability: InstitutionalCapability = {
  campusId: campus,
  state: 'eligible' as const,
  schoolName: '合成学校',
  capabilityVersion: version,
  consent: institutionalConsent,
  purpose: institutionalPurpose,
  supportedFacts: ['affiliation', 'student_number'] as const,
};
function fixture() {
  const storage = new MemoryStorage(),
    sessions = new SessionStore(),
    lifecycle = new PrivateViewLifecycle();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const journal = new PendingInstitutionalStore(storage, origin),
    calls: string[] = [],
    views: InstitutionalView[] = [];
  let current: InstitutionalReceipt = {
    requestId: id,
    requestHash: null,
    state: 'not_recorded',
  };
  const receipt = (
    state:
      | 'processing'
      | 'outcome_unknown'
      | 'ready_to_finalize'
      | 'cancelled'
      | 'stale' = 'processing',
  ) => ({
    requestId: current.requestId,
    requestHash: institutionalCommandHash(accountId, {
      ...command,
      requestId: current.requestId,
    }),
    state,
  });
  const prepared = (
    input = command,
  ): Extract<InstitutionalReceipt, { state: 'prepared' }> => ({
    requestId: input.requestId,
    requestHash: institutionalCommandHash(accountId, input),
    state: 'prepared',
    context: {
      campusId: input.campusId,
      capabilityVersion: input.capabilityVersion,
      consent: input.consent,
    },
    expiresAt: '2030-10-14 02:00:00.000001+00',
  });
  const completed = (): Extract<
    InstitutionalReceipt,
    { state: 'completed' }
  > => ({
    ...receipt(),
    state: 'completed',
    changedFacts: ['affiliation', 'student_number'],
    uidOutcome: 'issued',
    uidReason: null,
  });
  const gateway: InstitutionalGateway = {
    async capability() {
      calls.push('capability');
      return capability;
    },
    async prepare(input) {
      calls.push('prepare');
      assert.equal(journal.load(accountId)?.phase, 'prepare_unstarted');
      current = prepared(input);
      return current;
    },
    async read() {
      calls.push('read');
      return current;
    },
    async authorize() {
      calls.push('authorize');
      assert.equal(journal.load(accountId)?.phase, 'submit_pending');
      current = completed();
      return current;
    },
    async recover() {
      calls.push('recover');
      if (current.state === 'ready_to_finalize') current = completed();
      return current;
    },
    async close(requestId, requestHash) {
      calls.push('close');
      assert.equal(journal.load(accountId)?.phase, 'cancel');
      if (current.state !== 'completed')
        current = { requestId, requestHash, state: 'cancelled' };
      return current;
    },
  };
  const port: InstitutionalNativePort = {
    available: true,
    async authorize() {
      calls.push('handoff');
      assert.equal(journal.load(accountId)?.phase, 'authorize_pending');
      return {
        state: 'authorized',
        authorizationResponse: 'private-one-use-synthetic-response',
      };
    },
  };
  let sequence = 0,
    refreshed = 0,
    currentEnvironment = true;
  const runtime: InstitutionalRuntime = {
    sessions,
    gateway,
    journal,
    port,
    origin,
    privateViews: lifecycle,
    newRequestId: async () => (sequence++ === 0 ? id : nextId),
  };
  const make = (context = campus) =>
    new InstitutionalController(
      runtime,
      (view) => views.push(view),
      context,
      () => refreshed++,
      () => currentEnvironment,
    );
  const view = () => views[views.length - 1]!;
  async function prepare(controller: InstitutionalController) {
    await controller.load();
    controller.setConsent(true);
    await controller.prepare();
    assert.equal(view().state, 'prepared');
  }
  return {
    storage,
    sessions,
    lifecycle,
    journal,
    calls,
    views,
    gateway,
    port,
    runtime,
    make,
    view,
    prepared,
    completed,
    prepare,
    receipt,
    refreshed: () => refreshed,
    current: (r: InstitutionalReceipt) => {
      current = r;
    },
    environment: (value: boolean) => {
      currentEnvironment = value;
    },
  };
}

test('strict safe contracts reject private claims, extra fields and foreign original receipts', () => {
  assert.deepEqual(decodeInstitutionalCommand(command), command);
  assert.equal(institutionalCommandHash(accountId, command).length, 64);
  assert.notEqual(
    institutionalCommandHash(accountId, command),
    institutionalCommandHash(accountId, { ...command, requestId: nextId }),
  );
  for (const raw of [
    { ...capability, subject: 'private' },
    { ...capability, state: 'eligible', capabilityVersion: null },
    { ...capability, purpose: 'grades' },
    { ...capability, supportedFacts: ['phone'] },
  ])
    assert.throws(() => decodeInstitutionalCapability(raw));
  const f = fixture();
  for (const raw of [
    { ...f.completed(), studentNumber: '00123456' },
    { ...f.completed(), uidReason: 'raw-provider-error' },
    { ...f.prepared(), authorizationResponse: 'private' },
    { requestId: id, requestHash: null, state: 'completed' },
    { ...f.prepared(), context: { ...command, nonce: 'secret' } },
  ])
    assert.throws(() => decodeInstitutionalReceipt(raw));
});
test('journal freezes original intent, exact receipt and monotone phases; contains no raw actor or secrets', () => {
  const f = fixture(),
    pending = f.journal.freeze(accountId, command);
  assert.throws(() =>
    f.journal.freeze(accountId, { ...command, requestId: nextId }),
  );
  let p = pending;
  for (const phase of institutionalPhases.slice(1))
    p = f.journal.advance(p, phase);
  assert.throws(() => f.journal.advance(p, 'prepared_unstarted'));
  assert.throws(() =>
    f.journal.settle(p, {
      ...f.receipt('cancelled'),
      requestHash: 'b'.repeat(64),
    }),
  );
  assert.throws(() =>
    f.journal.settle(p, {
      requestId: id,
      requestHash: null,
      state: 'not_recorded',
    }),
  );
  const stored = JSON.stringify([...f.storage.data.values()]);
  assert.ok(!stored.includes(accountId));
  assert.ok(!stored.includes('authorizationResponse'));
  f.journal.settle(p, f.receipt('cancelled'));
  assert.equal(f.journal.load(accountId), null);
});
test('prepare, handoff and one submission have verified durable boundaries; double taps coalesce', async () => {
  const f = fixture(),
    c = f.make();
  await c.load();
  c.setConsent(true);
  await Promise.all([c.prepare(), c.prepare()]);
  await Promise.all([c.authorize(), c.authorize()]);
  assert.deepEqual(f.calls, ['capability', 'prepare', 'handoff', 'authorize']);
  assert.equal(f.view().state, 'completed');
  assert.equal(f.view().frozen, false);
  assert.equal(f.refreshed(), 1);
  const persistedAndRendered = JSON.stringify([
    ...f.storage.data.values(),
    ...f.views,
  ]);
  assert.ok(
    !persistedAndRendered.includes('private-one-use-synthetic-response'),
  );
  await c.authorize();
  assert.equal(f.calls.filter((x) => x === 'handoff').length, 1);
  await c.prepare();
  assert.equal(f.calls.filter((x) => x === 'prepare').length, 1);
  c.dispose();
});
test('production native port is unavailable even when server says eligible', async () => {
  const f = fixture();
  const runtime = {
    ...f.runtime,
    port: new UnavailableInstitutionalNativePort(),
  };
  let view!: InstitutionalView;
  const c = new InstitutionalController(
    runtime,
    (v) => {
      view = v;
    },
    campus,
  );
  await c.load();
  c.setConsent(true);
  await c.prepare();
  await c.authorize();
  assert.deepEqual(f.calls, ['capability']);
  assert.equal(view.nativeAvailable, false);
  assert.match(view.message, /尚未启用/);
  c.dispose();
});
test('readback failure prevents prepare and keeps new dispatch blocked', async () => {
  const f = fixture(),
    c = f.make();
  await c.load();
  c.setConsent(true);
  f.storage.set = () => undefined;
  await c.prepare();
  assert.deepEqual(f.calls, ['capability']);
  assert.notEqual(f.view().error, '');
  c.dispose();
});
test('storage refusal before handoff persistence prevents invocation', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.storage.failWrite = true;
  await c.authorize();
  assert.deepEqual(f.calls, ['capability', 'prepare']);
  c.dispose();
});
for (const phase of [
  'authorize_pending',
  'submit_pending',
  'recover_started',
] as const) {
  test(`cold ${phase} with server prepared never repeats a handoff`, async () => {
    const f = fixture();
    const p = f.journal.freeze(accountId, command);
    f.journal.advance(p, phase);
    f.current(f.prepared());
    const c = f.make();
    await c.load();
    await c.authorize();
    await c.prepare();
    assert.deepEqual(f.calls, ['read', 'recover']);
    assert.equal(f.view().frozen, true);
    assert.equal(f.view().canAuthorize, false);
    await c.close();
    assert.equal(f.view().state, 'cancelled');
    c.dispose();
  });
}
for (const phase of ['prepare_unstarted', 'prepared_unstarted'] as const) {
  test(`cold ${phase} may perform the first handoff after exact original recovery`, async () => {
    const f = fixture();
    const p = f.journal.freeze(accountId, command);
    if (phase === 'prepared_unstarted') f.journal.advance(p, phase);
    f.current(f.prepared());
    const c = f.make('');
    await c.load();
    assert.equal(f.view().campusId, campus);
    assert.deepEqual(f.calls, ['read']);
    await c.authorize();
    assert.equal(f.view().state, 'completed');
    assert.equal(f.calls.filter((x) => x === 'handoff').length, 1);
    c.dispose();
  });
}
test('crash after durable handoff phase but before invocation conservatively consumes the attempt', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.port.authorize = async () => {
    throw new Error('platform failed before starting');
  };
  await c.authorize();
  assert.equal(f.journal.load(accountId)?.phase, 'authorize_pending');
  c.dispose();
  const reopened = f.make();
  await reopened.load();
  await reopened.authorize();
  assert.deepEqual(f.calls, ['capability', 'prepare', 'read', 'recover']);
  reopened.dispose();
});
test('after native callback but before HTTP, failed submit journal loses response and cannot reacquire', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.port.authorize = async () => {
    f.calls.push('handoff');
    f.storage.failWrite = true;
    return { state: 'authorized', authorizationResponse: 'must-disappear' };
  };
  await c.authorize();
  assert.ok(!f.calls.includes('authorize'));
  assert.ok(!JSON.stringify(f.views).includes('must-disappear'));
  f.storage.failWrite = false;
  c.dispose();
  const reopened = f.make();
  await reopened.load();
  await reopened.authorize();
  assert.equal(f.calls.filter((x) => x === 'handoff').length, 1);
  reopened.dispose();
});
test('hide after HTTP dispatch before server claim recovers original prepared without a second handoff', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  const dispatch = deferred<InstitutionalReceipt>();
  f.gateway.authorize = async () => {
    f.calls.push('authorize');
    return dispatch.promise;
  };
  const running = c.authorize();
  await flush();
  assert.equal(f.journal.load(accountId)?.phase, 'submit_pending');
  c.dispose();
  const reopened = f.make();
  await reopened.load();
  await reopened.authorize();
  assert.equal(f.calls.filter((x) => x === 'handoff').length, 1);
  dispatch.resolve(f.completed());
  await running;
  assert.notEqual(f.view().state, 'completed');
  reopened.dispose();
});
for (const invalidation of [
  'hide',
  'account',
  'same-account-login',
  'context',
  'origin',
] as const) {
  test(`late callback after ${invalidation} cannot submit or render authorization material`, async () => {
    const f = fixture(),
      c = f.make();
    await f.prepare(c);
    const native = deferred<InstitutionalNativeResult>();
    f.port.authorize = async () => {
      f.calls.push('handoff');
      return native.promise;
    };
    const running = c.authorize();
    await flush();
    if (invalidation === 'hide') f.lifecycle.clear();
    if (invalidation === 'account') f.sessions.logout();
    if (invalidation === 'same-account-login')
      f.sessions.completeLogin(f.sessions.beginLogin(), wireCredentials('b'));
    if (invalidation === 'context') c.changeContext(otherCampus);
    if (invalidation === 'origin') f.environment(false);
    native.resolve({
      state: 'authorized',
      authorizationResponse: 'late-private-result',
    });
    await running;
    assert.ok(!f.calls.includes('authorize'));
    assert.ok(!JSON.stringify(f.views).includes('late-private-result'));
    c.dispose();
  });
}
test('same-session token rotation does not invalidate the original login epoch', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  const native = deferred<InstitutionalNativeResult>();
  f.port.authorize = async () => native.promise;
  const running = c.authorize();
  await flush();
  f.sessions.rotate(f.sessions.snapshot(), wireCredentials('b'));
  native.resolve({ state: 'authorized', authorizationResponse: 'once' });
  await running;
  assert.equal(f.view().state, 'completed');
  c.dispose();
});
test('close during handoff fences original key before a late callback and permits a deliberate new key', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  const native = deferred<InstitutionalNativeResult>();
  f.port.authorize = async () => {
    f.calls.push('handoff');
    return native.promise;
  };
  const running = c.authorize();
  await flush();
  await c.close();
  assert.equal(f.view().state, 'cancelled');
  await c.load();
  c.setConsent(true);
  await c.prepare();
  assert.equal(f.view().requestId, nextId);
  native.resolve({
    state: 'authorized',
    authorizationResponse: 'old-response',
  });
  await running;
  assert.ok(!f.calls.includes('authorize'));
  assert.equal(f.view().requestId, nextId);
  c.dispose();
});
test('cancel before delayed prepare arrival persists original cancellation and not_recorded never releases it', async () => {
  const f = fixture(),
    c = f.make();
  await c.load();
  c.setConsent(true);
  const reserve = deferred<InstitutionalReceipt>();
  f.gateway.prepare = async () => {
    f.calls.push('prepare');
    return reserve.promise;
  };
  const running = c.prepare();
  await flush();
  await c.close();
  assert.equal(f.view().state, 'cancelled');
  reserve.resolve(f.prepared());
  await running;
  assert.equal(f.view().state, 'cancelled');
  c.dispose();
  const g = fixture();
  g.journal.freeze(accountId, command);
  const d = g.make();
  await d.load();
  await d.prepare();
  assert.deepEqual(g.calls, ['read']);
  assert.equal(g.view().frozen, true);
  d.dispose();
});
test('durable admission resumes only local completion and lost completion replies refresh independently', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.gateway.authorize = async () => {
    f.current(f.receipt('ready_to_finalize'));
    throw new Error('lost post-admission reply');
  };
  await c.authorize();
  c.dispose();
  const restored = f.make();
  await restored.load();
  assert.equal(f.view().state, 'completed');
  assert.equal(f.refreshed(), 1);
  assert.equal(f.calls.filter((x) => x === 'handoff').length, 1);
  assert.ok(f.calls.includes('recover'));
  restored.dispose();
});
test('terminal removal failure refreshes current summaries but blocks replacement and preserves original recovery', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.storage.failRemove = true;
  await c.authorize();
  assert.equal(f.refreshed(), 1);
  assert.equal(f.view().frozen, true);
  assert.ok(f.journal.load(accountId));
  await c.prepare();
  assert.equal(f.calls.filter((x) => x === 'prepare').length, 1);
  f.storage.failRemove = false;
  await c.recover();
  assert.equal(f.view().frozen, false);
  c.dispose();
});
test('corrupt, disappeared and foreign journal block new dispatch without erasing recovery data', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  const key = [...f.storage.data.keys()][0]!;
  f.storage.data.set(key, {
    ...(f.storage.data.get(key) as object),
    actorScope: 'foreign',
  });
  await c.recover();
  await c.prepare();
  assert.equal(f.calls.filter((x) => x === 'read').length, 0);
  assert.equal(f.view().frozen, true);
  f.storage.data.delete(key);
  await c.recover();
  assert.equal(f.view().frozen, true);
  c.dispose();
});
test('wrong-key/hash receipts never settle the original journal or refresh facts', async () => {
  const f = fixture(),
    c = f.make();
  await f.prepare(c);
  f.gateway.authorize = async () => ({
    ...f.completed(),
    requestHash: 'b'.repeat(64),
  });
  await c.authorize();
  assert.equal(f.view().frozen, true);
  assert.equal(f.refreshed(), 0);
  assert.ok(f.journal.load(accountId));
  c.dispose();
});
test('local cancellation/challenge/rejection use original close and never fake verification', async () => {
  for (const state of [
    'cancelled',
    'challenge_required',
    'provider_unavailable',
    'rejected',
    'protocol_error',
  ] as const) {
    const f = fixture(),
      c = f.make();
    await f.prepare(c);
    f.port.authorize = async () => ({ state });
    await c.authorize();
    assert.equal(f.view().state, 'cancelled');
    assert.ok(f.calls.includes('close'));
    assert.ok(!f.calls.includes('authorize'));
    assert.equal(f.refreshed(), 0);
    c.dispose();
  }
});
test('actual API gateway makes one authorize attempt on 401, no auth refresh, no untrusted extra fields', async () => {
  const requests: HttpRequest[] = [],
    sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let refreshes = 0;
  const api = new ApiClient(
    origin,
    {
      async send(request) {
        requests.push(request);
        return {
          status: 401,
          headers: {},
          body: {
            error: {
              code: 'AUTH_SESSION_EXPIRED',
              message: 'private provider echo',
              requestId: id,
            },
          },
        };
      },
    },
    sessions,
    {
      async refresh() {
        refreshes++;
        return sessions.snapshot();
      },
    },
  );
  const gateway = new HttpInstitutionalGateway(api),
    cancel = new Cancellation(),
    hash = institutionalCommandHash(accountId, command);
  await assert.rejects(gateway.authorize(id, hash, 'opaque', cancel));
  assert.equal(requests.length, 1);
  assert.equal(refreshes, 0);
  assert.deepEqual(requests[0]?.body, {
    mode: 'authorize',
    requestHash: hash,
    authorizationResponse: 'opaque',
  });
  assert.equal(
    requests[0]?.url,
    `${origin}/v1/me/institutional-sso/requests/${id}/complete`,
  );
  assert.throws(() => gateway.authorize(id, hash, '中'.repeat(1366), cancel));
  assert.throws(() => gateway.authorize(id, hash, '', cancel));
  assert.throws(() => gateway.authorize(id, hash, 'opaque\nresponse', cancel));
  assert.equal(requests.length, 1);
});

test('unconfigured, unavailable, restricted and conflicting capabilities may have no supported facts', async () => {
  for (const state of [
    'provider_unconfigured',
    'provider_unavailable',
    'account_restricted',
    'verification_conflict',
    'not_applicable',
  ] as const) {
    const unavailable = {
      ...capability,
      state,
      schoolName: null,
      capabilityVersion: null,
      consent: null,
      supportedFacts: [],
    };
    assert.equal(decodeInstitutionalCapability(unavailable).state, state);
    const f = fixture();
    f.gateway.capability = async () => unavailable;
    const c = f.make();
    await c.load();
    assert.equal(f.view().capability?.state, state);
    assert.equal(f.view().error, '');
    c.setConsent(true);
    await c.prepare();
    assert.ok(!f.calls.includes('prepare'));
    c.dispose();
  }
});
for (const phase of [
  'prepared_unstarted',
  'submit_pending',
  'recover_started',
] as const) {
  test(`computed expired GET for ${phase} must settle durably before releasing the original key`, async () => {
    const f = fixture();
    await f.runtime.newRequestId();
    f.journal.advance(f.journal.freeze(accountId, command), phase);
    const expired = { ...f.receipt(), state: 'expired' as const };
    f.current(expired);
    const finalization = deferred<InstitutionalReceipt>();
    f.gateway.recover = async () => {
      f.calls.push('recover');
      assert.ok(f.journal.load(accountId));
      return finalization.promise;
    };
    const c = f.make();
    const loading = c.load();
    await flush();
    assert.deepEqual(f.calls, ['read', 'recover']);
    assert.equal(f.view().frozen, true);
    assert.ok(f.journal.load(accountId));
    finalization.resolve(expired);
    await loading;
    assert.equal(f.view().state, 'expired');
    assert.equal(f.view().frozen, false);
    assert.equal(f.journal.load(accountId), null);
    await c.load();
    c.setConsent(true);
    await c.prepare();
    assert.equal(f.view().state, 'prepared');
    assert.equal(f.view().requestId, nextId);
    c.dispose();
  });
}
test('lost durable expiry reply keeps the original journal until exact recovery succeeds', async () => {
  const f = fixture();
  f.journal.freeze(accountId, command);
  f.current({ ...f.receipt(), state: 'expired' });
  f.gateway.recover = async () => {
    throw new Error('lost expiry settlement reply');
  };
  const c = f.make();
  await c.load();
  assert.equal(f.view().frozen, true);
  assert.ok(f.journal.load(accountId));
  await c.prepare();
  assert.ok(!f.calls.includes('prepare'));
  c.dispose();
});
