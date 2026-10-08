import { manualProcessingConfig } from '../../config/manual-processing.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import {
  assertLocalJuryWorker,
  parseJuryCommand,
  JuryWorker,
} from './worker.js';
async function main() {
  const options = parseJuryCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertLocalJuryWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'jury')),
    { logger: false },
  );
  try {
    const result = await app.get(JuryWorker).run(options);
    process.stdout.write(
      `${JSON.stringify({ command: 'local-post-juries', ...result })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local jury command failed; check explicit selection, disposable local configuration and database availability\n',
  );
  process.exitCode = 1;
});
