import assert from 'node:assert/strict';
import { legacyHomeLowercase } from '../src/community/home-feed-policy/legacy-lowercase.js';
import { test } from 'node:test';
import { legacyHomePlainText } from '../src/community/home-feed-policy/legacy-plain-text.js';
import { decodeLegacyHtmlEntities } from '../src/community/home-feed-policy/php-text.js';
import {
  legacyDigitClass,
  legacyLetterNumberClass,
} from '../src/community/home-feed-policy/legacy-unicode.js';

// Fixed4494 content-plain-text-cases.json blob40eea6fdafc86fe7f6ebe307313d6171df2dd4ce.
const sourceCases: readonly (readonly [string, string])[] = [
  ['## 抽', '抽'],
  ['# 标题\n正文', '标题\n正文'],
  ['这是**重点**和*斜体*及~~旧文~~', '这是重点和斜体及旧文'],
  ['***~~删除加粗~~***', '删除加粗'],
  ['标题\n===\n\n正文', '标题\n\n正文'],
  ['> 引用\n> 第二行', '引用\n第二行'],
  ['- 第一项\n- [x] 第二项', '• 第一项\n• 第二项'],
  ['1. 第一项\n2. 第二项', '1. 第一项\n2. 第二项'],
  ['[说明](https://example.edu/a_(b))', '说明（https://example.edu/a_(b)）'],
  [
    '[说明][a]\n\n[a]: https://example.edu/some_path',
    '说明（https://example.edu/some_path）',
  ],
  ['![校园图片](photo.png)', '校园图片'],
  ['![](photo.png)', ''],
  ['|姓名|时间|\n|---|---|\n|同学|周一|', '姓名 / 时间\n同学 / 周一'],
  ["```js\nconst x = '**原样**';\n```", "const x = '**原样**';"],
  ['`a_b **literal**`', 'a_b **literal**'],
  ['\\# 标题与\\*字面星号\\*', '# 标题与*字面星号*'],
  [
    '<https://example.edu/a_b> &amp; <b>原始HTML</b>',
    'https://example.edu/a_b & <b>原始HTML</b>',
  ],
  [
    '看看#1088889，https://example.edu/a_b，2 * 3 * 4',
    '看看#1088889，https://example.edu/a_b，2 * 3 * 4',
  ],
  ['## 第一行\r\n正文🐳', '第一行\n正文🐳'],
  ['**跨行\n加粗**', '跨行\n加粗'],
];
for (const [source, expected] of sourceCases)
  test(`fixed source converter ${JSON.stringify(source)}`, () => {
    assert.equal(legacyHomePlainText(source, 'markdown'), expected);
    assert.equal(legacyHomePlainText(source, 'plain'), source);
  });

test('PHP strict named entities, aliases, pairs and single-pass semantics', () => {
  assert.equal(
    decodeLegacyHtmlEntities('&num;&Tab;&NewLine;&nbsp;&NotEqualTilde;&apos;'),
    '#\t\n\u00a0\u2242\u0338' + "'",
  );
  assert.equal(
    decodeLegacyHtmlEntities('&amp;#32; &amp;nbsp; &NewLine &unknown; &AMP;'),
    '&#32; &nbsp; &NewLine &unknown; &',
  );
});

test('PHP numeric entities are not HTML browser replacement or remapping', () => {
  for (const cp of [
    0, 1, 8, 11, 13, 31, 127, 128, 159, 0xd800, 0xdfff, 0xfdd0, 0xfdef, 0xfffe,
    0xffff, 0x1fffe, 0x10ffff, 0x110000,
  ]) {
    const source = `&#${cp};`;
    assert.equal(decodeLegacyHtmlEntities(source), source);
  }
  for (const cp of [
    9, 10, 12, 32, 160, 0x180e, 0xd7ff, 0xe000, 0xfdcf, 0xfdf0, 0x1f600,
    0x10fffd,
  ]) {
    assert.equal(
      decodeLegacyHtmlEntities(`&#${cp};`),
      String.fromCodePoint(cp),
    );
    assert.equal(
      decodeLegacyHtmlEntities(`&#x${cp.toString(16)};`),
      String.fromCodePoint(cp),
    );
  }
  assert.equal(decodeLegacyHtmlEntities('&#x0x41;&#X0X00041;'), 'AA');
  assert.equal(
    decodeLegacyHtmlEntities('&#x00x41;&#0x41;&#x0x;&#-1;&#32 &#x20'),
    '&#x00x41;&#0x41;&#x0x;&#-1;&#32 &#x20',
  );
  assert.equal(decodeLegacyHtmlEntities('&#' + '0'.repeat(1000) + '32;'), ' ');
});

