import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateLegacyHomePolicy,
  LEGACY_HOME_POLICY_COMMIT,
  legacyHomeReferenceCodes,
  trimLegacyHomeText,
} from '../src/community/home-feed-policy/policy.js';
import type { HomePolicyInput } from '../src/community/home-feed-policy/policy.js';

function input(
  text: string,
  format: 'plain' | 'markdown' = 'plain',
  overrides: Partial<HomePolicyInput> = {},
): HomePolicyInput {
  return {
    originalCategory: { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose: 2 },
    text,
    format,
    hasImages: false,
    hasPoll: false,
    hasGroup: false,
    hasLink: false,
    auditExempt: false,
    ...overrides,
  };
}
function reason(value: HomePolicyInput): string | null {
  const result = evaluateLegacyHomePolicy(value);
  assert.equal(result.status, 'resolved');
  return result.restriction?.reason ?? null;
}

for (const format of ['plain', 'markdown'] as const) {
  for (const text of [
    'a',
    '测试',
    '三个字',
    '  测试  ',
    '\t\n\r\0\v测试\t\n\r\0\v',
    '😀😀😀',
    'e\u0301',
  ])
    test(`${format}: raw scalar short ${JSON.stringify(text)}`, () => {
      assert.equal(reason(input(text, format)), 'short_text');
    });
  for (const text of [
    '四个汉字',
    '😀😀😀😀',
    '\u3000测试\u3000',
    '\u00a0测试\u00a0',
    '\f测试\f',
  ])
    test(`${format}: raw long ${JSON.stringify(text)}`, () => {
      assert.equal(reason(input(text, format)), null);
    });
}

test('PHP trim excludes Unicode spaces and formfeed; source is not modified', () => {
  assert.equal(trimLegacyHomeText(' \0\v\t\r\na\t\r\n\0\v '), 'a');
  assert.equal(
    trimLegacyHomeText('\f\u00a0\u3000a\u3000\u00a0\f'),
    '\f\u00a0\u3000a\u3000\u00a0\f',
  );
  const original = Object.freeze(input('\r\n测试\r\n', 'markdown'));
  assert.equal(reason(original), 'short_text');
  assert.equal(original.text, '\r\n测试\r\n');
});

for (const text of ['`a`', '# a'])
  test(`Markdown short branch precedes code/format exclusions: ${text}`, () => {
    assert.equal(reason(input(text, 'markdown')), 'short_text');
  });
for (const text of ['**字**', '## 抽'])
  test(`Markdown is not counted after rendering: ${text}`, () => {
    assert.equal(reason(input(text, 'markdown')), null);
  });

for (const text of [
  '#1000000',
  '#10000000',
  '#100000000',
  '#10000000\n#100000001',
  '\u3000#10000000\u00a0#100000001\u3000',
  '#10000000#10000000',
])
  test(`plain exact reference-only ${JSON.stringify(text)}`, () => {
    assert.equal(reason(input(text)), 'reference_only');
  });
for (const text of [
  '看看 #10000000',
  '#10000000 好',
  '#10000000，',
  '#01234567',
  '#123456',
  '#1234567890',
  'abc#10000000',
  '/#10000000',
  'https://example.test/#10000000',
  '\\#10000000',
  '#10000000#10000001',
])
  test(`plain not reference-only ${JSON.stringify(text)}`, () => {
    assert.equal(reason(input(text)), null);
  });

for (const text of [
  '`#10000000`',
  '```\n#10000000\n```',
  '~~~\n#10000000\n~~~',
  '[#10000000](https://example.test)',
  '[#10000000][target]',
  '[target]: https://example.test/#10000000',
  '#10000000 ![](https://example.test/a.png)',
])
  test(`Markdown source-proven exclusion ${JSON.stringify(text)}`, () => {
    assert.equal(reason(input(text, 'markdown')), null);
  });

for (const text of [
  '**#10000000**',
  '#10000000',
  '#10000000&NewLine;',
  '> #10000000',
  '# #10000000',
  '|#10000000|',
  '#10000000&#x180e;',
])
  test(`Markdown fixed-source conversion supports ${JSON.stringify(text)}`, () => {
    assert.equal(reason(input(text, 'markdown')), 'reference_only');
  });
