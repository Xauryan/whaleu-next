import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const requireNative = createRequire(__filename);
const { nativeComponentPreviewState } = requireNative(
  '../scripts/preview-native-component.mjs',
) as {
  nativeComponentPreviewState(
    definition: object,
    attributes: Record<string, string>,
    evaluate: (value: string) => unknown,
  ): Record<string, unknown>;
};

test('reference preview executes the actual bounded native initialization, not a made-up link renderer', () => {
  const host = globalThis as unknown as {
    Component?: (definition: object) => void;
  };
  const before = host.Component;
  let definition: object | undefined;
  const component = requireNative.resolve(
    '../src/components/reference-text/reference-text.ts',
  );
  try {
    host.Component = (value) => {
      definition = value;
    };
    delete requireNative.cache[component];
    requireNative(component);
  } finally {
    if (before === undefined) delete host.Component;
    else host.Component = before;
    delete requireNative.cache[component];
  }
  assert.ok(definition);
  const source = '<script>synthetic</script>\n #1234567';
  for (const available of [false, true]) {
    const state = nativeComponentPreviewState(
      definition,
      { source: '{{source}}', available: '{{available}}' },
      (value) =>
        value === '{{source}}'
          ? source
          : value === '{{available}}'
            ? available
            : value,
    );
    const segments = state['segments'] as {
      kind: string;
      text: string;
      code?: string;
    }[];
    assert.equal(segments.map((segment) => segment.text).join(''), source);
    assert.equal(
      segments.filter((segment) => segment.kind === 'reference').length,
      available ? 1 : 0,
    );
    if (available) assert.equal(segments[segments.length - 1]?.code, '1234567');
  }
});

test('source preview admits only the exact native reference component alongside its prior component whitelist', () => {
  const source = readFileSync(
    path.join(__dirname, '../scripts/preview-apple.mjs'),
    'utf8',
  );
  assert.match(source, /node\.tag === 'wu-reference-text' \|\|/);
  assert.match(source, /nativeComponentPreviewState\(definition, attrs/);
  assert.match(source, /components', name, name \+ '\.wxml'/);
  assert.doesNotMatch(source, /node\.tag\.startsWith\(['"]wu-/);
});
