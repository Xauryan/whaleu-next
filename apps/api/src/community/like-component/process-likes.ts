import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import {
  LikeComponentWorker,
  assertLocalLikeWorker,
  parseLikeCommand,
} from './worker.js';
async function main() {
  const options = parseLikeCommand(process.argv.slice(2)),
    config = loadConfig(process.env);
  assertLocalLikeWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'likes')),
    { logger: false },
  );
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-like-component', ...(await app.get(LikeComponentWorker).run(options)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local like processing failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
