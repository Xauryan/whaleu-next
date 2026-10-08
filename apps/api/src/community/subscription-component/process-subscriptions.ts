import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import {
  SubscriptionComponentWorker,
  assertLocalSubscriptionWorker,
  parseSubscriptionCommand,
} from './worker.js';
async function main() {
  const options = parseSubscriptionCommand(process.argv.slice(2)),
    config = loadConfig(process.env);
  assertLocalSubscriptionWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'subscriptions')),
    { logger: false },
  );
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-subscription-component', ...(await app.get(SubscriptionComponentWorker).run(options)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local subscription processing failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
