import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  preparationCatalogBody,
  preparationCatalogBodySha256,
} from '../src/account-deletion/real/catalog.js';
import {
  PREPARATION_TTL_SECONDS,
  MAX_ACCOUNT_PREPARATIONS,
} from '../src/account-deletion/real/contracts.js';
import { createRealDeletionOpenApiDocument } from '../scripts/real-deletion-openapi-document.js';

test('0181 finite catalog is exact runtime bytecode with no activation or permissive epoch replacement', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0181_identity_real_deletion_preparations.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const body = sql.split('AS $catalog$')[1]!.split('$catalog$;')[0];
  assert.equal(body, preparationCatalogBody);
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    preparationCatalogBodySha256,
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
test('OpenAPI explicitly documents non-activated accept/cancel and no ordinary credential recovery', () => {
  const doc = createRealDeletionOpenApiDocument();
  assert.equal(Object.keys(doc.paths).length, 4);
  assert(doc.paths['/v1/account-deletion/prepare']!.post!.responses['200']);
  assert(!doc.paths['/v1/account-deletion/accept']!.post!.responses['200']);
  assert(!doc.paths['/v1/account-deletion/cancel']!.post!.responses['200']);
  assert(JSON.stringify(doc).includes('Disabled by default'));
  assert(!doc.paths['/v1/account-deletion/status']!.post!.security);
});
