import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const app = JSON.parse(await readFile(path.join(out, 'app.json'), 'utf8'));
assert.ok(
  app.pages.includes(
    'pages/official-account-operations/official-account-operations',
  ),
);
const page = await readFile(
  path.join(
    out,
    'pages/official-account-operations/official-account-operations.js',
  ),
  'utf8',
);
const wxml = await readFile(
  path.join(
    out,
    'pages/official-account-operations/official-account-operations.wxml',
  ),
  'utf8',
);
for (const match of wxml.matchAll(
  /bind(?:tap|input|change)="([A-Za-z][A-Za-z0-9]*)"/g,
))
  assert.ok(page.includes(match[1]), `missing emitted handler ${match[1]}`);
assert.match(wxml, /不会自动发布/);
assert.doesNotMatch(wxml, /确认发布|operator\/publish/);
for (const name of ['controller', 'gateway', 'journal', 'contracts']) {
  const body = await readFile(
    path.join(out, `official-account-operations/${name}.js`),
    'utf8',
  );
  assert.ok(body.length > 0);
  if (name === 'contracts') assert.doesNotMatch(body, /require\("js-sha256"\)/);
}
console.log('Official-account emitted draft-only page smoke passed');
