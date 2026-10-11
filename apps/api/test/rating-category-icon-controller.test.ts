import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import type { z } from 'zod';
import { ApplicationError } from '../src/http/application-error.js';
import { ratingResponseHeaders } from '../src/http/rating-http.js';
import { SchemaValidationPipe } from '../src/http/validation.js';
import { CATEGORY_ICON_MEDIA_PROTOCOL } from '../src/media/contracts-category-icon.js';
import {
  RatingCategoryIconManagementController,
  RatingCategoryIconRequestController,
  ratingCategoryIconManagementEntrySchema,
  ratingCategoryIconUploadScopeRecoveryResultSchema,
} from '../src/ratings/category-management/icon-controller.js';
import * as icon from '../src/ratings/category-management/icon-contracts.js';
import * as scoped from '../src/ratings/category-management/scoped-contracts.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';

const management = RatingCategoryIconManagementController;
const requests = RatingCategoryIconRequestController;
type Controller = typeof management | typeof requests;
const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const token = `wu_a_${'a'.repeat(43)}`;
const auth = `Bearer ${token}`;
const selector = { kind: 'campus' as const, campusId: id(2) };
const commandContext = {
  id: id(1),
  token: 't'.repeat(43),
  tokenDigest: createHash('sha256').update('t'.repeat(43)).digest('hex'),
  selector,
  scopeRevision: 'a'.repeat(64),
  protocolGeneration: id(3),
  catalogRevision: id(4),
  headRevision: id(5),
  sourceDigest: 'b'.repeat(64),
};
const query = {
  contextId: commandContext.id,
  contextToken: commandContext.token,
};
const intent = icon.ratingCategoryIconIntentSchema.parse({
  protocolVersion: 5,
  mediaSnapshot: 'c'.repeat(64),
  context: commandContext,
  operation: 'edit_category_base_scoped',
  payload: {
    clientRequestId: id(6),
    expectedSnapshot: 'd'.repeat(64),
    categoryId: id(7),
    name: 'Category icon',
    description: '',
    icon: { mode: 'keep' },
  },
});
const textIntent = icon.categoryIconTextIntent(intent);
const uploadInput = icon.ratingCategoryIconUploadScopeSchema.parse({
  ...textIntent,
  protocolVersion: 5,
  mediaSnapshot: intent.mediaSnapshot,
  clientRequestId: id(8),
  draftRevision: id(9),
  slot: { kind: 'base', categoryId: id(7) },
  declaration: { mime: 'image/png', bytes: 1234, sha256: 'e'.repeat(64) },
});
const recoveryInput = {
  clientRequestId: uploadInput.clientRequestId,
  requestHash: icon.categoryIconUploadScopeRequestHash(uploadInput),
};
const closure = {
  protocolVersion: 5 as const,
  requestId: intent.payload.clientRequestId,
  operation: intent.operation,
  intentHash: icon.ratingCategoryIconIntentHash(intent),
};
const commit = {
  intent,
  preparationContextRevision: 'p'.repeat(43),
};
const expected = [
  ['entryContext', 'POST', 'entry-context', 'EntryContext'],
  ['context', 'POST', 'contexts', 'Context'],
  ['list', 'GET', 'categories', 'List'],
  ['detail', 'GET', 'categories/:categoryId', 'Detail'],
  ['history', 'GET', 'categories/:categoryId/history', 'History'],
  ['systemOptions', 'GET', 'system-options', 'SystemOptions'],
  ['uploadScope', 'POST', 'upload-scopes', 'UploadScope'],
  ['recoverUploadScope', 'POST', 'upload-scopes/recover', 'RecoverUploadScope'],
  ['cancelUploadScope', 'POST', 'upload-scopes/cancel', 'CancelUploadScope'],
  ['prepare', 'POST', 'prepare', 'Prepare'],
  ['commit', 'POST', 'commit', 'Commit'],
  ['cancel', 'POST', 'cancel', 'Cancel'],
  ['cancelByHash', 'POST', 'cancel-by-hash', 'CancelByHash'],
  ['retirementStatus', 'POST', 'retirement/status', 'RetirementStatus'],
  ['retirementCleanup', 'POST', 'retirement/cleanup', 'RetirementCleanup'],
  ['request', 'GET', ':requestId', 'GetRequest'],
] as const;

