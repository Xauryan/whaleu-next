import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { OpenAPIObject } from '@nestjs/swagger';
import test from 'node:test';
import {
  canonicalToolLink,
  sealToolCatalog,
  toolInstantMicros,
  toolLinkPolicySchema,
} from '../src/campus-tools/contracts.js';
import { validateToolManifest } from '../src/campus-tools/validation.js';
import {
  syntheticToolsCatalog,
  syntheticMapEntry,
} from './support/campus-tools-fixture.js';

test('canonical campus tools source is bounded, deterministic, immutable and not self-authorizing', () => {
  const catalog = syntheticToolsCatalog(randomUUID(), {
      entries: [syntheticMapEntry()],
    }),
    sealed = sealToolCatalog(catalog);
  assert.equal(
    validateToolManifest(`${sealed.canonical}\n`).report.state,
    'candidate',
  );
  assert.equal(validateToolManifest(sealed.canonical).report.trusted, false);
  assert.equal(
    sealToolCatalog(JSON.parse(sealed.canonical)).digest,
    sealed.digest,
  );
  assert.ok(Object.isFrozen(sealed.catalog.entries));
  assert.throws(
    () => validateToolManifest(JSON.stringify(catalog)),
    /NONCANONICAL/,
  );
  assert.throws(
    () =>
      validateToolManifest(
        sealed.canonical.replace(
          '"applicability":"applicable"',
          '"applicability":"applicable","applicability":"applicable"',
        ),
      ),
    /NONCANONICAL/,
  );
  assert.throws(() => sealToolCatalog({ ...catalog, accepted: true }));
  assert.throws(() =>
    sealToolCatalog({
      ...catalog,
      entries: [catalog.entries[0], { ...catalog.entries[0], ordinal: 1 }],
    }),
  );
  assert.throws(() =>
    sealToolCatalog({
      ...catalog,
      entries: [{ ...catalog.entries[0], coordinateSystem: 'wgs84' }],
    }),
  );
  assert.throws(() =>
    sealToolCatalog({
      ...catalog,
      entries: [
        { ...catalog.entries[0], center: { latitude: NaN, longitude: 110 } },
      ],
    }),
  );
  assert.throws(() =>
    sealToolCatalog({
      ...catalog,
      source: { ...catalog.source, maintainer: 'e\u0301' },
    }),
  );
  assert.equal(
    validateToolManifest(
      sealToolCatalog({ ...catalog, coverage: 'partial' }).canonical,
    ).report.state,
    'quarantined',
  );
  assert.equal(
    validateToolManifest(sealed.canonical, Date.parse('2100-01-01T00:00:00Z'))
      .report.reasons[0],
    'EXPIRED',
  );
  assert.equal(
    toolInstantMicros('2026-01-01T00:00:00.000001Z') -
      toolInstantMicros('2026-01-01T00:00:00Z'),
    1n,
  );
  assert.throws(() =>
    sealToolCatalog({
      ...catalog,
      validity: {
        kind: 'finite',
        effectiveAt: '2026-01-01T00:00:00.000002Z',
        expiresAt: '2026-01-01T00:00:00.000001Z',
      },
    }),
  );
});
test('exact action policy rejects URL normalization and arbitrary redirects without native URL assumptions', () => {
  const policy = {
    id: randomUUID(),
    version: 1 as const,
    rules: [
      {
        action: 'copy' as const,
        host: 'example.com',
        path: '/resource',
        query: [{ key: 'item', value: 'safe' }],
      },
    ],
  };
  const valid = 'https://example.com/resource?item=safe';
  assert.equal(canonicalToolLink(valid, 'copy', policy), valid);
  assert.equal(canonicalToolLink(valid, 'webview', policy), null);
  for (const value of [
    'http://example.com/resource?item=safe',
    '//example.com/resource?item=safe',
    'https://user@example.com/resource?item=safe',
    'https://example.com:443/resource?item=safe',
    'https://example.com./resource?item=safe',
    'https://example.com.evil.org/resource?item=safe',
    'https://127.0.0.1/resource?item=safe',
    'https://example.com/resource?item=safe#x',
    'https://EXAMPLE.com/resource?item=safe',
    'https://example.com/../resource?item=safe',
    'https://example.com/%2e%2e/resource?item=safe',
    'https://example.com/resource?item=%2573afe',
    'https://example.com/resource?item=safe&redirect=https://evil.org',
    'https://example.com\\@evil.org/resource?item=safe',
    'https://example.com/resource?item=safe\n',
    'https://example.com/resource?item=%0a',
    'https://example.com/resource?item=%zz',
  ])
    assert.equal(canonicalToolLink(value, 'copy', policy), null, value);
});

