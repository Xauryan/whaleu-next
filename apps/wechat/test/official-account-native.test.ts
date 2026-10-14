import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../src/auth/session';
import {
  OfficialController,
  initialOfficialView,
} from '../src/official-account-operations/controller';
import { OfficialCommandJournal } from '../src/official-account-operations/journal';
import {
  commandHash,
  decodePreview,
  decodeResult,
  decodeCommand,
  statusLabel,
} from '../src/official-account-operations/contracts';
import type {
  Command,
  Config,
  Capabilities,
  Preview,
  Result,
  Status,
} from '../src/official-account-operations/contracts';
import type { OfficialGateway } from '../src/official-account-operations/gateway';
import { MemoryStorage, deferred, flush, FakeClock } from './helpers';
import { wireCredentials } from './identity-helpers';
const program = '33333333-3333-4333-8333-333333333333',
  account = '44444444-4444-4444-8444-444444444444',
  request = '55555555-5555-4555-8555-555555555555',
  previewId = '66666666-6666-4666-8666-666666666666',
  h = 'a'.repeat(64),
  at = '1970-01-01T00:00:01.000Z';
const config: Config = {
  programId: program,
  accountRef: account,
  accountLabel: '合成学校',
  revision: h,
  author: '作者',
  coverAppearanceId: null,
  titleAppearanceId: null,
  readiness: 'synthetic_ready',
  schedule: { zone: 'Etc/UTC', slotTime: '00:00:00', automatic: false },
};
const capabilities: Capabilities = {
  programId: program,
  mode: 'synthetic',
  canManage: true,
  canPreview: true,
  canTest: true,
  canManualCreate: false,
  canPublish: false,
  reason: 'ready',
};
const preview: Preview = {
  previewId,
  programId: program,
  accountRef: account,
  accountLabel: '合成学校',
  kind: 'test',
  selectionAt: at,
  expiresAt: '1970-01-01T00:05:01.000Z',
  configRevision: h,
  manifestHash: h,
  eligibleCount: 1,
  mode: 'synthetic',
  article: {
    title: '【测试】标题',
    author: '作者',
    items: [
      {
        excerpt: '合成内容',
        publishedAt: at,
        publicCounts: { likes: '1', comments: '0', subscriptions: '0' },
        locator: `pages/community-detail/community-detail?postId=${request}`,
        mediaAppearanceRefs: [],
      },
    ],
    coverAppearanceId: null,
    titleAppearanceId: null,
  },
  actions: { createDraft: true },
  sourceState: 'complete',
};
function command(): Command {
  return {
    requestId: request,
    programId: program,
    expectedRevision: h,
    author: '作者',
    cover: { action: 'keep' },
    title: { action: 'keep' },
  };
}
function result(
  intent: Command,
  state: Status['state'] = 'config_applied',
): Result {
  return {
    receipt: {
      requestId: intent.requestId,
      intentHash: commandHash(intent),
      operation: 'expectedRevision' in intent ? 'config_save' : 'test_draft',
      programId: program,
      accountRef: account,
      acceptedAt: at,
      outcome: state === 'config_applied' ? 'config_applied' : 'admitted',
      configRevision: state === 'config_applied' ? h : null,
    },
    status: {
      state,
      cancelRequested: false,
      acceptedMaterialCount: 0,
      draftRef: null,
      withdrawal: 'none',
      nextAction: state === 'pending' ? 'wait' : 'none',
      updatedAt: at,
    },
  };
}
function harness(storage = new MemoryStorage()) {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const calls: string[] = [];
  let view = initialOfficialView();
  const gateway: OfficialGateway = {
    async capabilities() {
      calls.push('capabilities');
      return capabilities;
    },
    async config() {
      calls.push('config');
      return config;
    },
    async preview() {
      calls.push('preview');
      return preview;
    },
    async command(_op, intent) {
      calls.push('command:' + intent.requestId);
      return result(intent);
    },
    async recover() {
      calls.push('recover');
      return { state: 'not_recorded' };
    },
    async control(_action, intent) {
      calls.push('control');
      return result(intent, 'cancelled');
    },
  };
  const journal = new OfficialCommandJournal(
    storage,
    'https://api.example.test',
  );
  let ids = 0;
  const clock = new FakeClock();
  const controller = new OfficialController(
    sessions,
    gateway,
    journal,
    async () => {
      ids++;
      return ids === 1 ? request : previewId;
    },
    (v) => {
      view = v;
    },
    clock,
  );
  return {
    sessions,
    calls,
    gateway,
    journal,
    controller,
    storage,
    clock,
    get view() {
      return view;
    },
    get ids() {
      return ids;
    },
  };
}
test('strict DTOs reject unknown/private fields, wrong counts and malformed literals', () => {
  assert.equal(decodePreview(preview).eligibleCount, 1);
  assert.throws(() => decodePreview({ ...preview, providerId: 'private' }));
  assert.throws(() => decodePreview({ ...preview, eligibleCount: 0 }));
  assert.throws(() =>
    decodeCommand({ ...command(), author: '\ud800' }, 'config_save'),
  );
  assert.throws(() =>
    decodePreview({
      ...preview,
      article: {
        ...preview.article,
        items: [
          {
            ...preview.article.items[0],
            publicCounts: {
              likes: '9223372036854775808',
              comments: '0',
              subscriptions: '0',
            },
          },
        ],
      },
    }),
  );
  assert.throws(() =>
    decodeResult({
      ...result(command()),
      status: { ...result(command()).status, state: 'draft_confirmed' },
    }),
  );
  assert.equal(statusLabel(result(command()).status), '配置已保存');
  assert.equal(
    statusLabel(result(command(), 'dispatch_unknown').status),
    '结果未确认，请恢复原请求',
  );
});
test('journal verifies original complete intent, rejects overwrite and isolates account/origin', () => {
  const t = harness();
  const actor = wireCredentials().accountId;
  const pending = t.journal.write(actor, 'config_save', command());
  assert.equal(t.journal.read(actor)?.intentHash, pending.intentHash);
  assert.throws(() =>
    t.journal.write(actor, 'config_save', {
      ...command(),
      requestId: previewId,
    }),
  );
  assert.equal(
    new OfficialCommandJournal(t.storage, 'https://other.example.test').read(
      actor,
    ),
    null,
  );
  assert.equal(t.journal.read(account), null);
  assert.equal(
    JSON.stringify([...t.storage.data.values()]).includes('wu_a_'),
    false,
  );
});
test('write or readback failure blocks command dispatch', async () => {
  for (const readback of [false, true]) {
    const t = harness();
    await t.controller.load(program);
    if (readback) t.storage.get = () => undefined;
    else t.storage.failWrite = true;
    await t.controller.save();
    assert.equal(t.calls.filter((x) => x.startsWith('command')).length, 0);
    assert.match(t.view.error, /记录/);
    t.controller.dispose();
  }
});
test('double tap joins one original key and flight', async () => {
  const t = harness();
  await t.controller.load(program);
  const gate = deferred<Result>();
  t.gateway.command = async (_op, intent) => {
    t.calls.push('command:' + intent.requestId);
    return gate.promise;
  };
  const first = t.controller.save(),
    second = t.controller.save();
  assert.equal(first, second);
  await flush();
  assert.equal(t.ids, 1);
  assert.equal(t.calls.filter((x) => x.startsWith('command')).length, 1);
  gate.resolve(result(command()));
  await first;
  assert.equal(t.view.message, '配置已保存');
  t.controller.dispose();
});
test('cold restart recovers original key before capabilities; not_recorded retains original intent', async () => {
  const t = harness();
  const actor = wireCredentials().accountId;
  t.journal.write(actor, 'config_save', command());
  await t.controller.load(program);
  assert.equal(t.calls[0], 'recover');
  assert.equal(t.ids, 0);
  assert.equal(t.view.pending, true);
  await t.controller.recover('retry');
  assert.equal(t.calls.filter((x) => x === 'command:' + request).length, 1);
  assert.equal(t.ids, 0);
  t.controller.dispose();
});
test('recorded config recovery settles its receipt and reloads config without treating it as a cancellation', async () => {
  const t = harness();
  const actor = wireCredentials().accountId;
  t.journal.write(actor, 'config_save', command());
  t.gateway.recover = async () => ({ state: 'recorded', ...result(command()) });
  await t.controller.load(program);
  assert.equal(t.journal.read(actor), null);
  assert.equal(t.view.pending, false);
  assert.equal(t.view.status?.state, 'config_applied');
  assert.equal(t.view.message, '配置已保存');
  assert.deepEqual(t.view.config, config);
  assert.equal(t.view.error, '');
  assert.equal(t.calls.filter((x) => x.startsWith('command')).length, 0);
  t.controller.dispose();
});
test('hide during asynchronous new-key preparation prevents request and releases preview', async () => {
  const t = harness();
  const id = deferred<string>();
  let view = initialOfficialView();
  const c = new OfficialController(
    t.sessions,
    t.gateway,
    t.journal,
    () => id.promise,
    (v) => {
      view = v;
    },
    t.clock,
  );
  await c.load(program);
  const saving = c.save();
  await flush();
  c.hide();
  id.resolve(request);
  await saving;
  assert.equal(t.calls.filter((x) => x.startsWith('command')).length, 0);
  assert.equal(view.preview, null);
  assert.equal(view.config, null);
  c.dispose();
  t.controller.dispose();
});
test('target change and session change ignore late private responses', async () => {
  const t = harness();
  const gate = deferred<Config>();
  t.gateway.config = () => gate.promise;
  const loading = t.controller.load(program);
  await flush();
  t.controller.hide();
  gate.resolve(config);
  await loading;
  assert.equal(t.view.config, null);
  t.sessions.logout();
  assert.equal(t.view.preview, null);
  t.controller.dispose();
});
test('successful save and failed test are independent intents', async () => {
  const t = harness();
  await t.controller.load(program);
  await t.controller.save();
  assert.equal(t.journal.read(wireCredentials().accountId), null);
  await t.controller.preview('test');
  t.gateway.command = async () => {
    throw new Error('lost response');
  };
  await t.controller.createTest();
  assert.equal(
    t.journal.read(wireCredentials().accountId)?.operation,
    'test_draft',
  );
  assert.equal(t.view.pending, true);
  t.controller.dispose();
});
test('registered native surface contains no operator/publication action', () => {
  const wxml = readFileSync(
    join(
      __dirname,
      '../src/pages/official-account-operations/official-account-operations.wxml',
    ),
    'utf8',
  );
  assert.match(wxml, /不会自动发布/);
  assert.match(wxml, /开发合成模式/);
  assert.doesNotMatch(wxml, /bindtap="[^"]*[Pp]ublish/);
  const gateway = readFileSync(
    join(__dirname, '../src/official-account-operations/gateway.ts'),
    'utf8',
  );
  assert.doesNotMatch(gateway, /operator\/|publish-commands/);
});

