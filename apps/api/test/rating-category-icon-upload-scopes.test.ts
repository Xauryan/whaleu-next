import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  CATEGORY_ICON_MEDIA_PROTOCOL,
  categoryIconMediaRequestHash,
  type CategoryIconMediaRecovery,
} from '../src/media/contracts-category-icon.js';
import {
  categoryIconUploadScopeRequestHash,
  ratingCategoryIconUploadScopeSchema,
  type RatingCategoryIconUploadScopeInput,
} from '../src/ratings/category-management/icon-contracts.js';
import {
  CATEGORY_ICON_UPLOAD_SCOPE_OPERATION,
  CategoryIconUploadScopes,
  categoryIconUploadScopeRevision,
  type AuthorizedCategoryIconUploadScope,
} from '../src/ratings/category-management/icon-upload-scopes.js';

const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const actor = id(1),
  session = id(2);
const now = Date.parse('2026-10-10T22:00:00.000Z');
function input(): RatingCategoryIconUploadScopeInput {
  return ratingCategoryIconUploadScopeSchema.parse({
    protocolVersion: 5,
    operation: 'create_categories_scoped',
    context: {
      id: id(3),
      token: 't'.repeat(43),
      tokenDigest: createHash('sha256').update('t'.repeat(43)).digest('hex'),
      selector: { kind: 'campus', campusId: id(4) },
      scopeRevision: 'a'.repeat(64),
      protocolGeneration: id(5),
      catalogRevision: id(6),
      headRevision: id(7),
      sourceDigest: 'b'.repeat(64),
    },
    payload: {
      clientRequestId: id(8),
      expectedSnapshot: 'c'.repeat(64),
      parentId: null,
      placement: { kind: 'campuses', campusIds: [id(4)] },
      nodes: [
        { key: 'root', parentKey: null, name: '原文 🌊', description: '' },
        {
          key: 'child',
          parentKey: 'root',
          name: 'Child',
          description: 'Original text',
        },
      ],
    },
    mediaSnapshot: 'd'.repeat(64),
    clientRequestId: id(9),
    draftRevision: id(10),
    slot: { kind: 'new', key: 'root' },
    declaration: { mime: 'image/png', bytes: 1234, sha256: 'e'.repeat(64) },
  });
}
type Stored = {
  id: string;
  actor_id: string;
  client_request_id: string;
  command_request_id: string;
  scope_revision: string;
  scope_request_hash: string;
  request_hash: string;
  input: RatingCategoryIconUploadScopeInput;
  declaration: RatingCategoryIconUploadScopeInput['declaration'];
  context_id: string;
  session_id: string;
  category_id: string;
  identity_id: string;
  origin: AuthorizedCategoryIconUploadScope['origin'];
  expires_at: Date;
};
const key = (owner: unknown, request: unknown) => `${owner}:${request}`;
function fixture() {
  const scopes = new Map<string, Stored>();
  const fences = new Map<string, { request_hash: string }>();
  const claims = new Map<string, { operation: string; intent_hash: string }>();
  const heldLocks = new Map<string, object>();
  const queries: { sql: string; values: unknown[] }[] = [];
  const foreignKeys = new Set<string>();
  const mediaResults = new Map<string, CategoryIconMediaRecovery>();
  const mediaCalls: {
    method: string;
    actor: string;
    key: string;
    input?: unknown;
    tx: PoolClient;
  }[] = [];
  const state = {
    now,
    authorizeCalls: 0,
    authorityUnavailable: false,
    expectedInput: input(),
    authorized: {
      categoryId: id(11),
      identityId: id(12),
      origin: { kind: 'base' as const },
      contextId: id(3),
      expiresAt: new Date(now + 4 * 60 * 1000),
    } as AuthorizedCategoryIconUploadScope,
  };
  const service = new CategoryIconUploadScopes(
    {
      async authorize(owner, currentSession, scopeInput, tx) {
        state.authorizeCalls++;
        assert.equal(owner, actor);
        assert.equal(currentSession, session);
        assert.deepEqual(scopeInput, state.expectedInput);
        assert.ok(tx);
        if (state.authorityUnavailable)
          throw new ApplicationError('RATING_CATEGORY_CONTEXT_CHANGED');
        return state.authorized;
      },
    },
    {
      async recover(owner, request, tx) {
        mediaCalls.push({ method: 'recover', actor: owner, key: request, tx });
        return (
          mediaResults.get(key(owner, request)) ?? {
            protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
            requestId: request,
            serverNow: state.now,
            state: 'not_recorded',
            requestHash: null,
          }
        );
      },
      async cancelRequest(owner, request, value, tx) {
        mediaCalls.push({
          method: 'cancel',
          actor: owner,
          key: request,
          input: value,
          tx,
        });
        const body = value as { requestHash: string };
        const recovery: CategoryIconMediaRecovery = {
          protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
          requestId: request,
          serverNow: state.now,
          state: 'cancelled_before_prepare',
          requestHash: body.requestHash,
          reason: 'cancelled',
        };
        mediaResults.set(key(owner, request), recovery);
        return recovery;
      },
    },
  );
  function transaction() {
    const owner = {};
    const tx = {
      async query(sql: string, values: unknown[] = []) {
        queries.push({ sql, values });
        const response = (rows: unknown[]) => ({ rows, rowCount: rows.length });
        if (sql.startsWith('SELECT pg_try_advisory_xact_lock')) {
          const name = values[0] as string;
          const current = heldLocks.get(name);
          if (current && current !== owner)
            return response([{ locked: false }]);
          heldLocks.set(name, owner);
          return response([{ locked: true }]);
        }
        const k = key(values[0], values[1]);
        if (
          sql.startsWith(
            'SELECT * FROM whaleu_ratings.category_icon_upload_scopes',
          )
        ) {
          const row = scopes.get(k);
          return response(row ? [structuredClone(row)] : []);
        }
        if (
          sql.startsWith(
            'SELECT request_hash FROM whaleu_ratings.category_icon_upload_scope_fences',
          )
        ) {
          const row = fences.get(k);
          return response(row ? [row] : []);
        }
        if (
          sql.startsWith(
            'SELECT operation,intent_hash FROM whaleu_ratings.command_claims',
          )
        ) {
          const row = claims.get(k);
          return response(row ? [row] : []);
        }
        if (sql.startsWith('SELECT EXISTS('))
          return response([{ occupied: foreignKeys.has(k) }]);
        if (sql === 'SELECT clock_timestamp() now')
          return response([{ now: new Date(state.now) }]);
        if (sql.startsWith('INSERT INTO whaleu_ratings.command_claims')) {
          if (!claims.has(k))
            claims.set(k, {
              operation: values[2] as string,
              intent_hash: values[3] as string,
            });
          return response([]);
        }
        if (
          sql.startsWith(
            'INSERT INTO whaleu_ratings.category_icon_upload_scopes',
          )
        ) {
          const row: Stored = {
            id: values[0] as string,
            actor_id: values[1] as string,
            client_request_id: values[2] as string,
            command_request_id: values[3] as string,
            scope_revision: values[4] as string,
            scope_request_hash: values[5] as string,
            request_hash: values[6] as string,
            input: JSON.parse(
              values[7] as string,
            ) as RatingCategoryIconUploadScopeInput,
            declaration: JSON.parse(
              values[8] as string,
            ) as RatingCategoryIconUploadScopeInput['declaration'],
            context_id: values[9] as string,
            session_id: values[10] as string,
            category_id: values[11] as string,
            identity_id: values[12] as string,
            origin: JSON.parse(
              values[13] as string,
            ) as AuthorizedCategoryIconUploadScope['origin'],
            expires_at: new Date((values[14] as Date).getTime()),
          };
          scopes.set(key(row.actor_id, row.client_request_id), row);
          return response([]);
        }
        if (
          sql.startsWith(
            'INSERT INTO whaleu_ratings.category_icon_upload_scope_fences',
          )
        ) {
          assert.equal(fences.has(k), false);
          fences.set(k, { request_hash: values[2] as string });
          return response([]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as PoolClient;
    startTransactionDeadlines(tx);
    return {
      tx,
      close() {
        clearTransactionDeadlines(tx);
        for (const [name, held] of heldLocks)
          if (held === owner) heldLocks.delete(name);
      },
    };
  }
  return {
    service,
    state,
    scopes,
    fences,
    claims,
    queries,
    foreignKeys,
    mediaResults,
    mediaCalls,
    transaction,
  };
}
const isError = (code: ApplicationError['code']) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

test('scope creation persists the exact owner input and uses the actual Media8 hash codec', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  try {
    const result = await f.service.create(actor, session, request, t.tx);
    assert.deepEqual(Object.keys(result).sort(), [
      'categoryId',
      'editScopeId',
      'expiresAt',
      'identityId',
      'scopeRevision',
    ]);
    const row = f.scopes.get(key(actor, request.clientRequestId))!;
    assert.deepEqual(row.input, request);
    assert.equal(
      row.scope_request_hash,
      categoryIconUploadScopeRequestHash(request),
    );
    assert.equal(
      row.request_hash,
      categoryIconMediaRequestHash(actor, {
        protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
        clientRequestId: request.clientRequestId,
        editScopeId: result.editScopeId,
        scopeRevision: result.scopeRevision,
        slot: 'icon',
        declaration: request.declaration,
      }),
    );
    assert.notEqual(row.scope_request_hash, row.request_hash);
    assert.equal(
      row.scope_revision,
      categoryIconUploadScopeRevision(
        actor,
        session,
        row.id,
        request,
        f.state.authorized,
      ),
    );
    assert.deepEqual(f.claims.get(key(actor, request.clientRequestId)), {
      operation: CATEGORY_ICON_UPLOAD_SCOPE_OPERATION,
      intent_hash: row.scope_request_hash,
    });
    assert.equal(f.state.authorizeCalls, 1);
    assert.equal(f.mediaCalls.length, 0);
    assert.equal(
      f.queries.some(({ sql }) =>
        sql.startsWith('INSERT INTO whaleu_ratings.requests'),
      ),
      false,
    );
    const namespace = f.queries.find(({ sql }) =>
      sql.startsWith('SELECT EXISTS('),
    )!.sql;
    for (const table of [
      'upload_request_fences',
      'upload_intents',
      'category_icon_request_markers',
      'profile_request_markers',
      'ratings_request_markers',
      'ratings_discussion_request_markers',
      'ratings_discussion_batch_request_fences',
      'ratings_discussion_batches',
    ])
      assert.ok(namespace.includes(table));
    request.declaration.bytes++;
    assert.equal(row.declaration.bytes, 1234);
  } finally {
    t.close();
  }
});

test('an immutable retry survives stale context, expired scope and a newer authenticated session', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  try {
    const original = await f.service.create(actor, session, request, t.tx);
    f.state.authorityUnavailable = true;
    f.state.now += 24 * 60 * 60 * 1000;
    assert.deepEqual(
      await f.service.create(actor, id(99), request, t.tx),
      original,
    );
    const recovered = await f.service.recover(
      actor,
      {
        clientRequestId: request.clientRequestId,
        requestHash: categoryIconUploadScopeRequestHash(request),
      },
      t.tx,
    );
    assert.equal(recovered.state, 'known');
    assert.deepEqual(recovered.scope, original);
    assert.equal(recovered.recovery?.state, 'not_recorded');
    assert.equal(f.state.authorizeCalls, 1);
    assert.equal(f.scopes.size, 1);
  } finally {
    t.close();
  }
});

test('same upload key cannot change text, draft, slot, declaration, snapshot, context or command identity', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  try {
    await f.service.create(actor, session, request, t.tx);
    f.state.authorityUnavailable = true;
    const edits: ((value: RatingCategoryIconUploadScopeInput) => void)[] = [
      (value) => {
        value.draftRevision = id(88);
      },
      (value) => {
        value.slot = { kind: 'new', key: 'child' };
      },
      (value) => {
        value.declaration.mime = 'image/jpeg';
      },
      (value) => {
        value.declaration.bytes++;
      },
      (value) => {
        value.declaration.sha256 = 'f'.repeat(64);
      },
      (value) => {
        value.mediaSnapshot = 'f'.repeat(64);
      },
      (value) => {
        value.context.id = id(88);
      },
      (value) => {
        value.payload.clientRequestId = id(88);
      },
      (value) => {
        if (value.operation === 'create_categories_scoped')
          value.payload.nodes[0]!.name = 'Different text';
      },
    ];
    for (const edit of edits) {
      const changed = structuredClone(request);
      edit(changed);
      await assert.rejects(
        f.service.create(actor, session, changed, t.tx),
        isError('REQUEST_CONFLICT'),
      );
    }
    assert.equal(f.state.authorizeCalls, 1);
    assert.equal(f.scopes.size, 1);
  } finally {
    t.close();
  }
});

test('unknown recovery remains unknown without a journal-erasing claim, fence or fabricated Media request', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    for (let i = 0; i < 2; i++)
      assert.deepEqual(await f.service.recover(actor, lookup, t.tx), {
        scope: null,
        recovery: null,
        state: 'unknown',
      });
    assert.equal(f.claims.size, 0);
    assert.equal(f.fences.size, 0);
    assert.equal(f.mediaCalls.length, 0);
    assert.equal(f.state.authorizeCalls, 0);
    assert.equal(
      f.queries.some(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql)),
      false,
    );
  } finally {
    t.close();
  }
});