test('shared campus-tools semantic URL corpus matches the native action contract', () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/fixtures/campus-tools-links-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    policy: unknown;
    accepted: { url: string; action: 'copy' | 'webview' }[];
    rejected: { url: string; action: 'copy' | 'webview' }[];
  };
  const policy = toolLinkPolicySchema.parse(corpus.policy);
  for (const item of corpus.accepted)
    assert.equal(canonicalToolLink(item.url, item.action, policy), item.url);
  for (const item of corpus.rejected)
    assert.equal(
      canonicalToolLink(item.url, item.action, policy),
      null,
      item.url,
    );
});

test('emitted campus-tools OpenAPI registers all five public reads with exact scoped queries and binary Media', async () => {
  const require = createRequire(import.meta.url);
  const source = await import(
    pathToFileURL(
      require.resolve('../.openapi-build/scripts/campus-tools-openapi-document.js'),
    ).href
  );
  const doc: OpenAPIObject = await source.createCampusToolsOpenApiDocument();
  const hub = '/v1/campuses/{campusId}/tools';
  const detail = `${hub}/{entryId}`;
  const link = `${detail}/link`;
  const media =
    '/v3/media/campus-tools/{campusId}/{catalogId}/{entryId}/{bindingId}';
  const routes = [
    [hub, 'readCampusTools'],
    [detail, 'readCampusTool'],
    [link, 'resolveCampusToolLink'],
    [media, 'readCampusToolMediaDescriptor'],
    [`${media}/{variant}`, 'readCampusToolMediaVariant'],
  ] as const;
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    routes.map(([path]) => path).sort(),
  );
  for (const [path, operationId] of routes) {
    const item = doc.paths[path];
    const operation = item?.get;
    assert.ok(operation);
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{}, { accessToken: [] }]);
    assert.equal(item?.post, undefined);
    assert.equal(item?.put, undefined);
    assert.equal(item?.patch, undefined);
    assert.equal(item?.delete, undefined);
  }
  const queryNames = (path: string) =>
    (doc.paths[path]?.get?.parameters ?? [])
      .filter((parameter) => 'in' in parameter && parameter.in === 'query')
      .map((parameter) => ('name' in parameter ? parameter.name : ''))
      .sort();
  assert.deepEqual(queryNames(hub), []);
  assert.deepEqual(queryNames(detail), ['catalogId']);
  assert.deepEqual(queryNames(link), ['action', 'catalogId']);
  assert.deepEqual(queryNames(media), []);
  assert.deepEqual(queryNames(`${media}/{variant}`), []);
  const action = doc.paths[link]?.get?.parameters?.find(
    (parameter) => 'name' in parameter && parameter.name === 'action',
  );
  assert.ok(
    action && 'schema' in action && action.schema && !('$ref' in action.schema),
  );
  assert.deepEqual(action.schema.enum, ['copy', 'webview']);
  const hubResponse = JSON.stringify(doc.paths[hub]?.get?.responses);
  for (const state of [
    'ready',
    'known_empty',
    'not_applicable',
    'unknown',
    'expired',
    'unavailable',
  ])
    assert.ok(hubResponse.includes(`"${state}"`));
  assert.equal(hubResponse.includes('"url"'), false);
  const binary = doc.paths[`${media}/{variant}`]?.get?.responses['200'];
  assert.ok(binary && 'content' in binary && binary.content);
  assert.deepEqual(Object.keys(binary.content).sort(), [
    'image/jpeg',
    'image/png',
  ]);
  assert.ok(JSON.stringify(binary.content).includes('"binary"'));
  assert.ok(
    JSON.stringify(doc.paths[media]?.get?.responses).includes(
      'campus-tools-media-v1',
    ),
  );
});