function handler(controller: Controller, name: string): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    controller.prototype,
    name,
  )?.value;
  assert.equal(typeof value, 'function');
  return value as object;
}
function parameter(
  controller: Controller,
  name: string,
  type: RouteParamtypes,
) {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    name,
  ) as Record<string, { data?: string; pipes: unknown[]; schema?: z.ZodType }>;
  const entry = Object.entries(metadata).find(([key]) =>
    key.startsWith(`${type}:`),
  )?.[1];
  assert.ok(
    entry,
    `${name} must validate its ${RouteParamtypes[type]} parameter`,
  );
  return entry;
}
function pipe(controller: Controller, name: string, type: RouteParamtypes) {
  const pipes = parameter(controller, name, type).pipes;
  assert.equal(pipes.length, 1);
  assert.ok(pipes[0] instanceof SchemaValidationPipe);
  return pipes[0];
}
function responseSchema(controller: Controller, name: string): z.ZodType {
  const metadata = Reflect.getMetadata(
    'swagger/apiResponse',
    handler(controller, name),
  ) as Record<string, { standardSchema: z.ZodType; headers: unknown }>;
  assert.deepEqual(metadata['200']?.headers, ratingResponseHeaders);
  assert.ok(metadata['200']?.standardSchema);
  return metadata['200'].standardSchema;
}

test('all sixteen native protocol5 category paths retain guarded bearer auth, no-store headers and unique operation IDs', () => {
  const actual: { method: string; path: string; operationId: string }[] = [];
  for (const controller of [management, requests]) {
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [
      RatingRequestGuard,
    ]);
    assert.deepEqual(Reflect.getMetadata('swagger/apiSecurity', controller), [
      { accessToken: [] },
    ]);
    const errors = Reflect.getMetadata(
      'swagger/apiResponse',
      controller,
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(errors).sort(), [
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '429',
      '500',
      '503',
    ]);
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === 'constructor') continue;
      const method = handler(controller, name);
      assert.ok(Reflect.hasMetadata(METHOD_METADATA, method));
      assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, method), 200);
      const headers = Reflect.getMetadata(HEADERS_METADATA, method) as {
        name: string;
        value: string;
      }[];
      assert.ok(
        headers.some(
          (header) =>
            header.name === 'Cache-Control' && header.value === 'no-store',
        ),
      );
      assert.ok(
        headers.some(
          (header) =>
            header.name === 'Vary' && header.value === 'Authorization',
        ),
      );
      assert.equal(
        parameter(controller, name, RouteParamtypes.HEADERS).data,
        'authorization',
      );
      responseSchema(controller, name);
      const operation = Reflect.getMetadata('swagger/apiOperation', method) as {
        operationId: string;
      };
      actual.push({
        method:
          RequestMethod[
            Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod
          ]!,
        path: `/${prefix}/${Reflect.getMetadata(PATH_METADATA, method) as string}`,
        operationId: operation.operationId,
      });
    }
  }
  const wanted = expected.map(([name, method, path, operation]) => ({
    method,
    path: `/v5/ratings/${name === 'request' ? 'requests' : 'category-management'}/${path}`,
    operationId: `ratingCategoryIconManagement${operation}`,
  }));
  const sort = (rows: typeof actual) =>
    [...rows].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sort(actual), sort(wanted));
  assert.equal(new Set(actual.map((route) => route.operationId)).size, 16);
  assert.equal(
    new Set(actual.map((route) => `${route.method}:${route.path}`)).size,
    16,
  );
});

