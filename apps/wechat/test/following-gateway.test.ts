import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiClient,
  type Endpoint,
  type RequestOptions,
} from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import { decodeFollowState } from '../src/following/contract';
import { FollowingGateway } from '../src/following/gateway';
import {
  post,
  spaceId,
  otherId,
  requestId,
  publicExperienceDisplay,
} from './community-helpers';
function fixture(value: unknown) {
  const calls: { endpoint: Endpoint<unknown>; options: RequestOptions }[] = [];
  const api = {
    request: async <T>(endpoint: Endpoint<T>, options: RequestOptions) => {
      calls.push({ endpoint, options });
      return endpoint.decode(value);
    },
  } as unknown as ApiClient;
  return { gateway: new FollowingGateway(api), calls };
}
test('follow state accepts only public profile reference and boolean state', () => {
  assert.deepEqual(decodeFollowState({ profileId: otherId, following: true }), {
    profileId: otherId,
    following: true,
  });
  for (const value of [
    null,
    { profileId: otherId, following: 'true' },
    { profileId: otherId, following: true, accountId: otherId },
  ])
    assert.throws(() => decodeFollowState(value), { kind: 'protocol' });
});
test('Following gateway never accepts an anonymous author or a mismatched scope', async () => {
  const cancel = new Cancellation();
  const page = { items: [post()], nextCursor: null, continuation: 'end' };
  await assert.rejects(fixture(page).gateway.feed({ spaceId }, cancel), {
    kind: 'protocol',
  });
  const named = post({
    author: {
      kind: 'named',
      profileId: otherId,
      displayName: '鲸鱼',
      avatar: null,
      experienceDisplay: publicExperienceDisplay(),
    },
  });
  const f = fixture({ ...page, items: [named] });
  assert.equal((await f.gateway.feed({ spaceId }, cancel)).items.length, 1);
  assert.equal(f.calls[0]!.endpoint.authentication, 'required');
  assert.equal(f.calls[0]!.endpoint.path, '/v1/community/following/posts');
  assert.equal(f.calls[0]!.options.cancellation, cancel);
  await assert.rejects(
    fixture({ ...page, items: [named] }).gateway.feed(
      { spaceId: otherId },
      cancel,
    ),
    { kind: 'protocol' },
  );
});
test('follow mutation retains request identity and disables automatic mutation replay', async () => {
  const f = fixture({
      requestId,
      profileId: otherId,
      following: true,
      outcome: 'applied',
    }),
    cancel = new Cancellation();
  await f.gateway.set(otherId, true, requestId, cancel);
  assert.deepEqual(f.calls[0]!.options.body, { requestId });
  assert.equal(f.calls[0]!.endpoint.authReplay, 'never');
  await assert.rejects(f.gateway.set(otherId, false, requestId, cancel), {
    kind: 'protocol',
  });
  await assert.rejects(f.gateway.status(spaceId, cancel), { kind: 'protocol' });
});

test('verified terminal rejected receipt matches intent; arbitrary codes and wrong receipt IDs do not settle', async () => {
  const rejected = {
    requestId,
    profileId: otherId,
    following: true,
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  };
  assert.deepEqual(
    await fixture(rejected).gateway.set(
      otherId,
      true,
      requestId,
      new Cancellation(),
    ),
    rejected,
  );
  for (const patch of [
    { requestId: spaceId },
    { code: 'COMMUNITY_UNAVAILABLE' },
    { outcome: 'applied', code: 'POST_NOT_FOUND' },
    { accountId: otherId },
  ])
    await assert.rejects(
      fixture({ ...rejected, ...patch }).gateway.set(
        otherId,
        true,
        requestId,
        new Cancellation(),
      ),
      { kind: 'protocol' },
    );
});
