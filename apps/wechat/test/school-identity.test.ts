import { ApiClient } from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import { HttpSchoolIdentityGateway } from '../src/school-identity/gateway';
import { HttpSchoolUidGateway } from '../src/school-uid/gateway';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  decodeAuthorization,
  type Authorization,
} from '../src/identity-privacy/overlay';
import {
  decodeSchoolIdentityCommand,
  decodeSchoolIdentityManagement,
  decodeSchoolIdentityReceipt,
  matchSchoolIdentityReceipt,
  schoolIdentityCommandHash,
  schoolIdentityActorScope,
  type SchoolIdentityCommand,
  type SchoolIdentityManagement,
  type SchoolIdentityReceipt,
} from '../src/school-identity/contract';
import {
  SchoolIdentityController,
  type SchoolIdentityView,
} from '../src/school-identity/controller';
import type { SchoolIdentityGateway } from '../src/school-identity/gateway';
import { PendingSchoolIdentityStore } from '../src/school-identity/pending';
import {
  decodeSchoolUid,
  formatSchoolUid,
  parseSchoolUid,
} from '../src/school-uid/contract';
import { decodePublicProfile } from '../src/profile/discovery-contract';
import { publicProfile } from './discovery-helpers';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';
const capability = (
  allowed = true,
  role: Authorization['role'] = 'super_admin',
): Authorization => ({
  role,
  schoolAdminManagement: allowed,
  schoolIdentityManagement: allowed,
  management: {
    global: role === 'super_admin' || role === 'developer',
    operatingRegionIds: [],
  },
  identityView: { allowed: role === 'developer', maxBatchSize: 20 },
});
const command = (patch: Record<string, unknown> = {}): SchoolIdentityCommand =>
  decodeSchoolIdentityCommand({
    version: 1,
    clientRequestId: requestId,
    targetProfileId: postId,
    expectedStateVersion: 'a'.repeat(64),
    action: 'correct_school',
    destinationCampusId: otherId,
    expectedDestinationVersion: 'b'.repeat(64),
    ...patch,
  });
