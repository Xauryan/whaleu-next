import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../src/api/client';
import { StudentNoticesReader } from '../src/notifications/student-notices';
import { setup } from './community-helpers';
import { deferred, flush } from './helpers';
const id = '77777777-7777-4777-8777-777777777777';
const item = {
  id,
  kind: 'auth_result',
  outcome: 'approved',
  createdAt: '2026-10-01T00:00:00.000Z',
  read: false,
  available: true,
};
test('verification list and explicit read retain owner response authority rather than guessing read success', async () => {
  const h = setup();
  const methods: string[] = [];
  const api = {
    async request(spec: { method: string }) {
      methods.push(spec.method);
      return spec.method === 'GET'
        ? { items: [item], page: 1, hasNext: false }
        : { status: 'unavailable', target: null };
    },
  } as unknown as ApiClient;
  let items: readonly { read: boolean }[] = [];
  const reader = new StudentNoticesReader(h.runtime, api, (view) => {
    items = view.items;
  });
  await reader.load();
  assert.deepEqual(methods, ['GET']);
  await reader.acknowledge(id);
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.equal(items[0]?.read, false);
  reader.dispose();
});
test('verification navigation is rejected after owner replacement during target resolution', async () => {
  const h = setup();
  const target = deferred<unknown>();
  const api = {
    async request(spec: { path: string }) {
      return spec.path.endsWith('/target')
        ? target.promise
        : { items: [item], page: 1, hasNext: false };
    },
  } as unknown as ApiClient;
  const reader = new StudentNoticesReader(h.runtime, api, () => undefined);
  await reader.load();
  const opened: string[] = [];
  const opening = reader.open(id, async (url) => {
    opened.push(url);
  });
  await flush();
  h.sessions.logout();
  target.resolve({
    status: 'available',
    target: { applicationId: id, regionId: null },
  });
  await opening;
  assert.deepEqual(opened, []);
  reader.dispose();
});
