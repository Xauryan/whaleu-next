import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  categories,
  decodePost,
  decodePostIntent,
  isCategory,
  isReadableCategory,
} from '../src/community/contract';
import {
  decodeSearchHit,
  decodeSearchIntent,
} from '../src/community/search-contract';
import {
  decodeCategoryManagement,
  decodeReclassificationCommand,
  isReclassificationCategory,
  reclassificationCategories,
} from '../src/category-reclassification/contract';
import { intent, post, postId, spaceId } from './community-helpers';
import { hitFromPost } from './search-helpers';
import {
  assertHomeReadableDelta,
  assertReviewedHomeReadableSuccessor,
  homeReadableCorrections,
  homeReadableEvidenceRoot,
  homeReadablePaths,
  homeReadablePredecessor,
  homeReadableProofPaths,
  homeReadableSuccessors,
} from './reviewed-home-readable-successor';
import {
  assertReviewedReadingSuccessor,
  readingSuccessors,
} from './reviewed-reading-successor';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const noRead = () => {
  throw new Error('unrecognized source/hash must not access proof');
};

for (const entry of homeReadableSuccessors) {
  test(`${entry.path}: exact 89e readable successor composes only through its own predecessor`, () => {
    for (const alias of [entry.path, `apps/wechat/${entry.path}`]) {
      assert.equal(
        assertReviewedHomeReadableSuccessor(alias, entry.before),
        true,
      );
      assert.equal(
        sha(homeReadablePredecessor(alias, read(entry.path))),
        entry.before,
      );
    }
    for (const expected of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ])
      assert.equal(
        assertReviewedHomeReadableSuccessor(entry.path, expected, noRead),
        false,
      );
    for (const file of [
      `./${entry.path}`,
      `other/${entry.path}`,
      `${entry.path}/`,
      `${entry.path}.bak`,
      entry.path.toUpperCase(),
      'constructor',
      '__proto__',
      'src/app.json',
      'src/pages/community-feed/community-feed.wxml',
    ]) {
      assert.equal(
        assertReviewedHomeReadableSuccessor(file, entry.before, noRead),
        false,
      );
      const untouched = Buffer.from('not an admitted source');
      assert.equal(homeReadablePredecessor(file, untouched, noRead), untouched);
    }
  });

  test(`${entry.path}: complete forward/reverse delta rejects duplicates, omissions and unrelated edits`, () => {
    const before = read(
      `${homeReadableEvidenceRoot}/${entry.evidence}`,
    ).toString('utf8');
    const current = read(entry.path).toString('utf8');
    assertHomeReadableDelta(entry.path, before, current);
    for (const [old, next] of homeReadableCorrections[entry.path]) {
      assert.throws(
        () => assertHomeReadableDelta(entry.path, `${before}\n${old}`, current),
        /one forward correction/,
      );
      assert.throws(
        () =>
          assertHomeReadableDelta(entry.path, before, `${current}\n${next}`),
        /one reverse correction/,
      );
      assert.throws(() =>
        assertHomeReadableDelta(entry.path, before.replace(old, ''), current),
      );
      assert.throws(() =>
        assertHomeReadableDelta(entry.path, before, current.replace(next, '')),
      );
    }
    assert.throws(
      () =>
        assertHomeReadableDelta(
          entry.path,
          before,
          `${current}\n// unrelated edit`,
        ),
      /exact complete forward source delta/,
    );
    assert.throws(() =>
      assertHomeReadableDelta(
        entry.path,
        `${before}\n// altered predecessor`,
        current,
      ),
    );
    assert.throws(() =>
      homeReadablePredecessor(entry.path, Buffer.from(before)),
    );
  });
}

test('every owner, accepted presentation, old action inventory and proof byte authenticates independently', () => {
  const proof = JSON.parse(
    read(`${homeReadableEvidenceRoot}/manifest.json`).toString('utf8'),
  ) as {
    unchanged: { path: string }[];
  };
  const first = homeReadableSuccessors[0]!;
  for (const target of [
    ...homeReadableProofPaths,
    'test/fixtures/reviewed-reading-successor/manifest.json',
    ...homeReadablePaths,
    ...proof.unchanged.map((entry) => entry.path),
  ]) {
    assert.throws(
      () =>
        assertReviewedHomeReadableSuccessor(
          first.path,
          first.before,
          (file) => {
            const bytes = read(file);
            if (file === target) bytes[0] = bytes[0]! ^ 1;
            return bytes;
          },
        ),
      target,
    );
  }
  // A valid requested owner cannot conceal a mixed old/new bundle elsewhere.
  for (const other of homeReadableSuccessors.slice(1))
    assert.throws(() =>
      assertReviewedHomeReadableSuccessor(first.path, first.before, (file) =>
        file === other.path
          ? read(`${homeReadableEvidenceRoot}/${other.evidence}`)
          : read(file),
      ),
    );
  assert.throws(() => assertHomeReadableDelta('src/unknown.ts', '', ''));
});