test('cancel-before-create persists an exact owner fence and blocks every late create without current authority', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    assert.deepEqual(await f.service.cancel(actor, lookup, t.tx), {
      scope: null,
      recovery: null,
      state: 'cancelled',
    });
    assert.deepEqual(await f.service.cancel(actor, lookup, t.tx), {
      scope: null,
      recovery: null,
      state: 'cancelled',
    });
    assert.deepEqual(await f.service.recover(actor, lookup, t.tx), {
      scope: null,
      recovery: null,
      state: 'cancelled',
    });
    assert.equal(f.fences.size, 1);
    assert.equal(
      f.claims.get(key(actor, request.clientRequestId))?.intent_hash,
      lookup.requestHash,
    );
    assert.equal(f.mediaCalls.length, 0);
    f.state.authorityUnavailable = true;
    await assert.rejects(
      f.service.create(actor, session, request, t.tx),
      isError('MEDIA_REQUEST_CANCELLED'),
    );
    assert.equal(f.state.authorizeCalls, 0);
    assert.equal(f.scopes.size, 0);
    await assert.rejects(
      f.service.cancel(actor, { ...lookup, requestHash: 'f'.repeat(64) }, t.tx),
      isError('REQUEST_CONFLICT'),
    );
    await assert.rejects(
      f.service.recover(
        actor,
        { ...lookup, requestHash: 'f'.repeat(64) },
        t.tx,
      ),
      isError('REQUEST_CONFLICT'),
    );
    const changed = { ...request, draftRevision: id(88) };
    await assert.rejects(
      f.service.create(actor, session, changed, t.tx),
      isError('REQUEST_CONFLICT'),
    );
  } finally {
    t.close();
  }
});