function receipt(c = command(), unchanged = false): SchoolIdentityReceipt {
  const { clientRequestId, ...intent } = c;
  return {
    ...intent,
    requestId: clientRequestId,
    outcome: unchanged ? 'unchanged' : 'applied',
    eventId: otherId,
    recordedAt: createdAt,
  };
}
function rejected(c = command()): SchoolIdentityReceipt {
  const { clientRequestId, ...intent } = c;
  return {
    ...intent,
    requestId: clientRequestId,
    outcome: 'rejected',
    code: 'SCHOOL_IDENTITY_CANCELLED',
  };
}
const manage = (selected = false): SchoolIdentityManagement => ({
  target: { profileId: postId, displayName: '合成昵称' },
  stateVersion: 'a'.repeat(64),
  current: {
    school: { code: '12345', name: '原学校' },
    schoolUid: {
      status: 'assigned',
      school: { code: '12345', name: '原学校' },
      uid: '9007199254740993',
      formattedUid: '9007199254740993',
    },
  },
  destination: selected
    ? {
        campusId: otherId,
        campusName: '目标校区',
        school: { code: '54321', name: '新学校' },
        destinationVersion: 'b'.repeat(64),
      }
    : null,
  actions: { correctSchool: true, completeUid: false },
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: { command: SchoolIdentityCommand; cancelling: boolean }[] = [];
  let managementReads = 0,
    capabilityReads = 0;
  const gateway: SchoolIdentityGateway = {
    capabilities: async () => {
      capabilityReads++;
      return capability();
    },
    management: async (_target, _cancel, destination) => {
      managementReads++;
      return manage(!!destination);
    },
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      return cancelling ? rejected(c) : receipt(c);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingSchoolIdentityStore(
    storage,
    'https://synthetic.invalid',
  );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    schoolIdentity: gateway,
    pendingSchoolIdentity: store,
  };
  if (runtime.profiles)
    runtime.profiles.campuses = async () => ({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          id: otherId,
          institutionId: '54321',
          institutionName: '新学校',
          fullName: '目标校区',
          shortName: null,
          district: '合成',
          isActive: true,
        },
      ],
    });
  let view!: SchoolIdentityView;
  const make = () =>
    new SchoolIdentityController(runtime, (next) => {
      view = next;
    });
  return {
    ...s,
    runtime,
    commands,
    gateway,
    store,
    storage,
    make,
    view: () => view,
    reads: () => ({ managementReads, capabilityReads }),
    freeze: () =>
      store.freeze({
        version: 1,
        accountId: s.accountId,
        origin: store.origin,
        phase: 'submit',
        command: command(),
      }),
  };
}
async function confirm(c: SchoolIdentityController) {
  await c.load(postId);
  await c.searchCampuses();
  await c.selectCampus(otherId);
  c.request('correct_school');
}
test('native UID parser is bigint-exact, canonical and never truncates output', () => {
  for (const value of [
    '1',
    '999999',
    '1000000',
    '9007199254740993',
    '9223372036854775807',
  ]) {
    assert.equal(parseSchoolUid(value), value);
    assert.equal(formatSchoolUid(value), value.padStart(6, '0'));
  }
  assert.equal(parseSchoolUid('000001'), '1');
  for (const invalid of [
    1,
    '0',
    '0000',
    ' 1',
    '+1',
    '1.0',
    '1e3',
    '9223372036854775808',
    '00000000000000000001',
  ])
    assert.throws(() => parseSchoolUid(invalid));
  assert.throws(() =>
    decodeSchoolUid({
      status: 'assigned',
      school: { code: '12345', name: '学校' },
      uid: '1',
      formattedUid: '1',
    }),
  );
});
test('public decoder enforces atomic school and UID fields without private identifiers', () => {
  const base = publicProfile();
  const assigned = {
    ...base,
    schoolUidStatus: 'assigned',
    affiliation: { schoolCode: '12345', schoolName: '合成学校' },
    publicUid: { value: '9007199254740993', formatted: '9007199254740993' },
  };
  assert.deepEqual(decodePublicProfile(assigned), assigned);
  for (const patch of [
    { affiliation: null },
    { publicUid: null },
    { schoolUidStatus: 'unavailable' },
    { publicUid: { value: '1', formatted: '1' } },
    {
      affiliation: {
        schoolCode: '12345',
        schoolName: '学校',
        institutionId: otherId,
      },
    },
  ])
    assert.throws(() => decodePublicProfile({ ...assigned, ...patch }));
});
test('command and management decoders reject ambiguous actions, internal IDs and predicted UID', () => {
  for (const patch of [
    { accountId: otherId },
    { assertionId: otherId },
    { studentNumber: 'private' },
    { action: 'complete_uid' },
    { version: 2 },
    { destinationCampusId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { expectedStateVersion: 'A'.repeat(64) },
  ])
    assert.throws(() =>
      decodeSchoolIdentityCommand({ ...command(), ...patch }),
    );
  assert.deepEqual(decodeSchoolIdentityManagement(manage(true)), manage(true));
  assert.throws(() =>
    decodeSchoolIdentityManagement({
      ...manage(true),
      destination: { ...manage(true).destination, predictedUid: '1' },
    }),
  );
  assert.equal(
    schoolIdentityCommandHash(command()),
    schoolIdentityCommandHash(command({ clientRequestId: otherId })),
  );
  assert.notEqual(
    schoolIdentityCommandHash(command()),
    schoolIdentityCommandHash(
      command({ expectedDestinationVersion: 'c'.repeat(64) }),
    ),
  );
});
test('minimal receipts must match every frozen intent field', () => {
  assert.deepEqual(decodeSchoolIdentityReceipt(receipt()), receipt());
  for (const patch of [
    { requestId: otherId },
    { targetProfileId: otherId },
    { expectedStateVersion: 'b'.repeat(64) },
    { destinationCampusId: postId },
    { expectedDestinationVersion: 'c'.repeat(64) },
  ])
    assert.throws(() =>
      matchSchoolIdentityReceipt(command(), {
        ...receipt(),
        ...patch,
      } as SchoolIdentityReceipt),
    );
  assert.throws(() =>
    decodeSchoolIdentityReceipt({ ...receipt(), schoolName: 'historical' }),
  );
});
test('developer label alone cannot enable school identity management', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  s.gateway.capabilities = async () => capability(false, 'developer');
  await c.load(postId);
  assert.equal(s.view().canManage, false);
  assert.equal(s.reads().managementReads, 0);
  assert.throws(() =>
    decodeAuthorization({
      ...capability(false, 'member'),
      schoolIdentityManagement: true,
    }),
  );
});
test('destination requires real explicit catalog selection and confirmation', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  await c.load(postId);
  c.request('correct_school');
  await c.submit();
  assert.equal(s.commands.length, 0);
  await c.selectCampus(otherId);
  assert.equal(s.view().management?.destination, null);
  await c.searchCampuses();
  await c.selectCampus(otherId);
  assert.equal(s.view().management?.destination?.campusId, otherId);
  c.request('correct_school');
  c.closeConfirmation();
  await c.submit();
  assert.equal(s.commands.length, 0);
});
test('double tap persists one full command before mutation and does not create another key', async (t) => {
  const s = harness(),
    c = s.make(),
    late = deferred<SchoolIdentityReceipt>();
  t.after(() => c.dispose());
  s.gateway.submit = async (command, _cancel, cancelling = false) => {
    assert.deepEqual(s.store.load(s.accountId)?.command, command);
    s.commands.push({ command, cancelling });
    return late.promise;
  };
  await confirm(c);
  const work = c.submit();
  await c.submit();
  await flush();
  assert.equal(s.commands.length, 1);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().management, null);
  late.resolve(receipt());
  await work;
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /历史结果/);
});
test('lost response cold restart recovers original key after role loss before private target reads', async (t) => {
  const s = harness();
  let c = s.make();
  t.after(() => c.dispose());
  s.gateway.submit = async () => {
    throw new ClientError('timeout', 'lost');
  };
  await confirm(c);
  await c.submit();
  const pending = s.store.load(s.accountId);
  assert.ok(pending);
  c.dispose();
  c = s.make();
  s.gateway.capabilities = async () => capability(false, 'member');
  s.gateway.management = async () => {
    throw new Error('must not read target');
  };
  await c.load('invalid');
  assert.equal(s.view().frozen, true);
  s.gateway.receipt = async () => ({
    state: 'recorded',
    receipt: receipt(pending.command),
  });
  await c.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.view().canManage, false);
});
test('not_recorded keeps original key, retry uses exact full body', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  const pending = s.freeze();
  await c.load();
  await c.recover();
  assert.deepEqual(s.store.load(s.accountId), pending);
  await c.recover(true);
  assert.deepEqual(s.commands[0]?.command, pending.command);
});
test('explicit cancel preserves full intent and returns either winner without claiming rollback', async (t) => {
  for (const applied of [false, true]) {
    const s = harness(),
      c = s.make();
    t.after(() => c.dispose());
    const pending = s.freeze();
    await c.load();
    s.gateway.submit = async (command, _cancel, cancelling) => {
      assert.equal(cancelling, true);
      assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
      assert.deepEqual(command, pending.command);
      return applied ? receipt(command) : rejected(command);
    };
    c.requestCancellation();
    await c.confirmCancellation();
    assert.equal(s.store.load(s.accountId), null);
    assert.match(s.view().receiptStatus, applied ? /历史结果/ : /取消/);
  }
});
test('storage failure blocks HTTP and corrupt journals cannot be replaced', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  await confirm(c);
  s.storage.failWrite = true;
  await c.submit();
  assert.equal(s.commands.length, 0);
  assert.match(s.view().error, /保存失败/);
  s.storage.failWrite = false;
  s.storage.data.set(
    `whaleu.school-identity.pending.v1:${s.store.origin}:${schoolIdentityActorScope(s.accountId)}`,
    { version: 1, token: 'forbidden' },
  );
  assert.throws(() => s.store.load(s.accountId));
  await c.load(postId);
  assert.equal(s.commands.length, 0);
});
test('same-account replacement session retains journal while account/origin swaps cannot recover it', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  const pending = s.freeze();
  await c.load();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: s.accountId,
    sessionId: otherId,
  });
  await c.load();
  assert.equal(s.view().pendingRequestId, pending.command.clientRequestId);
  assert.equal(
    new PendingSchoolIdentityStore(s.storage, 'https://other.invalid').load(
      s.accountId,
    ),
    null,
  );
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherId,
  });
  assert.equal(s.view().management, null);
  await c.load();
  assert.equal(s.view().frozen, false);
  assert.deepEqual(s.store.load(pending.accountId), pending);
});
test('hide/dispose and stop waiting clear rendered private data without cancelling or losing pending intent', async () => {
  const s = harness(),
    c = s.make(),
    late = deferred<SchoolIdentityReceipt>();
  s.gateway.submit = async () => late.promise;
  await confirm(c);
  const work = c.submit();
  await flush();
  const pending = s.store.load(s.accountId);
  assert.ok(pending);
  c.cancel();
  assert.deepEqual(s.store.load(s.accountId), pending);
  c.dispose();
  assert.equal(s.view().management, null);
  assert.equal(s.view().pendingTargetProfileId, '');
  late.resolve(receipt());
  await work;
  assert.deepEqual(s.store.load(s.accountId), pending);
  assert.equal(s.view().management, null);
});
test('same-school unchanged does not tell the user a transfer happened', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  s.gateway.submit = async (command) => receipt(command, true);
  await confirm(c);
  await c.submit();
  assert.match(s.view().receiptStatus, /未更正学校/);
  assert.match(s.view().receiptStatus, /未重新分配/);
});