test('private preview expires without extending on refresh and hide releases timers', async () => {
  const t = harness();
  await t.controller.load(program);
  await t.controller.preview('test');
  assert.equal(t.clock.timers, 1);
  t.clock.advance(300000);
  assert.equal(t.view.preview, null);
  await t.controller.preview('test');
  t.controller.hide();
  assert.equal(t.clock.timers, 0);
  t.controller.dispose();
});

test('cancel acknowledgement loss recovers the exact pre-admission tombstone after restart', async () => {
  const first = harness(),
    actor = wireCredentials().accountId;
  const pending = first.journal.write(actor, 'config_save', command());
  first.gateway.control = async () => {
    throw new Error('lost cancel acknowledgement');
  };
  await first.controller.recover('cancel');
  assert.equal(first.journal.read(actor)?.intentHash, pending.intentHash);
  first.controller.dispose();
  const second = harness(first.storage);
  second.gateway.recover = async () => ({
    state: 'cancelled_before_admission',
    requestId: pending.command.requestId,
    intentHash: pending.intentHash,
  });
  await second.controller.load(program);
  assert.equal(second.journal.read(actor), null);
  assert.equal(second.view.pending, false);
  assert.equal(second.calls.filter((x) => x.startsWith('command')).length, 0);
  second.controller.dispose();
});
