import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { CurrentMediaSession } from '../src/identity/current-media-session.js';
import type { CategoryIconMediaRuntime } from '../src/media/application-category-icon.js';
import type {
  CategoryIconMediaDescriptor,
  PrepareCategoryIconMediaInput,
} from '../src/media/contracts-category-icon.js';
import type {
  AuthorizedCategoryIconMediaRead,
  CategoryIconMediaReadRequest,
} from '../src/media/category-icon-owner-proof.js';
import type { AuthorizedCategoryIconMediaEdit } from '../src/media/category-icon-prepare-scope.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import {
  CategoryIconMediaCredentials,
  type CategoryIconMediaAuthority,
} from '../src/ratings/category-management/icon-media-authority.js';
import { RatingCategoryIconMediaService } from '../src/ratings/category-management/icon-media.service.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE';

function fixture(runtime?: CategoryIconMediaRuntime) {
  const actor = randomUUID(),
    sessionId = randomUUID(),
    credentials = new CategoryIconMediaCredentials(),
    events: string[] = [],
    transactions: PoolClient[] = [];
  const input: PrepareCategoryIconMediaInput = {
    protocol: 'ratings-category-icon-media-v1',
    clientRequestId: randomUUID(),
    editScopeId: randomUUID(),
    scopeRevision: 'a'.repeat(64),
    slot: 'icon',
    declaration: { mime: 'image/png', bytes: 12, sha256: 'b'.repeat(64) },
  };
  const request: CategoryIconMediaReadRequest = {
    categoryId: randomUUID(),
    appearanceId: randomUUID(),
    contextId: randomUUID(),
    contextToken: 'a'.repeat(43),
    requestId: randomUUID(),
    purpose: 'direct-content',
  };
  const scope: AuthorizedCategoryIconMediaEdit = {
    actorAccountId: actor,
    serverScopeId: input.editScopeId,
    scopeRevision: input.scopeRevision,
    expiresAt: Date.now() + 60000,
    ownerKind: 'ratings',
    resourceKind: 'category_icon',
    targetKind: 'edit',
    contentVersion: 1,
    audience: 'content-gated',
    purpose: 'ratings-category-icon-image',
    slot: 'icon',
    ordinal: 0,
  };
  const read: AuthorizedCategoryIconMediaRead = {
    principal: { kind: 'authenticatedRatings', accountId: actor, sessionId },
    actorAccountId: randomUUID(),
    categoryId: request.categoryId,
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      resourceId: request.appearanceId,
      contentVersion: 1,
    },
    assetId: randomUUID(),
    manifestDigest: 'c'.repeat(64),
    bindingId: randomUUID(),
    ownerRevision: 'd'.repeat(64),
    reviewRevision: 'e'.repeat(64),
    qualification: {
      releaseId: randomUUID(),
      catalogId: randomUUID(),
      effectiveRevision: randomUUID(),
      identityId: randomUUID(),
      baseSource: { id: randomUUID(), revision: randomUUID() },
      overrideSource: { id: randomUUID(), revision: randomUUID() },
      definitionId: randomUUID(),
      extensionDigest: 'f'.repeat(64),
    },
  };
  const descriptor: CategoryIconMediaDescriptor = {
    protocol: 'ratings-category-icon-media-v1',
    kind: 'ratings-category-icon-media',
    categoryId: request.categoryId,
    contextId: request.contextId,
    contextToken: request.contextToken,
    appearanceId: request.appearanceId,
    bindingId: read.bindingId,
    width: 20,
    height: 30,
    variants: ['thumb-v1', 'display-v1'],
  };
  const database = {
    async transaction<T>(work: (tx: PoolClient) => Promise<T>) {
      const tx = {
        async query(sql: string, values: unknown[] = []) {
          events.push(sql);
          if (sql.includes('whaleu_ratings.category_icon_delivery_holds'))
            return { rows: [{ id: values[0] }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      } as unknown as PoolClient;
      transactions.push(tx);
      startTransactionDeadlines(tx);
      try {
        return await work(tx);
      } finally {
        assert.throws(() => credentials.require(tx), unavailable);
        clearTransactionDeadlines(tx);
      }
    },
  } as unknown as DatabaseService;
  const identity = {
    async session(token: string) {
      events.push('identity');
      if (token !== 'current-token')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        accountId: actor,
        sessionId,
        expiresAt: Date.now() + 60000,
        refreshExpiresAt: Date.now() + 120000,
      };
    },
  } as unknown as IdentityService;
  const access = {
    async recheck(token: string, tx: PoolClient) {
      assert.equal(credentials.require(tx).token, token);
      events.push('recheck');
    },
  } as unknown as RatingsAccessService;
  const authority: CategoryIconMediaAuthority = {
    async authorizePrepare(account, current, tx) {
      events.push('prepare');
      assert.equal(account, actor);
      assert.deepEqual(current, input);
      assert.equal(credentials.require(tx).token, 'current-token');
      assert.equal(credentials.require(tx).session.sessionId, sessionId);
      return scope;
    },
    async authorizeCurrent(token, current, tx) {
      events.push('current');
      assert.equal(token, 'current-token');
      assert.equal(credentials.require(tx).token, token);
      assert.equal(current.categoryId, request.categoryId);
      assert.equal(current.appearanceId, request.appearanceId);
      return read;
    },
  };
  const service = new RatingCategoryIconMediaService(
    database,
    identity,
    access,
    authority,
    credentials,
    new MediaDeliveryBudgetPool(),
    runtime,
  );
  return {
    service,
    credentials,
    database,
    identity,
    access,
    authority,
    actor,
    sessionId,
    events,
    transactions,
    input,
    request,
    scope,
    read,
    descriptor,
  };
}

test('Category icon transport defaults to null runtime and authenticates under Safety before work', async () => {
  const f = fixture();
  assert.equal(f.service.runtime, null);
  assert.equal(f.service.ingress, null);
  assert.equal(f.service.delivery, null);
  assert.equal(
    await f.service.authorized('current-token', async (session, tx) => {
      assert.equal(session.accountId, f.actor);
      assert.equal(f.credentials.require(tx).session, session);
      f.events.push('work');
      return 'finished';
    }),
    'finished',
  );
  assert.match(f.events[0]!, /pg_advisory_xact_lock\(/);
  assert.deepEqual(f.events.slice(1), ['identity', 'work', 'recheck']);
});

test('Category icon prepare binds the current actor and exact typed request through the original authority', async () => {
  const f = fixture();
  await f.service.authorized('current-token', async (_session, tx) => {
    const proof = await f.service.scopes.authorizeCategoryIcon(
      f.actor,
      f.input,
      tx,
    );
    const facts = f.service.scopes.require(proof, tx);
    assert.deepEqual(facts.input, f.input);
    assert.deepEqual(facts.scope, f.scope);
    assert.equal(Object.isFrozen(facts.input), true);
    await assert.rejects(
      f.service.scopes.authorizeCategoryIcon(randomUUID(), f.input, tx),
      unavailable,
    );
    assert.throws(() => f.credentials.require({} as PoolClient), unavailable);
  });
  assert.equal(f.events.filter((event) => event === 'prepare').length, 1);
  await f.database.transaction(async (tx) => {
    await assert.rejects(
      f.service.scopes.authorizeCategoryIcon(f.actor, f.input, tx),
      unavailable,
    );
  });
});

test('Category icon prepare rejects mismatched authority scope and preserves authority rejection', async () => {
  const f = fixture();
  f.authority.authorizePrepare = async () => ({
    ...f.scope,
    serverScopeId: randomUUID(),
  });
  await assert.rejects(
    f.service.authorized('current-token', (_session, tx) =>
      f.service.scopes.authorizeCategoryIcon(f.actor, f.input, tx),
    ),
    unavailable,
  );
  const refusal = new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  f.authority.authorizePrepare = async () => {
    throw refusal;
  };
  await assert.rejects(
    f.service.authorized('current-token', (_session, tx) =>
      f.service.scopes.authorizeCategoryIcon(f.actor, f.input, tx),
    ),
    (error) => error === refusal,
  );
});

test('Category icon transaction credentials clear on work and final identity failures', async () => {
  const f = fixture(),
    failure = new Error('synthetic failure');
  await assert.rejects(
    f.service.authorized('current-token', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  f.access.recheck = async () => {
    throw failure;
  };
  await assert.rejects(
    f.service.authorized('current-token', async () => 'must not escape'),
    (error) => error === failure,
  );
  for (const tx of f.transactions)
    assert.throws(() => f.credentials.require(tx), unavailable);
});

test('Category icon credentials reject forged sessions and restored transaction epochs', async () => {
  const f = fixture();
  await f.database.transaction(async (tx) => {
    await assert.rejects(
      f.credentials.run(
        'current-token',
        { accountId: f.actor } as CurrentMediaSession,
        tx,
        async () => true,
      ),
      unavailable,
    );
  });
  await assert.rejects(
    f.service.authorized('current-token', async (_session, tx) => {
      const checkpoint = checkpointTransactionDeadlines(tx);
      restoreTransactionDeadlines(tx, checkpoint);
      assert.throws(() => f.credentials.require(tx), unavailable);
    }),
    unavailable,
  );
});

test('Category icon nested credentials cannot switch bearer or end the outer credential lifetime', async () => {
  const f = fixture();
  await f.service.authorized('current-token', async (session, tx) => {
    await assert.rejects(
      f.credentials.run('other-token', session, tx, async () => true),
      unavailable,
    );
    const before = f.credentials.require(tx);
    assert.equal(
      await f.credentials.run('current-token', session, tx, async () => {
        assert.equal(f.credentials.require(tx), before);
        return 'nested';
      }),
      'nested',
    );
    assert.equal(f.credentials.require(tx), before);
  });
});

test('Category icon descriptor retains exact current qualification and allows a different original uploader', async (t) => {
  const f = fixture();
  assert.notEqual(f.read.actorAccountId, f.actor);
  t.mock.method(
    f.service.assets,
    'categoryIconDescriptor',
    async (
      ...[proof, request, tx]: Parameters<
        typeof f.service.assets.categoryIconDescriptor
      >
    ) => {
      assert.deepEqual(f.service.registry.require(proof, request, tx), f.read);
      assert.deepEqual(request, f.request);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(f.credentials.require(tx).session.accountId, f.actor);
      return f.descriptor;
    },
  );
  assert.deepEqual(
    await f.service.describe('current-token', f.request),
    f.descriptor,
  );
  assert.equal(f.events.filter((event) => event === 'current').length, 1);
  assert.match(f.events[0]!, /pg_advisory_xact_lock_shared/);
  assert.equal(
    f.events.some((event) => /SELECT.*category/i.test(event)),
    false,
  );
  await f.database.transaction(async (tx) => {
    assert.deepEqual(
      await f.service.descriptorInTransaction('current-token', f.request, tx),
      f.descriptor,
    );
    assert.throws(() => f.credentials.require(tx), unavailable);
  });
});

test('Category icon current authority cannot substitute the viewer account or session', async (t) => {
  const f = fixture();
  const descriptor = t.mock.method(
    f.service.assets,
    'categoryIconDescriptor',
    async () => f.descriptor,
  );
  for (const principal of [
    { ...f.read.principal, accountId: randomUUID() },
    { ...f.read.principal, sessionId: randomUUID() },
  ]) {
    f.authority.authorizeCurrent = async () => ({ ...f.read, principal });
    await assert.rejects(
      f.service.describe('current-token', f.request),
      unavailable,
    );
  }
  assert.equal(descriptor.mock.callCount(), 0);
});

test('Category icon current denial and invalid credentials never fall back to historical descriptors', async (t) => {
  const f = fixture(),
    refusal = new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  const descriptor = t.mock.method(
    f.service.assets,
    'categoryIconDescriptor',
    async () => f.descriptor,
  );
  const authority = t.mock.method(f.authority, 'authorizeCurrent', async () => {
    throw refusal;
  });
  await assert.rejects(
    f.service.describe('wrong-token', f.request),
    unavailable,
  );
  assert.equal(authority.mock.callCount(), 0);
  await assert.rejects(
    f.service.describe('current-token', f.request),
    (error) => error === refusal,
  );
  assert.equal(descriptor.mock.callCount(), 0);
});

test('Category icon owner wires protocol 8 ingress and two current delivery checks without external transport', async (t) => {
  const bytes = Buffer.from('synthetic-category-icon-owner'),
    object = {
      provider: 'local-fixture',
      environment: 'synthetic',
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    };
  const unexpected = () => {
    throw new Error('unused synthetic transport');
  };
  let opened = 0;
  const planning = {
    writerInstanceId: randomUUID(),
    plan: () => ({ staging: object, sealed: object }),
    scratch: () => object,
    requireStopped: unexpected,
  };
  const runtime: CategoryIconMediaRuntime = {
    planning,
    ingressStorage: {
      ...planning,
      write: unexpected,
      quiesce: unexpected,
      removeScratch: unexpected,
    },
    storage: {
      provider: object.provider,
      environment: object.environment,
      seal: unexpected,
      deleteExact: unexpected,
      async openExact() {
        opened++;
        return { bytes: bytes.length, stream: Readable.from([bytes]) };
      },
    },
  };
  const f = fixture(runtime);
  assert.ok(f.service.ingress);
  assert.ok(f.service.delivery);
  const request = { ...f.request, purpose: 'download' as const };
  t.mock.method(
    f.service.assets,
    'categoryIconDeliveryPlan',
    async (
      ...[proof, current, variant, tx]: Parameters<
        typeof f.service.assets.categoryIconDeliveryPlan
      >
    ) => {
      const read = f.service.registry.require(proof, current, tx);
      assert.equal(f.credentials.require(tx).session.accountId, f.actor);
      return {
        ...read,
        contextId: current.contextId,
        contextToken: current.contextToken,
        variant,
        safetyRevision: '1',
        object,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        attachmentSetRevision: 'a'.repeat(64),
        bytes: bytes.length,
        mime: 'image/png' as const,
      };
    },
  );
  const stream = await f.service.delivery.open(
    'current-token',
    request,
    'display-v1',
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream.stream) chunks.push(chunk as Buffer);
  stream.abort();
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(opened, 1);
  assert.equal(
    f.transactions.length,
    3,
    'Two authorizations plus one physically-quiet hold closure',
  );
  assert.equal(
    f.events.filter((event) =>
      event.includes('UPDATE whaleu_ratings.category_icon_delivery_holds'),
    ).length,
    1,
  );
  assert.equal(f.events.filter((event) => event === 'current').length, 2);
  assert.equal(f.events.filter((event) => event === 'recheck').length, 4);
  // A non-8 repository would reject before reaching this Category query.
  let queried = false;
  const tx = {
    async query() {
      queried = true;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    // The injected repository reaches its Category query, rather than rejecting
    // Category 8 as an unsupported transport protocol.
    await assert.rejects(
      f.service.ingress.originalCategoryIconInput(f.actor, randomUUID(), tx),
    );
    assert.equal(queried, true);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