test('cancel after scope creation uses only its stored Media8 request hash in the same transaction', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    const scope = await f.service.create(actor, session, request, t.tx);
    const row = f.scopes.get(key(actor, request.clientRequestId))!;
    f.state.authorityUnavailable = true;
    const result = await f.service.cancel(actor, lookup, t.tx);
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(result.scope, scope);
    assert.equal(result.recovery?.state, 'cancelled_before_prepare');
    assert.deepEqual(f.mediaCalls[0], {
      method: 'cancel',
      actor,
      key: request.clientRequestId,
      tx: t.tx,
      input: {
        protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
        requestHash: row.request_hash,
      },
    });
    assert.notEqual(row.request_hash, lookup.requestHash);
    await assert.rejects(
      f.service.create(actor, session, request, t.tx),
      isError('MEDIA_REQUEST_CANCELLED'),
    );
    assert.equal(f.state.authorizeCalls, 1);
    const recovered = await f.service.recover(actor, lookup, t.tx);
    assert.deepEqual(recovered, result);
  } finally {
    t.close();
  }
});

test('recovery rejects changed owner hashes and a mismatched Media8 receipt', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    await f.service.create(actor, session, request, t.tx);
    await assert.rejects(
      f.service.recover(
        actor,
        { ...lookup, requestHash: 'f'.repeat(64) },
        t.tx,
      ),
      isError('REQUEST_CONFLICT'),
    );
    f.mediaResults.set(key(actor, request.clientRequestId), {
      protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
      requestId: request.clientRequestId,
      serverNow: now,
      state: 'cancelled_before_prepare',
      requestHash: 'f'.repeat(64),
      reason: 'cancelled',
    });
    await assert.rejects(
      f.service.recover(actor, lookup, t.tx),
      isError('REQUEST_CONFLICT'),
    );
  } finally {
    t.close();
  }
});

