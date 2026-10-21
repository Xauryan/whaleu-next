import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findContentReferences,
  isContentReferenceCode,
  splitContentReferenceText,
  truncateReferencePreview,
} from '../src/content-references/text';

const codes = (source: string): string[] =>
  findContentReferences(source).map((reference) => reference.code);

function assertReconstruction(source: string): void {
  const segments = splitContentReferenceText(source, true);
  assert.equal(segments.map((segment) => segment.text).join(''), source);
  let offset = 0;
  for (const segment of segments) {
    assert.equal(segment.start, offset);
    assert.equal(segment.text, source.slice(segment.start, segment.end));
    offset = segment.end;
  }
  assert.equal(offset, source.length);
}

function assertPreviewDoesNotInvent(source: string): void {
  const original = new Map(
    findContentReferences(source).map((reference) => [
      reference.start,
      reference.end,
    ]),
  );
  for (let limit = 0; limit <= source.length; limit++) {
    const preview = truncateReferencePreview(source, limit);
    assert.ok(
      preview.length <= limit + 13,
      `${JSON.stringify(source)} at ${limit}: output bound`,
    );
    for (const reference of findContentReferences(preview)) {
      assert.equal(
        original.get(reference.start),
        reference.end,
        `${JSON.stringify(source)} at ${limit}: invented ${reference.text}`,
      );
    }
    const prefix =
      preview.endsWith('...') && preview !== source
        ? preview.slice(0, -3)
        : preview;
    assert.ok(
      source.startsWith(prefix),
      'preview is an exact source prefix, not normalized text',
    );
    if (prefix.length < source.length && prefix.length > 0) {
      const before = prefix.charCodeAt(prefix.length - 1);
      const after = source.charCodeAt(prefix.length);
      assert.ok(
        !(
          before >= 0xd800 &&
          before <= 0xdbff &&
          after >= 0xdc00 &&
          after <= 0xdfff
        ),
      );
    }
  }
}

test('accepts only complete 7/8/9-digit ASCII nonzero codes, without inferring target kind', () => {
  assert.deepEqual(
    codes(
      '看看#5831947，（#82649135）。#123456 #0123456 #123456789 #1234567890 #5831947abc #5831947_ a#5831947 ##5831947 5831947',
    ),
    ['5831947', '82649135', '123456789'],
  );
  for (const value of ['1000000', '10000000', '100000000', '999999999'])
    assert.equal(isContentReferenceCode(value), true);
  for (const value of [
    null,
    undefined,
    1234567,
    '',
    '#1234567',
    '0123456',
    '000000000',
    '123456',
    '1234567890',
    '１２３４５６７',
    '١٢٣٤٥٦٧',
    '123456\n',
    '1234567\n',
  ]) {
    assert.equal(isContentReferenceCode(value), false, String(value));
  }
});

test('rejects preceding ASCII word/slash/hash/backslash and following ASCII word', () => {
  for (const before of ['a', 'Z', '0', '9', '_', '/', '#', '\\']) {
    assert.deepEqual(codes(`${before}#1234567`), [], before);
  }
  for (const after of ['a', 'Z', '0', '9', '_']) {
    assert.deepEqual(codes(`#123456789${after}`), [], after);
  }
  for (const adjacent of [
    '中',
    'é',
    '🙂',
    '１',
    '١',
    '\u0301',
    '\u200b',
    '\n',
    '\r',
    '\t',
    ' ',
    '。',
    '-',
    '(',
    ')',
  ]) {
    assert.deepEqual(
      codes(`${adjacent}#1234567${adjacent}`),
      ['1234567'],
      adjacent,
    );
  }
});

test('does not reinterpret Unicode digits or normalize source code points', () => {
  assert.deepEqual(
    codes('#１２３４５６７ #١٢٣٤٥٦٧ #123４567 #1234567８ #1234567中'),
    ['1234567', '1234567'],
  );
  assertReconstruction(
    '\u0000\ufeff\ud800\udc00\ud800\t#1234567\r\n👨‍👩‍👧‍👦 e\u0301\n\u2028\u2029',
  );
});

test('preserves every whitespace, newline, emoji and source offset', () => {
  const source = '🐳\r\n  看看#5831947\t#82649135 \n\n#123456789🙂\r 尾\u00a0';
  assert.deepEqual(
    findContentReferences(source).map(({ start, end, text }) => ({
      start,
      end,
      text,
    })),
    [
      { start: 8, end: 16, text: '#5831947' },
      { start: 17, end: 26, text: '#82649135' },
      { start: 29, end: 39, text: '#123456789' },
    ],
  );
  assertReconstruction(source);
  assertReconstruction('');
  assertReconstruction('#1234567#12345678');
});

