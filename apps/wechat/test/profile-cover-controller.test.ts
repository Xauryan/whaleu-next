import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  ProfileCoverController,
  type CoverEditView,
} from '../src/profile/cover-controller';
import { CoverPrincipalOwner } from '../src/profile/cover-principal';
import { PendingCoverStore } from '../src/profile/cover-pending';
import {
  PROFILE_COVER_PROTOCOL as protocol,
  type CoverEditStatus,
} from '../src/profile/cover-contract';
import { FakeClock, MemoryStorage, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  coverIds,
  coverReady,
  FakeCoverGateway,
  FakeCoverUpload,
} from './support/cover-fixtures';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const principals = new CoverPrincipalOwner(sessions),
    storage = new MemoryStorage(),
    pending = new PendingCoverStore(storage, 'https://api.example.test');
  const gateway = new FakeCoverGateway(),
    transfer = new FakeCoverUpload(),
    clock = new FakeClock(),
    views: CoverEditView[] = [];
  const ids = [coverIds.request, coverIds.command];
  let changed = 0;
  const controller = new ProfileCoverController(
    sessions,
    principals,
    gateway,
    pending,
    transfer,
    clock,
    async () => ids.shift()!,
    (view) => views.push(view),
    () => {
      changed++;
    },
  );
  return {
    sessions,
    principals,
    storage,
    pending,
    gateway,
    transfer,
    clock,
    controller,
    views,
    changed: () => changed,
    view: () => views[views.length - 1]!,
  };
}
test('shared system picker preview remains uncommitted at upload 100%, ready custom command is exact CAS', async () => {
  const s = setup();
  await s.controller.load();
  const finalize = deferred<CoverEditStatus>();
  s.gateway.finalize = async () => finalize.promise;
  const choosing = s.controller.chooseCustomCover();
  await flush();
  await flush();
  assert.equal(s.view().progress, 100);
  assert.equal(s.view().canSave, false);
  assert.equal(s.gateway.commands.length, 0);
  assert.match(s.view().status, /仍在等待/);
  finalize.resolve(coverReady());
  await choosing;
  assert.equal(s.view().canSave, true);
  await s.controller.save();
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.gateway.commands[0]!.source.kind, 'custom');
  assert.equal(s.gateway.commands[0]!.expectedRevision, 5);
  assert.equal(s.pending.load(coverIds.actor), null);
  assert.equal(s.changed(), 1);
  assert.equal(s.view().previewSrc, '');
  assert.equal(s.view().needsReload, true);
});
test('A to B to A clears private UI and recovers the original command key with a fresh epoch', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.gateway.commandFailure = new ClientError(
    'network',
    'Lost committed response',
  );
  await s.controller.save();
  const record = s.pending.load(coverIds.actor)!;
  assert.ok(record.command);
  const originalId = record.command.input.clientRequestId;
  s.sessions.logout();
  assert.equal(s.view().previewSrc, '');
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: coverIds.other,
  });
  await s.controller.load();
  assert.equal(s.gateway.commandReads.length, 0);
  assert.deepEqual(s.pending.load(coverIds.actor), record);
  assert.equal(s.pending.load(coverIds.other), null);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  await s.controller.load();
  assert.deepEqual(s.gateway.commandReads, [
    { actor: coverIds.actor, id: originalId },
  ]);
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.pending.load(coverIds.actor), null);
});
test('late system picker result after logout never prepares under the new actor', async () => {
  const s = setup();
  await s.controller.load();
  const picked = deferred<{ localId: string }>();
  s.transfer.pick = async () => picked.promise;
  const selecting = s.controller.chooseCustomCover();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: coverIds.other,
  });
  picked.resolve({ localId: 'late-cover' });
  await selecting;
  assert.equal(s.pending.load(coverIds.actor), null);
  assert.equal(s.pending.load(coverIds.other), null);
  assert.equal(s.view().previewSrc, '');
  assert.equal(s.gateway.commands.length, 0);
  assert.deepEqual(s.transfer.removed, ['late-cover']);
});
test('clear selection cancels an unbound custom edit first; local stop never settles journal', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.chooseCustomCover();
  assert.ok(s.pending.load(coverIds.actor)?.edit);
  await s.controller.selectClear();
  assert.equal(s.pending.load(coverIds.actor), null);
  assert.equal(s.view().selection, 'clear');
  await s.controller.save();
  assert.equal(s.gateway.commands[0]!.source.kind, 'clear');
});
test('CAS conflict does not increment expectedRevision or silently rebase the command', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.gateway.commandFailure = new ClientError('business', 'Conflict', {
    httpStatus: 409,
    serverCode: 'PROFILE_REVISION_CONFLICT',
  });
  await s.controller.save();
  assert.equal(s.view().needsReload, true);
  assert.equal(s.view().canSave, false);
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.gateway.commands[0]!.expectedRevision, 5);
  assert.ok(s.pending.load(coverIds.actor)?.command);
  s.gateway.receipt = null;
  await s.controller.cancelPendingCommand();
  assert.equal(s.pending.load(coverIds.actor), null);
});
test('pre-prepare cancellation fence permits a new selection only after authoritative confirmation', async () => {
  const s = setup();
  await s.controller.load();
  const record = s.pending.freezeEdit(coverIds.actor, {
    protocol,
    clientRequestId: coverIds.request,
    expectedRevision: 5,
    slot: 'cover',
    declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
  });
  s.gateway.cancelEdit = async () => ({
    protocol,
    requestId: coverIds.request,
    serverNow: 1000,
    state: 'cancelled_before_prepare',
    requestHash: record.edit!.requestHash,
    reason: 'cancelled',
  });
  assert.equal(await s.controller.cancelPendingEdit(), true);
  assert.equal(s.pending.load(coverIds.actor), null);
});
test('cancel versus committed command returns history and never creates a second command or clears current cover', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.gateway.commandFailure = new ClientError('network', 'Lost response');
  await s.controller.save();
  assert.ok(s.pending.load(coverIds.actor)?.command);
  await s.controller.cancelPendingCommand();
  assert.equal(s.pending.load(coverIds.actor), null);
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.changed(), 1);
  assert.equal(s.view().needsReload, true);
});
test('a not-recorded command is retained and explicit retry preserves the original key and CAS revision', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.gateway.commandFailure = new ClientError('network', 'Unknown');
  await s.controller.save();
  const original = s.pending.load(coverIds.actor)!;
  s.gateway.receipt = null;
  await s.controller.recover();
  assert.deepEqual(s.pending.load(coverIds.actor), original);
  assert.equal(s.gateway.commands.length, 1);
  s.gateway.commandFailure = null;
  await s.controller.recover(true);
  assert.equal(s.gateway.commands.length, 2);
  assert.deepEqual(s.gateway.commands[0], s.gateway.commands[1]);
});
test('same-epoch token refresh preserves the selection while failed durable write prevents dispatch', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('r'));
  assert.equal(s.view().selection, 'clear');
  s.storage.failWrite = true;
  await s.controller.save();
  assert.equal(s.gateway.commands.length, 0);
  assert.match(s.view().error, /恢复记录/);
});
test('native picker cancel has no server journal and the next selection remains usable', async () => {
  const s = setup();
  await s.controller.load();
  s.transfer.pick = async () => {
    throw new ClientError('cancelled', 'chooseMedia cancelled');
  };
  await s.controller.chooseCustomCover();
  assert.equal(s.view().busy, false);
  assert.equal(s.view().needsRecovery, false);
  assert.equal(s.view().canChoose, true);
  assert.equal(s.pending.load(coverIds.actor), null);
  s.transfer.pick = async (session) => {
    session.current();
    return { localId: 'selected-again' };
  };
  await s.controller.chooseCustomCover();
  assert.equal(s.view().canSave, true);
  assert.equal(s.pending.load(coverIds.actor)?.edit?.assetId, coverIds.asset);
});

