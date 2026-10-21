import assert from 'node:assert/strict';

const decode = (value) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
const tagPattern = /<\/?([a-z][\w-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const allowedTags = new Set([
  'div',
  'span',
  'button',
  'a',
  'input',
  'textarea',
  'img',
  'label',
]);

/** Validate the shipped static frames, not the surrounding documentation or CSS source. */
export function validatePreviewFramesHtml(html, expectedFrames) {
  const frames = [
    ...html.matchAll(/<iframe\b[^>]*srcdoc="([^"]*)"[^>]*>/g),
  ].map((match) => decode(match[1]));
  assert.equal(
    frames.length,
    expectedFrames,
    'Unexpected static preview frame count',
  );
  return frames.map((frame, index) => {
    const body = /<body>([\s\S]*?)<\/body>/.exec(frame)?.[1];
    assert.ok(body, `Frame ${index + 1}: missing body`);
    assert.doesNotMatch(
      body,
      /{{|}}|\bundefined\b|\[object Object\]/,
      `Frame ${index + 1}: unresolved content`,
    );
    for (const tag of body.matchAll(tagPattern))
      assert.ok(
        allowedTags.has(tag[1].toLowerCase()),
        `Frame ${index + 1}: native/unsafe tag ${tag[1]}`,
      );
    assert.doesNotMatch(
      body,
      /\b(?:wx:[\w-]+|bind[\w-]+|catch[\w-]+)\s*=/,
      `Frame ${index + 1}: leaked native attributes`,
    );
    assert.doesNotMatch(
      body,
      /\b(?:src|href)="(?:https?:|file:|javascript:)/,
      `Frame ${index + 1}: nonlocal source`,
    );
    const text = decode(body.replace(tagPattern, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    assert.doesNotMatch(
      text,
      /wx:|bindtap=|bindinput=|class=|mediaGallery\.|&amp;&amp;|&gt;|&lt;/,
      `Frame ${index + 1}: leaked attribute fragment`,
    );
    return { frame: index + 1, text, passed: true };
  });
}

export function validateCorePreviewHtml(html) {
  const frames = validatePreviewFramesHtml(html, 12);
  for (const [index, { text }] of frames.entries()) {
    if (index >= 10) {
      assert.doesNotMatch(text, /使用偏好|账户与更多功能/);
      assert.match(text, /编辑资料.*公开范围/);
    }
    if (index === 6 || index === 7)
      assert.doesNotMatch(text, /下一组|图片 · 0 张/);
    if (index === 4 || index === 5) assert.match(text, /今天的晚风刚刚好/);
  }
  return frames;
}

export function validateMenuPreviewHtml(html) {
  const frames = validatePreviewFramesHtml(html, 4);
  const documents = [
    ...html.matchAll(/<iframe\b[^>]*srcdoc="([^"]*)"[^>]*>/g),
  ].map((match) => decode(match[1]));
  for (const [index, { text }] of frames.entries()) {
    if (index < 2) {
      assert.match(text, /浏览记录/);
      assert.match(text, /扫一扫.*帮助与客服.*设置/);
      assert.match(documents[index], /class="menu-backdrop"/);
      assert.match(documents[index], /class="profile-menu"/);
    } else {
      assert.match(text, /系统设置.*公众号提示.*每日热榜/);
      assert.match(text, /消息投递待接入/);
      assert.doesNotMatch(text, /保存设置|取消修改|编辑资料|账户与更多功能/);
      assert.equal(
        [...documents[index].matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)]
          .length,
        11,
        'All eleven real preferences represented',
      );
      assert.equal(
        [...documents[index].matchAll(/<input\b[^>]* checked(?:\s|>)[^>]*>/g)]
          .length,
        2,
        'Synthetic checked states represented accurately',
      );
    }
  }
  return frames;
}

/** Every synthetic state must actually render in both themes, not silently fall back to empty. */
export function validateProductPreviewHtml(html, fixtures) {
  assert.ok(
    Array.isArray(fixtures) && fixtures.length > 0,
    'Missing product fixtures',
  );
  const checks = validatePreviewFramesHtml(html, fixtures.length * 2);
  for (const [index, check] of checks.entries()) {
    const fixture = fixtures[Math.floor(index / 2)];
    assert.ok(
      Array.isArray(fixture.expectedText) && fixture.expectedText.length > 0,
      `${fixture.id}: missing expected fixture markers`,
    );
    for (const expected of fixture.expectedText) {
      assert.ok(
        typeof expected === 'string' && expected.trim().length > 0,
        `${fixture.id}: invalid fixture marker`,
      );
      assert.ok(
        check.text.includes(expected),
        `${fixture.id}: missing rendered fixture marker ${expected}`,
      );
    }
  }
  return checks;
}
