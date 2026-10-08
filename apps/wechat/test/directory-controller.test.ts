import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type {
  DirectoryContext,
  DirectoryPage,
  DirectoryEntry,
} from '../src/directory/contract';
import {
  directoryCategoryId,
  directoryDetail,
  directoryDetailRoute,
  directoryEntry,
  directoryEntryId,
  directoryHarness,
  directoryListRoute,
  directoryOtherRegion,
  directoryRegion,
  directoryToken,
} from './directory-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const error = (serverCode: string) =>
  new ClientError('forbidden', 'Synthetic denial', { serverCode });
test('hub uses directory context only and preserves all kinds and current category navigation', async () => {
  const h = directoryHarness('hub');
  for (const kind of ['school', 'org', 'official']) {
    await h.controller.load({ kind });
    assert.equal(h.view().regionId, directoryRegion);
    assert.equal(h.view().categories[0]!.kind, kind);
    assert.equal(
      h.controller.categoryPath(directoryCategoryId),
      `/pages/directory-list/directory-list?regionId=${directoryRegion}&kind=${kind}&categoryId=${directoryCategoryId}`,
    );
    assert.equal(
      h.controller.searchPath(),
      `/pages/directory-list/directory-list?regionId=${directoryRegion}&kind=${kind}`,
    );
    assert.equal(h.controller.categoryPath(directoryOtherRegion), null);
  }
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ['context', 'categories', 'context', 'categories', 'context', 'categories'],
  );
  h.controller.dispose();
});
test('every page starts with actual identity context; foreign routes cannot call entry APIs', async () => {
  for (const mode of ['list', 'detail'] as const) {
    const h = directoryHarness(mode);
    await h.controller.load({
      ...(mode === 'list' ? directoryListRoute : directoryDetailRoute),
      regionId: directoryOtherRegion,
    });
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ['context'],
    );
    assert.equal(h.view().loaded, false);
    assert.match(h.view().error, /身份校区/);
    h.controller.dispose();
  }
});
test('missing or malformed routes settle explicitly; login required does not dispatch a guest read', async () => {
  for (const mode of ['list', 'detail'] as const) {
    const h = directoryHarness(mode);
    await h.controller.load({});
    assert.equal(h.view().busy, false);
    assert.match(h.view().error, /入口/);
    assert.equal(h.calls.length, 0);
    h.controller.dispose();
  }
  const h = directoryHarness('hub', false);
  await h.controller.load({});
  assert.equal(h.calls.length, 0);
  assert.match(h.view().error, /登录/);
  h.controller.dispose();
});
test('empty, no matches, unavailable and expired pagination remain distinct and clear old content', async () => {
  const h = directoryHarness();
  await h.controller.load(directoryListRoute);
  assert.equal(h.view().entries.length, 1);
  h.behavior.entries = async () => ({
    items: [],
    continuation: 'end',
    nextCursor: null,
  });
  await h.controller.refresh();
  assert.equal(h.view().loaded, true);
  assert.match(h.view().status, /暂无条目/);
  h.controller.setInput('没有');
  await h.controller.submit();
  assert.match(h.view().status, /没有匹配/);
  h.behavior.entries = async () => {
    throw error('DIRECTORY_UNAVAILABLE');
  };
  await h.controller.refresh();
  assert.equal(h.view().loaded, false);
  assert.match(h.view().error, /不代表目录为空/);
  h.behavior.entries = async () => {
    throw error('DISCOVERY_RESTART_REQUIRED');
  };
  await h.controller.refresh();
  assert.equal(h.view().restartRequired, true);
  assert.equal(h.view().entries.length, 0);
  assert.equal(h.view().canNext, false);
  h.controller.dispose();
});
test('draft editing does not change submitted query used for fresh Next/Previous; forward branch discards', async () => {
  const h = directoryHarness();
  h.behavior.entries = async (_intent, cursor) => ({
    items: [directoryEntry()],
    continuation: cursor === directoryToken(2) ? 'end' : 'more',
    nextCursor:
      cursor === null
        ? directoryToken(1)
        : cursor === directoryToken(1)
          ? directoryToken(2)
          : null,
  });
  await h.controller.load(directoryListRoute);
  h.controller.setInput('  已提交  ');
  await h.controller.submit();
  h.controller.setInput('还没提交');
  await h.controller.next();
  await h.controller.next();
  assert.equal(h.view().pageNumber, 3);
  await h.controller.previous();
  assert.equal(h.view().pageNumber, 2);
  assert.equal(h.view().inputDraft, '还没提交');
  const calls = h.calls.filter((call) => call.method === 'entries');
  assert.equal((calls.slice(-1)[0]!.args[0] as { q: string }).q, '已提交');
  assert.equal(calls.slice(-1)[0]!.args[1], directoryToken(1));
  await h.controller.previous();
  assert.equal(h.view().pageNumber, 1);
  assert.equal(h.view().canPrevious, false);
  await h.controller.clearSearch();
  assert.equal(h.view().submittedQuery, '');
  assert.equal(
    (
      h.calls.filter((call) => call.method === 'entries').slice(-1)[0]!
        .args[0] as { q?: string }
    ).q,
    undefined,
  );
  h.controller.dispose();
});
test('cross-category search waits for explicit submission and clear returns to input-only state', async () => {
  const h = directoryHarness();
  await h.controller.load({ regionId: directoryRegion, kind: 'org' });
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ['context'],
  );
  assert.match(h.view().status, /请输入/);
  h.controller.setInput('社团');
  await h.controller.submit();
  assert.equal(h.view().loaded, true);
  await h.controller.clearSearch();
  assert.equal(h.view().loaded, false);
  assert.equal(h.view().entries.length, 0);
  assert.match(h.view().status, /请输入/);
  h.controller.dispose();
});
test('slow repeated Next taps coalesce; cancelled/late response cannot restore rows or cursors', async () => {
  const h = directoryHarness();
  h.behavior.entries = async () => ({
    items: [directoryEntry()],
    continuation: 'more',
    nextCursor: directoryToken(),
  });
  await h.controller.load(directoryListRoute);
  const pending = deferred<DirectoryPage<DirectoryEntry>>();
  h.behavior.entries = async () => pending.promise;
  const first = h.controller.next();
  const second = h.controller.next();
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'entries').length, 2);
  assert.equal(h.view().entries.length, 0);
  const last = h.calls.slice(-1)[0]!;
  h.controller.cancel();
  assert.equal((last.args[2] as { isCancelled: boolean }).isCancelled, true);
  pending.resolve({
    items: [directoryEntry()],
    continuation: 'end',
    nextCursor: null,
  });
  await Promise.all([first, second]);
  assert.equal(h.view().loaded, false);
  assert.equal(h.view().canNext, false);
  h.controller.dispose();
});
test('replacement search owns generation even when an old context ignores cancellation', async () => {
  const h = directoryHarness();
  const old = deferred<DirectoryContext>();
  let count = 0;
  h.behavior.context = async () =>
    ++count === 1 ? old.promise : { regionId: directoryRegion };
  const load = h.controller.load(directoryListRoute);
  await flush();
  h.controller.setInput('new');
  const search = h.controller.submit();
  await search;
  old.resolve({ regionId: directoryRegion });
  await load;
  assert.equal(h.calls.filter((call) => call.method === 'entries').length, 1);
  assert.equal(h.view().submittedQuery, 'new');
  h.controller.dispose();
});
test('multi-step cursor cycles fail closed and explicit refresh restarts', async () => {
  const h = directoryHarness();
  let count = 0;
  h.behavior.entries = async () => ({
    items: [directoryEntry()],
    continuation: 'more',
    nextCursor: directoryToken(++count === 3 ? 1 : count),
  });
  await h.controller.load(directoryListRoute);
  await h.controller.next();
  await h.controller.next();
  assert.equal(h.view().loaded, false);
  assert.equal(h.view().entries.length, 0);
  assert.equal(h.view().canPrevious, false);
  h.behavior.entries = async () => ({
    items: [directoryEntry()],
    continuation: 'end',
    nextCursor: null,
  });
  await h.controller.refresh();
  assert.equal(h.view().pageNumber, 1);
  h.controller.dispose();
});
test('same-account relogin and account change clear DTO, submitted query and pending responses', async () => {
  for (const accountId of [wireCredentials().accountId, directoryOtherRegion]) {
    const h = directoryHarness();
    await h.controller.load(directoryListRoute);
    h.controller.setInput('private query');
    await h.controller.submit();
    const pending = deferred<DirectoryPage<DirectoryEntry>>();
    h.behavior.entries = async () => pending.promise;
    const refresh = h.controller.refresh();
    await flush();
    h.runtime.sessions.completeLogin(h.runtime.sessions.beginLogin(), {
      ...wireCredentials(),
      accountId,
    });
    assert.equal(h.view().entries.length, 0);
    assert.equal(h.view().inputDraft, '');
    pending.resolve({
      items: [directoryEntry()],
      continuation: 'end',
      nextCursor: null,
    });
    await refresh;
    assert.equal(h.view().loaded, false);
    h.controller.dispose();
  }
});
test('safety and identity-scope invalidation clear pending lists and forbid stale navigation', async () => {
  for (const invalidate of ['safety', 'scope'] as const) {
    const h = directoryHarness();
    await h.controller.load(directoryListRoute);
    assert.ok(h.controller.entryPath(directoryEntryId));
    const pending = deferred<DirectoryPage<DirectoryEntry>>();
    h.behavior.entries = async () => pending.promise;
    const refresh = h.controller.refresh();
    await flush();
    const account = h.runtime.sessions.snapshot().credentials!.accountId;
    if (invalidate === 'scope') h.runtime.directoryScopeChanges.clear(account);
    else h.runtime.safetyChanges.invalidate(account);
    assert.equal(h.controller.entryPath(directoryEntryId), null);
    assert.equal(h.view().regionId, '');
    pending.resolve({
      items: [directoryEntry()],
      continuation: 'end',
      nextCursor: null,
    });
    await refresh;
    assert.equal(h.view().loaded, false);
    h.controller.dispose();
  }
});
test('returned platform controls QQ copy independently of official badge, absent or unavailable never copies', async () => {
  const h = directoryHarness('detail');
  const copied: string[] = [];
  await h.controller.load(directoryDetailRoute);
  assert.equal(h.view().canCopy, true);
  await h.controller.copyQq(async (value) => {
    copied.push(value);
  });
  assert.deepEqual(copied, ['0012345678901234']);
  for (const detail of [
    directoryDetail('wechat'),
    directoryDetail('official'),
    {
      ...directoryDetail(),
      qqGroupNumber: { status: 'known' as const, value: null },
    },
    {
      ...directoryDetail(),
      qqGroupNumber: { status: 'unavailable' as const, value: null },
    },
  ]) {
    h.behavior.detail = async () => detail;
    await h.controller.refresh();
    await h.controller.copyQq(async (value) => {
      copied.push(value);
    });
    assert.equal(h.view().canCopy, false);
  }
  assert.equal(copied.length, 1);
  h.controller.dispose();
});
test('same-tick hide, logout, scope and safety invalidation cancel deferred clipboard dispatch', async () => {
  for (const invalidation of ['hide', 'logout', 'scope', 'safety'] as const) {
    const h = directoryHarness('detail');
    await h.controller.load(directoryDetailRoute);
    let copied = 0;
    const copy = h.controller.copyQq(async () => {
      copied++;
    });
    const account = h.runtime.sessions.snapshot().credentials!.accountId;
    if (invalidation === 'hide') h.controller.dispose();
    if (invalidation === 'logout') h.runtime.sessions.logout();
    if (invalidation === 'scope')
      h.runtime.directoryScopeChanges.clear(account);
    if (invalidation === 'safety') h.runtime.safetyChanges.invalidate(account);
    await copy;
    assert.equal(copied, 0);
    assert.equal(h.view().detail, null);
    assert.equal(h.view().canCopy, false);
    h.controller.dispose();
  }
});
test('repeated clipboard taps coalesce; late success after root hide has no visible effect', async () => {
  const h = directoryHarness('detail');
  await h.controller.load(directoryDetailRoute);
  const pending = deferred<void>();
  let copied = 0;
  const copy = h.controller.copyQq(async () => {
    copied++;
    return pending.promise;
  });
  await flush();
  await h.controller.copyQq(async () => {
    copied++;
  });
  assert.equal(copied, 1);
  h.runtime.privateViews!.clear();
  pending.resolve();
  await copy;
  assert.equal(h.view().detail, null);
  assert.equal(h.view().copyBusy, false);
  assert.equal(h.controller.snapshot(), null);
  h.controller.dispose();
});
test('clipboard failure permits another explicit attempt, detail denial clears all contacts', async () => {
  const h = directoryHarness('detail');
  await h.controller.load(directoryDetailRoute);
  await h.controller.copyQq(async () => {
    throw new Error('clipboard');
  });
  let copied = '';
  await h.controller.copyQq(async (value) => {
    copied = value;
  });
  assert.equal(copied, '0012345678901234');
  h.behavior.detail = async () => {
    throw error('DIRECTORY_NOT_FOUND');
  };
  await h.controller.refresh();
  await h.controller.copyQq(async () => {
    assert.fail('stale copy');
  });
  assert.equal(h.view().detail, null);
  h.controller.dispose();
});
test('directory retains no bodies, contacts, managers or cursor in durable storage; snapshot is intent-only', async () => {
  const h = directoryHarness();
  const before = JSON.stringify([...h.storage.data]);
  await h.controller.load(directoryListRoute);
  h.controller.setInput('query');
  await h.controller.submit();
  assert.deepEqual(h.controller.snapshot(), {
    route: directoryListRoute,
    inputDraft: 'query',
    submittedQuery: 'query',
  });
  assert.equal(JSON.stringify([...h.storage.data]), before);
  h.controller.dispose();
  assert.equal(h.view().entries.length, 0);
});
