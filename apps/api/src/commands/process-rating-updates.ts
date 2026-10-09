import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import { manualProcessingConfig } from '../config/manual-processing.js';
import {
  assertLocalRatingUpdatesWorker,
  parseRatingUpdatesCommand,
  RatingUpdatesWorker,
} from '../notifications/ratings/worker.js';

async function main() {
  const options = parseRatingUpdatesCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertLocalRatingUpdatesWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'ratingsUpdates')),
    { logger: false },
  );
  try {
    const { retryableEventIds: _privateRetryIds, ...result } = await app
      .get(RatingUpdatesWorker)
      .run(options);
    void _privateRetryIds;
    process.stdout.write(
      `${JSON.stringify({ command: 'rating-updates', ...result })}\n`,
    );
    if (result.failed || result.retryable) process.exitCode = 1;
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local rating updates failed; check explicit event selection, local-only configuration and database availability\n',
  );
  process.exitCode = 1;
});