test('every operation fails closed on a foreign Ratings claim or Media namespace', async () => {
  for (const foreign of ['claim', 'media'] as const) {
    const f = fixture(),
      t = f.transaction(),
      request = input();
    const lookup = {
      clientRequestId: request.clientRequestId,
      requestHash: categoryIconUploadScopeRequestHash(request),
    };
    try {
      if (foreign === 'claim')
        f.claims.set(key(actor, request.clientRequestId), {
          operation: 'create_categories_scoped',
          intent_hash: lookup.requestHash,
        });
      else f.foreignKeys.add(key(actor, request.clientRequestId));
      await assert.rejects(
        f.service.create(actor, session, request, t.tx),
        isError('REQUEST_CONFLICT'),
      );
      await assert.rejects(
        f.service.recover(actor, lookup, t.tx),
        isError('REQUEST_CONFLICT'),
      );
      await assert.rejects(
        f.service.cancel(actor, lookup, t.tx),
        isError('REQUEST_CONFLICT'),
      );
      assert.equal(f.state.authorizeCalls, 0);
      assert.equal(f.scopes.size, 0);
      assert.equal(f.fences.size, 0);
      assert.equal(f.mediaCalls.length, 0);
    } finally {
      t.close();
    }
  }
});

test('owner hash alone cannot reveal another actor scope or cancel that actor Media request', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    const scope = await f.service.create(actor, session, request, t.tx);
    assert.deepEqual(await f.service.recover(id(90), lookup, t.tx), {
      scope: null,
      recovery: null,
      state: 'unknown',
    });
    assert.deepEqual(await f.service.cancel(id(90), lookup, t.tx), {
      scope: null,
      recovery: null,
      state: 'cancelled',
    });
    assert.equal(f.mediaCalls.length, 0);
    assert.equal(f.fences.has(key(actor, request.clientRequestId)), false);
    assert.deepEqual(
      await f.service.create(actor, session, request, t.tx),
      scope,
    );
  } finally {
    t.close();
  }
});

