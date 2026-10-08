import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ErrandAdminService } from '../src/errands/admin-service.js';
import type { ErrandAdminRow } from '../src/errands/admin-repository.js';
import type { DatabaseService } from '../src/database/database.js';
import type { ErrandAccessService } from '../src/errands/access.js';
import type { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { ErrandAdminRepository } from '../src/errands/admin-repository.js';
import type { ProfileAdminParticipantFacade } from '../src/profile/admin-participant.facade.js';
import type { CampusErrandScopeFacade } from '../src/campus/errand-scope.facade.js';
import type { DiscoveryContinuationFacade } from '../src/community/discovery-continuation.module.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
function fixture() {
  const actor = randomUUID(),
    region = randomUUID(),
    publisher = randomUUID(),
    profile = randomUUID();
  const source: {
    rows: ErrandAdminRow[];
    name: string;
    afterRead: () => void;
  } = { rows: [], name: 'Before', afterRead: () => {} };
  const commands: string[] = [];
  const tx = {
    query: async (sql: string) => {
      commands.push(sql);
      return {
        rows: sql.includes('clock_timestamp() AS now')
          ? [{ now: new Date() }]
          : sql.includes("current_setting('statement_timeout')")
            ? [{ statement_timeout: '15s', lock_timeout: '0' }]
            : [],
      };
    },
  } as unknown as PoolClient;
  const db = {
    transaction: async <T>(work: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        const result = await work(tx);
        source.afterRead();
        await checkTransactionDeadlines(tx);
        return result;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const service = new ErrandAdminService(
    db,
    {
      common: async () => ({ accountId: actor, sessionId: randomUUID() }),
      recheck: async () => {},
    } as unknown as ErrandAccessService,
    {
      requireErrandManagement: async () => ({
        regionId: region,
        management: 'fixed',
        grant: { id: randomUUID() },
      }),
    } as unknown as AuthorizationService,
    { candidates: async () => source.rows } as unknown as ErrandAdminRepository,
    {
      batch: async () =>
        new Map([
          [
            publisher,
            {
              status: 'available',
              profileId: profile,
              displayName: source.name,
            },
          ],
        ]),
    } as unknown as ProfileAdminParticipantFacade,
    {
      historicalBatch: async () =>
        new Map([
          [
            region,
            { id: region, status: 'available', label: 'Region', active: true },
          ],
        ]),
      fenceAdminLabels: async () => {
        commands.push('campus NOWAIT');
      },
    } as unknown as CampusErrandScopeFacade,
    {
      create: async () => {
        throw new Error('End pages have no cursor wait');
      },
    } as unknown as DiscoveryContinuationFacade,
    { PG_POOL_MAX: 1 },
  );
  const row: ErrandAdminRow = {
    id: randomUUID(),
    revision: randomUUID(),
    publisher_id: publisher,
    accepter_id: null,
    target_region_id: region,
    source_region_id: region,
    title: 'Public title',
    public_text: 'Body',
    expected_time_text: 'Tomorrow',
    reward: '10',
    state: 'pending',
    created_at: new Date('2001-01-01T00:00:00Z'),
    scan_at: '2001-01-01T00:00:00.000000Z',
    accepted_at: null,
    completed_at: null,
    cancelled_at: null,
    deleted_at: null,
  };
  const list = (keyword = '') =>
    service.list('synthetic', { status: 'all', keyword, limit: 20 });
  return { source, row, list, commands };
}
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'ERRAND_UNAVAILABLE';
test('empty end page is a mandatory full-slice fact even without optional count capacity', async () => {
  const f = fixture();
  f.source.afterRead = () => {
    f.source.rows = [f.row];
  };
  await assert.rejects(f.list(), unavailable);
  assert.ok(f.commands.includes('SET CONSTRAINTS ALL IMMEDIATE'));
  assert.ok(f.commands.some((x) => x.includes('IN SHARE MODE NOWAIT')));
});
test('negative matching fact on an empty end page cannot silently become a positive after read', async () => {
  const f = fixture();
  f.source.rows = [f.row];
  f.source.afterRead = () => {
    f.source.name = 'After';
  };
  await assert.rejects(f.list('After'), unavailable);
});
test('unchanged empty end page survives with unavailable optional total rather than invented zero', async () => {
  const f = fixture();
  const page = await f.list();
  assert.deepEqual(page.items, []);
  assert.equal(page.continuation, 'end');
  assert.deepEqual(page.total, { status: 'unavailable' });
});
