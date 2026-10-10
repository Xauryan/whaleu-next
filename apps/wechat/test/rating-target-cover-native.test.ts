import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import { MediaLocalFiles } from '../src/media/local-files';
import { AuthenticatedMediaDownload } from '../src/media/authenticated-download';
import { RatingCoverDownload } from '../src/ratings/target-cover-download';
import { RATINGS_MEDIA_PROTOCOL } from '../src/ratings/target-cover-media-contract';
import { ProfileAvatarDownload } from '../src/profile/avatar-download';
import { AvatarPrincipalOwner } from '../src/profile/avatar-principal';
import { FakeClock, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { scopedContext } from './rating-scoped-helpers';
import { targetId, otherId, requestId } from './ratings-helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
  attachment,
} from './support/media-read-fixtures';
import { avatarCurrent } from './support/avatar-fixtures';
const origin = 'https://ratings-native.invalid';
function harness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const clock = new FakeClock(),
    files = new ReadFiles(),
    registry = new MediaLocalFiles(files),
    calls: DownloadCall[] = [];
  const wx: WxMediaApi = {
    downloadFile(options) {
      const call = new DownloadCall(options);
      calls.push(call);
      return call;
    },
  };
  const auth = { refresh: async () => sessions.snapshot() },
    owner = {},
    ticket = sessions.snapshot();
  const session = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  const scope = {
    ...scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      clock.now(),
    ),
    protocolVersion: 3 as const,
    capabilities: ['target_cover'],
  };
  const descriptor = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    kind: 'ratings-target-media' as const,
    contextId: scope.id,
    contextToken: scope.token,
    targetId,
    appearanceId: otherId,
    bindingId: requestId,
    width: 80,
    height: 60,
    variants: ['thumb-v1', 'display-v1'] as const,
  };
  return {
    sessions,
    clock,
    files,
    registry,
    calls,
    wx,
    auth,
    owner,
    session,
    scope,
    descriptor,
    transfer: new RatingCoverDownload(
      origin,
      wx,
      files,
      registry,
      sessions,
      auth,
      clock,
    ),
  };
}
test('Ratings controlled bytes use only exact target/appearance and read context with authenticated session', async () => {
  const h = harness(),
    pending = h.transfer.download(
      h.descriptor,
      h.scope,
      'display-v1',
      h.owner,
      h.session,
      new Cancellation(),
    );
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0]!.options.url,
    `${origin}/v3/media/ratings-target/targets/${targetId}/appearances/${otherId}/display-v1?contextId=${h.scope.id}&contextToken=${h.scope.token}`,
  );
  assert.equal(
    h.calls[0]!.options.header.Authorization,
    `Bearer ${wireCredentials().accessToken}`,
  );
  const path = 'wxfile://tmp/ratings-cover.png';
  h.files.put(path);
  h.calls[0]!.headers(imageHeaders());
  h.calls[0]!.success(path);
  h.calls[0]!.complete();
  const file = await pending;
  assert.equal(
    await h.transfer.resolve(file, h.owner, h.sessions.snapshot()),
    path,
  );
  await h.transfer.release(file);
  assert.deepEqual(h.files.deleted, [path]);
});
test('Community, Profile and Ratings share in-page transfer credits; abort does not release until complete', async () => {
  const h = harness(),
    ratingsCancel = new Cancellation(),
    profileCancel = new Cancellation();
  const principals = new AvatarPrincipalOwner(h.sessions);
  const profile = new ProfileAvatarDownload(
    origin,
    h.wx,
    h.files,
    h.registry,
    principals,
    h.auth,
    h.clock,
  );
  const community = new AuthenticatedMediaDownload(
    origin,
    h.wx,
    h.files,
    h.registry,
    h.sessions,
    h.auth,
    h.clock,
  );
  const ratings = assert.rejects(
    h.transfer.download(
      h.descriptor,
      h.scope,
      'thumb-v1',
      h.owner,
      h.session,
      ratingsCancel,
    ),
    { kind: 'cancelled' },
  );
  const avatar = assert.rejects(
    profile.download(
      avatarCurrent,
      'thumb-v1',
      {},
      { current: () => principals.snapshot() },
      profileCancel,
    ),
    { kind: 'cancelled' },
  );
  await flush();
  assert.equal(h.calls.length, 2);
  await assert.rejects(
    community.download(
      attachment,
      'thumb-v1',
      {},
      h.session,
      new Cancellation(),
    ),
    { kind: 'configuration' },
  );
  ratingsCancel.cancel();
  profileCancel.cancel();
  await Promise.all([ratings, avatar]);
  await assert.rejects(
    community.download(
      attachment,
      'thumb-v1',
      {},
      h.session,
      new Cancellation(),
    ),
    { kind: 'configuration' },
  );
  h.calls[0]!.complete();
  h.calls[1]!.complete();
  h.registry.assertTransferCapacity();
});
