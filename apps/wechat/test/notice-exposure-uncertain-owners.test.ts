import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import { StudentNoticesReader } from '../src/notifications/student-notices';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import { setup, requestId } from './community-helpers';
import { deferred, flush } from './helpers';
import { FakeRatingUpdatesGateway, notice } from './ratings-r2a-helpers';

function fixture(kind: 'verification' | 'rating') {
  const h = setup();
  const runtime = {
    ...h.runtime,
    safetyChanges: new SafetyChanges(),
    browsingScopeChanges: new PrivateViewLifecycle(),
    directoryScopeChanges: new PrivateViewLifecycle(),
  };
  let reject = new ClientError('network', 'Unknown');
  let blocked: ReturnType<typeof deferred<never>> | undefined;
  let writes = 0;
  const rows = [
    {
      id: requestId,
      kind: 'auth_result' as const,
      outcome: 'approved' as const,
      createdAt: '2026-10-01T00:00:00.000Z',
      read: false,
      available: true,
    },
  ];
  let view:
    | {
        items: readonly unknown[];
        loaded: boolean;
        error: string;
        status: string;
        busy: boolean;
        unreadCount?: number | null;
      }
    | undefined;
  const accept = (next: NonNullable<typeof view>) => {
    view = next;
  };
  const fail = async () => {
    writes++;
    if (blocked) return blocked.promise;
    throw reject;
  };
  const gateway = new FakeRatingUpdatesGateway();
  gateway.listImpl = async () => ({
    items: [notice({ noticeId: requestId })],
    nextCursor: null,
    unreadCount: 9,
  });
  gateway.markReadImpl = fail;
  const reader =
    kind === 'verification'
      ? new StudentNoticesReader(
          runtime,
          {
            request: async (endpoint: { method: string }) =>
              endpoint.method === 'GET'
                ? { items: rows, page: 1, hasNext: false }
                : fail(),
          } as unknown as ApiClient,
          accept,
        )
      : new RatingUpdatesController(
          { ...runtime, ratingUpdates: gateway },
          accept,
          async () => undefined,
        );
  return {
    ...h,
    runtime,
    reader,
    view: () => view!,
    writes: () => writes,
    async load() {
      if (reader instanceof RatingUpdatesController)
        await reader.selectCategory('reply');
      else await reader.load();
    },
    error(error: ClientError) {
      reject = error;
    },
    pending() {
      blocked = deferred<never>();
      return blocked;
    },
  };
}
for (const kind of ['verification', 'rating'] as const) {
  test(`${kind}: guarded unknown keeps exact source snapshot, conservative count, manual default remains clearing`, async () => {
    const h = fixture(kind);
    try {
      await h.load();
      const items = h.view().items;
      await h.reader.acknowledge(requestId, () => true);
      assert.equal(h.view().items, items);
      assert.equal(h.view().loaded, true);
      assert.match(h.view().error, /未确认/);
      if (kind === 'rating')
        assert.equal((h.view() as RatingUpdatesView).unreadCount, null);
      await h.reader.acknowledge(requestId);
      assert.equal(h.writes(), 2);
      assert.equal(h.view().loaded, false);
      assert.deepEqual(h.view().items, []);
    } finally {
      h.reader.dispose();
    }
  });
  for (const boundary of [
    'private',
    'browse',
    'directory',
    'safety',
    'logout',
    'cancel',
    'dispose',
    'reload',
  ] as const)
    test(`${kind}: guarded unknown cannot restore a ${boundary}-invalidated snapshot`, async () => {
      const h = fixture(kind);
      try {
        await h.load();
        const before = h.view().items;
        const pending = h.pending();
        const action = h.reader.acknowledge(requestId, () => true);
        await flush();
        assert.equal(h.writes(), 1);
        if (boundary === 'private') h.runtime.privateViews!.clear(h.accountId);
        else if (boundary === 'browse')
          h.runtime.browsingScopeChanges.clear(h.accountId);
        else if (boundary === 'directory')
          h.runtime.directoryScopeChanges.clear(h.accountId);
        else if (boundary === 'safety')
          h.runtime.safetyChanges.invalidate(h.accountId);
        else if (boundary === 'logout') h.sessions.logout();
        else if (boundary === 'cancel') h.reader.cancel();
        else if (boundary === 'dispose') h.reader.dispose();
        else await h.load();
        await flush();
        const fresh = h.view().items;
        pending.reject(new ClientError('network', 'Late unknown result'));
        await action;
        if (boundary === 'safety' || boundary === 'reload') {
          assert.notEqual(fresh, before);
          assert.equal(
            h.view().items,
            fresh,
            'fresh authority result must win over old exposure',
          );
        } else {
          assert.equal(h.view().loaded, false);
          assert.deepEqual(h.view().items, []);
        }
      } finally {
        h.reader.dispose();
      }
    });
}

test('verification: same-array changed content cannot inherit an earlier exposure outcome', async () => {
  const h = fixture('verification');
  try {
    await h.load();
    const pending = h.pending();
    const action = h.reader.acknowledge(requestId, () => true);
    await flush();
    (h.view().items[0] as { outcome: string }).outcome = 'rejected';
    pending.reject(
      new ClientError('network', 'Unknown result for old content'),
    );
    await action;
    assert.equal(h.view().loaded, false);
    assert.deepEqual(h.view().items, []);
  } finally {
    h.reader.dispose();
  }
});
