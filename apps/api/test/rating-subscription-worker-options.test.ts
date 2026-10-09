import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  parseRatingSubscriptionCommand,
  ratingSubscriptionWorkerSchema,
} from '../src/notifications/ratings/subscription-worker.js';
import { ratingUpdatesCursorScope } from '../src/notifications/ratings/cursor.js';
import { ratingSubscriptionUpdatesCursorScope } from '../src/notifications/ratings/subscription-cursor.js';
test('subscription worker defaults to bounded true dry-run and requires explicit unique apply IDs', () => {
  assert.deepEqual(parseRatingSubscriptionCommand([]), {
    mode: 'dry-run',
    eventIds: [],
    maxPages: 2,
    maxRecipients: 50,
  });
  const id = randomUUID();
  assert.deepEqual(
    parseRatingSubscriptionCommand([
      'apply',
      `--event-id=${id}`,
      '--max-pages=3',
      '--max-recipients=75',
    ]),
    { mode: 'apply', eventIds: [id], maxPages: 3, maxRecipients: 75 },
  );
  for (const args of [
    ['apply'],
    ['--all'],
    ['--event-id=not-a-uuid'],
    [`--event-id=${id}`, `--event-id=${id}`],
    ['--max-pages=0'],
    ['--max-pages=21'],
    ['--max-recipients=1001'],
    ['--max-pages=2', '--max-pages=2'],
    ['--max-pages=02'],
    ['--max-recipients=1.5'],
  ])
    assert.throws(() => parseRatingSubscriptionCommand(args));
  for (const extra of [
    { accountId: id },
    { automatic: true },
    { maxRecipients: 0 },
    { maxPages: 1.5 },
    { eventIds: Array.from({ length: 51 }, () => randomUUID()) },
  ])
    assert.equal(
      ratingSubscriptionWorkerSchema.safeParse(extra).success,
      false,
    );
});
test('subscription cursor scope is isolated from reply and like cursors and binds owner/session/limit/token', () => {
  const a = randomUUID(),
    s = randomUUID(),
    scope = ratingSubscriptionUpdatesCursorScope(a, s, 'token', 20);
  assert.notEqual(scope, ratingUpdatesCursorScope(a, s, 'token', 20));
  assert.notEqual(scope, ratingUpdatesCursorScope(a, s, 'token', 20, 'like'));
  for (const other of [
    ratingSubscriptionUpdatesCursorScope(randomUUID(), s, 'token', 20),
    ratingSubscriptionUpdatesCursorScope(a, randomUUID(), 'token', 20),
    ratingSubscriptionUpdatesCursorScope(a, s, 'other', 20),
    ratingSubscriptionUpdatesCursorScope(a, s, 'token', 19),
  ])
    assert.notEqual(scope, other);
});
