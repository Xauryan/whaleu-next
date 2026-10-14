import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRatingRoute } from '../src/ratings/controller';
const category = '12345678-1234-4123-8123-123456789abc',
  region = 'abcdef12-1234-4123-8123-123456789abc';
test('promotion uses only registered catalog parent/context UUID locator and introduces no send control', () => {
  assert.deepEqual(decodeRatingRoute({ parentId: category }, 'catalog'), {
    parentId: category,
  });
  assert.deepEqual(
    decodeRatingRoute({ parentId: category, regionId: region }, 'catalog'),
    { parentId: category, regionId: region },
  );
  for (const route of [
    { categoryId: '60' },
    { parentId: '60' },
    { parentId: category, title: '课程' },
    { parentId: category, testDestinationId: region },
    { parentId: category, promotionId: region },
    { parentId: category, isSystem: 'true' },
    { parentId: category, levelCount: '3' },
  ])
    assert.throws(() => decodeRatingRoute(route, 'catalog'));
  const app = JSON.parse(
    readFileSync(join(__dirname, '../src/app.json'), 'utf8'),
  ) as { pages: string[] };
  assert.ok(app.pages.includes('pages/rating-catalog/rating-catalog'));
  assert.ok(!app.pages.some((page) => page.includes('group-promotion')));
});
