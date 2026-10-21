import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { CoverPrincipalOwner } from '../src/profile/cover-principal';
import {
  CoverReadController,
  type CoverReadTransfer,
  type CoverReadView,
} from '../src/profile/cover-read-controller';
import { createProfileCoverRuntime } from '../src/profile/cover-runtime';
import { FakeClock, MemoryStorage, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { coverIds, FakeCoverGateway } from './support/cover-fixtures';
function setup() {
  const sessions = new SessionStore(),
    principals = new CoverPrincipalOwner(sessions),
    gateway = new FakeCoverGateway(),
    clock = new FakeClock();
  const released: string[] = [],
    downloads: string[] = [],
    views: CoverReadView[] = [];
  const transfer: CoverReadTransfer = {
    async download(_current, _variant, _owner, principal) {
      const value = principal.current();
      downloads.push(value.kind);
      return { localId: `cover-${downloads.length}` };
    },
    async resolve(file) {
      return `wxfile://tmp/${file.localId}.png`;
    },
    async release(file) {
      released.push(file.localId);
    },
  };
  const reader = new CoverReadController(
    principals,
    gateway,
    transfer,
    clock,
    (view) => views.push(view),
  );
  return {
    sessions,
    principals,
    gateway,
    clock,
    released,
    downloads,
    transfer,
    reader,
    views,
    view: () => views[views.length - 1]!,
  };
}
test('guest current read has a separate generation, a finite lease and fresh read on next open', async () => {
  const s = setup();
  await s.reader.load(coverIds.profile);
  assert.equal(s.view().status, 'ready');
  assert.deepEqual(s.gateway.currentReads, ['guest']);
  assert.equal(s.principals.snapshot().kind, 'guest');
  assert.equal('credentials' in s.principals.snapshot(), false);
  s.clock.advance(30000);
  assert.equal(s.view().localSrc, '');
  assert.deepEqual(s.released, ['cover-1']);
  await s.reader.open();
  assert.equal(s.gateway.currentReads.length, 2);
  assert.equal(s.view().expanded, true);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  assert.equal(s.view().localSrc, '');
  assert.deepEqual(s.released, ['cover-1', 'cover-2']);
});
test('a late guest download after login is released and never rendered for the session', async () => {
  const s = setup(),
    file = deferred<{ localId: string }>();
  s.transfer.download = async () => file.promise;
  const loading = s.reader.load(coverIds.profile);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  file.resolve({ localId: 'late-guest' });
  await loading;
  assert.equal(s.view().localSrc, '');
  assert.deepEqual(s.released, ['late-guest']);
});
test('one shared app cover window revokes another page before allocating the next reader', async () => {
  const s = setup(),
    views: CoverReadView[][] = [[], []];
  const runtime = createProfileCoverRuntime({
    sessions: s.sessions,
    principals: s.principals,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    clock: s.clock,
    newRequestId: async () => coverIds.request,
    gateway: s.gateway,
    download: s.transfer,
  });
  const first = runtime.createReader((view) => views[0]!.push(view)),
    second = runtime.createReader((view) => views[1]!.push(view));
  await first.load(coverIds.profile);
  assert.ok(views[0]![views[0]!.length - 1]!.localSrc);
  await second.load(coverIds.profile);
  assert.equal(views[0]![views[0]!.length - 1]!.localSrc, '');
  assert.ok(views[1]![views[1]!.length - 1]!.localSrc);
  runtime.hide();
  assert.equal(views[1]![views[1]!.length - 1]!.localSrc, '');
});
test('normal runtime remains explicitly unavailable with no gateway or native transfer', async () => {
  const s = setup();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  const runtime = createProfileCoverRuntime({
    sessions: s.sessions,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    clock: s.clock,
    newRequestId: async () => coverIds.request,
  });
  const reader = runtime.createReader((view) => s.views.push(view));
  await reader.load(coverIds.profile);
  assert.equal(s.view().status, 'unavailable');
  assert.equal(s.downloads.length, 0);
});
test('renderer failure cannot prevent synchronous session revocation and file release', async () => {
  const s = setup();
  const reader = new CoverReadController(
    s.principals,
    s.gateway,
    s.transfer,
    s.clock,
    () => {
      throw new Error('synthetic render failure');
    },
  );
  await reader.load(coverIds.profile);
  assert.equal(reader.snapshot().status, 'ready');
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  assert.equal(reader.snapshot().localSrc, '');
  assert.equal(s.released.length, 1);
});
