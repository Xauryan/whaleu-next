import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..', process.argv[2] ?? 'src');
let references = 0;
function resolve(from, reference) {
  return reference.startsWith('/')
    ? path.join(root, reference)
    : path.resolve(path.dirname(from), reference);
}
function assertFile(from, reference) {
  if (
    !reference ||
    reference.includes('{{') ||
    /^(https?:|plugin:|data:)/.test(reference)
  )
    return;
  const target = resolve(from, reference);
  assert.ok(
    target.startsWith(root + path.sep),
    `Asset escapes native root: ${from}: ${reference}`,
  );
  assert.ok(
    existsSync(target),
    `Missing native asset: ${path.relative(root, from)} -> ${reference}`,
  );
  references++;
}
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(file);
      continue;
    }
    if (entry.name.endsWith('.wxss')) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /@import\s+['"]([^'"]+)['"]/g,
      ))
        assertFile(file, match[1]);
    } else if (entry.name.endsWith('.wxml')) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /<(?:import|include|image)\b[^>]*\bsrc="([^"]+)"/g,
      ))
        assertFile(file, match[1]);
    } else if (entry.name.endsWith('.json')) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      for (const reference of Object.values(json.usingComponents ?? {})) {
        if (typeof reference !== 'string' || reference.startsWith('plugin:'))
          continue;
        for (const extension of [
          'json',
          'wxml',
          'wxss',
          root.endsWith('/src') ? 'ts' : 'js',
        ])
          assertFile(file, `${reference}.${extension}`);
      }
    }
  }
}
visit(root);
console.log(
  `Native asset integrity: ${references} local stylesheet/template/component/image references resolve.`,
);