for (const text of [
  '**#10000000** extra',
  '- #10000000',
  '#10000000&#13;',
  '#10000000&#0;',
  '#10000000&NewLine',
  '#10000000\uFEFF',
])
  test(`Markdown converted source is not only references ${JSON.stringify(text)}`, () => {
    assert.equal(reason(input(text, 'markdown')), null);
  });

test('reference code lexer retains exact context boundaries and deduplicates', () => {
  assert.deepEqual(
    legacyHomeReferenceCodes('#10000000 #10000001 #10000000', 'plain'),
    ['10000000', '10000001'],
  );
  assert.deepEqual(
    legacyHomeReferenceCodes('https://x.test/#10000000 #10000001', 'plain'),
    ['10000001'],
  );
  assert.deepEqual(
    legacyHomeReferenceCodes(
      '~~~\n#10000000\n```\n#10000001\n~~~~\n#10000002',
      'markdown',
    ),
    ['10000002'],
  );
  assert.deepEqual(
    legacyHomeReferenceCodes(
      '`#10000000` [#10000001](https://x.test/(y)) **#10000002**',
      'markdown',
    ),
    ['10000002'],
  );
});

for (const key of [
  'hasImages',
  'hasPoll',
  'hasGroup',
  'hasLink',
  'auditExempt',
] as const)
  test(`trusted ${key} exemption precedes short and both reference branches`, () => {
    for (const format of ['plain', 'markdown'] as const)
      for (const text of ['测试', '#10000000', '**#10000000**'])
        assert.equal(reason(input(text, format, { [key]: true })), null);
  });
for (const choose of [-1, 0, 3, 101, 102])
  test(`original old category ${choose} exempt`, () => {
    assert.equal(
      reason(
        input('测试', 'plain', {
          originalCategory: { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose },
        }),
      ),
      null,
    );
  });
for (const choose of [1, 2, 9, 15, 99, 100])
  test(`original old category ${choose} eligible, not new enum ordering`, () => {
    assert.equal(
      reason(
        input('测试', 'plain', {
          originalCategory: { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose },
        }),
      ),
      'short_text',
    );
  });

test('unknown numeric mapping fails closed rather than assuming discussion', () => {
  for (const originalCategory of [
    null,
    { sourceCommit: 'wrong', choose: 2 },
    { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose: '2' },
    { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose: 2.5 },
    { sourceCommit: LEGACY_HOME_POLICY_COMMIT, choose: NaN },
  ])
    assert.deepEqual(
      evaluateLegacyHomePolicy(
        input('测试', 'plain', {
          originalCategory:
            originalCategory as HomePolicyInput['originalCategory'],
        }),
      ),
      { status: 'unavailable', reason: 'original_category_mapping_required' },
    );
});

test('malformed normalized values cannot masquerade as exemptions', () => {
  for (const override of [
    { text: '\ud800' },
    { text: '字'.repeat(2501) },
    { format: 'html' },
    { hasImages: 'false' },
    { auditExempt: 1 },
  ])
    assert.deepEqual(
      evaluateLegacyHomePolicy(
        input('测试', 'plain', override as Partial<HomePolicyInput>),
      ),
      { status: 'unavailable', reason: 'invalid_normalized_input' },
    );
});

test('restriction contains legacy effects but no identity or detail permission', () => {
  const result = evaluateLegacyHomePolicy(input('测试'));
  assert.deepEqual(result, {
    status: 'resolved',
    restriction: {
      reason: 'short_text',
      legacyWaterChoose: 9,
      homeAudience: 'author_only',
      officialPushEligible: false,
      groupPushEligible: false,
      syncToRelatedCampuses: false,
    },
  });
  assert.equal(JSON.stringify(result).includes('account'), false);
  assert.equal(JSON.stringify(result).includes('visibility'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    result.status === 'resolved' && Object.isFrozen(result.restriction),
    true,
  );
});
