import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('static preview parser keeps raw and escaped comparison expressions inside attributes', () => {
  const parser = pathToFileURL(
    path.join(__dirname, '../scripts/preview-wxml.mjs'),
  ).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { parsePreviewWxml } from ${JSON.stringify(parser)};
    for (const source of [
      '<view wx:if="{{images.length > 1 && status !== \\'ready\\'}}"><button disabled="{{index + 1 >= total}}">下一组</button></view>',
      '<view wx:if="{{images.length &gt; 1 &amp;&amp; status !== \\'ready\\'}}"><button disabled="{{index + 1 &gt;= total}}">下一组</button></view>',
    ]) {
      const root = parsePreviewWxml(source);
      assert.equal(root.children.length, 1);
      const view = root.children[0];
      assert.equal(view.attrs['wx:if'], "{{images.length > 1 && status !== 'ready'}}");
      assert.equal(view.children.length, 1);
      assert.equal(view.children[0].attrs.disabled, '{{index + 1 >= total}}');
      assert.deepEqual(view.children[0].children, ['下一组']);
    }
    const nested = parsePreviewWxml('<view wx:if="{{a < 3 && b > 2}}"><picker><view>私密</view></picker></view>');
    assert.equal(nested.children[0].attrs['wx:if'], '{{a < 3 && b > 2}}');
    assert.throws(() => parsePreviewWxml('<view><text>bad</view>'));
    console.log('comparison-parser-ok');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.match(result, /comparison-parser-ok/);
});

test('core static frame validator rejects native-tag and attribute-fragment leaks', () => {
  const validator = pathToFileURL(
    path.join(__dirname, '../scripts/validate-core-preview.mjs'),
  ).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { validateCorePreviewHtml } from ${JSON.stringify(validator)};
    const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const page = content => '<html><body><div>' + content + '</div></body></html>';
    const make = bad => Array.from({length: 12}, (_, index) => '<iframe srcdoc="' + escape(page(index === 0 ? bad : index >= 10 ? '编辑资料 公开范围' : '今天的晚风刚刚好')) + '"></iframe>').join('');
    assert.equal(validateCorePreviewHtml(make('校园')).length, 12);
    for (const leak of ['{{text}}', 'undefined', '1 &amp;&amp; mediaGallery.groupKind', '<picker>value</picker>', '<view>value</view>', '<script>bad</script>'])
      assert.throws(() => validateCorePreviewHtml(make(leak)), leak);
    console.log('semantic-gate-ok');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.match(result, /semantic-gate-ok/);
});

test('menu preview validator requires both themes and truthful checked states', () => {
  const validator = pathToFileURL(
    path.join(__dirname, '../scripts/validate-core-preview.mjs'),
  ).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { validateMenuPreviewHtml } from ${JSON.stringify(validator)};
    const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const drawer = '<div class="menu-backdrop"></div><div class="profile-menu">浏览记录 扫一扫 帮助与客服 设置</div>';
    const settings = count => '<div>系统设置 公众号提示 每日热榜 消息投递待接入</div>' + Array.from({length: 11}, (_, i) => '<input type="checkbox"' + (i < count ? ' checked ' : '') + '>').join('');
    const make = (count = 2, leak = '') => [drawer, drawer, settings(count) + leak, settings(count)].map(body => '<iframe srcdoc="' + escape('<html><body>' + body + '</body></html>') + '"></iframe>').join('');
    assert.equal(validateMenuPreviewHtml(make()).length, 4);
    assert.throws(() => validateMenuPreviewHtml(make(0)));
    assert.throws(() => validateMenuPreviewHtml(make(2, ' 使用偏好 {{unsafe}}')));
    assert.throws(() => validateMenuPreviewHtml(make() + '<iframe srcdoc="extra"></iframe>'));
    console.log('menu-semantic-gate-ok');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.match(result, /menu-semantic-gate-ok/);
});

test('product preview gate requires loaded markers in each theme and rejects empty marker contracts', () => {
  const validator = pathToFileURL(
    path.join(__dirname, '../scripts/validate-core-preview.mjs'),
  ).href;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { validateProductPreviewHtml } from ${JSON.stringify(validator)};
    const frame = (text) => '<iframe srcdoc="&lt;body>&lt;div>' + text + '&lt;/div>&lt;/body>"></iframe>';
    const fixtures = [{id:'course-loaded', expectedText:['示例课程', '评分']}];
    const loaded = frame('示例课程 评分');
    assert.equal(validateProductPreviewHtml(loaded + loaded, fixtures).length, 2);
    assert.throws(() => validateProductPreviewHtml(loaded + frame('尚无内容'), fixtures), /missing rendered fixture marker/);
    assert.throws(() => validateProductPreviewHtml(loaded, fixtures), /frame count/);
    assert.throws(() => validateProductPreviewHtml(loaded + loaded, [{id:'bad',expectedText:[]}]), /missing expected fixture markers/);
    assert.throws(() => validateProductPreviewHtml(loaded + loaded, [{id:'bad',expectedText:['']}]), /invalid fixture marker/);
  `,
    ],
    { encoding: 'utf8' },
  );
});

test('static preview rejects syntax-invalid interpolation instead of silently hiding it', () => {
  const parser = pathToFileURL(
    path.join(__dirname, '../scripts/preview-wxml.mjs'),
  ).href;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { evaluatePreviewExpression, parsePreviewWxml } from ${JSON.stringify(parser)};
    assert.throws(() => evaluatePreviewExpression("ok ? 'ready' : 'broken" + String.fromCharCode(10) + "literal'", {ok:false}), SyntaxError);
    assert.equal(evaluatePreviewExpression('optional.missing', {}), undefined);
    assert.equal(evaluatePreviewExpression('count === 0 ? 0 : null', {count:0}), 0);
    assert.equal(parsePreviewWxml('<view>{{a &amp;&amp; b}}</view>').children[0].children[0], '{{a && b}}');
  `,
    ],
    { encoding: 'utf8' },
  );
});
