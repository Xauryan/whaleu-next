import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NoticeSendersController,
  type NoticeSenderSnapshot,
} from '../src/notifications/senders';
import {
  systemNoticesSetup,
  systemNotice,
  systemNotices,
} from './system-notices-helpers';
import type { SystemNoticesList } from '../src/community/system-notices-contract';
import { deferred, flush } from './helpers';
function harness(loggedIn = true) {
  const s = systemNoticesSetup(loggedIn);
  let rows: readonly NoticeSenderSnapshot[] = [];
  const controller = new NoticeSendersController(s.runtime, (next) => {
    rows = next;
  });
  return { ...s, controller, rows: () => rows };
}
test('sender snapshots use actual owner latest time/count without acknowledging any message', async () => {
  const h = harness();
  h.notices.listImpl = async () =>
    systemNotices(
      [
        systemNotice({ createdAt: '2026-01-01T00:00:00.000Z' }),
        systemNotice({
          noticeId: '77777777-7777-4777-8777-777777777777',
          createdAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
      null,
      7,
    );
  await h.controller.load();
  const system = h.rows().find((row) => row.kind === 'system')!;
  assert.equal(system.name, '系统消息');
  assert.equal(system.latest?.createdAt, '2026-02-01T00:00:00.000Z');
  assert.equal(system.latest?.summary, '帖子陪审结果已更新');
  assert.equal(system.unreadCount, null);
  assert.equal(system.hasUnread, true);
  assert.ok(h.notices.calls.every((call) => call.method === 'list'));
  assert.equal(
    h.rows().some((row) => row.kind === 'activity'),
    false,
  );
  h.controller.dispose();
});
test('unavailable/guest sender is not an empty history or fabricated zero unread', async () => {
  const h = harness(false);
  await h.controller.load();
  assert.deepEqual(h.rows(), []);
  assert.equal(h.notices.calls.length, 0);
  h.controller.dispose();
});
test('source snapshots clear on account replacement, disposal and late response', async () => {
  const h = harness();
  const pending = deferred<SystemNoticesList>();
  h.notices.listImpl = () => pending.promise;
  const loading = h.controller.load();
  await flush();
  h.sessions.logout();
  pending.resolve(systemNotices());
  await loading;
  assert.deepEqual(h.rows(), []);
  h.controller.dispose();
  await h.controller.load();
  assert.deepEqual(h.rows(), []);
});
test('private reasons and identities never become a sender list preview', async () => {
  const h = harness();
  h.notices.listImpl = async () =>
    systemNotices([
      {
        noticeId: '77777777-7777-4777-8777-777777777777',
        kind: 'account_appeal_decided',
        createdAt: '2026-02-01T00:00:00.000Z',
        readAt: null,
        appealId: '88888888-8888-4888-8888-888888888888',
        outcome: 'upheld',
        reason: 'private appeal details',
      },
    ]);
  await h.controller.load();
  assert.equal(h.rows()[0]!.latest?.summary, '申诉处理结果已更新');
  assert.equal(
    JSON.stringify(h.rows()).includes('private appeal details'),
    false,
  );
  h.controller.dispose();
});

test('community interactions are not duplicated as a system sender', async () => {
  const h = harness();
  await h.controller.load();
  assert.deepEqual(
    h.rows().map((row) => row.kind),
    ['system'],
  );
  assert.equal(h.rows()[0]?.unreadCount, null);
  assert.ok(
    h.gateway.calls.every(
      (call) => call.method !== 'updates' && call.method !== 'readUpdate',
    ),
  );
  h.controller.dispose();
});
