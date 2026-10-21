import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function templates(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory()
      ? templates(file)
      : entry.name.endsWith('.wxml')
        ? [file]
        : [];
  });
}

test('all native WXML interpolations keep quoted strings free of formatter-inserted line breaks', () => {
  const root = path.join(__dirname, '../src');
  for (const file of templates(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      for (const literal of match[1]!.matchAll(
        /'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"/g,
      )) {
        assert.doesNotMatch(
          literal[0].replace(/\\\r?\n/g, ''),
          /[\r\n]/,
          `${path.relative(root, file)} contains an invalid multiline quoted interpolation`,
        );
      }
    }
  }
});
