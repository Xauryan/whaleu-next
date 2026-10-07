import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { SchemaValidationPipe } from '../src/http/validation.js';

test('runtime schema validation returns typed input and rejects unknown keys', () => {
  const pipe = new SchemaValidationPipe(
    z.strictObject({ page: z.number().int().min(1) }),
  );
  assert.deepEqual(pipe.transform({ page: 2 }), { page: 2 });
  assert.throws(
    () => pipe.transform({ page: 2, actorId: 99 }),
    /Invalid request/,
  );
  assert.throws(() => pipe.transform({ page: '2' }), /Invalid request/);
  assert.throws(() => pipe.transform({ page: -1 }), /Invalid request/);
});

test('validation does not disclose submitted values or private schema diagnostics', () => {
  const pipe = new SchemaValidationPipe(
    z.string().email('private schema message'),
  );
  assert.throws(
    () => pipe.transform('secret-input'),
    (error: Error) => {
      assert.equal(error.message, 'Invalid request');
      return true;
    },
  );
});
