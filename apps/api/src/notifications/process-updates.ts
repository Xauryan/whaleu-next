import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import {
  assertLocalUpdatesWorker,
  parseUpdatesCommand,
} from './worker-options.js';
import { UpdatesWorker } from './worker.js';
async function main() {
  const options = parseUpdatesCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertLocalUpdatesWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register({
      ...config,
      COMMUNITY_UPDATES_PROCESSING:
        config.COMMUNITY_UPDATES_PROCESSING === 'disabled'
          ? 'disabled'
          : 'manual_only',
    }),
    { logger: false },
  );
  try {
    const { retryableEventIds: _privateRetryIds, ...result } = await app
      .get(UpdatesWorker)
      .run(options);
    void _privateRetryIds;
    // Aggregate counts only. No event/recipient IDs, previews, credentials or URLs.
    process.stdout.write(
      `${JSON.stringify({ command: 'community-updates', ...result })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local Updates worker failed; check explicit event selection, local-only configuration and database availability\n',
  );
  process.exitCode = 1;
});