test('actual gateways bind destination preview and preserve decimal strings on exact routes', async () => {
  const s = setup(),
    transport = new ScriptedTransport(),
    api = new ApiClient(
      'https://school-identity.example',
      transport,
      s.sessions,
      {
        refresh: async () => {
          throw Error('no auth replay');
        },
      },
    ),
    gateway = new HttpSchoolIdentityGateway(api),
    uidGateway = new HttpSchoolUidGateway(api);
  transport.reply(manage(true));
  await gateway.management(postId, new Cancellation(), otherId);
  assert.equal(
    new URL(transport.requests[0]!.url).search,
    `?targetProfileId=${postId}&destinationCampusId=${otherId}`,
  );
  transport.reply(manage(false));
  await assert.rejects(gateway.management(postId, new Cancellation(), otherId));
  transport.reply(receipt());
  await gateway.submit(command(), new Cancellation());
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply(rejected());
  await gateway.submit(command(), new Cancellation(), true);
  assert.ok(transport.requests[3]!.url.endsWith('/commands/cancel'));
  transport.reply({ state: 'recorded', receipt: receipt() });
  await gateway.receipt(requestId, new Cancellation());
  transport.reply({
    status: 'found',
    target: { profileId: postId, displayName: '合成' },
  });
  await uidGateway.lookup('12345', '000001', new Cancellation());
  assert.equal(
    new URL(transport.requests[5]!.url).search,
    '?schoolCode=12345&uid=1',
  );
  transport.reply({ status: 'unavailable' });
  await uidGateway.lookup('12345', '9007199254740993', new Cancellation());
  assert.equal(
    new URL(transport.requests[6]!.url).search,
    '?schoolCode=12345&uid=9007199254740993',
  );
});
test('deferred completion freezes no destination and cannot accept an assigned preview as eligible', async (t) => {
  const s = harness(),
    c = s.make();
  t.after(() => c.dispose());
  s.gateway.management = async () => ({
    ...manage(),
    current: {
      school: { code: '12345', name: '原学校' },
      schoolUid: { status: 'unavailable' },
    },
    actions: { correctSchool: true, completeUid: true },
  });
  await c.load(postId);
  c.request('complete_uid');
  await c.submit();
  const submitted = s.commands[0]?.command;
  assert.ok(submitted);
  assert.equal(submitted.action, 'complete_uid');
  assert.equal('destinationCampusId' in submitted, false);
  assert.equal('expectedDestinationVersion' in submitted, false);
  assert.throws(() =>
    decodeSchoolIdentityManagement({
      ...manage(),
      actions: { correctSchool: true, completeUid: true },
    }),
  );
});
test('replacing runtime origin/gateway while awaiting cannot settle the original environment journal', async (t) => {
  const s = harness(),
    c = s.make(),
    late = deferred<SchoolIdentityReceipt>();
  t.after(() => c.dispose());
  s.gateway.submit = async () => late.promise;
  await confirm(c);
  const work = c.submit();
  await flush();
  const pending = s.store.load(s.accountId);
  assert.ok(pending);
  Object.assign(s.runtime, {
    pendingSchoolIdentity: new PendingSchoolIdentityStore(
      s.storage,
      'https://other.invalid',
    ),
  });
  late.resolve(receipt());
  await work;
  assert.deepEqual(s.store.load(s.accountId), pending);
  assert.equal(s.view().management, null);
  assert.equal(s.view().frozen, true);
});

test('durable record and storage key contain no raw account IDs, credentials or private target facts', () => {
  const s = harness();
  s.freeze();
  const wire = JSON.stringify([...s.storage.data]);
  assert.equal(wire.includes(s.accountId), false);
  assert.equal(wire.includes('accountId'), false);
  assert.equal(wire.includes('accessToken'), false);
  assert.equal(wire.includes('assertionId'), false);
  assert.equal(wire.includes('studentNumber'), false);
  assert.ok(wire.includes('actorScope'));
  assert.ok(wire.includes(requestId));
});
