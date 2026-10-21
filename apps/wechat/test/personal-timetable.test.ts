import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  TimetableController,
  initialTimetableView,
  parseRoute,
  type Mode,
} from '../src/personal-timetable/controller';
import { TimetableJournal } from '../src/personal-timetable/journal';
import {
  HttpTimetableGateway,
  type TimetableGateway,
} from '../src/personal-timetable/gateway';
import {
  commandHash,
  decodeCommand,
  decodeDetail,
  decodeEntryFields,
  decodeReceipt,
  decodeTerms,
  matchReceipt,
  type Command,
  type Detail,
  type Receipt,
  type Term,
  type TermFields,
} from '../src/personal-timetable/contracts';
import {
  clockTime,
  conflicts,
  currentMonday,
  dateDay,
  dayDate,
  explicitWeeks,
  monday,
  shanghaiToday,
  timeMinutes,
  weekAt,
  weekDates,
  weeksFor,
} from '../src/personal-timetable/calendar';
import { timetablePage } from '../src/personal-timetable/page';
import { DirectoryNavigator } from '../src/directory/navigation';
const { timetableCommandSchema, timetableIntentHash } = createRequire(
  __filename,
)('../../api/src/personal-timetable/contracts.ts') as {
  timetableCommandSchema: { parse(value: unknown): unknown };
  timetableIntentHash(value: unknown): string;
};
import { MemoryStorage, deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
const id = (n: number) =>
  `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term: Term = {
  termId: id(1),
  name: '秋季学期',
  weekOneMonday: '2026-09-07',
  weekCount: 20,
  timeZone: 'Asia/Shanghai',
  revision: 2,
};
const entry = {
  entryId: id(2),
  termId: id(1),
  name: '线性代数',
  teacher: '林老师',
  location: '理科楼 201',
  note: '带习题册\n第二行',
  dayOfWeek: 2,
  startMinute: 480,
  endMinute: 525,
  weeks: [1, 3, 5],
  color: 'blue' as const,
};
const detail: Detail = { term, entries: [entry] };
function receipt(
  command: Command,
  outcome: Receipt['outcome'] = 'applied',
  code: string | null = null,
): Receipt {
  return {
    version: 1,
    requestId: command.requestId,
    intentHash: commandHash(command),
    operation: command.operation,
    termId: command.termId,
    entryId: command.entryId ?? null,
    expectedRevision: command.expectedRevision,
    resultingRevision:
      outcome === 'applied'
        ? command.expectedRevision + 1
        : outcome === 'cancelled'
          ? null
          : command.expectedRevision || null,
    outcome,
    code,
  };
}
function command(): Command {
  return decodeCommand({
    version: 1,
    requestId: id(10),
    operation: 'entry.create',
    termId: term.termId,
    expectedRevision: 2,
    entryId: id(11),
    payload: {
      name: entry.name,
      teacher: entry.teacher,
      location: entry.location,
      note: entry.note,
      dayOfWeek: entry.dayOfWeek,
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
      weeks: entry.weeks,
      color: entry.color,
    },
  });
}
function harness(mode: Mode = 'entry', storage = new MemoryStorage()) {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const actor = sessions.snapshot().credentials!.accountId;
  const journal = new TimetableJournal(storage, 'https://timetable.example');
  const visibility = new PrivateViewLifecycle();
  let view = initialTimetableView(mode),
    next = 20;
  const calls: string[] = [],
    commands: Command[] = [];
  const gateway: TimetableGateway = {
    async terms() {
      calls.push('terms');
      return { terms: [structuredClone(term)] };
    },
    async detail() {
      calls.push('detail');
      return structuredClone(detail);
    },
    async command(value) {
      calls.push('command');
      commands.push(structuredClone(value));
      return receipt(value);
    },
    async recover(requestId) {
      calls.push('recover');
      return { status: 'unknown', requestId };
    },
    async cancel(value) {
      calls.push('cancel');
      commands.push(structuredClone(value));
      return receipt(value, 'cancelled');
    },
  };
  const controller = new TimetableController(
    mode,
    sessions,
    gateway,
    journal,
    async () => id(next++),
    (value) => {
      view = value;
    },
    () => Date.parse('2026-09-08T00:00:00Z'),
    visibility,
  );
  const route = {
    termId: term.termId,
    entryId: mode === 'entry' ? entry.entryId : null,
    duplicate: false,
  };
  return {
    controller,
    gateway,
    journal,
    sessions,
    actor,
    calls,
    commands,
    storage,
    visibility,
    route,
    get view() {
      return view;
    },
    get next() {
      return next;
    },
  };
}

test('calendar is independent of local timezone, Gregorian leap days, Monday and year boundaries', () => {
  assert.equal(dayDate(dateDay('2024-02-29')), '2024-02-29');
  assert.throws(() => dateDay('2100-02-29'));
  assert.throws(() => dateDay('2024-02-30'));
  assert.throws(() => dateDay('1899-12-31'));
  assert.throws(() => monday('2026-09-08'));
  assert.equal(monday('2024-12-30'), '2024-12-30');
  assert.deepEqual(weekDates('2024-12-30', 1), [
    '2024-12-30',
    '2024-12-31',
    '2025-01-01',
    '2025-01-02',
    '2025-01-03',
    '2025-01-04',
    '2025-01-05',
  ]);
  const old = process.env.TZ;
  try {
    for (const zone of [
      'Pacific/Honolulu',
      'America/New_York',
      'Asia/Shanghai',
    ]) {
      process.env.TZ = zone;
      assert.equal(
        shanghaiToday(Date.parse('2024-02-28T16:00:00Z')),
        '2024-02-29',
      );
      assert.equal(
        currentMonday(Date.parse('2025-01-05T16:00:00Z')),
        '2025-01-06',
      );
      assert.deepEqual(weekAt('2024-12-30', 2, '2025-01-06'), {
        state: 'within',
        week: 2,
      });
    }
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
  assert.deepEqual(weekAt(term.weekOneMonday, 20, '2026-09-06'), {
    state: 'before',
    week: null,
  });
  assert.deepEqual(weekAt(term.weekOneMonday, 1, '2026-09-14'), {
    state: 'after',
    week: null,
  });
});
test('explicit weeks and half-open conflict intervals never reject adjacent courses', () => {
  assert.deepEqual(explicitWeeks('1-4, 6，8,2', 20), [1, 2, 3, 4, 6, 8]);
  assert.deepEqual(weeksFor('odd', 6), [1, 3, 5]);
  assert.deepEqual(weeksFor('even', 5), [2, 4]);
  for (const value of ['', '0', '31', '4-2', '1,,3', '1.5'])
    assert.throws(() => explicitWeeks(value, 30));
  assert.equal(
    conflicts(entry, { ...entry, startMinute: 525, endMinute: 600 }),
    false,
  );
  assert.equal(
    conflicts(entry, { ...entry, startMinute: 524, endMinute: 600 }),
    true,
  );
  assert.equal(conflicts(entry, { ...entry, weeks: [2, 4] }), false);
  assert.equal(conflicts(entry, { ...entry, dayOfWeek: 3 }), false);
  assert.equal(clockTime(1440), '24:00');
  assert.equal(timeMinutes('24:00'), 1440);
  assert.throws(() => timeMinutes('24:01'));
});
test('strict native codecs match server canonical hashes and reject private/extra/malformed fields', () => {
  const original = command();
  assert.equal(
    commandHash(original),
    timetableIntentHash(timetableCommandSchema.parse(original)),
  );
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(commandHash(decodeCommand(reversed)), commandHash(original));
  assert.deepEqual(decodeDetail(detail), detail);
  assert.throws(() => decodeDetail({ ...detail, accountId: id(9) }));
  assert.throws(() =>
    decodeDetail({ term, entries: [{ ...entry, termId: id(9) }] }),
  );
  assert.throws(() =>
    decodeDetail({ term: { ...term, weekCount: 2 }, entries: [entry] }),
  );
  assert.throws(() => decodeTerms({ terms: [term, term] }));
  assert.throws(() =>
    decodeCommand({
      ...original,
      payload: { ...original.payload, weeks: [3, 1] },
    }),
  );
  assert.throws(() =>
    decodeCommand({
      ...original,
      payload: { ...original.payload, note: '\r' },
    }),
  );
  assert.throws(() =>
    decodeCommand({
      ...original,
      payload: { ...original.payload, name: ' 课程' },
    }),
  );
  assert.throws(() =>
    decodeCommand({
      ...original,
      payload: { ...original.payload, name: '\ud800' },
    }),
  );
  assert.throws(() =>
    decodeCommand({
      ...original,
      payload: { ...original.payload, color: '#007aff' },
    }),
  );
  assert.throws(() =>
    decodeEntryFields({
      ...original.payload,
      startMinute: 600,
      endMinute: 500,
    }),
  );
  assert.throws(() =>
    decodeReceipt({ ...receipt(original), extra: 'private' }),
  );
  assert.throws(() =>
    matchReceipt(original, {
      ...receipt(original),
      intentHash: '0'.repeat(64),
    }),
  );
  assert.throws(() =>
    matchReceipt(original, { ...receipt(original), expectedRevision: 3 }),
  );
  assert.throws(() =>
    matchReceipt(original, { ...receipt(original), resultingRevision: 99 }),
  );
});
test('journal readback verification, corrupt storage and origin/account isolation are fail-closed', () => {
  const h = harness(),
    original = command();
  const pending = h.journal.write(h.actor, original);
  assert.ok(Object.isFrozen(pending.command));
  assert.ok(Object.isFrozen(pending.command.payload));
  assert.equal(h.journal.read(id(999)), null);
  assert.equal(
    new TimetableJournal(h.storage, 'https://another.example').read(h.actor),
    null,
  );
  assert.throws(() =>
    h.journal.write(h.actor, { ...original, requestId: id(12) }),
  );
  const key = [...h.storage.data.keys()][0]!;
  h.storage.data.set(key, { ...pending, intentHash: 'bad' });
  assert.throws(() => h.journal.read(h.actor));
  const corrupt = new MemoryStorage();
  corrupt.set = (key, value) =>
    corrupt.data.set(key, {
      ...(value as object),
      version: 99,
    }) as unknown as void;
  assert.throws(() =>
    new TimetableJournal(corrupt, 'https://timetable.example').write(
      h.actor,
      original,
    ),
  );
});
test('storage failure and corruption prevent every mutation dispatch', async () => {
  const h = harness();
  await h.controller.load(h.route);
  h.storage.failWrite = true;
  h.controller.setEntry('name', '新名称');
  await h.controller.save();
  assert.equal(h.commands.length, 0);
  assert.equal(h.view.blocked, true);
  assert.match(h.view.error, /停止发送/);
  h.controller.dispose();
  const broken = harness();
  broken.journal.write(broken.actor, command());
  broken.storage.data.set([...broken.storage.data.keys()][0]!, { version: 0 });
  await broken.controller.load(broken.route);
  await broken.controller.save();
  assert.deepEqual(broken.calls, []);
  assert.equal(broken.view.blocked, true);
  broken.controller.dispose();
});
test('double tap makes one immutable command; ordinary text trims only before freezing', async () => {
  const h = harness();
  await h.controller.load(h.route);
  const deferredReceipt = deferred<Receipt>();
  h.gateway.command = async (original) => {
    h.commands.push(original);
    return deferredReceipt.promise;
  };
  h.controller.setEntry('name', '  课程改名  ');
  h.controller.setEntry('note', '甲\r\n乙');
  const first = h.controller.save();
  const second = h.controller.save();
  h.controller.setEntry('name', '不能覆盖');
  await flush();
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0]!.payload.name, '课程改名');
  assert.equal((h.commands[0]!.payload as { note: string }).note, '甲\n乙');
  deferredReceipt.resolve(receipt(h.commands[0]!));
  await Promise.all([first, second]);
  assert.equal(h.journal.read(h.actor), null);
  assert.match(h.view.message, /已保存/);
  assert.equal(h.view.entryForm.name, '');
  h.controller.dispose();
});
test('lost response, cold restart, unknown lookup and exact retry keep original payload and request ID', async () => {
  const h = harness();
  await h.controller.load(h.route);
  h.gateway.command = async (original) => {
    h.commands.push(structuredClone(original));
    throw new ClientError('network', 'lost');
  };
  h.controller.setEntry('name', '持久课程');
  await h.controller.save();
  const original = h.journal.read(h.actor)!;
  assert.ok(original);
  h.controller.hide();
  assert.equal(h.view.entryForm.name, '');
  assert.ok(h.journal.read(h.actor));
  const cold = harness('entry', h.storage);
  await cold.controller.load(cold.route);
  assert.equal(cold.view.pending, true);
  assert.deepEqual(cold.calls, []);
  await cold.controller.recover();
  assert.equal(cold.view.pending, true);
  assert.match(cold.view.message, /不代表失败/);
  cold.controller.setEntry('name', '禁止修改');
  await cold.controller.save();
  assert.equal(cold.commands.length, 0);
  await cold.controller.recover('retry');
  assert.deepEqual(cold.commands, [original.command]);
  assert.equal(cold.journal.read(cold.actor), null);
  h.controller.dispose();
  cold.controller.dispose();
});
test('committed-lost-response read recovery works without any readable term and never sends again', async () => {
  const h = harness();
  const original = command();
  h.journal.write(h.actor, original);
  h.gateway.terms = async () => {
    throw new Error('deleted term');
  };
  h.gateway.recover = async () => ({
    status: 'settled',
    receipt: receipt(original),
  });
  await h.controller.load(h.route);
  await h.controller.recover('retry');
  assert.equal(h.commands.length, 0);
  assert.equal(h.journal.read(h.actor), null);
  assert.match(h.view.message, /已保存/);
  h.controller.dispose();
});
test('receipt mismatch and clearing failure retain recovery barrier', async () => {
  const h = harness();
  const original = command();
  h.journal.write(h.actor, original);
  h.gateway.recover = async () => ({
    status: 'settled',
    receipt: { ...receipt(original), intentHash: '0'.repeat(64) },
  });
  await h.controller.load(h.route);
  await h.controller.recover();
  assert.ok(h.journal.read(h.actor));
  assert.equal(h.view.pending, true);
  h.gateway.recover = async () => ({
    status: 'settled',
    receipt: receipt(original),
  });
  h.storage.failRemove = true;
  await h.controller.recover();
  assert.ok(h.journal.read(h.actor));
  assert.equal(h.view.blocked, true);
  h.storage.failRemove = false;
  await h.controller.recover();
  assert.equal(h.journal.read(h.actor), null);
  h.controller.dispose();
});
test('durable cancellation survives lost reply; retry cannot resurrect the original write', async () => {
  const h = harness();
  const original = command();
  h.journal.write(h.actor, original);
  await h.controller.load(h.route);
  h.gateway.cancel = async (value) => {
    assert.deepEqual(value, original);
    throw new Error('lost cancellation reply');
  };
  await h.controller.recover('cancel');
  assert.equal(h.journal.read(h.actor)!.phase, 'cancel');
  h.controller.dispose();
  const cold = harness('entry', h.storage);
  await cold.controller.load(cold.route);
  await cold.controller.recover('retry');
  assert.deepEqual(cold.calls, ['recover', 'cancel']);
  assert.deepEqual(cold.commands, [original]);
  assert.equal(cold.journal.read(cold.actor), null);
  assert.match(cold.view.message, /已取消/);
  cold.controller.dispose();
});
test('cancel race reports the actual committed receipt rather than claiming rollback', async () => {
  const h = harness();
  const original = command();
  h.journal.write(h.actor, original);
  h.gateway.cancel = async () => receipt(original);
  await h.controller.load(h.route);
  await h.controller.recover('cancel');
  assert.match(h.view.message, /已保存/);
  assert.doesNotMatch(h.view.message, /已取消/);
  assert.equal(h.journal.read(h.actor), null);
  h.controller.dispose();
});
test('stale revision is terminal, never silently rebased or automatically retried', async () => {
  const h = harness();
  await h.controller.load(h.route);
  h.gateway.command = async (original) => {
    h.commands.push(original);
    return receipt(original, 'rejected', 'TIMETABLE_REVISION_CONFLICT');
  };
  await h.controller.save();
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0]!.expectedRevision, 2);
  assert.equal(h.journal.read(h.actor), null);
  assert.match(h.view.error, /其他设备更新/);
  assert.equal(h.view.ready, false);
  await h.controller.save();
  assert.equal(h.commands.length, 1);
  h.controller.dispose();
});
test('hide, app lifecycle, unload and account replacement clear rendered private state; late callbacks ignored', async () => {
  const h = harness();
  await h.controller.load(h.route);
  const later = deferred<Receipt>();
  let sent: Command | undefined;
  h.gateway.command = async (original) => {
    sent = original;
    return later.promise;
  };
  const saving = h.controller.save();
  await flush();
  assert.ok(sent);
  assert.ok(h.journal.read(h.actor));
  h.visibility.clear();
  assert.equal(h.view.entryForm.name, '');
  assert.equal(h.view.term, null);
  later.resolve(receipt(sent!));
  await saving;
  assert.equal(h.view.message, '');
  assert.ok(h.journal.read(h.actor));
  h.controller.dispose();
  const account = harness();
  await account.controller.load(account.route);
  account.sessions.logout();
  assert.equal(account.view.entryForm.note, '');
  assert.equal(account.view.term, null);
  assert.deepEqual(account.view.terms, []);
  account.controller.dispose();
  const read = harness();
  const waiting = deferred<Detail>();
  read.gateway.detail = async () => waiting.promise;
  const loading = read.controller.load(read.route);
  await flush();
  read.controller.dispose();
  waiting.resolve(detail);
  await loading;
  assert.deepEqual(read.view, initialTimetableView('entry'));
});
test('date shift requires explicit confirmation; editing invalidates the old confirmation', async () => {
  const h = harness('term');
  await h.controller.load(h.route);
  h.controller.setTerm('weekOneMonday', '2026-09-14');
  await h.controller.save();
  assert.equal(h.commands.length, 0);
  assert.match(h.view.dateShiftPrompt, /所有课程日期/);
  h.controller.setTerm('name', '修改名称');
  await h.controller.confirmDateShift();
  assert.equal(h.commands.length, 0);
  await h.controller.save();
  await h.controller.confirmDateShift();
  assert.equal(h.commands.length, 1);
  assert.equal(
    (h.commands[0]!.payload as TermFields).weekOneMonday,
    '2026-09-14',
  );
  h.controller.dispose();
});
test('term delete requires exact typed name and preserves backend shrinking rejection', async () => {
  const h = harness('term');
  await h.controller.load(h.route);
  h.controller.beginDelete();
  h.controller.setDeleteText('秋季');
  await h.controller.confirmDelete();
  assert.equal(h.commands.length, 0);
  h.controller.setDeleteText(term.name);
  await h.controller.confirmDelete();
  assert.equal(h.commands[0]!.operation, 'term.delete');
  assert.deepEqual(h.commands[0]!.payload, {});
  h.controller.dispose();
  const shrink = harness('term');
  await shrink.controller.load(shrink.route);
  shrink.controller.setTerm('weekCount', '2');
  shrink.gateway.command = async (original) => {
    shrink.commands.push(original);
    return receipt(original, 'rejected', 'TIMETABLE_WEEKS_OUT_OF_RANGE');
  };
  await shrink.controller.save();
  assert.equal((shrink.commands[0]!.payload as TermFields).weekCount, 2);
  assert.match(shrink.view.error, /不会自动裁剪/);
  shrink.controller.dispose();
});
test('duplicate is a new entry and warns about conflicts without prohibiting save', async () => {
  const h = harness();
  await h.controller.load({ ...h.route, duplicate: true });
  assert.equal(h.view.duplicate, true);
  assert.match(h.view.conflictWarning, /仍可保存/);
  await h.controller.save();
  assert.equal(h.commands[0]!.operation, 'entry.create');
  assert.notEqual(h.commands[0]!.entryId, entry.entryId);
  assert.equal(h.commands[0]!.payload.name, entry.name);
  h.controller.dispose();
});
test('routes contain identifiers only; outside-term current date is never clamped', async () => {
  assert.throws(() => parseRoute('agenda', { name: '私密课程' }));
  assert.throws(() => parseRoute('entry', { termId: id(1), duplicate: '1' }));
  assert.throws(() => parseRoute('term', { termId: '../evil' }));
  const h = harness('agenda');
  h.gateway.detail = async () => ({
    term: { ...term, weekOneMonday: '2026-10-05' },
    entries: [],
  });
  await h.controller.load(h.route);
  assert.equal(h.view.currentWeek, null);
  assert.match(h.view.currentLabel, /不在学期内/);
  assert.equal(h.view.week, 1);
  assert.match(
    h.controller.path('newEntry')!,
    /^\/pages\/personal-timetable-entry\/personal-timetable-entry\?termId=[0-9a-f-]+$/,
  );
  h.controller.dispose();
});
test('HTTP gateway sends account-required exact bodies, no text queries, no automatic write auth replay', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient('https://timetable.example', transport, sessions, {
    refresh: async () => {
      refreshes++;
      return sessions.snapshot();
    },
  } as never);
  const gateway = new HttpTimetableGateway(api),
    cancel = new Cancellation(),
    original = command();
  transport.reply({ terms: [term] });
  await gateway.terms(cancel);
  transport.reply(detail);
  await gateway.detail(term.termId, cancel);
  transport.reply(receipt(original));
  await gateway.command(original, cancel);
  transport.reply({ status: 'unknown', requestId: original.requestId });
  await gateway.recover(original.requestId, cancel);
  transport.reply(receipt(original, 'cancelled'));
  await gateway.cancel(original, cancel);
  assert.deepEqual(
    transport.requests.map((request) => request.method),
    ['GET', 'GET', 'POST', 'GET', 'POST'],
  );
  assert.deepEqual(transport.requests[2]!.body, original);
  assert.deepEqual(transport.requests[4]!.body, original);
  assert.ok(
    transport.requests.every(
      (request) => !request.url.includes('?') && request.headers.Authorization,
    ),
  );
  transport.reply(
    { error: { code: 'AUTH_ACCESS_EXPIRED', message: 'expired' } },
    401,
  );
  await assert.rejects(() => gateway.command(original, cancel));
  assert.equal(refreshes, 0);
});

const nativeRequire = createRequire(__filename),
  src = path.join(__dirname, '../src');
const { createNativePressBridge } = nativeRequire(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: object): {
    capture(
      handler: string,
      dataset?: Record<string, string>,
    ): { press(): boolean; detach(): void };
    hide(): void;
  };
};
test('actual F7 button → registered page handler → controller writes once; navigation failures remain recoverable', async () => {
  const h = harness('term');
  const page = {
    ...timetablePage('term'),
    data: { ...timetablePage('term').data },
    setData(patch: object) {
      Object.assign(this.data, patch);
    },
  };
  page.controller = h.controller;
  await h.controller.load(h.route);
  Object.assign(page.data, h.view);
  h.controller.setTerm('name', '原生按钮学期');
  Object.assign(page.data, h.view);
  const bridge = createNativePressBridge({
    page,
    pageFile: path.join(
      src,
      'pages/personal-timetable-term/personal-timetable-term',
    ),
    dist: src,
    extension: 'ts',
  });
  const button = bridge.capture('onSave');
  assert.equal(button.press(), true);
  assert.equal(button.press(), true);
  await flush();
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0]!.payload.name, '原生按钮学期');
  button.detach();
  let navigations = 0;
  page.navigator = new DirectoryNavigator(
    {
      navigateTo(options) {
        navigations++;
        options.fail(new Error('native route failed'));
      },
    },
    () => h.controller.navigationFailed(),
  );
  page.onNavigate({ currentTarget: { dataset: { target: 'agenda' } } });
  assert.equal(navigations, 1);
  assert.match(h.view.error, /数据未改变/);
  page.onHide();
  assert.deepEqual(page.data.termForm, {
    name: '',
    weekOneMonday: '',
    weekCount: '20',
  });
});
test('actual F7 Input input/clear event reaches the page-owned term form; hidden input cannot emit', async () => {
  const h = harness('term');
  await h.controller.load(h.route);
  const page = { ...timetablePage('term'), setData() {} };
  page.controller = h.controller;
  let component:
    | {
        properties: Record<string, { value: unknown }>;
        data: object;
        methods: Record<string, (...args: unknown[]) => void>;
        lifetimes: Record<string, () => void>;
        pageLifetimes: Record<string, () => void>;
      }
    | undefined;
  const previous = globalThis.Component;
  globalThis.Component = ((value: unknown) => {
    component = value as typeof component;
  }) as typeof Component;
  try {
    delete nativeRequire.cache[
      nativeRequire.resolve('../src/components/f7-input/f7-input.ts')
    ];
    nativeRequire('../src/components/f7-input/f7-input.ts');
  } finally {
    globalThis.Component = previous;
  }
  assert.ok(component);
  const native = {
    properties: {
      ...Object.fromEntries(
        Object.entries(component.properties).map(([key, property]) => [
          key,
          property.value,
        ]),
      ),
      clearable: true,
      value: '名称',
    },
    data: { ...component.data },
    setData(patch: object) {
      Object.assign(this.data, patch);
    },
    triggerEvent(type: string, event: { value: string }) {
      if (type === 'input')
        page.onTerm({
          currentTarget: { dataset: { field: 'name' } },
          detail: event,
        });
    },
    ...component.methods,
  };
  component.lifetimes.attached!.call(native);
  component.methods.onInput!.call(native, {
    detail: { value: '真实组件输入', cursor: 6 },
  });
  assert.equal(h.view.termForm.name, '真实组件输入');
  component.pageLifetimes.hide!.call(native);
  component.methods.onInput!.call(native, { detail: { value: '隐藏事件' } });
  assert.equal(h.view.termForm.name, '真实组件输入');
  h.controller.dispose();
});
test('page sources are native-only and privacy recovery is not replaced by a local fake', () => {
  for (const name of [
    'personal-timetable',
    'personal-timetable-term',
    'personal-timetable-entry',
  ]) {
    const source = readFileSync(
      path.join(src, `pages/${name}/${name}.wxml`),
      'utf8',
    );
    assert.match(source, /wu-f7-button/);
    assert.doesNotMatch(source, /web-view|教务密码|导入成绩|订阅通知/);
  }
  const runtime = readFileSync(
    path.join(src, 'personal-timetable/runtime.ts'),
    'utf8',
  );
  assert.match(runtime, /import type \{ WhaleuApp \}/);
  assert.doesNotMatch(runtime, /from ['"].*community\/runtime/);
});
test('terminal access errors scrub already loaded schedule and forms while preserving durable original recovery', async () => {
  for (const error of [
    new ClientError('auth-expired', 'expired'),
    new ClientError('forbidden', 'blocked', { serverCode: 'ACCOUNT_BLOCKED' }),
    new ClientError('forbidden', 'suspended', {
      serverCode: 'SAFETY_ACCESS_SUSPENDED',
    }),
  ]) {
    const h = harness();
    await h.controller.load(h.route);
    assert.equal(h.view.entryForm.name, entry.name);
    h.gateway.command = async () => {
      throw error;
    };
    await h.controller.save();
    assert.ok(h.journal.read(h.actor));
    assert.equal(h.view.pending, true);
    assert.equal(h.view.term, null);
    assert.deepEqual(h.view.terms, []);
    assert.equal(h.view.entryForm.name, '');
    assert.equal(h.view.entryForm.note, '');
    assert.equal(h.view.termForm.name, '');
    assert.deepEqual(h.view.days, []);
    assert.match(h.view.error, /访问状态已失效/);
    h.controller.dispose();
  }
});
test('hide or account switch before queued work invokes no journal or gateway work', async () => {
  const h = harness();
  const loading = h.controller.load(h.route);
  h.controller.hide();
  await loading;
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.view, initialTimetableView('entry'));
  const other = harness();
  const queued = other.controller.load(other.route);
  other.sessions.logout();
  await queued;
  assert.deepEqual(other.calls, []);
  assert.deepEqual(other.view, initialTimetableView('entry'));
  h.controller.dispose();
  other.controller.dispose();
});
test('guest gets an explicit native login route without reading journals or invoking any provider', async () => {
  const h = harness();
  h.journal.write(h.actor, command());
  h.sessions.logout();
  await h.controller.load(h.route);
  assert.equal(h.view.authenticated, false);
  assert.equal(h.view.pending, false);
  assert.equal(h.view.requestId, '');
  assert.deepEqual(h.calls, []);
  const template = readFileSync(
    path.join(src, 'personal-timetable/recovery.wxml'),
    'utf8',
  );
  assert.match(
    template,
    /<navigator wx:if="{{!authenticated}}" url="\/pages\/login\/login"/,
  );
  for (const name of [
    'personal-timetable',
    'personal-timetable-term',
    'personal-timetable-entry',
  ])
    assert.match(
      readFileSync(path.join(src, `pages/${name}/${name}.wxml`), 'utf8'),
      /mode,authenticated/,
    );
  h.controller.dispose();
});
test('cancelled receipt with a revision is malformed and cannot clear the original journal', async () => {
  const h = harness();
  const original = command();
  h.journal.write(h.actor, original);
  const malformed: Receipt = {
    ...receipt(original, 'cancelled'),
    resultingRevision: original.expectedRevision,
  };
  assert.throws(() => decodeReceipt(malformed));
  assert.throws(() => matchReceipt(original, malformed));
  h.gateway.recover = async () => ({ status: 'settled', receipt: malformed });
  await h.controller.load(h.route);
  await h.controller.recover();
  assert.equal(h.view.pending, true);
  assert.ok(h.journal.read(h.actor));
  h.controller.dispose();
});
