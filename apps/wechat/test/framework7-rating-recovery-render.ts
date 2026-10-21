/** Source-only native WXML/Component-slot text projection, never device evidence. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PresentationNode } from './framework7-action-parity';
const nativeRequire = createRequire(__filename);
const root = path.resolve(__dirname, '../src');
const { parsePreviewWxml: parse, evaluatePreviewExpression: evaluate } =
  nativeRequire('../scripts/preview-wxml.mjs') as {
    parsePreviewWxml(source: string): PresentationNode;
    evaluatePreviewExpression(
      source: string,
      scope: Record<string, unknown>,
    ): unknown;
  };
const { nativeComponentPreviewState } = nativeRequire(
  '../scripts/preview-native-component.mjs',
) as {
  nativeComponentPreviewState(
    definition: object,
    attrs: Record<string, string>,
    evaluate: (value: string) => unknown,
  ): Record<string, unknown>;
};
export function registerNative<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let definition: T | undefined;
  globals[kind] = (value: T) => {
    definition = value;
  };
  try {
    const target = nativeRequire.resolve(path.join(root, file));
    delete nativeRequire.cache[target];
    nativeRequire(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition, `${kind} ${file}`);
  return definition;
}
type Node = PresentationNode | string;
type Templates = Record<string, Node[]>;
type Slots = Record<string, () => string>;
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
function expand(file: string, templates: Templates = {}): Node[] {
  const nodes: Node[] = [];
  for (const node of parse(read(file)).children) {
    if (typeof node === 'string') {
      nodes.push(node);
      continue;
    }
    if (node.tag === 'import' || node.tag === 'include') {
      const nested = expand(
        path.join(path.dirname(file), node.attrs.src!),
        templates,
      );
      if (node.tag === 'include') nodes.push(...nested);
    } else if (node.tag === 'template' && node.attrs.name)
      templates[node.attrs.name] = node.children;
    else nodes.push(node);
  }
  return nodes;
}
const interpolate = (text: string, scope: Record<string, unknown>) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, expr: string) =>
    String(evaluate(expr, scope) ?? ''),
  );
function render(
  nodes: Node[],
  scope: Record<string, unknown>,
  templates: Templates,
  slots: Slots = {},
): string {
  let result = '',
    matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result += interpolate(node, scope);
      continue;
    }
    const attrs = node.attrs;
    if (attrs['wx:for']) {
      const values = evaluate(attrs['wx:for'].slice(2, -2), scope) as
        unknown[] | undefined;
      const rest = { ...attrs };
      delete rest['wx:for'];
      result += (values ?? [])
        .map((item, index) =>
          render(
            [{ ...node, attrs: rest }],
            {
              ...scope,
              [attrs['wx:for-item'] ?? 'item']: item,
              [attrs['wx:for-index'] ?? 'index']: index,
            },
            templates,
            slots,
          ),
        )
        .join(' ');
      continue;
    }
    if ('wx:if' in attrs) matched = false;
    const condition = attrs['wx:if'] ?? attrs['wx:elif'];
    if ('wx:elif' in attrs && matched) continue;
    if (condition !== undefined) {
      if (!evaluate(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    if (attrs.hidden && evaluate(attrs.hidden.slice(2, -2), scope)) continue;
    if (node.tag === 'template' && attrs.is) {
      assert.ok(templates[attrs.is], `Missing template ${attrs.is}`);
      result += render(
        templates[attrs.is]!,
        evaluate(`({${attrs.data!.slice(2, -2)}})`, scope) as Record<
          string,
          unknown
        >,
        templates,
        slots,
      );
      continue;
    }
    if (node.tag === 'slot') {
      result += slots[attrs.name ?? 'default']?.() ?? '';
      continue;
    }
    if (node.tag.startsWith('wu-f7-')) {
      const name = node.tag.slice(3);
      assert.ok(
        [
          'f7-button',
          'f7-input',
          'f7-block',
          'f7-list',
          'f7-list-item',
        ].includes(name),
        `Unsupported component ${name}`,
      );
      const definition = registerNative<object>(
        'Component',
        `components/${name}/${name}.ts`,
      );
      const state = nativeComponentPreviewState(definition, attrs, (value) =>
        value.startsWith('{{') && value.endsWith('}}')
          ? evaluate(value.slice(2, -2), scope)
          : interpolate(value, scope),
      );
      const componentSlots: Slots = {};
      for (const child of node.children) {
        const slot =
          typeof child === 'string'
            ? 'default'
            : (child.attrs.slot ?? 'default');
        const previous = componentSlots[slot];
        componentSlots[slot] = () =>
          (previous?.() ?? '') + render([child], scope, templates, slots);
      }
      result += render(
        expand(`components/${name}/${name}.wxml`),
        state,
        {},
        componentSlots,
      );
      continue;
    }
    assert.ok(
      !node.tag.startsWith('wu-') || node.tag === 'wu-icon',
      `Unsupported custom component ${node.tag}`,
    );
    result += render(node.children, scope, templates, slots);
  }
  return result;
}
export function renderNativePageText(
  page: string,
  patch: Record<string, unknown>,
): string {
  const definition = registerNative<{ data: Record<string, unknown> }>(
      'Page',
      `pages/${page}/${page}.ts`,
    ),
    templates: Templates = {};
  return render(
    expand(`pages/${page}/${page}.wxml`, templates),
    { ...structuredClone(definition.data), ...patch },
    templates,
  )
    .replace(/\s+/g, ' ')
    .trim();
}
export function renderNativeListItemText(node: PresentationNode): string {
  assert.equal(node.tag, 'wu-f7-list-item');
  return render([node], {}, {}).replace(/\s+/g, ' ').trim();
}
