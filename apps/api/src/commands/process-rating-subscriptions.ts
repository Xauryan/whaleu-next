import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import { manualProcessingConfig } from '../config/manual-processing.js';
import { assertLocalRatingUpdatesWorker } from '../notifications/ratings/worker.js';
import {
  parseRatingSubscriptionCommand,
  RatingSubscriptionUpdatesWorker,
} from '../notifications/ratings/subscription-worker.js';
async function main() {
  const options = parseRatingSubscriptionCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertLocalRatingUpdatesWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'ratingsUpdates')),
    { logger: false },
  );
  try {
    const {
      remainingEventIds: _remaining,
      retryableEventIds: _retry,
      ...result
    } = await app.get(RatingSubscriptionUpdatesWorker).run(options);
    void _remaining;
    void _retry;
    process.stdout.write(
      `${JSON.stringify({ command: 'rating-subscriptions', ...result })}\n`,
    );
    if (result.failed || result.retryable || result.partial)
      process.exitCode = 1;
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local rating subscriptions failed; check explicit event selection, local-only configuration and database availability\n',
  );
  process.exitCode = 1;
});
