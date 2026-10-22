import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PREPARATION_TTL_SECONDS,
  MAX_ACCOUNT_PREPARATIONS,
} from '../src/account-deletion/real/contracts.js';
import {
  preparationCatalogBody,
  preparationCatalogBodySha256,
} from '../src/account-deletion/real/catalog.js';
import { createRealDeletionOpenApiDocument } from '../scripts/real-deletion-openapi-document.js';

test('0181 immutable predecessor retains its exact catalog and non-activating contract', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0181_identity_real_deletion_preparations.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const catalog = sql.split('AS $catalog$')[1];
  assert(catalog, 'Historical catalog opener must exist');
  const body = catalog.split('$catalog$;')[0];
  assert(body, 'Historical catalog body must exist');
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    '8e0098d98b9e0580a4170c752a19beaa9c57834fd511f649f22783d24dd2170b',
  );
  assert(sql.includes("interval '" + PREPARATION_TTL_SECONDS + " seconds'"));
  assert(sql.includes('LIMIT ' + MAX_ACCOUNT_PREPARATIONS));
  assert(
    !/CREATE OR REPLACE|SECURITY DEFINER|\bGRANT\b|DISABLE TRIGGER|session_replication_role/i.test(
      sql.replace(/--.*$/gm, ''),
    ),
  );
  for (const source of [
    'LIMIT 129',
    'LIMIT 65',
    'LIMIT 33',
    'bytes<=32768',
    '262144',
    'conenforced',
    'source_oversized',
    'preparation_protocol()',
  ])
    assert(body.includes(source));
});
test('OpenAPI distinguishes unavailable new acceptance from existing request recovery without ordinary credentials', () => {
  const doc = createRealDeletionOpenApiDocument();
  assert.equal(Object.keys(doc.paths).length, 4);
  assert(doc.paths['/v1/account-deletion/prepare']!.post!.responses['200']);
  assert(doc.paths['/v1/account-deletion/accept']!.post!.responses['200']);
  assert(doc.paths['/v1/account-deletion/accept']!.post!.responses['401']);
  assert(doc.paths['/v1/account-deletion/cancel']!.post!.responses['200']);
  assert(
    JSON.stringify(doc).includes('installed production owner is unavailable'),
  );
  assert(JSON.stringify(doc).includes('Disabled by default'));
  assert(!doc.paths['/v1/account-deletion/status']!.post!.security);
});

test('0182 preparation catalog is exactly the bounded successor runtime collector', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0182_real_deletion_request_authority.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const marker =
    'CREATE OR REPLACE FUNCTION whaleu_real_deletion.preparation_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$';
  assert.equal(sql.split(marker).length, 2);
  const body = sql.split(marker)[1]!.split('$catalog$;')[0];
  assert.equal(body, preparationCatalogBody);
  assert.equal(
    createHash('sha256').update(body!).digest('hex'),
    preparationCatalogBodySha256,
  );
  for (const required of [
    'LIMIT 129',
    'LIMIT 65',
    'LIMIT 33',
    'bytes<=32768',
    '262144',
    'conenforced',
    'source_oversized',
    'preparation_protocol()',
  ])
    assert.ok(body!.includes(required));
});
