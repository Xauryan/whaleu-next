import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberately outside *.test.ts: the build runs this after compiling and copying
// assets. A fresh checkout must not substitute source modules for missing output.
test('compiled Category icon Page, native adapters and emitted WXML smoke', async (t) => {
  const runner = await import(
    pathToFileURL(path.join(__dirname, 'category-icon-emitted-harness.mjs'))
      .href
  );
  await runner.runCategoryIconEmittedSmoke(t);
});
