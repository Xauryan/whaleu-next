import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Existing output only. No hidden build and no source controller substitution.
test('emitted category and rating-card human-adoption journeys', async (t) => {
  const runner = await import(
    pathToFileURL(
      path.join(__dirname, 'ratings-assistance-emitted-harness.mjs'),
    ).href
  );
  await runner.runRatingsAssistanceEmittedSmoke(t);
});
