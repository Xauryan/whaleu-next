import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { ratingTime, ratingTimeLabels } from '../src/ratings/presentation';

type Action = { tag: string; attrs: Record<string, string> };
const root = path.join(__dirname, '../src');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/ratings-product-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
function actions(source: string): Action[] {
  return [...source.matchAll(/<([\w-]+)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)]
    .map((match) => ({
      tag: match[1]!,
      attrs: Object.fromEntries(
        [...match[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [
          a[1]!,
          a[2]!,
        ]),
      ),
    }))
    .map((node) => normalizeFramework7ActionNode({ ...node, children: [] }))
    .filter(
      ({ tag, attrs }) =>
        tag === 'navigator' ||
        Object.keys(attrs).some((key) => /^(bind|catch)/.test(key)),
    );
}
for (const [file, original] of Object.entries(inventory)) {
  test(`${file} retains every original route, event, data binding and per-control guard`, () => {
    const current = actions(
      read(
        file === 'ratings/common.wxml'
          ? 'ratings/framework7-product.wxml'
          : file.replace('/common.wxml', '/product.wxml'),
      ),
    );
    for (const previous of original) {
      const expected = { ...previous.attrs };
      // Strengthened nullable thumbnail access; never promotes an unavailable image.
      if (
        file.includes('rating-scoped') &&
        expected['wx:if'] === '{{coverThumbnails[item.id].localSrc}}'
      ) {
        expected['wx:if'] =
          '{{coverThumbnails[item.id] &amp;&amp; coverThumbnails[item.id].localSrc}}';
      }
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === previous.tag &&
          Object.entries(expected).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      assert.notEqual(
        index,
        -1,
        `Missing or weakened action: ${JSON.stringify(previous)}`,
      );
      current.splice(index, 1);
    }
  });
}

test('public rating and course journeys are isolated from admin styles and parse structurally', () => {
  const pages = Object.keys(inventory).filter((file) =>
    file.startsWith('pages/'),
  );
  const parser = pathToFileURL(
    path.join(__dirname, '../scripts/preview-wxml.mjs'),
  ).href;
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import {readFileSync} from 'node:fs'; import {parsePreviewWxml} from ${JSON.stringify(parser)}; for (const file of ${JSON.stringify(pages.map((file) => path.join(root, file)))}) parsePreviewWxml(readFileSync(file,'utf8'));`,
  ]);
  for (const file of pages) {
    assert.match(read(file), /class="screen (rating|course)-product/);
    assert.doesNotMatch(
      read(file),
      /WHALEU ·|Unicode 字符|grade_score|ability_score|overall_score/,
    );
    assert.match(
      read(file.replace('.wxml', '.wxss')),
      /ratings\/product\.wxss/,
    );
  }
  assert.doesNotMatch(read('ratings/ratings.wxss'), /product-/);
  assert.doesNotMatch(read('course-ratings/course-ratings.wxss'), /product-/);
});

test('scores preserve zero, unavailable and unknown states without invented summary values', () => {
  const detail = read('pages/rating-detail/rating-detail.wxml');
  assert.match(detail, /!summary \|\| summary.status === 'unavailable'/);
  assert.match(detail, /summary.count === 0/);
  assert.match(detail, /!myScoreKnown/);
  assert.match(
    detail,
    /myScoreKnown &amp;&amp; detail.allowedActions.setScore/,
  );
  assert.match(detail, /selectedScore !== null/);
  const course = read('pages/course-rating-detail/course-rating-detail.wxml');
  assert.match(course, /detail.myScore.kind === 'unavailable'/);
  assert.match(course, /gradeScore === null/);
  assert.match(course, /abilityScore === null/);
  assert.match(course, /overallScore === null/);
  assert.match(course, /提交后不能修改或删除/);
  assert.match(course, /wx:if="{{canScore}}"/);
});

test('reading surfaces use flat content and contextual actions instead of administrative panels', () => {
  assert.match(
    read('pages/rating-detail/rating-detail.wxml'),
    /class="product-comment"/,
  );
  assert.match(
    read('pages/rating-detail/rating-detail.wxml'),
    /uiPanel === 'comment:' \+ item.id/,
  );
  assert.match(
    read('pages/rating-thread/rating-thread.wxml'),
    /uiPanel === 'reply:' \+ item.id/,
  );
  assert.match(
    read('pages/course-comments/course-comments.wxml'),
    /uiPanel === 'compose' &amp;&amp; !confirming/,
  );
  assert.match(
    read('pages/course-rating-detail/course-rating-detail.wxml'),
    /uiPanel === 'score' &amp;&amp; !confirming/,
  );
  assert.match(
    read('pages/rating-scoped/rating-scoped.wxml'),
    /uiPanel === 'cover' \|\| coverUpload.status !== 'idle'/,
  );
  assert.match(
    read('ratings/product.wxss'),
    /background: var\(--wu-elevated\)/,
  );
  assert.match(read('ratings/product.wxss'), /env\(safe-area-inset-bottom\)/);
});

test('presentation disclosures clear on hide, show and authentication loss without touching mutation controllers', () => {
  for (const file of [
    'ratings/page.ts',
    'ratings/scoped-page.ts',
    'course-ratings/page.ts',
    'pages/rating-thread/rating-thread.ts',
    'pages/rating-random/rating-random.ts',
    'pages/course-comments/course-comments.ts',
  ]) {
    const source = read(file);
    assert.match(source, /onShow\(\) \{\s*this.setData\(\{ uiPanel: '' \}\)/);
    assert.match(source, /onHide\(\) \{\s*this.setData\(\{ uiPanel: '' \}\)/);
    assert.match(
      source,
      /!view.hasSession \|\| !view.loaded \? \{ uiPanel: '' \} : \{\}/,
    );
    assert.match(source, /this.data.uiPanel === panel \? '' : panel/);
    assert.match(
      source,
      /onClosePanel\(\) \{\s*this.setData\(\{ uiPanel: '' \}\)/,
    );
  }
});

test('display dates do not invent freshness or mutate source records', () => {
  const now = new Date(2026, 9, 20, 14, 0).getTime();
  assert.equal(ratingTime('invalid', now), '');
  assert.equal(ratingTime('', now), '');
  assert.equal(
    ratingTime(new Date(2026, 9, 20, 12, 5).toISOString(), now),
    '12:05',
  );
  assert.equal(
    ratingTime(new Date(2026, 9, 19, 12, 5).toISOString(), now),
    '10月19日',
  );
  assert.equal(
    ratingTime(new Date(2025, 9, 19, 12, 5).toISOString(), now),
    '2025年10月19日',
  );
  const source = Object.freeze([
    { id: 'reply', createdAt: new Date(2026, 9, 20, 12, 5).toISOString() },
  ]);
  assert.deepEqual(ratingTimeLabels(source, now), { reply: '12:05' });
  assert.ok(source[0]!.createdAt.includes('T'));
  assert.doesNotMatch(
    read('ratings/product.wxss'),
    /min-height: (64|68|76)rpx/,
  );
});

test('public pages use original icon components and do not repeat native page titles', () => {
  for (const file of Object.keys(inventory).filter((file) =>
    file.startsWith('pages/'),
  )) {
    const template = read(file);
    assert.doesNotMatch(template, /•••|›|▾/);
    assert.doesNotMatch(template, /'实名'/);
    if (template.includes('<wu-icon')) {
      const config = JSON.parse(read(file.replace('.wxml', '.json'))) as {
        usingComponents?: Record<string, string>;
      };
      assert.equal(
        config.usingComponents?.['wu-icon'],
        '../../components/icon/icon',
      );
    }
  }
  assert.doesNotMatch(
    read('pages/rating-thread/rating-thread.wxml'),
    /<view class="meta">评价与回复/,
  );
  assert.doesNotMatch(
    read('pages/course-rating-detail/course-rating-detail.wxml'),
    /<view class="meta">课程评分/,
  );
  assert.doesNotMatch(
    read('pages/course-comments/course-comments.wxml'),
    /<view class="title">课程回复/,
  );
});
