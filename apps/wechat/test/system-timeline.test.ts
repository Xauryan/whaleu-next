import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SystemTimelineController,
  type SystemTimelineView,
} from '../src/notifications/system-timeline';
import {
  systemNoticesSetup,
  systemNotice,
  systemNotices,
} from './system-notices-helpers';
import type { ErrandNoticesGateway } from '../src/errands/notices';
import { deferred, flush } from './helpers';
import type { SystemNoticesList } from '../src/community/system-notices-contract';
const id = '77777777-7777-4777-8777-777777777777';
test('system timeline namespaces colliding owner ids and acknowledges only the selected source', async () => {
  const h = systemNoticesSetup();
  const reads: string[] = [];
  const errand: ErrandNoticesGateway = {
    async list() {
      return {
        items: [
          {
            noticeId: id,
            kind: 'completed',
            orderId: id,
            createdAt: '2026-10-01T00:00:00.000Z',
            readAt: null,
          },
        ],
        nextCursor: null,
        unreadCount: 1,
      };
    },
    async read(noticeId) {
      reads.push(noticeId);
      return { noticeId, readAt: '2026-10-02T00:00:00.000Z', unreadCount: 0 };
    },
    async unread() {
      return { unreadCount: 1 };
    },
  };
  h.notices.listImpl = async () =>
    systemNotices([
      systemNotice({ noticeId: id, createdAt: '2026-10-01T00:00:00.000Z' }),
    ]);
  let view: SystemTimelineView | undefined;
  const controller = new SystemTimelineController(
    { ...h.runtime, errandNotices: errand },
    (next) => {
      view = next;
    },
  );
  await controller.load();
  assert.deepEqual(
    view!.items.map((item) => item.key),
    [`errand:${id}`, `system:${id}`],
  );
  assert.equal(view!.unreadCount, null);
  assert.deepEqual(reads, []);
  await controller.acknowledge(`errand:${id}`);
  assert.deepEqual(reads, [id]);
  assert.ok(h.notices.calls.every((call) => call.method !== 'read'));
  assert.equal(
    view!.items.find((item) => item.source === 'system')!.readAt,
    null,
  );
  await controller.acknowledge(id);
  assert.deepEqual(reads, [id]);
  controller.dispose();
  assert.deepEqual(view!.items, []);
});
test('system aggregation clears every source before logout callbacks and rejects late reads', async () => {
  const h = systemNoticesSetup();
  const pending = deferred<SystemNoticesList>();
  h.notices.listImpl = () => pending.promise;
  const snapshots: SystemTimelineView[] = [];
  const controller = new SystemTimelineController(h.runtime, (view) =>
    snapshots.push(view),
  );
  const loading = controller.load();
  await flush();
  h.sessions.logout();
  const boundary = snapshots.length;
  pending.resolve(systemNotices());
  await loading;
  assert.ok(snapshots.slice(boundary).every((view) => view.items.length === 0));
  assert.deepEqual(controller.snapshot().items, []);
  controller.dispose();
});

test('known owner unread beyond the loaded page remains a dot without a fabricated combined count', async () => {
  const h = systemNoticesSetup();
  h.notices.listImpl = async () =>
    systemNotices(
      [systemNotice({ readAt: '2026-10-02T00:00:00.000Z' })],
      null,
      7,
    );
  const controller = new SystemTimelineController(h.runtime, () => undefined);
  await controller.load();
  assert.equal(controller.snapshot().hasUnread, true);
  assert.equal(controller.snapshot().unreadCount, null);
  controller.dispose();
});

test('repeated read cannot hide the first action failure while owner transport is pending', async () => {
  const h = systemNoticesSetup();
  const pending = deferred<never>();
  h.notices.readImpl = () => pending.promise;
  const controller = new SystemTimelineController(h.runtime, () => undefined);
  await controller.load();
  const key = controller.snapshot().items[0]!.key;
  const first = controller.acknowledge(key);
  await flush();
  await controller.acknowledge(key);
  pending.reject(new Error('connection lost'));
  await first;
  assert.ok(controller.snapshot().error);
  assert.equal(
    h.notices.calls.filter((call) => call.method === 'read').length,
    1,
  );
  controller.dispose();
});
