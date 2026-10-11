/** Disposable restarted worker process; only synthetic recipient/provider ports.
 * AppModule, PostgreSQL, Errands source, Safety, Review and Media proofs are real. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  ERRAND_GROUP_RUNTIME,
  groupDestinationSchema,
} from '../../src/notifications/errand-group/contracts.js';
import type { ErrandGroupRuntime } from '../../src/notifications/errand-group/contracts.js';
import { ErrandGroupWorker } from '../../src/notifications/errand-group/worker.js';
import {
  DurableSyntheticGroupSender,
  SyntheticGroupAuthority,
} from './errand-group-runtime.js';
const send = (value: unknown) =>
  new Promise<void>((resolve, reject) =>
    process.send!(value, (error: Error | null) =>
      error ? reject(error) : resolve(),
    ),
  );
process.once('message', (raw: unknown) => {
  void (async () => {
    const input = raw as {
      directory: string;
      destinations: unknown;
      now: number;
      discover: boolean;
    };
    assert.equal(process.env['NODE_ENV'], 'test');
    assert.equal(process.env['WHALEU_TEST_MAINTENANCE'], 'controlled');
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/whaleu_test');
    const authority = new SyntheticGroupAuthority();
    for (const d of groupDestinationSchema
      .array()
      .max(64)
      .parse(input.destinations))
      authority.groups.set(d.id, d);
    const sender = new DurableSyntheticGroupSender(
      input.directory,
      () => input.now,
    );
    const runtime: ErrandGroupRuntime = {
      mode: 'synthetic-only',
      authority,
      sender,
      shortlinks: null,
      now: () => input.now,
    };
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      PG_POOL_MAX: '4',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const app = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    })
      .overrideProvider(ERRAND_GROUP_RUNTIME)
      .useValue(runtime)
      .compile();
    try {
      await app.init();
      const worker = app.get(ErrandGroupWorker);
      if (input.discover) await worker.discover();
      const claimed = await worker.runOne();
      await send({
        event: 'done',
        pid: process.pid,
        claimed,
        attempts: sender.attempts.map((p) => ({
          destination: p.destination,
          key: p.key,
          payload: p.payload,
        })),
      });
    } finally {
      await app.close();
    }
  })()
    .catch(async (error: unknown) => {
      await send({
        event: 'failure',
        message: error instanceof Error ? error.stack : String(error),
      });
    })
    .finally(() => process.disconnect());
});
