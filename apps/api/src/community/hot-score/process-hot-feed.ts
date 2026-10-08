import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import { assertLocalExperienceWorker } from '../../experience/worker.js';
import { HotFeedProcessing } from './processing.js';
async function main() {
  const ids = process.argv.slice(2).map((arg) => {
    const match = /^--post-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid arguments');
    return match[1]!;
  });
  const config = loadConfig(process.env);
  assertLocalExperienceWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'hotFeed')),
    { logger: false },
  );
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-hot-feed', ...(await app.get(HotFeedProcessing).processSelected(ids)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local hot feed processing failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