test('every route strictly validates query, body and path without accepting recovery authority', () => {
  for (const [name, method] of expected) {
    const controller = name === 'request' ? requests : management;
    const queryPipe = pipe(controller, name, RouteParamtypes.QUERY);
    const bodyPipe = pipe(controller, name, RouteParamtypes.BODY);
    if (method === 'POST' || name === 'request') {
      assert.deepEqual(queryPipe.transform({}), {});
      assert.throws(() => queryPipe.transform(query), BadRequestException);
    } else {
      assert.deepEqual(queryPipe.transform(query), query);
      assert.throws(() => queryPipe.transform({}), BadRequestException);
      assert.throws(
        () => queryPipe.transform({ ...query, authority: 'global' }),
        BadRequestException,
      );
      assert.throws(
        () => queryPipe.transform({ ...query, protocolVersion: 2 }),
        BadRequestException,
      );
      if (name !== 'history')
        assert.throws(
          () => queryPipe.transform({ ...query, cursor: id(10) }),
          BadRequestException,
        );
    }
    if (method === 'GET') {
      assert.equal(bodyPipe.transform(undefined), undefined);
      assert.deepEqual(bodyPipe.transform({}), {});
      for (const invalid of [
        null,
        [],
        { context: commandContext },
        { intentHash: closure.intentHash },
      ])
        assert.throws(() => bodyPipe.transform(invalid), BadRequestException);
    }
    if (name === 'detail' || name === 'history' || name === 'request') {
      const idPipe = pipe(controller, name, RouteParamtypes.PARAM);
      assert.equal(idPipe.transform(id(1)), id(1));
      for (const invalid of ['not-an-id', `${id(1)}/extra`, [id(1)]])
        assert.throws(() => idPipe.transform(invalid), BadRequestException);
    }
  }
  assert.deepEqual(
    pipe(management, 'history', RouteParamtypes.QUERY).transform({
      ...query,
      cursor: id(10),
    }),
    { ...query, cursor: id(10) },
  );
});

test('route-bound request schemas reject protocol2 writes, incomplete identities, extra fields and mismatched upload slots', () => {
  const bodies: Record<string, unknown> = {
    entryContext: { selector },
    context: { selector },
    uploadScope: uploadInput,
    recoverUploadScope: recoveryInput,
    cancelUploadScope: recoveryInput,
    prepare: intent,
    commit,
    cancel: intent,
    cancelByHash: closure,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const bodyPipe = pipe(management, name, RouteParamtypes.BODY);
    assert.deepEqual(bodyPipe.transform(body), body);
    assert.throws(
      () =>
        bodyPipe.transform({ ...(body as object), authorization: 'trusted' }),
      BadRequestException,
    );
    assert.throws(() => bodyPipe.transform(undefined), BadRequestException);
  }
  for (const name of ['entryContext', 'context']) {
    const bodyPipe = pipe(management, name, RouteParamtypes.BODY);
    assert.throws(
      () => bodyPipe.transform({ selector, mode: 'public' }),
      BadRequestException,
    );
    assert.throws(
      () => bodyPipe.transform({ selector: { ...selector, regionId: id(12) } }),
      BadRequestException,
    );
  }
  for (const name of ['prepare', 'cancel']) {
    const bodyPipe = pipe(management, name, RouteParamtypes.BODY);
    assert.throws(() => bodyPipe.transform(textIntent), BadRequestException);
    assert.throws(
      () => bodyPipe.transform({ ...intent, mediaSnapshot: undefined }),
      BadRequestException,
    );
  }
  const commitPipe = pipe(management, 'commit', RouteParamtypes.BODY);
  assert.throws(
    () => commitPipe.transform({ ...commit, intent: textIntent }),
    BadRequestException,
  );
  assert.throws(() => commitPipe.transform({ intent }), BadRequestException);
  const uploadPipe = pipe(management, 'uploadScope', RouteParamtypes.BODY);
  assert.throws(
    () => uploadPipe.transform({ ...uploadInput, protocolVersion: 2 }),
    BadRequestException,
  );
  assert.throws(
    () =>
      uploadPipe.transform({
        ...uploadInput,
        slot: { kind: 'base', categoryId: id(12) },
      }),
    BadRequestException,
  );
  assert.throws(
    () =>
      uploadPipe.transform({
        ...uploadInput,
        clientRequestId: intent.payload.clientRequestId,
      }),
    BadRequestException,
  );
  for (const name of ['recoverUploadScope', 'cancelUploadScope']) {
    const bodyPipe = pipe(management, name, RouteParamtypes.BODY);
    assert.throws(
      () => bodyPipe.transform({ clientRequestId: id(8) }),
      BadRequestException,
    );
    assert.throws(
      () => bodyPipe.transform({ ...recoveryInput, requestHash: 'wrong' }),
      BadRequestException,
    );
    assert.throws(
      () => bodyPipe.transform({ ...recoveryInput, context: commandContext }),
      BadRequestException,
    );
  }
  const closurePipe = pipe(management, 'cancelByHash', RouteParamtypes.BODY);
  for (const invalid of [
    { ...closure, protocolVersion: 2 },
    { ...closure, operation: 'set_score_scoped' },
    { ...closure, intentHash: undefined },
    { ...closure, context: commandContext },
  ])
    assert.throws(() => closurePipe.transform(invalid), BadRequestException);
});

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const methods = Object.fromEntries(
    expected.map(([name]) => {
      const method = name === 'request' ? 'recover' : name;
      return [
        method,
        (...args: unknown[]) => {
          calls.push({ method, args });
          return Promise.resolve({ method });
        },
      ];
    }),
  ) as unknown as ConstructorParameters<typeof management>[0];
  const controller = new management(methods);
  const recovery = new requests(methods);
  const invocations: [string, unknown[], (header: unknown) => unknown][] = [
    [
      'entryContext',
      [{ selector }],
      (header) => controller.entryContext(header, {}, { selector }),
    ],
    [
      'context',
      [{ selector }],
      (header) => controller.context(header, {}, { selector }),
    ],
    ['list', [query], (header) => controller.list(header, query, undefined)],
    [
      'detail',
      [query, id(7)],
      (header) => controller.detail(header, id(7), query, undefined),
    ],
    [
      'history',
      [{ ...query, cursor: id(10) }, id(7)],
      (header) =>
        controller.history(
          header,
          id(7),
          { ...query, cursor: id(10) },
          undefined,
        ),
    ],
    [
      'systemOptions',
      [query],
      (header) => controller.systemOptions(header, query, undefined),
    ],
    [
      'uploadScope',
      [uploadInput],
      (header) => controller.uploadScope(header, {}, uploadInput),
    ],
    [
      'recoverUploadScope',
      [recoveryInput],
      (header) => controller.recoverUploadScope(header, {}, recoveryInput),
    ],
    [
      'cancelUploadScope',
      [recoveryInput],
      (header) => controller.cancelUploadScope(header, {}, recoveryInput),
    ],
    ['prepare', [intent], (header) => controller.prepare(header, {}, intent)],
    ['commit', [commit], (header) => controller.commit(header, {}, commit)],
    ['cancel', [intent], (header) => controller.cancel(header, {}, intent)],
    [
      'cancelByHash',
      [closure],
      (header) => controller.cancelByHash(header, {}, closure),
    ],
    [
      'recover',
      [closure.requestId],
      (header) => recovery.request(header, closure.requestId, {}, undefined),
    ],
  ];
  return { calls, invocations };
}

