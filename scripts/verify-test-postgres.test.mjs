import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlledTestDatabase } from './verify-test-postgres.mjs';
const env = {
  NODE_ENV: 'test',
  WHALEU_TEST_MAINTENANCE: 'controlled',
  TEST_DATABASE_URL: 'postgresql://whaleu_test@127.0.0.1:55432/whaleu_test',
};
test('controlled-maintenance admission requires explicit test mode and an exact loopback test target', () => {
  assert.equal(controlledTestDatabase(env), env.TEST_DATABASE_URL);
  for (const change of [
    { NODE_ENV: 'production' },
    { NODE_ENV: undefined },
    { WHALEU_TEST_MAINTENANCE: undefined },
    { TEST_DATABASE_URL: 'postgresql://whaleu_test@example.org/whaleu_test' },
    { TEST_DATABASE_URL: 'postgresql://whaleu_test@127.0.0.1/production' },
    { TEST_DATABASE_URL: 'postgresql://postgres@127.0.0.1/whaleu_test' },
    {
      TEST_DATABASE_URL:
        'postgresql://whaleu_test@127.0.0.1/whaleu_test?options=x',
    },
  ])
    assert.throws(() => controlledTestDatabase({ ...env, ...change }));
});