test('unconfigured trusted upload disables selection but leaves explicit clear available', async () => {
  const s = setup();
  s.gateway.capabilitiesValue = { protocol, upload: 'unavailable' };
  let picks = 0;
  s.transfer.pick = async () => {
    picks++;
    return { localId: 'must-not-pick' };
  };
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().uploadAvailable, false);
  assert.equal(s.view().canChoose, false);
  await s.controller.chooseCustomCover();
  assert.equal(picks, 0);
  await s.controller.selectClear();
  assert.equal(s.view().canSave, true);
  await s.controller.save();
  assert.equal(s.gateway.commands[0]?.source.kind, 'clear');
});

test('native picker hide suspends inspection and upload until the same page resumes', async () => {
  const s = setup();
  await s.controller.load();
  const picked = deferred<{ localId: string }>();
  s.transfer.pick = async () => {
    s.transfer.pickerState = 'waiting-native';
    return picked.promise;
  };
  let prepared = 0;
  const prepare = s.gateway.prepare.bind(s.gateway);
  s.gateway.prepare = async (...args) => {
    prepared++;
    return prepare(...args);
  };
  const selecting = s.controller.chooseCustomCover();
  await flush();
  assert.equal(s.controller.isNativePickerPending(), true);
  s.controller.hide();
  s.transfer.pickerState = 'ready';
  picked.resolve({ localId: 'album-cover' });
  await flush();
  assert.equal(s.view().previewSrc, '');
  assert.equal(prepared, 0);
  assert.equal(s.pending.load(coverIds.actor), null);
  s.controller.resume();
  await selecting;
  assert.equal(prepared, 1);
  assert.equal(s.view().canSave, true);
  assert.equal(s.gateway.commands.length, 0);
});

for (const boundary of ['dispose', 'invalidate', 'logout'] as const) {
  test(`native picker return cannot upload after ${boundary} while hidden`, async () => {
    const s = setup();
    await s.controller.load();
    const picked = deferred<{ localId: string }>();
    s.transfer.pick = async () => {
      s.transfer.pickerState = 'waiting-native';
      return picked.promise;
    };
    let prepared = 0;
    const prepare = s.gateway.prepare.bind(s.gateway);
    s.gateway.prepare = async (...args) => {
      prepared++;
      return prepare(...args);
    };
    const selecting = s.controller.chooseCustomCover();
    await flush();
    s.controller.hide();
    s.transfer.pickerState = 'ready';
    picked.resolve({ localId: 'hidden-cover' });
    await flush();
    if (boundary === 'logout') s.sessions.logout();
    else s.controller[boundary]();
    await selecting;
    assert.equal(prepared, 0);
    assert.equal(s.view().previewSrc, '');
    assert.equal(s.view().uploadAvailable, false);
    assert.equal(s.pending.load(coverIds.actor), null);
    assert.deepEqual(s.transfer.removed, ['hidden-cover']);
  });
}
