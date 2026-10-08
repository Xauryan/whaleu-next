import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import { parseHotScoreCommand } from './contracts.js';
import { HotScoreModule } from './module.js';
import { HotScoreService, assertLocalHotScore } from './service.js';

async function main() {
  const options = parseHotScoreCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertLocalHotScore(config);
  @Module({
    imports: [
      AppModule.register(manualProcessingConfig(config, 'hotScore')),
      HotScoreModule,
    ],
  })
  class LocalHotScoreModule {}
  const app = await NestFactory.createApplicationContext(LocalHotScoreModule, {
    logger: false,
  });
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-hot-score', ...(await app.get(HotScoreService).run(options)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local internal score computation failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
