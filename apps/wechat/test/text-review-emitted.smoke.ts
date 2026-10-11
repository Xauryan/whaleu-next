import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Requires existing build output; never substitutes source Pages or runs a build.
test('emitted text-review recovery and native phone authorization event smoke', async (t) => {
  const runner = await import(
    pathToFileURL(path.join(__dirname, 'text-review-emitted-harness.mjs')).href
  );
  await runner.runTextReviewEmittedSmoke(t);
});