test('handlers dispatch exact original inputs to their protocol5 owner without context warmup or implicit publication', async () => {
  const f = fixture();
  for (const [method, args, invoke] of f.invocations) {
    const count = f.calls.length;
    assert.deepEqual(await invoke(auth), { method });
    assert.equal(f.calls.length, count + 1);
    assert.deepEqual(f.calls[count], { method, args: [token, ...args] });
  }
});

test('all handlers reject missing, malformed or refresh bearer tokens before any service call', () => {
  const f = fixture();
  for (const [, , invoke] of f.invocations) {
    for (const invalid of [
      undefined,
      '',
      token,
      `bearer ${token}`,
      `Bearer wu_r_${'a'.repeat(43)}`,
      [auth],
    ])
      assert.throws(() => invoke(invalid), ApplicationError);
  }
  assert.deepEqual(f.calls, []);
});

test('failed entry negotiation propagates unchanged and cannot fall back through an unapproved context', async () => {
  const error = new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  const controller = new management({
    entryContext: () => Promise.reject(error),
    context: () =>
      assert.fail(
        'An unavailable negotiated entry cannot refresh or downgrade authority',
      ),
  } as unknown as ConstructorParameters<typeof management>[0]);
  await assert.rejects(
    controller.entryContext(auth, {}, { selector }),
    (value: unknown) => value === error,
  );
});

