import type { OwnProfile } from '../src/profile/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { decodeErrandSchoolService } from '../src/school-configuration/contract';
import type { ErrandSchoolService } from '../src/school-configuration/contract';
import {
  ErrandTargetServicesController,
  initialErrandTargetServicesView,
} from '../src/errands/target-services';
import type { ErrandDetail } from '../src/errands/contract';
import { FakeProfileGateway, campus } from './profile-helpers';
import { wireCredentials } from './identity-helpers';
import { deferred, flush } from './helpers';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const detail: ErrandDetail = {
  id: id(1),
  revision: id(2),
  title: 'Synthetic',
  publicText: '',
  expectedTimeText: 'Tomorrow',
  reward: '1',
  state: 'pending',
  createdAt: '2026-10-11T00:00:00.000Z',
  acceptedAt: null,
  completedAt: null,
  cancelledAt: null,
  sourceRegion: { id: id(3), label: 'source' },
  targetRegion: { id: id(4), label: 'target' },
  scope: 'foreign',
  relation: 'none',
  capabilities: { accept: true, cancel: false, complete: false, delete: false },
};
const service = (): ErrandSchoolService => ({
  context: {
    orderId: detail.id,
    targetRegion: { id: id(4), name: 'target group' },
  },
  entry: {
    entryKey: 'errand',
    revision: 4,
    state: 'configured',
    data: {
      kind: 'group',
      enabled: true,
      name: 'group',
      description: 'join',
      joinUrl: '',
      qqGroupNumber: '',
      maxGroupNumber: 3,
    },
    qrcode: { status: 'configured' },
  },
});
function setup() {
  const sessions = new SessionStore(),
    profiles = new FakeProfileGateway();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  profiles.current = {
    ...profiles.current,
    selectedCampus: campus({ id: id(90) }),
  };
  let view = initialErrandTargetServicesView(),
    cleared = 0;
  const gateway = { read: async () => service() };
  const controller = new ErrandTargetServicesController(
    sessions,
    gateway,
    profiles,
    () => cleared++,
    (v) => {
      view = v;
    },
  );
  return {
    sessions,
    profiles,
    gateway,
    controller,
    view: () => view,
    cleared: () => cleared,
  };
}
test('order-target contract rejects campus/context substitution and non-errand entries', () => {
  assert.deepEqual(decodeErrandSchoolService(service()), service());
  assert.throws(() =>
    decodeErrandSchoolService({
      ...service(),
      context: { ...service().context, campusId: id(5) },
    }),
  );
  assert.throws(() =>
    decodeErrandSchoolService({
      ...service(),
      entry: { ...service().entry, entryKey: 'review' },
    }),
  );
  assert.throws(() =>
    decodeErrandSchoolService({
      ...service(),
      entry: { ...service().entry, state: 'disabled' },
    }),
  );
});
test('immutable order target ignores selected campus; dismissal retries exact narrow CAS after conflict', async () => {
  const f = setup();
  await f.controller.load(detail);
  assert.equal(f.view().visible, true);
  assert.deepEqual(f.controller.previewContext(), {
    orderId: id(1),
    targetRegionId: id(4),
    entryKey: 'errand',
    entryRevision: 4,
  });
  let calls = 0;
  f.profiles.preferencesImpl = async (patch) => {
    assert.deepEqual(patch.preferences, { showErrandGroupNotice: false });
    calls++;
    if (calls === 1) {
      f.profiles.current = {
        ...f.profiles.current,
        revision: 1,
        preferences: { ...f.profiles.current.preferences, showHotTopic: false },
      };
      throw new ClientError('business', 'conflict', {
        serverCode: 'PROFILE_REVISION_CONFLICT',
        httpStatus: 409,
      });
    }
    assert.equal(patch.expectedRevision, 1);
    f.profiles.current = {
      ...f.profiles.current,
      revision: 2,
      preferences: { ...f.profiles.current.preferences, ...patch.preferences },
    };
    return f.profiles.current;
  };
  await f.controller.dismiss();
  assert.equal(calls, 2);
  assert.equal(f.view().visible, false);
  assert.equal(f.profiles.current.preferences.showHotTopic, false);
  assert.equal(f.controller.previewContext(), null);
  await f.controller.load(detail);
  assert.equal(f.view().visible, false);
  f.controller.dispose();
});
test('lost dismiss response is read back, never blindly resent; foreign profile/order refuses rendering', async () => {
  const f = setup();
  await f.controller.load(detail);
  let calls = 0;
  f.profiles.preferencesImpl = async () => {
    calls++;
    f.profiles.current = {
      ...f.profiles.current,
      revision: 1,
      preferences: {
        ...f.profiles.current.preferences,
        showErrandGroupNotice: false,
      },
    };
    throw new ClientError('network', 'lost');
  };
  await f.controller.dismiss();
  assert.equal(calls, 1);
  assert.equal(f.view().visible, false);
  f.gateway.read = async () => ({
    ...service(),
    context: {
      ...service().context,
      targetRegion: { id: id(9), name: 'wrong' },
    },
  });
  await f.controller.load(detail);
  assert.equal(f.view().visible, false);
  assert.ok(f.view().error);
  f.gateway.read = async () => service();
  f.profiles.current = { ...f.profiles.current, accountId: id(10) };
  await f.controller.load(detail);
  assert.equal(f.view().visible, false);
  assert.ok(f.view().error);
  f.controller.dispose();
});
test('clear/dispose/account change discard non-cooperative late detail and preference callbacks', async () => {
  for (const mode of ['clear', 'dispose', 'account'] as const) {
    const f = setup(),
      pending = deferred<ErrandSchoolService>();
    f.gateway.read = () => pending.promise;
    const loading = f.controller.load(detail);
    if (mode === 'account')
      f.sessions.completeLogin(f.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: id(90),
      });
    else f.controller[mode]();
    pending.resolve(service());
    await loading;
    assert.equal(f.view().visible, false);
    assert.equal(f.controller.previewContext(), null);
    f.controller.dispose();
  }
  const f = setup();
  await f.controller.load(detail);
  const pending = deferred<OwnProfile>();
  f.profiles.preferencesImpl = () => pending.promise;
  const dismiss = f.controller.dismiss();
  f.sessions.completeLogin(f.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: id(91),
  });
  pending.resolve({
    ...f.profiles.current,
    preferences: {
      ...f.profiles.current.preferences,
      showErrandGroupNotice: false,
    },
  });
  await dismiss;
  await flush();
  assert.equal(f.view().visible, false);
  assert.equal(f.controller.previewContext(), null);
  f.controller.dispose();
});
