import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  ProfileAvatarController,
  type AvatarEditView,
} from '../src/profile/avatar-controller';
import { AvatarPrincipalOwner } from '../src/profile/avatar-principal';
import { PendingAvatarStore } from '../src/profile/avatar-pending';
import {
  PROFILE_MEDIA_PROTOCOL as protocol,
  type AvatarEditStatus,
} from '../src/profile/avatar-contract';
import { FakeClock, MemoryStorage, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  avatarIds,
  avatarReady,
  FakeAvatarGateway,
  FakeAvatarUpload,
} from './support/avatar-fixtures';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const principals = new AvatarPrincipalOwner(sessions),
    storage = new MemoryStorage(),
    pending = new PendingAvatarStore(storage, 'https://api.example.test');
  const gateway = new FakeAvatarGateway(),
    transfer = new FakeAvatarUpload(),
    clock = new FakeClock(),
    views: AvatarEditView[] = [];
  const ids = [avatarIds.request, avatarIds.command];
  let changed = 0;
  const controller = new ProfileAvatarController(
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
  const finalize = deferred<AvatarEditStatus>();
  s.gateway.finalize = async () => finalize.promise;
  const choosing = s.controller.chooseCustomAvatar();
  await flush();
  await flush();
  assert.equal(s.view().progress, 100);
  assert.equal(s.view().canSave, false);
  assert.equal(s.gateway.commands.length, 0);
  assert.match(s.view().status, /仍在等待/);
  finalize.resolve(avatarReady());
  await choosing;
  assert.equal(s.view().canSave, true);
  await s.controller.save();
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.gateway.commands[0]!.source.kind, 'custom');
  assert.equal(s.gateway.commands[0]!.expectedRevision, 5);
  assert.equal(s.pending.load(avatarIds.actor), null);
  assert.equal(s.changed(), 1);
  assert.equal(s.view().previewSrc, '');
  assert.equal(s.view().needsReload, true);
});
test('A to B to A clears private UI and recovers the original command key with a fresh epoch', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectCatalog('synthetic-one');
  s.gateway.commandFailure = new ClientError(
    'network',
    'Lost committed response',
  );
  await s.controller.save();
  const record = s.pending.load(avatarIds.actor)!;
  assert.ok(record.command);
  const originalId = record.command.input.clientRequestId;
  s.sessions.logout();
  assert.equal(s.view().previewSrc, '');
  assert.equal(s.view().selectedItem, '');
  assert.equal(s.view().catalog.length, 0);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: avatarIds.other,
  });
  await s.controller.load();
  assert.equal(s.gateway.commandReads.length, 0);
  assert.deepEqual(s.pending.load(avatarIds.actor), record);
  assert.equal(s.pending.load(avatarIds.other), null);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  await s.controller.load();
  assert.deepEqual(s.gateway.commandReads, [
    { actor: avatarIds.actor, id: originalId },
  ]);
  assert.equal(s.gateway.commands.length, 1);
  assert.equal(s.pending.load(avatarIds.actor), null);
});
test('late system picker result after logout never prepares under the new actor', async () => {
  const s = setup();
  await s.controller.load();
  const picked = deferred<{ localId: string }>();
  s.transfer.pick = async () => picked.promise;
  const selecting = s.controller.chooseCustomAvatar();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: avatarIds.other,
  });
  picked.resolve({ localId: 'late-avatar' });
  await selecting;
  assert.equal(s.pending.load(avatarIds.actor), null);
  assert.equal(s.pending.load(avatarIds.other), null);
  assert.equal(s.view().previewSrc, '');
  assert.equal(s.gateway.commands.length, 0);
  assert.deepEqual(s.transfer.removed, ['late-avatar']);
});
test('catalog selection cancels an unbound custom edit first; local stop never settles journal', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.chooseCustomAvatar();
  assert.ok(s.pending.load(avatarIds.actor)?.edit);
  await s.controller.selectCatalog('synthetic-one');
  assert.equal(s.pending.load(avatarIds.actor), null);
  assert.equal(s.view().selection, 'catalog');
  await s.controller.save();
  assert.equal(s.gateway.commands[0]!.source.kind, 'catalog');
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
  assert.ok(s.pending.load(avatarIds.actor)?.command);
  s.gateway.receipt = null;
  await s.controller.cancelPendingCommand();
  assert.equal(s.pending.load(avatarIds.actor), null);
});
test('pre-prepare cancellation fence permits a new selection only after authoritative confirmation', async () => {
  const s = setup();
  await s.controller.load();
  const record = s.pending.freezeEdit(avatarIds.actor, {
    protocol,
    clientRequestId: avatarIds.request,
    expectedRevision: 5,
    slot: 'avatar',
    declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
  });
  s.gateway.cancelEdit = async () => ({
    protocol,
    requestId: avatarIds.request,
    serverNow: 1000,
    state: 'cancelled_before_prepare',
    requestHash: record.edit!.requestHash,
    reason: 'cancelled',
  });
  assert.equal(await s.controller.cancelPendingEdit(), true);
  assert.equal(s.pending.load(avatarIds.actor), null);
});
test('cancel versus committed command returns history and never creates a second command or clears current avatar', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectClear();
  s.gateway.commandFailure = new ClientError('network', 'Lost response');
  await s.controller.save();
  assert.ok(s.pending.load(avatarIds.actor)?.command);
  await s.controller.cancelPendingCommand();
  assert.equal(s.pending.load(avatarIds.actor), null);
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
  const original = s.pending.load(avatarIds.actor)!;
  s.gateway.receipt = null;
  await s.controller.recover();
  assert.deepEqual(s.pending.load(avatarIds.actor), original);
  assert.equal(s.gateway.commands.length, 1);
  s.gateway.commandFailure = null;
  await s.controller.recover(true);
  assert.equal(s.gateway.commands.length, 2);
  assert.deepEqual(s.gateway.commands[0], s.gateway.commands[1]);
});
test('same-epoch token refresh preserves the selection while failed durable write prevents dispatch', async () => {
  const s = setup();
  await s.controller.load();
  await s.controller.selectCatalog('synthetic-one');
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('r'));
  assert.equal(s.view().selectedItem, 'synthetic-one');
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
  await s.controller.chooseCustomAvatar();
  assert.equal(s.view().busy, false);
  assert.equal(s.view().needsRecovery, false);
  assert.equal(s.view().canChoose, true);
  assert.equal(s.pending.load(avatarIds.actor), null);
  s.transfer.pick = async (session) => {
    session.current();
    return { localId: 'selected-again' };
  };
  await s.controller.chooseCustomAvatar();
  assert.equal(s.view().canSave, true);
  assert.equal(s.pending.load(avatarIds.actor)?.edit?.assetId, avatarIds.asset);
});