test('response metadata uses exact icon codecs, preserving legacy history and system-option shapes', () => {
  const schemas: Record<string, z.ZodType> = {
    entryContext: ratingCategoryIconManagementEntrySchema,
    context: icon.ratingCategoryIconContextSchema,
    list: icon.ratingManagedCategoryIconsSchema,
    detail: icon.ratingManagedCategoryIconSchema,
    history: scoped.ratingCategoryManagementHistorySchema,
    systemOptions: scoped.ratingCategorySystemOptionsSchema,
    uploadScope: icon.ratingCategoryIconUploadScopeResultSchema,
    recoverUploadScope: ratingCategoryIconUploadScopeRecoveryResultSchema,
    cancelUploadScope: ratingCategoryIconUploadScopeRecoveryResultSchema,
    prepare: icon.ratingCategoryIconPrepareResultSchema,
    commit: icon.ratingCategoryIconReceiptSchema,
    cancel: icon.ratingCategoryIconReceiptSchema,
    cancelByHash: icon.ratingCategoryIconReceiptSchema,
    request: icon.ratingCategoryIconReceiptSchema,
  };
  for (const [name, schema] of Object.entries(schemas))
    assert.equal(
      responseSchema(name === 'request' ? requests : management, name),
      schema,
    );
  const receipt = {
    ...closure,
    outcome: 'closed',
    code: 'RATING_CATEGORY_CANCELLED',
  };
  assert.ok(responseSchema(requests, 'request').safeParse(receipt).success);
  assert.equal(
    responseSchema(requests, 'request').safeParse({
      ...receipt,
      protocolVersion: 2,
    }).success,
    false,
  );
  assert.equal(
    scoped.ratingCategoryScopedReceiptSchema.safeParse(receipt).success,
    false,
  );
  assert.ok(
    scoped.ratingCategoryScopedReceiptSchema.safeParse({
      ...receipt,
      protocolVersion: 2,
    }).success,
  );
});

test('entry negotiation accepts exactly the matching protocol5 icon or original protocol2 management context', () => {
  const legacy = scoped.ratingCategoryManagementContextSchema.parse({
    protocolVersion: 2,
    commandContext,
    expiresAt: '2026-10-10T23:59:00.000Z',
    snapshotRevision: 'd'.repeat(64),
    campusIds: [selector.campusId],
    canManageGlobal: false,
    operations: ['edit_category_base_scoped'],
  });
  const current = icon.ratingCategoryIconContextSchema.parse({
    ...legacy,
    protocolVersion: 5,
    mediaSnapshot: 'e'.repeat(64),
    capabilities: ['category_icon'],
  });
  for (const value of [
    { kind: 'icon', context: current },
    { kind: 'legacy', context: legacy },
  ])
    assert.deepEqual(
      ratingCategoryIconManagementEntrySchema.parse(value),
      value,
    );
  for (const value of [
    { kind: 'icon', context: legacy },
    { kind: 'legacy', context: current },
    { kind: 'icon', context: { ...current, capabilities: [] } },
    { kind: 'legacy', context: legacy, capability: 'category_icon' },
  ])
    assert.equal(
      ratingCategoryIconManagementEntrySchema.safeParse(value).success,
      false,
    );
});

test('scope recovery embeds the strict Media8 result and enforces native known, unknown and cancelled consistency', () => {
  const scope = {
    editScopeId: id(11),
    scopeRevision: 'a'.repeat(64),
    categoryId: id(7),
    identityId: id(12),
    expiresAt: '2026-10-10T23:59:00.000Z',
  };
  const media = {
    protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
    requestId: id(8),
    requestHash: 'b'.repeat(64),
    serverNow: 1791676200000,
    state: 'recorded',
    status: {
      protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
      requestId: id(8),
      requestHash: 'b'.repeat(64),
      editScopeId: scope.editScopeId,
      intentId: id(13),
      serverNow: 1791676200000,
      status: 'prepared',
      operationDeadlineAt: 1791676400000,
      upload: 'none',
    },
  };
  for (const value of [
    { state: 'known', scope, recovery: media },
    { state: 'unknown', scope: null, recovery: null },
    { state: 'cancelled', scope: null, recovery: null },
    { state: 'cancelled', scope, recovery: media },
  ])
    assert.deepEqual(
      ratingCategoryIconUploadScopeRecoveryResultSchema.parse(value),
      value,
    );
  for (const value of [
    { state: 'known', scope: null, recovery: media },
    { state: 'unknown', scope, recovery: null },
    { state: 'unknown', scope: null, recovery: media },
    {
      state: 'known',
      scope,
      recovery: { ...media, protocol: 'ratings-target-media-v1' },
    },
    {
      state: 'known',
      scope,
      recovery: { ...media, status: { ...media.status, editScopeId: id(14) } },
    },
    {
      state: 'known',
      scope,
      recovery: { ...media, assetUrl: 'https://invalid.example/asset' },
    },
    { state: 'known', scope, recovery: media, currentAuthority: true },
  ])
    assert.equal(
      ratingCategoryIconUploadScopeRecoveryResultSchema.safeParse(value)
        .success,
      false,
    );
});