test('historical reading hashes remain strict and only three additional Home owners use direct 89e joins', () => {
  for (const entry of homeReadableSuccessors) {
    const reading = readingSuccessors.find((old) => old.path === entry.path);
    if (reading) {
      assert.equal(entry.before, reading.after);
      assert.equal(
        assertReviewedReadingSuccessor(entry.path, reading.before),
        true,
      );
      assert.equal(
        assertReviewedReadingSuccessor(entry.path, entry.before, noRead),
        false,
      );
    } else {
      assert.equal(
        assertReviewedReadingSuccessor(entry.path, entry.before),
        true,
      );
      assert.equal(
        assertReviewedReadingSuccessor(entry.path, entry.after, noRead),
        false,
      );
    }
  }
});

test('semantic authority: water is response-only, unknown categories and expanded write targets still fail closed', () => {
  const originalCategories = [
    'discussion',
    'feedback',
    'confession',
    'companions',
    'pets',
    'internships',
    'scenery',
    'dorms',
    'research',
    'deep_sea',
    'trading',
  ];
  assert.deepEqual(categories, originalCategories);
  assert.deepEqual(
    reclassificationCategories,
    originalCategories.filter(
      (category) => !['feedback', 'trading'].includes(category),
    ),
  );
  assert.equal(isReadableCategory('water'), true);
  assert.equal(isCategory('water'), false);
  assert.equal(isReclassificationCategory('water'), false);
  const water = post({ category: 'water' });
  assert.equal(decodePost(water).category, 'water');
  assert.equal(decodeSearchHit(hitFromPost(water)).category, 'water');
  const command = {
    clientRequestId: intent().clientRequestId,
    postId,
    expectedRevision: 0,
    targetCategory: 'water',
  };
  for (const category of ['water', 'unknown', 'Water', '', null, 0]) {
    assert.throws(() => decodePostIntent({ ...intent(), category }));
    assert.throws(() => decodeSearchIntent({ spaceId, category, q: '原文' }));
    assert.throws(() =>
      decodeReclassificationCommand({ ...command, targetCategory: category }),
    );
    if (category !== 'water') {
      assert.equal(isReadableCategory(category), false);
      assert.throws(() => decodePost({ ...water, category }));
      assert.throws(() => decodeSearchHit({ ...hitFromPost(water), category }));
    }
  }
  const unavailable = {
    postId,
    currentCategory: 'water',
    revision: 0,
    canChange: false,
    targets: [],
  };
  assert.deepEqual(decodeCategoryManagement(unavailable), unavailable);
  const explicit = { ...unavailable, canChange: true, targets: ['discussion'] };
  assert.deepEqual(decodeCategoryManagement(explicit), explicit);
  for (const patch of [
    { canChange: true },
    { targets: ['discussion'] },
    { canChange: true, targets: ['water'] },
    { canChange: true, targets: ['discussion', 'discussion'] },
    { canChange: true, targets: ['discussion'], revision: 2147483647 },
    { canChange: true, targets: ['discussion'], currentCategory: 'feedback' },
    { currentCategory: 'unknown' },
  ])
    assert.throws(() => decodeCategoryManagement({ ...unavailable, ...patch }));
});

test('semantic permission guards, nullable counts and anonymous identity remain exact outside the read-category delta', () => {
  const water = post({ category: 'water' });
  for (const count of [null, 0, 17]) {
    const actual = decodePost({
      ...water,
      commentCount: count,
      replyCount: count,
      discussionCount: count === null ? null : count * 2,
    });
    assert.equal(actual.commentCount, count);
    assert.equal(actual.replyCount, count);
    assert.equal(actual.discussionCount, count === null ? null : count * 2);
  }
  for (const count of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1, undefined])
    assert.throws(() => decodePost({ ...water, commentCount: count }));
  assert.throws(() =>
    decodePost({ ...water, space: { ...water.space, kind: 'global' } }),
  );
  assert.throws(() =>
    decodeSearchHit({
      ...hitFromPost(water),
      space: { ...water.space, kind: 'global' },
    }),
  );
  assert.throws(() =>
    decodePost({ ...water, author: { ...water.author, accountId: postId } }),
  );
  assert.throws(() => decodePost({ ...water, allowAnonymousDm: true }));
  const entry = homeReadableSuccessors[0]!;
  const before = read(`${homeReadableEvidenceRoot}/${entry.evidence}`).toString(
    'utf8',
  );
  const current = read(entry.path).toString('utf8');
  for (const [old, next] of [
    ["  'trading',\n] as const;", "  'trading',\n  'water',\n] as const;"],
    ["value === 'water' || isCategory(value)", "typeof value === 'string'"],
    ['value === null ||', 'value === undefined || value === null ||'],
  ] as const) {
    assert.ok(current.includes(old));
    assert.throws(() =>
      assertHomeReadableDelta(entry.path, before, current.replace(old, next)),
    );
  }
});
