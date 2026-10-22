import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTestApplication } from './support/initialize-test-application.js';

function fixture(
  options: {
    createError?: unknown;
    initError?: unknown;
    appCloseError?: unknown;
    moduleCloseError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const app = {
    async init() {
      calls.push('app.init');
      if ('initError' in options) throw options.initError;
    },
    async close() {
      calls.push('app.close');
      if ('appCloseError' in options) throw options.appCloseError;
    },
  };
  const module = {
    createNestApplication() {
      calls.push('module.create');
      if ('createError' in options) throw options.createError;
      return app;
    },
    async close() {
      calls.push('module.close');
      if ('moduleCloseError' in options) throw options.moduleCloseError;
    },
  };
  return { calls, app, module };
}

test('test app success transfers exact resource without premature cleanup', async () => {
  const f = fixture();
  const app = await initializeTestApplication(f.module, async (created) => {
    assert.equal(created, f.app);
    await created.init();
  });
  assert.equal(app, f.app);
  assert.deepEqual(f.calls, ['module.create', 'app.init']);
  await app.close();
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('initialization failure closes only the exact app and rethrows original error', async () => {
  const original = new Error('initialization failed');
  const f = fixture({ initError: original });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => error === original,
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('creation failure closes module because no app was created', async () => {
  const original = new Error('creation failed');
  const f = fixture({ createError: original });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => error === original,
  );
  assert.deepEqual(f.calls, ['module.create', 'module.close']);
});

test('double init and app-close failures preserve both identities and original cause', async () => {
  const original = new Error('initialization failed');
  const cleanup = new Error('app cleanup failed');
  const f = fixture({ initError: original, appCloseError: cleanup });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      assert.equal(error.cause, original);
      return true;
    },
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('double create and module-close failures preserve both identities and original cause', async () => {
  const original = new Error('creation failed');
  const cleanup = new Error('module cleanup failed');
  const f = fixture({ createError: original, moduleCloseError: cleanup });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      assert.equal(error.cause, original);
      return true;
    },
  );
  assert.deepEqual(f.calls, ['module.create', 'module.close']);
});

test('configuration or readiness assertion failure also closes the created resource', async () => {
  const original = new Error('readiness check failed');
  const f = fixture();
  await assert.rejects(
    initializeTestApplication(f.module, async (app) => {
      await app.init();
      throw original;
    }),
    (error: unknown) => error === original,
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('undefined initialization rejection remains a rejection after successful cleanup', async () => {
  const f = fixture({ initError: undefined });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => error === undefined,
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('undefined double failure preserves both slots and an explicit undefined cause', async () => {
  const f = fixture({ initError: undefined, appCloseError: undefined });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [undefined, undefined]);
      assert.equal(Object.hasOwn(error, 'cause'), true);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('non-Error initialization and cleanup values retain exact object identities', async () => {
  const original = Object.freeze({ origin: 'initialization' });
  const cleanup = Object.freeze({ origin: 'cleanup' });
  const f = fixture({ initError: original, appCloseError: cleanup });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors[1], cleanup);
      assert.equal(error.cause, original);
      return true;
    },
  );
  assert.deepEqual(f.calls, ['module.create', 'app.init', 'app.close']);
});

test('falsy non-Error creation and module cleanup failures are not swallowed', async () => {
  const f = fixture({ createError: false, moduleCloseError: null });
  await assert.rejects(
    initializeTestApplication(f.module, (app) => app.init()),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [false, null]);
      assert.equal(error.cause, false);
      return true;
    },
  );
  assert.deepEqual(f.calls, ['module.create', 'module.close']);
});
