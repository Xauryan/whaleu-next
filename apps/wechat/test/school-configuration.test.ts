import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import {
  publicSchoolEntryKeys,
  decodeSchoolPublic,
  emptySchoolData,
  schoolCommandHash,
} from '../src/school-configuration/contract';
import type {
  SchoolPublicView,
  SchoolEntryKey,
  SchoolCommand,
  SchoolReceipt,
} from '../src/school-configuration/contract';
import type { SchoolConfigurationGateway } from '../src/school-configuration/gateway';
import { SchoolCommandJournal } from '../src/school-configuration/pending';
import {
  SchoolServicesController,
  initialSchoolServicesView,
} from '../src/school-configuration/public-controller';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
const campus = '33333333-3333-4333-8333-333333333333',
  other = '44444444-4444-4444-8444-444444444444',
  region = '55555555-5555-4555-8555-555555555555';
function view(campusId = campus): SchoolPublicView {
  return {
    context: {
      campusId,
      campusName: '合成大学',
      region: { id: region, name: '合成运营地区' },
    },
    entries: publicSchoolEntryKeys.map((entryKey) => ({
      entryKey,
      revision: entryKey === 'admin' ? 1 : 0,
      state: entryKey === 'admin' ? 'configured' : 'unconfigured',
      data:
        entryKey === 'admin'
          ? { kind: 'admin', enabled: true, wechatId: 'synthetic_admin' }
          : null,
      qrcode: { status: 'none' },
    })),
  };
}
const unavailable = async (): Promise<never> => {
  throw new Error('Unexpected mutation');
};
function gateway(
  read: SchoolConfigurationGateway['public'],
): SchoolConfigurationGateway {
  return {
    public: read,
    capabilities: unavailable,
    management: unavailable,
    save: unavailable,
    recover: unavailable,
    cancel: unavailable,
  };
}
test('native public decoder rejects review entries, secret/URL extras and disabled payload leakage', () => {
  assert.deepEqual(decodeSchoolPublic(view()), view());
  const unknown = { ...view(), secret: 'never' };
  assert.throws(() => decodeSchoolPublic(unknown));
  const leaked = view();
  leaked.entries[4] = { ...leaked.entries[4]!, state: 'disabled' };
  assert.throws(() => decodeSchoolPublic(leaked));
  const review = view();
  review.entries[0] = { ...review.entries[0]!, entryKey: 'review' };
  assert.throws(() => decodeSchoolPublic(review));
});
test('journal validates exact original account/scope/hash, settles only exact receipt and retains failed cleanup', () => {
  const storage = new MemoryStorage(),
    journal = new SchoolCommandJournal(
      storage,
      'https://native-school.invalid',
    ),
    actor = wireCredentials().accountId;
  const command: SchoolCommand = {
    clientRequestId: '77777777-7777-4777-8777-777777777777',
    expectedRevision: 0,
    entry: emptySchoolData('admin'),
    qrcode: { action: 'keep' },
  };
  const pending = journal.write(actor, region, 'admin', command);
  assert.equal(
    pending.requestHash,
    schoolCommandHash(actor, region, 'admin', command),
  );
  assert.throws(() =>
    journal.write(actor, region, 'admin', { ...command, expectedRevision: 1 }),
  );
  const receipt: SchoolReceipt = {
    requestId: command.clientRequestId,
    requestHash: pending.requestHash,
    regionId: region,
    entryKey: 'admin',
    revision: 1,
    outcome: 'saved',
  };
  assert.throws(() => journal.settle(pending, { ...receipt, regionId: other }));
  assert.ok(journal.read(actor));
  journal.settle(pending, receipt);
  assert.equal(journal.read(actor), null);
});
test('public controller rejects noncooperative late campus/account callbacks and refreshes before clipboard transmission', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let current = view(),
    resolve: ((value: SchoolPublicView) => void) | null = null,
    hold = false;
  const api = gateway(async (campusId) => {
    if (hold) {
      hold = false;
      return new Promise<SchoolPublicView>((done) => {
        resolve = done;
      });
    }
    return { ...current, context: { ...current.context, campusId } };
  });
  const copied: string[] = [],
    states: ReturnType<typeof initialSchoolServicesView>[] = [],
    controller = new SchoolServicesController(
      sessions,
      api,
      undefined,
      {
        set: async (text) => {
          copied.push(text);
        },
      },
      (next) => states.push(next),
    );
  await controller.load(campus);
  await controller.copy('admin', 'wechatId');
  assert.deepEqual(copied, ['synthetic_admin']);
  current = {
    ...current,
    entries: current.entries.map((entry) =>
      entry.entryKey === 'admin'
        ? { ...entry, revision: 2, state: 'disabled', data: null }
        : entry,
    ),
  };
  await controller.copy('admin', 'wechatId');
  assert.deepEqual(copied, ['synthetic_admin']);
  assert.equal(states[states.length - 1]!.entries[4]!.data, null);
  hold = true;
  const old = controller.load(campus);
  await Promise.resolve();
  await controller.load(other);
  (resolve as unknown as (value: SchoolPublicView) => void)(view(campus));
  await old;
  assert.equal(states[states.length - 1]!.campusId, other);
  sessions.logout();
  assert.deepEqual(states[states.length - 1]!.entries, []);
  controller.dispose();
});
test('copy never sends a previous value when refreshed data or permission is unavailable', async () => {
  const sessions = new SessionStore();
  let fail = false,
    copies = 0;
  const api = gateway(async () => {
    if (fail) throw new ClientError('forbidden', 'Denied');
    return view();
  });
  const controller = new SchoolServicesController(
    sessions,
    api,
    undefined,
    {
      set: async () => {
        copies++;
      },
    },
    () => undefined,
  );
  await controller.load(campus);
  fail = true;
  await controller.copy('admin' as SchoolEntryKey, 'wechatId');
  assert.equal(copies, 0);
  controller.dispose();
});
