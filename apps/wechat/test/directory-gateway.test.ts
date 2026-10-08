import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpDirectoryGateway } from '../src/directory/gateway';
import { Cancellation } from '../src/platform/contracts';
import { SessionStore } from '../src/auth/session';
import { ScriptedTransport, signedIn } from './helpers';
import {
  directoryCategory,
  directoryCategoryId,
  directoryDetail,
  directoryEntry,
  directoryEntryId,
  directoryListRoute,
  directoryOtherRegion,
  directoryRegion,
  directoryToken,
} from './directory-helpers';
function harness(loggedIn = true) {
  const transport = new ScriptedTransport(),
    sessions = loggedIn ? signedIn() : new SessionStore();
  return {
    transport,
    sessions,
    gateway: new HttpDirectoryGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => {
          throw new Error('Unexpected refresh');
        },
      }),
    ),
  };
}
test('directory context/category/list/search/detail are required-auth GETs with no body and exact routes', async () => {
  const h = harness(),
    cancel = new Cancellation();
  h.transport.reply({ regionId: directoryRegion });
  await h.gateway.context(cancel);
  h.transport.reply({
    items: [directoryCategory()],
    continuation: 'end',
    nextCursor: null,
  });
  await h.gateway.categories(directoryRegion, 'org', null, cancel);
  h.transport.reply({
    items: [directoryEntry()],
    continuation: 'end',
    nextCursor: null,
  });
  await h.gateway.entries(
    { ...directoryListRoute, q: '  名称%_\\  ' },
    null,
    cancel,
  );
  h.transport.reply(directoryDetail());
  await h.gateway.detail(directoryRegion, directoryEntryId, cancel);
  const urls = h.transport.requests.map((request) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    assert.match(request.headers.Authorization!, /^Bearer /);
    return new URL(request.url);
  });
  assert.equal(urls[0]!.pathname, '/v1/directory/context');
  assert.equal(
    urls[1]!.pathname,
    `/v1/directory/regions/${directoryRegion}/categories`,
  );
  assert.equal(urls[1]!.searchParams.get('kind'), 'org');
  assert.equal(urls[2]!.searchParams.get('q'), '名称%_\\');
  assert.equal(urls[2]!.searchParams.get('categoryId'), directoryCategoryId);
  assert.equal(urls[2]!.searchParams.get('limit'), '20');
  assert.equal(
    urls[3]!.pathname,
    `/v1/directory/regions/${directoryRegion}/entries/${directoryEntryId}`,
  );
  assert.equal(urls[3]!.search, '');
});
test('guest or cancelled reads never dispatch; malformed targets and cursor bounds reject locally', async () => {
  const h = harness(false),
    cancel = new Cancellation();
  await assert.rejects(h.gateway.context(cancel));
  assert.equal(h.transport.requests.length, 0);
  const valid = harness();
  cancel.cancel();
  await assert.rejects(valid.gateway.context(cancel));
  assert.equal(valid.transport.requests.length, 0);
  for (const limit of [0, 51, 1.5])
    await assert.rejects(
      valid.gateway.categories(
        directoryRegion,
        'org',
        null,
        new Cancellation(),
        limit,
      ),
    );
  await assert.rejects(
    valid.gateway.detail('../escape', directoryEntryId, new Cancellation()),
  );
  await assert.rejects(
    valid.gateway.entries(directoryListRoute, 'bad', new Cancellation()),
  );
  assert.equal(valid.transport.requests.length, 0);
});
test('gateway rejects wrong target/kind/category, cursor loops and short more pages', async () => {
  const h = harness(),
    cancel = new Cancellation();
  h.transport.reply({
    items: [directoryCategory({ kind: 'school' })],
    continuation: 'end',
    nextCursor: null,
  });
  await assert.rejects(
    h.gateway.categories(directoryRegion, 'org', null, cancel),
  );
  h.transport.reply({
    items: [directoryEntry({ categoryId: directoryOtherRegion })],
    continuation: 'end',
    nextCursor: null,
  });
  await assert.rejects(h.gateway.entries(directoryListRoute, null, cancel));
  h.transport.reply({ ...directoryDetail(), id: directoryOtherRegion });
  await assert.rejects(
    h.gateway.detail(directoryRegion, directoryEntryId, cancel),
  );
  h.transport.reply({
    items: [directoryEntry()],
    continuation: 'more',
    nextCursor: directoryToken(),
  });
  await assert.rejects(h.gateway.entries(directoryListRoute, null, cancel));
  h.transport.reply({
    items: [directoryEntry()],
    continuation: 'more',
    nextCursor: directoryToken(),
  });
  await assert.rejects(
    h.gateway.entries(directoryListRoute, directoryToken(), cancel, 1),
  );
});
test('directory gateway accepts full 50-row page without a hidden total cap or client sorting', async () => {
  const h = harness();
  const items = Array.from({ length: 50 }, (_, index) =>
    directoryEntry({
      id: `00000000-0000-4000-8000-${String(50 - index).padStart(12, '0')}`,
    }),
  );
  h.transport.reply({
    items,
    continuation: 'more',
    nextCursor: directoryToken(),
  });
  assert.deepEqual(
    (
      await h.gateway.entries(directoryListRoute, null, new Cancellation(), 50)
    ).items.map((item) => item.id),
    items.map((item) => item.id),
  );
});
