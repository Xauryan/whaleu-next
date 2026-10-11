import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { RatingCategoryManagementAuthorityFacade } from '../src/authorization/rating-category-management.facade.js';
import type { CampusRatingScopedContextFacade } from '../src/campus/rating-scoped-context.facade.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type {
  CategoryIconMediaAssetRepository,
  CategoryIconMediaMutation,
} from '../src/media/category-icon-asset-repository.js';
import { CategoryIconRetirementProofRegistry } from '../src/media/category-icon-retirement-proof.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import type { CategoryIconPlan } from '../src/ratings/category-management/icon-plan.js';
import type { CategoryIconBaseRoot } from '../src/ratings/category-management/icon-references.js';
import {
  RatingCategoryIconRetirementOwner,
  retireCategoryIconAppearances,
} from '../src/ratings/category-management/icon-retirement.js';

const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'RATING_SCOPE_UNAVAILABLE';
function fixture() {
  const actor = id(1),
    request = { requestId: id(2), appearanceIds: [id(3)] },
    scopes = [`campus:${id(10)}`, `campus:${id(11)}`],
    calls: { sql: string; values: unknown[] }[] = [],
    events: string[] = [];
  const state = {
    blocker: null as string | null,
    retired: false,
    detached: false,
    closure: 'a'.repeat(64),
    authorized: true,
    gate: true,
    missing: false,
    phaseChange: false,
    reads: 0,
    global: false,
  };
  const row = () => ({
    appearance_id: id(3),
    asset_id: id(4),
    binding_id: id(5),
    actor_id: id(6),
    manifest_digest: 'b'.repeat(64),
    scope_keys: scopes,
    global_required: state.global,
    retired: state.retired,
    blocker: state.blocker,
  });
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '100ms',
            },
          ],
        };
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ locked: state.gate }] };
      if (sql.startsWith('SELECT q.appearance_id')) {
        state.reads++;
        if (state.phaseChange && state.reads === 2) state.blocker = 'delivery';
        return { rows: state.missing ? [] : [row()] };
      }
      if (
        sql.startsWith('SELECT whaleu_ratings.category_icon_retirement_closure')
      )
        return { rows: [{ revision: state.closure }] };
      if (
        sql.startsWith(
          'INSERT INTO whaleu_ratings.category_icon_terminal_retirements',
        )
      ) {
        events.push('terminal');
        state.retired = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT causing_actor_id actor_id'))
        return { rows: [{ actor_id: actor }] };
      if (sql.includes('count(*)::integer count'))
        return { rows: [{ count: state.detached ? 1 : 0 }] };
      if (sql.startsWith('SELECT epoch'))
        return { rows: [{ epoch: '1', version: 1 }] };
      if (sql.startsWith('SELECT jsonb_build_object'))
        return { rows: [{ state: { category: 'stable' } }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const required: { campuses: readonly string[]; global: boolean }[] = [];
  const access = {
    async authenticate(token: string) {
      assert.equal(token, 'session');
      events.push('authenticate');
      return { accountId: actor, sessionId: id(7) };
    },
    async requireDeletionActor(value: string) {
      assert.equal(value, actor);
    },
    async recheck(token: string) {
      assert.equal(token, 'session');
    },
  } as unknown as RatingsAccessService;
  const authority = {
    async resolve(value: string) {
      assert.equal(value, actor);
      return { accountId: actor };
    },
    require(_grant: unknown, campuses: readonly string[], global: boolean) {
      required.push({ campuses, global });
      events.push('all-of');
      if (!state.authorized)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    },
  } as unknown as RatingCategoryManagementAuthorityFacade;
  const campus = {
    async resolveCategoryManagementDomains(
      _actor: unknown,
      selectors: unknown[],
    ) {
      assert.equal(selectors.length, scopes.length);
      events.push('campus');
      return [];
    },
  } as unknown as CampusRatingScopedContextFacade;
  const owner = new RatingCategoryIconRetirementOwner(
      access,
      authority,
      campus,
    ),
    registry = new CategoryIconRetirementProofRegistry(owner);
  const assets = {
    async prepareCategoryIconMutation(
      value: string,
      fresh: string[],
      proof: Parameters<CategoryIconRetirementProofRegistry['claim']>[0],
      client: PoolClient,
    ) {
      events.push('media-prepare');
      assert.deepEqual(fresh, []);
      assert.equal(value, actor);
      const facts = registry.claim(proof, value, client);
      assert.equal(
        facts.appearances[0]?.actorAccountId,
        id(6),
        'uploader is not inferred from current manager',
      );
      return {} as CategoryIconMediaMutation;
    },
    async finishCategoryIconMutation() {
      events.push('media-finish');
      state.detached = true;
    },
  } as unknown as CategoryIconMediaAssetRepository;
  startTransactionDeadlines(tx);
  return {
    owner,
    registry,
    assets,
    tx,
    state,
    request,
    actor,
    scopes,
    calls,
    events,
    required,
  };
}

test('Category terminal cleanup authenticates all original scopes before exact Media8 admission and reports no physical deletion', async () => {
  const f = fixture();
  try {
    const result = await retireCategoryIconAppearances(
      f.owner,
      f.registry,
      f.assets,
      'session',
      f.request,
      f.tx,
    );
    assert.deepEqual(result, {
      state: 'cleanup_pending',
      appearanceIds: f.request.appearanceIds,
    });
    assert.deepEqual(f.required, [
      { campuses: f.scopes.map((scope) => scope.slice(7)), global: false },
    ]);
    assert.ok(f.events.indexOf('all-of') < f.events.indexOf('terminal'));
    assert.ok(f.events.indexOf('terminal') < f.events.indexOf('media-prepare'));
    assert.ok(
      f.events.indexOf('media-prepare') < f.events.indexOf('media-finish'),
    );
    await checkTransactionDeadlines(f.tx);
    assert.ok(
      f.calls.some(
        (call) =>
          call.sql.includes('category_icon_delivery_holds') &&
          call.sql.includes('SHARE MODE NOWAIT'),
      ),
    );
    assert.ok(
      f.calls.some(
        (call) =>
          call.sql.includes('whaleu_media.jobs') &&
          call.sql.includes('SHARE MODE NOWAIT'),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

for (const blocker of [
  'recoverable_root',
  'unresolved_root',
  'prepared_command',
  'delivery',
  'worker',
  'retention',
  'unknown',
]) {
  test(`Category terminal cleanup retains ${blocker} without detaching or manufacturing closure`, async () => {
    const f = fixture();
    f.state.blocker = blocker;
    try {
      await assert.rejects(
        retireCategoryIconAppearances(
          f.owner,
          f.registry,
          f.assets,
          'session',
          f.request,
          f.tx,
        ),
        unavailable,
      );
      assert.equal(f.state.retired, false);
      assert.equal(f.state.detached, false);
      assert.equal(f.events.includes('media-prepare'), false);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  });
}

test('Category queue inspection is minimal and authorized all-of even for a held or already-retired appearance', async () => {
  for (const retired of [false, true]) {
    const f = fixture();
    f.state.retired = retired;
    f.state.blocker = 'delivery';
    f.state.global = true;
    try {
      assert.deepEqual(await f.owner.inspect('session', f.request, f.tx), [
        { appearanceId: id(3), state: retired ? 'retired' : 'held' },
      ]);
      assert.equal(f.required[0]?.global, true);
      await checkTransactionDeadlines(f.tx);
      assert.equal(
        f.calls.some((call) => call.sql.startsWith('INSERT')),
        false,
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
  const denied = fixture();
  denied.state.authorized = false;
  try {
    await assert.rejects(
      denied.owner.inspect('session', denied.request, denied.tx),
      unavailable,
    );
    assert.equal(denied.events.includes('terminal'), false);
  } finally {
    clearTransactionDeadlines(denied.tx);
  }
});

test('Category terminal closure rechecks after owner epoch acquisition and rejects an arriving hold', async () => {
  const f = fixture();
  f.state.phaseChange = true;
  try {
    await assert.rejects(
      retireCategoryIconAppearances(
        f.owner,
        f.registry,
        f.assets,
        'session',
        f.request,
        f.tx,
      ),
      unavailable,
    );
    assert.equal(f.state.retired, false);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('Category terminal final proof rejects late holds, root-closure drift and unfinished Media detach', async () => {
  for (const change of ['hold', 'closure', 'detach'] as const) {
    const f = fixture();
    try {
      await retireCategoryIconAppearances(
        f.owner,
        f.registry,
        f.assets,
        'session',
        f.request,
        f.tx,
      );
      if (change === 'hold') f.state.blocker = 'delivery';
      if (change === 'closure') f.state.closure = 'c'.repeat(64);
      if (change === 'detach') f.state.detached = false;
      await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('Category retirement proof cannot finish without Media or survive another transaction epoch', async () => {
  const f = fixture();
  try {
    const checkpoint = checkpointTransactionDeadlines(f.tx);
    await f.registry.authorize('session', f.request, f.tx);
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
    restoreTransactionDeadlines(f.tx, checkpoint);
    await assert.rejects(f.owner.finish(f.request, f.tx), unavailable);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('Category retirement fails closed on lock conflict, unknown queue identity and duplicate or empty batches', async () => {
  for (const mode of ['gate', 'missing', 'duplicate', 'empty'] as const) {
    const f = fixture();
    if (mode === 'gate') f.state.gate = false;
    if (mode === 'missing') f.state.missing = true;
    const exact =
      mode === 'duplicate'
        ? { ...f.request, appearanceIds: [id(3), id(3)] }
        : mode === 'empty'
          ? { ...f.request, appearanceIds: [] }
          : f.request;
    try {
      await assert.rejects(
        f.owner.inspect('session', exact, f.tx),
        unavailable,
      );
      assert.equal(f.events.includes('media-prepare'), false);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

function root(): CategoryIconBaseRoot {
  return {
    kind: 'base',
    categoryId: id(20),
    identityId: id(21),
    definitionId: id(22),
    source: { id: id(23), revision: id(24) },
    scopeKeys: [`campus:${id(10)}`],
    retention: 'current',
    value: {
      kind: 'image',
      appearance: {
        categoryId: id(20),
        identityId: id(21),
        appearanceId: id(3),
        assetId: id(4),
        actorId: id(6),
        manifestDigest: 'b'.repeat(64),
        origin: { kind: 'base' },
      },
    },
  };
}
function plan(
  beforeRoots: CategoryIconBaseRoot[],
  afterRoots: CategoryIconBaseRoot[],
): CategoryIconPlan {
  return {
    accountId: id(1),
    requestId: id(2),
    digest: 'd'.repeat(64),
    beforeRoots,
    afterRoots,
    noop: false,
    globalRequired: false,
    affectedScopeKeys: [`campus:${id(10)}`, `campus:${id(11)}`],
  } as unknown as CategoryIconPlan;
}
test('Category keep, dormant, archive and source-only successors never enqueue a retirement', async () => {
  const f = fixture(),
    before = root();
  try {
    for (const after of [
      before,
      { ...before, retention: 'dormant' as const },
      { ...before, retention: 'archived' as const },
      {
        ...before,
        definitionId: id(25),
        source: { id: id(26), revision: id(27) },
      },
    ]) {
      await f.owner.enqueue(plan([before], [after]), f.tx);
    }
    assert.equal(f.calls.length, 0);
    await f.owner.enqueue(plan([before], []), f.tx);
    assert.equal(f.calls.length, 1);
    assert.match(
      f.calls[0]!.sql,
      /INSERT INTO whaleu_ratings.category_icon_retirement_queue/,
    );
    assert.deepEqual(f.calls[0]!.values, [
      [id(3)],
      id(1),
      id(2),
      'd'.repeat(64),
      [`campus:${id(10)}`, `campus:${id(11)}`],
      false,
    ]);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
