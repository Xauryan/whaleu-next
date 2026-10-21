import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(__filename);
const { evaluatePreviewAttribute } = require('../scripts/preview-wxml.mjs') as {
  evaluatePreviewAttribute(
    value: string,
    scope: Record<string, unknown>,
  ): unknown;
};
test('component preview preserves typed single expressions and renders mixed attribute interpolation as text', () => {
  const scope = {
    item: { title: '合成主题', action: '查看回复' },
    disabled: false,
    count: 3,
    values: ['a', 'b'],
  };
  assert.equal(
    evaluatePreviewAttribute('{{item.title}}，{{item.action}}', scope),
    '合成主题，查看回复',
  );
  assert.equal(
    evaluatePreviewAttribute('打开 {{item.title}}', scope),
    '打开 合成主题',
  );
  assert.equal(evaluatePreviewAttribute('{{disabled}}', scope), false);
  assert.equal(evaluatePreviewAttribute('{{count}}', scope), 3);
  assert.equal(evaluatePreviewAttribute('{{values}}', scope), scope.values);
  assert.equal(evaluatePreviewAttribute('说明 {{missing}}', scope), '说明 ');
  assert.equal(evaluatePreviewAttribute('纯文本', scope), '纯文本');
});
