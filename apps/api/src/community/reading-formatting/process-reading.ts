import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import { DatabaseService } from '../../database/database.js';
import { requireReadingSchema } from './readiness.js';
import { ReadingFormattingWorker } from './worker.js';
import {
  assertReadingWorkerRole,
  readingProcessOptions,
  runReadingProcess,
} from './worker-process.js';
async function main() {
  const config = loadConfig(process.env);
  const options = readingProcessOptions(config, process.argv.slice(2));
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(
      AppModule.register(manualProcessingConfig(config, 'reading')),
      { logger: false },
    );
    const database = app.get(DatabaseService);
    await runReadingProcess(
      options,
      {
        worker: app.get(ReadingFormattingWorker),
        ready: async () => {
          if (!(await database.ready()))
            throw new Error('Reading database unavailable');
          await database.transaction(
            async (tx) => {
              await requireReadingSchema(tx);
              if (config.NODE_ENV === 'production')
                await assertReadingWorkerRole(tx);
            },
            { isolationLevel: 'read committed' },
          );
        },
        // Health is aggregate lifecycle/counts only: no source, IDs, tokens or SQL errors.
        report: (health) =>
          process.stdout.write(
            JSON.stringify({ worker: 'reading-formatting', ...health }) + '\n',
          ),
      },
      stop.signal,
    );
  } finally {
    // Never close the pool while an accepted tick is still completing/rolling back.
    try {
      await app?.close();
    } finally {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
  }
}
main().catch(() => {
  process.stderr.write(
    'Reading worker failed; check explicit mode, schema readiness and managed-runtime role\n',
  );
  process.exitCode = 1;
});
