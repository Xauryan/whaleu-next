import assert from 'node:assert/strict';

const decode = (value) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** Static-preview parser. A > inside a quoted WXML expression is not a tag boundary. */
export function parsePreviewWxml(source) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      assert.ok(end !== -1, 'Unclosed WXML comment');
      index = end + 3;
      continue;
    }
    if (source[index] !== '<') {
      const end = source.indexOf('<', index);
      const text = source.slice(index, end === -1 ? source.length : end);
      if (text.trim()) stack.at(-1).children.push(decode(text));
      index = end === -1 ? source.length : end;
      continue;
    }
    let end = index + 1;
    let quote = '';
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    assert.ok(end < source.length, 'Unclosed WXML tag');
    const token = source.slice(index, end + 1);
    index = end + 1;
    if (token.startsWith('</')) {
      assert.equal(
        stack.pop()?.tag,
        token.slice(2, -1).trim(),
        'Mismatched WXML closing tag',
      );
      continue;
    }
    const tag = /^<([\w-]+)/.exec(token)?.[1];
    assert.ok(tag, 'Invalid WXML tag');
    const attrs = Object.fromEntries(
      [...token.matchAll(/([\w:-]+)=("[^"]*"|'[^']*')/g)].map((match) => [
        match[1],
        decode(match[2].slice(1, -1)),
      ]),
    );
    if (/\bwx:else(?:\s|>|\/)/.test(token)) attrs['wx:else'] = '';
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  assert.equal(stack.length, 1, 'Unclosed WXML element');
  return root;
}

/** Fail on invalid repository expressions; absent fixture fields remain optional. */
export function evaluatePreviewExpression(text, scope) {
  const evaluate = Function('scope', `with(scope){return (${text});}`);
  try {
    return evaluate(new Proxy(scope, { has: () => true }));
  } catch {
    return undefined;
  }
}

/** Preserve a single expression's native type; mixed attributes are strings. */
export function evaluatePreviewAttribute(value, scope) {
  const single = /^{{((?:(?!{{|}})[\s\S])*)}}$/.exec(value);
  if (single) return evaluatePreviewExpression(single[1], scope);
  return value.replace(/{{([\s\S]*?)}}/g, (_, text) =>
    String(evaluatePreviewExpression(text, scope) ?? ''),
  );
}
