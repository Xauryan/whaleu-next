import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import { manualProcessingConfig } from '../config/manual-processing.js';
import {
  ExperienceWorker,
  assertLocalExperienceWorker,
  parseExperienceCommand,
} from './worker.js';
async function main() {
  const options = parseExperienceCommand(process.argv.slice(2)),
    config = loadConfig(process.env);
  assertLocalExperienceWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'experience')),
    { logger: false },
  );
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-experience', ...(await app.get(ExperienceWorker).run(options)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local experience processing failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
