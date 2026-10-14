import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntheticRatingAssistance } from '../support/rating-assistance-fixture.js';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';

test(
  'emitted native assistance and card journeys use normal authenticated HTTP, real owner preparation, actual Review and PostgreSQL publication',
  { timeout: 600_000 },
  async (t) => {
    const provider = new SyntheticRatingAssistance();
    const f = await ratingTargetLinkFixture(provider);
    t.after(() => f.close());
    // CI downloads the separately successful native build artifact. No hidden
    // compile, source-controller fallback or mocked HTTP response is permitted.
    const bridge = await import(
      pathToFileURL(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../support/rating-assistance-emitted-bridge.mjs',
        ),
      ).href
    );
    await bridge.runAssistanceNativeRoundtrip(t, f, provider);
  },
);