test('requires capability strictly true, including for empty and unavailable content', () => {
  const source = '\t#1234567\r\n';
  for (const capability of [
    false,
    undefined,
    null,
    0,
    1,
    'true',
    'false',
    {},
    [],
  ]) {
    assert.deepEqual(splitContentReferenceText(source, capability), [
      { kind: 'text', start: 0, end: source.length, text: source },
    ]);
  }
  assert.deepEqual(splitContentReferenceText('', true), [
    { kind: 'text', start: 0, end: 0, text: '' },
  ]);
  assert.equal(
    splitContentReferenceText(source, true).filter(
      (segment) => segment.kind === 'reference',
    ).length,
    1,
  );
});

test('full scheme URLs win, including unknown schemes, unsupported hosts and fragments', () => {
  for (const prefix of [
    'https://example.com/',
    'HTTP://localhost?',
    'ftp://host.invalid/path?q=',
    'custom+v2.1://not_a_host?',
    '1abc://x?',
    '.abc://x?',
    'x://💥?',
  ]) {
    assert.deepEqual(
      codes(`${prefix}#5831947，看看#82649135`),
      ['82649135'],
      prefix,
    );
  }
  assert.deepEqual(
    codes('abc:def?#1234567'),
    ['1234567'],
    'a colon without :// does not create a full URL',
  );
  assert.deepEqual(
    codes('scheme://x?before=#1234567&after=#12345678#123456789'),
    [],
  );
  assert.deepEqual(codes('scheme://x?#1234567🙂#12345678'), []);
});

test('full URL delimiters follow the pinned legacy contract, not generic URL parsing', () => {
  for (const separator of [
    ' ',
    '\t',
    '\r',
    '\n',
    '<',
    '>',
    '"',
    '，',
    '。',
    '！',
    '？',
    '；',
    '、',
    '（',
    '）',
    '【',
    '】',
  ]) {
    assert.deepEqual(
      codes(`other://x?${separator}#1234567`),
      ['1234567'],
      separator,
    );
  }
  for (const notSeparator of [
    '`',
    "'",
    '(',
    ')',
    '[',
    ']',
    '“',
    '”',
    '：',
    '…',
    '—',
    '\u200b',
  ]) {
    assert.deepEqual(
      codes(`other://x?${notSeparator}#1234567`),
      [],
      notSeparator,
    );
  }
});

test('bare, www, escaped HTTP and escaped bare contacts have precedence', () => {
  for (const prefix of [
    'example.com?',
    'www.example.invalid?',
    'WWW.EXAMPLE.INVALID?',
    'example.com:65535?',
    'https:\\/\\/example.com?',
    'example\\.com?',
    'example.com/路径?',
    'example.com/#片段?',
    'example.com\\?',
  ]) {
    const source = `${prefix}#1234567 看#12345678`;
    assert.deepEqual(codes(source), ['12345678'], prefix);
    assertReconstruction(source);
  }
  assert.deepEqual(codes('a@example.com name+tag@example.org #1234567'), [
    '1234567',
  ]);
  assert.deepEqual(codes('file.js?#1234567 example.invalid?#12345678'), [
    '1234567',
    '12345678',
  ]);
});

test('contact bounds reject invalid ports/hosts and unsupported path terminators without guessing', () => {
  for (const prefix of [
    'example.com:0?',
    'example.com:65536?',
    'example.com:123456?',
    '-example.com?',
    'a..com?',
    'a@example.com?',
    'example.com_?',
  ]) {
    assert.deepEqual(codes(`${prefix}#1234567`), ['1234567'], prefix);
  }
  assert.deepEqual(codes('example.com?#1234567💥'), ['1234567']);
  assert.deepEqual(codes('example.com?#1234567\u200b'), ['1234567']);
  assert.deepEqual(codes('example.com?#1234567，#12345678'), ['12345678']);
});

test('email overlap suppresses a reference even when the hash is outside the contact', () => {
  for (const source of [
    '#1234567@example.com',
    '#12345678\\@example.com',
    '#123456789@example\\.com',
    'a.com?#1234567@example.com💥',
  ]) {
    assert.deepEqual(codes(source), [], source);
    assertReconstruction(source);
    assertPreviewDoesNotInvent(source);
  }
  assert.deepEqual(
    codes('#1234567@invalid #12345678@a..com #123456789@example.com_'),
    ['1234567', '12345678', '123456789'],
  );
  assert.deepEqual(codes('#1234567@example.com?#12345678'), ['12345678']);
});

test('externally identified contacts win by overlap, without mutation or trusting invalid ranges', () => {
  const source = '#1234567 #12345678 #123456789';
  const contacts = Object.freeze([
    Object.freeze({ start: 12, end: 18 }),
    Object.freeze({ start: 1, end: 4 }),
    Object.freeze({ start: 0, end: 2 }),
    Object.freeze({ start: -1, end: 100 }),
    Object.freeze({ start: 0.5, end: 30 }),
    Object.freeze({ start: 0, end: source.length + 1 }),
    Object.freeze({ start: 19, end: 19 }),
  ]);
  assert.deepEqual(
    findContentReferences(source, contacts).map((reference) => reference.code),
    ['123456789'],
  );
  assert.equal(
    splitContentReferenceText(source, true, contacts)
      .map((segment) => segment.text)
      .join(''),
    source,
  );
});

