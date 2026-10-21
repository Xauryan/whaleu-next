import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PresentationNode } from './framework7-action-parity';
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
type Definition = { file: string; node: PresentationNode };
/** Literal template reachability, not conditional expression execution or native rendering. */
export function activeNativeComponentTags(
  entry: string,
  read: (file: string) => string,
): string[] {
  const cache = new Map<string, PresentationNode>();
  const tags = new Set<string>();
  function fileName(file: string) {
    const normalized = path.posix.normalize(file);
    assert.ok(
      normalized.startsWith('apps/wechat/src/') && normalized.endsWith('.wxml'),
      'template outside native source',
    );
    return normalized;
  }
  function source(file: string) {
    file = fileName(file);
    let node = cache.get(file);
    if (!node) {
      node = parse(read(file));
      cache.set(file, node);
    }
    return node;
  }
  function resolve(file: string, target: string | undefined) {
    assert.ok(
      target && !target.includes('{{') && !target.includes('://'),
      'dynamic/external/missing template reference',
    );
    return fileName(
      target.startsWith('/')
        ? `apps/wechat/src/${target.slice(1)}`
        : path.posix.join(path.posix.dirname(file), target),
    );
  }
  function definitions(file: string) {
    const result = new Map<string, Definition>();
    for (const node of source(file).children) {
      if (
        typeof node === 'string' ||
        node.tag !== 'template' ||
        !node.attrs.name
      )
        continue;
      assert.ok(!result.has(node.attrs.name), 'duplicate template definition');
      result.set(node.attrs.name, { file, node });
    }
    return result;
  }
  function context(file: string) {
    const result = new Map<string, Definition>();
    for (const node of source(file).children) {
      if (typeof node !== 'string' && node.tag === 'import') {
        for (const [name, definition] of definitions(
          resolve(file, node.attrs.src),
        ))
          result.set(name, definition);
      }
    }
    for (const [name, definition] of definitions(file))
      result.set(name, definition);
    return result;
  }
  function walk(
    node: PresentationNode,
    file: string,
    env: Map<string, Definition>,
    chain: string[],
  ) {
    if (node.tag === 'import') return;
    if (node.tag === 'template') {
      if (node.attrs.name) return;
      const name = node.attrs.is;
      assert.ok(
        name && !name.includes('{{'),
        'dynamic/missing template invocation',
      );
      const definition = env.get(name);
      assert.ok(definition, `unresolved template: ${name}`);
      const identity = `${definition.file}#${name}`;
      assert.ok(!chain.includes(identity), 'cyclic template invocation');
      const nested = new Map([...env, ...context(definition.file)]);
      for (const child of definition.node.children)
        if (typeof child !== 'string')
          walk(child, definition.file, nested, [...chain, identity]);
      return;
    }
    if (node.tag === 'include') {
      const target = resolve(file, node.attrs.src);
      assert.ok(!chain.includes(target), 'cyclic template include');
      walk(source(target), target, new Map([...env, ...context(target)]), [
        ...chain,
        target,
      ]);
      return;
    }
    if (node.tag.startsWith('wu-f7-')) tags.add(node.tag);
    for (const child of node.children)
      if (typeof child !== 'string') walk(child, file, env, chain);
  }
  entry = fileName(entry);
  walk(source(entry), entry, context(entry), [entry]);
  return [...tags].sort();
}
