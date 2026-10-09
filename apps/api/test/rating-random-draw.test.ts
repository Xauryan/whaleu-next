import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RatingRandomDraw } from '../src/ratings/random/draw.js';
import { ApplicationError } from '../src/http/application-error.js';
test('random draw supports full-pool sizes rather than a page capacity', () => {
  const draw = new RatingRandomDraw();
  assert.equal(draw.index(1), 0);
  for (const size of [129, 1001, 2048, 10000])
    for (let i = 0; i < 32; i++) {
      const index = draw.index(size);
      assert.equal(Number.isInteger(index), true);
      assert.ok(index >= 0 && index < size);
    }
});
test('random draw rejects invalid counts before crypto sampling', () => {
  const draw = new RatingRandomDraw();
  for (const size of [
    0,
    -1,
    1.1,
    NaN,
    Infinity,
    2 ** 48,
    Number.MAX_SAFE_INTEGER,
  ])
    assert.throws(() => draw.index(size), ApplicationError);
});
