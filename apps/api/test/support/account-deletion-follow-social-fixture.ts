/** Successor-only fixture. The frozen 0172 deletion fixture is not modified.
 * All positive source/work/notice graphs come from the real application writers.
 * Never runs implicitly; the parent fixture enforces the disposable PG lane. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ReadingFormattingRuntime } from '../../src/community/reading-formatting/runtime.js';
import {
  HistoricalReadingFormattingRuntime,
  historicalReadingAbsenceSql,
} from './historical-content-definition/reading-enrollment.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import {
  configureHistoricalContentDefinitions,
  HistoricalContentDefinitionRepository,
  historicalTextSourceAbsenceSql,
} from './historical-content-definition/configure.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import { FollowingService } from '../../src/community/following/service.js';
import { SocialUpdatesReadService } from '../../src/notifications/social/read.service.js';
import { SocialUpdatesWorker } from '../../src/notifications/social/worker.js';
import { SocialUpdatesDispatcher } from '../../src/notifications/social/dispatcher.js';
import { UpdatesDispatcher } from '../../src/notifications/dispatcher.js';
import { accountDeletionFixture } from './account-deletion-fixture.js';

export type FollowDeletionActor = Awaited<
  ReturnType<Awaited<ReturnType<typeof accountDeletionFixture>>['create']>
>;
export const deletionRequest = (expectedGeneration = '0') => ({
  version: 1,
  requestId: randomUUID(),
  expectedGeneration,
  consent: 'account-deletion-explicit-v1',
});
export interface FollowDeletionSource {
  id: string;
  actor_account_id: string;
  recipient_account_id: string;
  source_epoch_id: string;
  state: 'pending' | 'completed';
  outcome: 'materialized' | 'existing' | 'account_deleted' | null;
  notice_id: string | null;
}

export async function accountDeletionFollowSocialFixture() {
  // Historical follow/social erasure owner, not current-catalog qualification.
  const base = await accountDeletionFixture({ throughMigration: 174 });
  let app: INestApplication | undefined;
  try {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'],
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '8',
      PG_STATEMENT_TIMEOUT_MS: '30000',
      COMMUNITY_UPDATES_PROCESSING: 'manual_only',
      EXPERIENCE_PROCESSING: 'disabled',
    });
    // Test-only 0174 adapters: exact predecessor definition reads and guarded
    // source-free same-transaction enrollment absence. All other reading
    // runtime methods remain current.
    // Deletion, Review, publication, social and validation owners remain current.
    const builder = Test.createTestingModule({
      imports: [AppModule.register(config)],
    });
    await configureHistoricalContentDefinitions(builder, config, 174);
    app = (await builder.compile()).createNestApplication({ logger: false });
    const reader = app.get(ContentDefinitionRepository);
    assert.ok(reader instanceof HistoricalContentDefinitionRepository);
    const reading = app.get(ReadingFormattingRuntime);
    assert.ok(reading instanceof HistoricalReadingFormattingRuntime);
    assert.equal(
      (await base.pool.query<{ absent: boolean }>(historicalReadingAbsenceSql))
        .rows[0]?.absent,
      true,
    );
    assert.equal(
      (
        await base.pool.query<{ absent: boolean }>(
          historicalTextSourceAbsenceSql,
        )
      ).rows[0]?.absent,
      true,
    );
    configureHttp(app);
    await app.init();
    assert.equal(app.get(ContentDefinitionRepository), reader);
    assert.equal(app.get(ReadingFormattingRuntime), reading);
    await app.get(SocialUpdatesDispatcher).beforeApplicationShutdown();
    await app.get(UpdatesDispatcher).stop();
    const following = app.get(FollowingService);
    const socialWorker = app.get(SocialUpdatesWorker);
    const socialReads = app.get(SocialUpdatesReadService);
    const profile = async (actor: { accountId: string }) => {
      await base.repository.transaction((tx) =>
        base.profiles.authorDisplay(actor.accountId, tx),
      );
      const id = await base.repository.transaction((tx) =>
        base.profiles.publicReference(actor.accountId, tx),
      );
      assert.ok(id);
      return id;
    };
    const sources = async (
      actor: { accountId: string } | null,
      recipient: { accountId: string } | null,
    ) =>
      (
        await base.pool.query<FollowDeletionSource>(
          `SELECT s.id,s.actor_account_id,s.recipient_account_id,s.source_epoch_id,
                w.state,r.outcome,r.notice_id
           FROM whaleu_community.social_sources s
           JOIN whaleu_notifications.social_work w ON w.source_id=s.id
           LEFT JOIN whaleu_notifications.social_receipts r ON r.source_id=s.id
          WHERE ($1::uuid IS NULL OR s.actor_account_id=$1)
            AND ($2::uuid IS NULL OR s.recipient_account_id=$2)
          ORDER BY s.occurred_at,s.id`,
          [actor?.accountId ?? null, recipient?.accountId ?? null],
        )
      ).rows;
    const settle = async (ids: readonly string[]) => {
      for (let start = 0; start < ids.length; start += 50) {
        const page = ids.slice(start, start + 50);
        const result = await socialWorker.run({
          mode: 'apply',
          sourceIds: page,
        });
        assert.equal(result.retryable, 0, JSON.stringify(result));
        assert.equal(result.missing, 0, JSON.stringify(result));
        assert.equal(
          result.materialized + result.existing + result.alreadyProcessed,
          page.length,
        );
      }
    };
    const complete = async (requestId: string) => {
      const pages = [];
      // Test bound, not a production retry policy. This exceeds the source/row
      // phase count of the largest generated fixture by more than an order.
      for (let i = 0; i < 400; i++) {
        const status = await base.worker.tick(requestId);
        pages.push(status);
        if (status.phase === 'completed') return { status, pages };
        assert.equal(status.phase, 'waiting', JSON.stringify(status));
        assert.ok(
          status.pending.every((reason) =>
            ['OWNER_PAGE_PENDING', 'OWNER_WORK_PENDING'].includes(reason),
          ),
          `Unexpected blocker: ${JSON.stringify(status)}`,
        );
      }
      assert.fail(`Deletion did not finish: ${JSON.stringify(pages.at(-1))}`);
    };
    const close = async () => {
      try {
        await app?.close();
      } finally {
        await base.close();
      }
    };
    return {
      ...base,
      app,
      http: app.getHttpServer(),
      following,
      socialWorker,
      socialReads,
      profile,
      sources,
      settle,
      complete,
      close,
    };
  } catch (error) {
    await app?.close();
    await base.close();
    throw error;
  }
}

export type AccountDeletionFollowSocialFixture = Awaited<
  ReturnType<typeof accountDeletionFollowSocialFixture>
>;
