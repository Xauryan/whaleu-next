import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../src/auth/session';
import { decodeRatingScopedContext } from '../src/ratings/scoped-contract';
import { decodeRatingTargetCoverContext } from '../src/ratings/target-cover-context';
import {
  decodeRatingDiscussionMediaContext,
  ratingDiscussionMediaCommandContext,
} from '../src/ratings/discussion-media-contract';
import {
  RatingDiscussionMediaContextLease,
  matchRatingDiscussionCoverObservation,
} from '../src/ratings/discussion-media-context';
import { scopedContext } from './rating-scoped-helpers';
import { wireCredentials } from './identity-helpers';
import { FakeClock } from './helpers';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  purpose: 'interact',
  selector: { kind: 'global' },
  mode: 'public',
} as const;
test('context4 and cover3 coexist without token or capability lending', () => {
  const base = scopedContext(request),
    discussion = decodeRatingDiscussionMediaContext({
      ...base,
      protocolVersion: 4,
      discussionMedia: {
        id: id(90),
        generation: id(91),
        sourceDigest: 'c'.repeat(64),
        validUntil: base.expiresAt,
      },
      capabilities: [...base.capabilities, 'discussion_images'],
    });
  const cover = decodeRatingTargetCoverContext({
    ...base,
    protocolVersion: 3,
    id: id(92),
    capabilities: [...base.capabilities, 'target_cover'],
  });
  assert.throws(() => decodeRatingScopedContext(discussion));
  assert.throws(() => decodeRatingTargetCoverContext(discussion));
  assert.throws(() => decodeRatingDiscussionMediaContext(cover));
  assert.doesNotThrow(() =>
    matchRatingDiscussionCoverObservation(discussion, cover),
  );
  assert.throws(() =>
    matchRatingDiscussionCoverObservation(discussion, {
      ...cover,
      id: discussion.id,
    }),
  );
  assert.throws(() =>
    decodeRatingDiscussionMediaContext({
      ...discussion,
      capabilities: ['target_cover'],
    }),
  );
});
test('context4 invalidates across actor session ABA and source expiry', () => {
  const sessions = new SessionStore(),
    clock = new FakeClock();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const base = scopedContext(request, clock.now());
  const context = decodeRatingDiscussionMediaContext({
    ...base,
    protocolVersion: 4,
    discussionMedia: {
      id: id(90),
      generation: id(91),
      sourceDigest: 'c'.repeat(64),
      validUntil: base.expiresAt,
    },
    capabilities: [...base.capabilities, 'discussion_images'],
  });
  const lease = new RatingDiscussionMediaContextLease(
      sessions,
      clock,
      () => undefined,
    ),
    generation = lease.capture();
  lease.accept(context, request, generation);
  sessions.logout();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  assert.throws(() => lease.current());
  assert.throws(() => lease.accept(context, request, generation));
  assert.throws(() =>
    decodeRatingDiscussionMediaContext({
      ...context,
      discussionMedia: {
        ...context.discussionMedia,
        validUntil: context.issuedAt,
      },
    }),
  );
  lease.dispose();
});

test('shared golden context4 and cover3 keep independent tokens and discussion capability', () => {
  const golden = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../packages/fixtures/ratings-discussion-media-v1.json',
      ),
      'utf8',
    ),
  ) as {
    contexts: { discussion4: unknown; targetCover3: unknown };
  };
  const discussion = decodeRatingDiscussionMediaContext(
    golden.contexts.discussion4,
  );
  const cover = decodeRatingTargetCoverContext(golden.contexts.targetCover3);
  assert.notEqual(discussion.id, cover.id);
  assert.notEqual(discussion.token, cover.token);
  assert.notEqual(discussion.tokenDigest, cover.tokenDigest);
  assert.deepEqual(discussion.heads, cover.heads);
  assert.ok(discussion.capabilities.includes('discussion_images'));
  assert.ok(discussion.capabilities.includes('target_cover'));
  assert.ok(!cover.capabilities.includes('discussion_images'));
  assert.doesNotThrow(() =>
    matchRatingDiscussionCoverObservation(discussion, cover),
  );
  assert.throws(() => decodeRatingTargetCoverContext(discussion));
  assert.throws(() => decodeRatingDiscussionMediaContext(cover));
  assert.throws(() =>
    decodeRatingDiscussionMediaContext({ ...cover, protocolVersion: 4 }),
  );
  assert.throws(() =>
    decodeRatingDiscussionMediaContext({
      ...cover,
      protocolVersion: 4,
      discussionMedia: discussion.discussionMedia,
    }),
  );
  const command = ratingDiscussionMediaCommandContext(discussion);
  assert.equal(command.id, discussion.id);
  assert.equal(command.token, discussion.token);
  assert.equal(command.tokenDigest, discussion.tokenDigest);
  assert.deepEqual(command.discussionMedia, discussion.discussionMedia);
  assert.notEqual(command.token, cover.token);
});