test('original actor reservation and per-key lock serialize cancellation against creation with bounded failure', async () => {
  const f = fixture(),
    first = f.transaction(),
    second = f.transaction(),
    request = input();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  try {
    await f.service.cancel(actor, lookup, first.tx);
    await assert.rejects(
      f.service.create(actor, session, request, second.tx),
      isError('RATING_SCOPE_UNAVAILABLE'),
    );
    assert.equal(f.state.authorizeCalls, 0);
    first.close();
    await assert.rejects(
      f.service.create(actor, session, request, second.tx),
      isError('MEDIA_REQUEST_CANCELLED'),
    );
    const lockNames = f.queries
      .filter(({ sql }) => sql.startsWith('SELECT pg_try_advisory_xact_lock'))
      .map(({ values }) => values[0]);
    assert.ok(lockNames.includes(`whaleu:media-reservation:v1:${actor}`));
    assert.ok(
      lockNames.includes(
        `whaleu:ratings-category-icon-upload-scope:v1:${actor}:${request.clientRequestId}`,
      ),
    );
  } finally {
    first.close();
    second.close();
  }
});

test('unmanaged transactions cannot use create, recover or cancellation as actor-only authority', async () => {
  const f = fixture(),
    t = f.transaction(),
    request = input();
  t.close();
  const lookup = {
    clientRequestId: request.clientRequestId,
    requestHash: categoryIconUploadScopeRequestHash(request),
  };
  await assert.rejects(
    f.service.create(actor, session, request, t.tx),
    isError('RATING_SCOPE_UNAVAILABLE'),
  );
  await assert.rejects(
    f.service.recover(actor, lookup, t.tx),
    isError('RATING_SCOPE_UNAVAILABLE'),
  );
  await assert.rejects(
    f.service.cancel(actor, lookup, t.tx),
    isError('RATING_SCOPE_UNAVAILABLE'),
  );
  assert.equal(f.queries.length, 0);
});

test('authorized target, origin, context and expiry cannot be substituted before persistence', async () => {
  const invalidAuthorities: Partial<AuthorizedCategoryIconUploadScope>[] = [
    { contextId: id(90) },
    { origin: { kind: 'override', campusId: id(4) } },
    { expiresAt: new Date(now) },
    { expiresAt: new Date(now + 300001) },
    { expiresAt: new Date(Number.NaN) },
  ];
  for (const invalid of invalidAuthorities) {
    const f = fixture(),
      t = f.transaction();
    try {
      f.state.authorized = { ...f.state.authorized, ...invalid };
      await assert.rejects(
        f.service.create(actor, session, input(), t.tx),
        isError('RATING_SCOPE_UNAVAILABLE'),
      );
      assert.equal(f.scopes.size, 0);
      assert.equal(f.claims.size, 0);
    } finally {
      t.close();
    }
  }
});

