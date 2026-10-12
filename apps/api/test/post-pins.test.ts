import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  pinCommandSchema,
  pinQuerySchema,
} from '../src/community/post-pins/contracts.js';
import { pinIntentHash } from '../src/community/post-pins/service.js';
test('post pin strict duration/level defaults, exact scope filter and immutable intent', () => {
  const base = {
    clientRequestId: randomUUID(),
    operation: 'pin',
    postId: randomUUID(),
  };
  const command = pinCommandSchema.parse(base);
  assert.equal(command.operation, 'pin');
  assert.deepEqual(command, { ...base, durationHours: 24, level: 2 });
  for (const durationHours of [0, 169, 1.5, '24', null, NaN])
    assert.equal(
      pinCommandSchema.safeParse({ ...base, durationHours }).success,
      false,
    );
  for (const durationHours of [1, 168])
    assert.equal(
      pinCommandSchema.safeParse({ ...base, durationHours }).success,
      true,
    );
  for (const level of [0, 3, '2', null])
    assert.equal(pinCommandSchema.safeParse({ ...base, level }).success, false);
  for (const field of ['regionId', 'spaceId', 'accountId', 'readAt'])
    assert.equal(
      pinCommandSchema.safeParse({ ...base, [field]: randomUUID() }).success,
      false,
    );
  const actor = randomUUID();
  assert.equal(
    pinIntentHash(actor, command),
    pinIntentHash(
      actor,
      pinCommandSchema.parse({ ...base, durationHours: 24, level: 2 }),
    ),
  );
  assert.notEqual(
    pinIntentHash(actor, command),
    pinIntentHash(actor, pinCommandSchema.parse({ ...base, durationHours: 1 })),
  );
  assert.equal(
    pinQuerySchema.safeParse({ spaceId: randomUUID(), tradingSubtype: 'shuma' })
      .success,
    false,
  );
  assert.equal(
    pinCommandSchema.safeParse({
      clientRequestId: randomUUID(),
      operation: 'read',
      postId: randomUUID(),
    }).success,
    false,
  );
});