test('protected code, escaped punctuation and URL segments are never recursively decoded', () => {
  assert.equal(
    legacyHomePlainText(
      '`&amp; **x**` \\*a\\* <https://x.test/a_b?x=&amp;>',
      'markdown',
    ),
    '&amp; **x** *a* https://x.test/a_b?x=&amp;',
  );
  assert.equal(
    legacyHomePlainText('[label](https://x.test/a_b)', 'markdown', false),
    'label',
  );
  assert.equal(
    legacyHomePlainText(
      '[label][A]\n[A]: https://x.test/a_b',
      'markdown',
      false,
    ),
    'label',
  );
});

test('legacy table byte slicing drops an invalid UTF8 line, not replacement characters', () => {
  for (const edge of ['\u00a0', '\u3000']) {
    assert.equal(
      legacyHomePlainText(edge + '|#10000000|' + edge, 'markdown'),
      '',
    );
    assert.equal(
      legacyHomePlainText(
        'before\n' + edge + '|#10000000|' + edge + '\nafter',
        'markdown',
      ),
      'before\n\nafter',
    );
  }
});

test('PHP Unicode whitespace differs from JavaScript trim and regex whitespace', () => {
  for (const space of ['\u0085', '\u180e', '\u3000'])
    assert.equal(
      legacyHomePlainText('#' + space + '#10000000', 'markdown'),
      '#10000000',
    );
  assert.equal(
    legacyHomePlainText('#\ufeff#10000000', 'markdown'),
    '#\ufeff#10000000',
  );
  assert.equal(legacyHomePlainText('**a\u2028b**', 'markdown'), 'a\u2028b');
});

test('frozen PCRE Unicode sets avoid Node Unicode17 category drift', () => {
  const digit = new RegExp('^' + legacyDigitClass + '$', 'u');
  const letterNumber = new RegExp('^' + legacyLetterNumberClass + '$', 'u');
  assert.equal(digit.test('١'), true);
  assert.equal(digit.test('\u{11de0}'), false);
  assert.equal(letterNumber.test('中'), true);
  assert.equal(letterNumber.test('\u{088f}'), false);
  assert.equal(letterNumber.test('\u{16ff4}'), false);
  assert.equal(legacyHomePlainText('١. #10000000', 'markdown'), '١. #10000000');
  assert.equal(
    legacyHomePlainText('\u{11de0}) #10000000', 'markdown'),
    '\u{11de0}) #10000000',
  );
  assert.equal(legacyHomePlainText('\u{088f}_a_', 'markdown'), '\u{088f}a');
});

test('reference key casing is PHP-frozen, including sigma context and buffer boundaries', () => {
  assert.equal(legacyHomeLowercase('ASCII ÄİΣ'), 'ascii äi\u0307ς');
  assert.equal(legacyHomeLowercase('AΣ꟎'), 'aς꟎');
  assert.equal(legacyHomeLowercase('꟎Σ'), '꟎σ');
  assert.equal(legacyHomeLowercase('A'.repeat(63) + 'Σ'), 'a'.repeat(63) + 'ς');
  assert.equal(legacyHomeLowercase('A'.repeat(64) + 'Σ'), 'a'.repeat(64) + 'ς');
  assert.equal(
    legacyHomePlainText('[text][AΣ꟎]\n[aς꟎]: https://x.test', 'markdown'),
    'text（https://x.test）',
  );
});

test('unknown protected-looking text cannot consume the start of an overlapping real key', () => {
  for (const unknown of ['999', '00', '1']) {
    assert.equal(
      legacyHomePlainText('\u001a' + unknown + '\u001a0\u001a `X`', 'markdown'),
      '\u001a' + unknown + 'X X',
    );
  }
});