test('scope revision binds the actual authorized identity and origin as well as the entire original input', () => {
  const request = input(),
    authority = fixture().state.authorized;
  const original = categoryIconUploadScopeRevision(
    actor,
    session,
    id(30),
    request,
    authority,
  );
  const variants = [
    categoryIconUploadScopeRevision(
      id(31),
      session,
      id(30),
      request,
      authority,
    ),
    categoryIconUploadScopeRevision(actor, id(31), id(30), request, authority),
    categoryIconUploadScopeRevision(actor, session, id(31), request, authority),
    categoryIconUploadScopeRevision(
      actor,
      session,
      id(30),
      { ...request, draftRevision: id(31) },
      authority,
    ),
    categoryIconUploadScopeRevision(actor, session, id(30), request, {
      ...authority,
      categoryId: id(31),
    }),
    categoryIconUploadScopeRevision(actor, session, id(30), request, {
      ...authority,
      identityId: id(31),
    }),
    categoryIconUploadScopeRevision(actor, session, id(30), request, {
      ...authority,
      origin: { kind: 'override', campusId: id(31) },
    }),
    categoryIconUploadScopeRevision(actor, session, id(30), request, {
      ...authority,
      contextId: id(31),
    }),
    categoryIconUploadScopeRevision(actor, session, id(30), request, {
      ...authority,
      expiresAt: new Date(now + 1),
    }),
  ];
  assert.equal(new Set([original, ...variants]).size, variants.length + 1);
});

test('base and override scopes retain their exact authorized category and origin', async () => {
  for (const kind of ['base', 'override'] as const) {
    const f = fixture(),
      t = f.transaction(),
      original = input();
    const request = ratingCategoryIconUploadScopeSchema.parse({
      ...original,
      operation:
        kind === 'base'
          ? 'edit_category_base_scoped'
          : 'set_category_override_scoped',
      slot:
        kind === 'base'
          ? { kind, categoryId: id(11) }
          : { kind, categoryId: id(11), campusId: id(4) },
      payload: {
        clientRequestId: original.payload.clientRequestId,
        expectedSnapshot: original.payload.expectedSnapshot,
        categoryId: id(11),
        name:
          kind === 'base'
            ? 'Original category'
            : { mode: 'set', value: 'Override category' },
        description: kind === 'base' ? '' : { mode: 'inherit' },
      },
    });
    f.state.expectedInput = request;
    f.state.authorized = {
      ...f.state.authorized,
      origin: kind === 'base' ? { kind } : { kind, campusId: id(4) },
    };
    try {
      f.state.authorized = { ...f.state.authorized, categoryId: id(90) };
      await assert.rejects(
        f.service.create(actor, session, request, t.tx),
        isError('RATING_SCOPE_UNAVAILABLE'),
      );
      assert.equal(f.scopes.size, 0);
      f.state.authorized = { ...f.state.authorized, categoryId: id(11) };
      if (kind === 'override') {
        f.state.authorized = {
          ...f.state.authorized,
          origin: { kind, campusId: id(90) },
        };
        await assert.rejects(
          f.service.create(actor, session, request, t.tx),
          isError('RATING_SCOPE_UNAVAILABLE'),
        );
        f.state.authorized = {
          ...f.state.authorized,
          origin: { kind, campusId: id(4) },
        };
      }
      const result = await f.service.create(actor, session, request, t.tx);
      assert.equal(result.categoryId, id(11));
      assert.deepEqual(
        f.scopes.get(key(actor, request.clientRequestId))!.origin,
        f.state.authorized.origin,
      );
    } finally {
      t.close();
    }
  }
});

test('stored scope metadata cannot diverge from the immutable input and its exact Media8 hash', async () => {
  const changes: ((row: Stored) => void)[] = [
    (row) => {
      row.request_hash = 'f'.repeat(64);
    },
    (row) => {
      row.scope_revision = 'f'.repeat(64);
    },
    (row) => {
      row.declaration.bytes++;
    },
    (row) => {
      row.actor_id = id(90);
    },
    (row) => {
      row.command_request_id = id(90);
    },
    (row) => {
      row.category_id = id(90);
    },
    (row) => {
      row.identity_id = id(90);
    },
    (row) => {
      row.expires_at = new Date(row.expires_at.getTime() + 1);
    },
    (row) => {
      row.input.draftRevision = id(90);
    },
  ];
  for (const change of changes) {
    const f = fixture(),
      t = f.transaction(),
      request = input();
    const lookup = {
      clientRequestId: request.clientRequestId,
      requestHash: categoryIconUploadScopeRequestHash(request),
    };
    try {
      await f.service.create(actor, session, request, t.tx);
      change(f.scopes.get(key(actor, request.clientRequestId))!);
      await assert.rejects(
        f.service.recover(actor, lookup, t.tx),
        isError('RATING_SCOPE_UNAVAILABLE'),
      );
      assert.equal(f.mediaCalls.length, 0);
    } finally {
      t.close();
    }
  }
});