test('plain content never becomes Markdown, including literal code/link/image/definition syntax', () => {
  const source =
    '`#1234567`\n```\n#12345678\n```\n**#123456789**\n[ #2345678 ](target)\n![#3456789](image)\n[label]: #4567890\n<table>#5678901</table>';
  assert.deepEqual(codes(source), [
    '1234567',
    '12345678',
    '123456789',
    '2345678',
    '3456789',
    '4567890',
    '5678901',
  ]);
  assertReconstruction(source);
  assert.deepEqual(codes('[ #1234567 ](https://example.com/#2345678)'), [
    '1234567',
  ]);
});

test('preview extends short intersecting runs instead of fabricating a shorter code', () => {
  const prefix = '文'.repeat(22);
  assert.equal(
    truncateReferencePreview(`${prefix}#82649135后续正文`, 30),
    `${prefix}#82649135...`,
  );
  assert.deepEqual(
    codes(truncateReferencePreview(`${prefix}#123456789后续正文`, 30)),
    ['123456789'],
  );
  assert.equal(
    truncateReferencePreview('文'.repeat(35), 30),
    `${'文'.repeat(30)}...`,
  );
  assert.equal(truncateReferencePreview('#12345678', 5), '#12345678');
  assert.equal(truncateReferencePreview('#1234567abc', 8), '#1234567a...');
});

test('preview deliberately drops intersecting overlong runs to keep output bounded', () => {
  for (const run of ['1234567890', '0'.repeat(50), '1'.repeat(100_000)]) {
    const source = `前#${run}后`;
    assert.equal(truncateReferencePreview(source, 9), '前...');
    assert.deepEqual(codes(truncateReferencePreview(source, 9)), []);
  }
});

test('preview preserves complete source when no truncation is necessary and validates budget', () => {
  for (const source of ['', '#1234567', '🙂\r\n', 'literal...']) {
    assert.equal(truncateReferencePreview(source, source.length), source);
    assert.equal(truncateReferencePreview(source, source.length + 1), source);
  }
  for (const limit of [
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => truncateReferencePreview('x', limit), RangeError);
  }
  assert.equal(truncateReferencePreview('🐳abc', 1), '...');
  assert.equal(truncateReferencePreview('x🐳abc', 2), 'x...');
  assert.equal(truncateReferencePreview('x', 0), '...');
});

test('every preview boundary preserves reference identity across invalid runs, contacts and code points', () => {
  for (const source of [
    '#123456 #0123456 #000000000 #1234567890 #123456789 #12345678 #1234567',
    '#1234567abc #12345678_ #123456789x a#1234567 /#12345678 ##123456789 \\#1234567',
    '🐳\r\n#1234567🙂#12345678中#123456789\u200b',
    'other+scheme://💥?#1234567&x=#12345678，#123456789',
    'example.com?#1234567，www.example.invalid?#12345678；#123456789',
    'https:\\/\\/example.com?#1234567 example\\.com?#12345678 #123456789',
    'example.com?#1234567💥 #1234567word #1234567#1234567',
    '#1234567@example.com #12345678\\@example.com #123456789@example\\.com',
    '`#1234567` **#12345678** [#123456789](x) literal...',
  ])
    assertPreviewDoesNotInvent(source);
});

test(
  'long adversarial schemes, hosts, invalid URL tails and digit runs finish without regex backtracking',
  { timeout: 10_000 },
  () => {
    const source = `${'a'.repeat(200_000)} #${'1'.repeat(200_000)} ${'a.'.repeat(100_000)} #1234567`;
    assert.deepEqual(codes(source), ['1234567']);
    assertReconstruction(source);
    const invalidPath = `${'a.com?#1234567&'.repeat(10_000)}💥`;
    assert.equal(findContentReferences(invalidPath).length, 10_000);
    const url = `unknown+v1://${'x?#1234567&'.repeat(10_000)} #12345678`;
    assert.deepEqual(codes(url), ['12345678']);
    const escaped = `${'a\\.'.repeat(50_000)} #123456789`;
    assert.deepEqual(codes(escaped), ['123456789']);
    assertReconstruction(escaped);
  },
);

test('deterministic mixed-text fixtures reconstruct exactly and never shorten digit identities', () => {
  const atoms = [
    '文',
    '🙂',
    '\r\n',
    ' ',
    '#1234567',
    '#12345678',
    '#123456789',
    '#0123456',
    '#1234567890',
    '_',
    '\\',
    '/',
    'a',
    '#',
    'other://x?',
    '，',
    '`',
    '[',
    ']',
    'example.com?',
  ];
  let state = 17;
  for (let sample = 0; sample < 80; sample++) {
    let source = '';
    for (let index = 0; index < 10; index++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      source += atoms[state % atoms.length];
    }
    assertReconstruction(source);
    assertPreviewDoesNotInvent(source);
  }
});
