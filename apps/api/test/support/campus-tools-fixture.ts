import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import { AppModule } from '../../src/app.module.js';
import { DatabaseService } from '../../src/database/database.js';
import { CampusToolsService } from '../../src/campus-tools/service.js';
import { CampusToolsMediaService } from '../../src/campus-tools/media/service.js';
import { CampusToolsAdmission } from '../../src/campus-tools/admission.js';
import { CAMPUS_TOOLS_RUNTIME } from '../../src/campus-tools/runtime.js';
import type {
  CampusToolsRuntime,
  ToolStagingInput,
} from '../../src/campus-tools/runtime.js';
import { sealToolCatalog } from '../../src/campus-tools/contracts.js';
import type { ToolCatalog } from '../../src/campus-tools/contracts.js';
import { RegisteredSyntheticSharpProcessor } from '../../src/media/processing/isolated-sharp.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { sealProcessedManifest } from '../../src/media/processing/processed-manifest.js';
import { SyntheticMediaStorage } from './media/synthetic-storage.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { createRuntimeActor } from './community-runtime-fixtures.js';

/** Only exact synthetic bytes/digests and isolated loopback DB. No provider or
 * publisher role grants. Real existing Sharp processor and immutable store. */
export async function campusToolsFixture(
  options: { webview?: CampusToolsRuntime['webview'] } = {},
) {
  const storage = await SyntheticMediaStorage.create();
  const bytes = await sharp({
    create: { width: 64, height: 40, channels: 3, background: '#245276' },
  })
    .png()
    .toBuffer();
  const processor = new RegisteredSyntheticSharpProcessor([sha256(bytes)]);
  const inputs = new Map<string, ToolStagingInput>(),
    accepted = new Set<string>();
  const secret = randomUUID();
  const signature = (digest: string) =>
    createHmac('sha256', secret).update(digest).digest('hex');
  let processCalls = 0;
  const runtime: CampusToolsRuntime = {
    authority: {
      accept: async (_catalog, digest) => {
        assert.ok(accepted.has(digest), 'Unregistered synthetic source');
        return {
          reference: 'synthetic-campus-tools-authority',
          proof: signature(digest),
        };
      },
      verify: (catalog, digest, acceptance) => {
        if (
          !accepted.has(digest) ||
          acceptance.reference !== 'synthetic-campus-tools-authority' ||
          acceptance.proof.length !== 64 ||
          sealToolCatalog(catalog).digest !== digest
        )
          return false;
        return timingSafeEqual(
          Buffer.from(signature(digest)),
          Buffer.from(acceptance.proof),
        );
      },
    },
    storage,
    admission: {
      staging: async (digest, assetId) => {
        assert.ok(accepted.has(digest));
        const input = inputs.get(assetId);
        assert.ok(input);
        return input;
      },
      process: async (stream, mime) => {
        processCalls++;
        return processor.process(stream, mime);
      },
      put: (data, destination) => storage.writePlanned(destination, data),
    },
    webview: options.webview ?? null,
  };
  try {
    const base = await directoryRuntimeFixture(undefined, {
      createApp: async (config, configurePolicy) => {
        const builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        })
          .overrideProvider(CAMPUS_TOOLS_RUNTIME)
          .useValue(runtime);
        await configurePolicy(builder);
        return (await builder.compile()).createNestApplication({
          logger: false,
        });
      },
    });
    const originalOpen = storage.openExact.bind(storage);
    storage.openExact = async (object, maximum) => {
      const planned = await base.pool.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_campus_tools.media_attempts WHERE staging->'original'=$1::jsonb OR staging->'destinations' @> jsonb_build_array($1::jsonb)) present`,
        [JSON.stringify(object)],
      );
      assert.ok(
        planned.rows[0]?.present,
        'A durable exact attempt must precede provider open',
      );
      return originalOpen(object, maximum);
    };
    const originalPut = runtime.admission.put.bind(runtime.admission);
    runtime.admission.put = async (data, destination) => {
      const planned = await base.pool.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_campus_tools.media_attempts WHERE staging->'destinations' @> jsonb_build_array($1::jsonb)) present`,
        [JSON.stringify(destination)],
      );
      assert.ok(
        planned.rows[0]?.present,
        'A committed exact destination attempt must precede provider write',
      );
      return originalPut(data, destination);
    };
    const database = base.app.get(DatabaseService),
      admission = new CampusToolsAdmission(database, runtime);
    const register = (catalog: ToolCatalog) => {
      const sealed = sealToolCatalog(catalog);
      accepted.add(sealed.digest);
      return sealed;
    };
    return {
      ...base,
      runtime,
      storage,
      database,
      admission,
      tools: base.app.get(CampusToolsService),
      media: base.app.get(CampusToolsMediaService),
      actor: () => createRuntimeActor(base.app),
      register,
      revoke: (digest: string) => accepted.delete(digest),
      processCalls: () => processCalls,
      admit: async (catalog: ToolCatalog, key = randomUUID()) => {
        const sealed = register(catalog);
        return admission.apply(sealed.canonical, key);
      },
      image: async () => {
        const original = await storage.upload(bytes),
          destinations = [storage.newObject(), storage.newObject()] as const;
        const processed = await processor.process(
          Readable.from([bytes]),
          'image/png',
        );
        const sealed = sealProcessedManifest(processed, original.object, [
          {
            object: destinations[0],
            bytes: processed.variants[0].bytes,
            sha256: processed.variants[0].sha256,
          },
          {
            object: destinations[1],
            bytes: processed.variants[1].bytes,
            sha256: processed.variants[1].sha256,
          },
        ]);
        const assetId = randomUUID();
        inputs.set(assetId, {
          original: original.object,
          mime: 'image/png',
          sha256: sha256(bytes),
          bytes: bytes.length,
          destinations,
        });
        return {
          id: 'image',
          bindingId: randomUUID(),
          assetId,
          manifestDigest: sealed.digest,
          alt: 'Synthetic campus image',
        };
      },
      close: async () => {
        try {
          await base.close();
        } finally {
          await storage.dispose();
        }
      },
    };
  } catch (error) {
    await storage.dispose();
    throw error;
  }
}
export function syntheticToolsCatalog(
  campusId: string,
  overrides: Partial<ToolCatalog> = {},
): ToolCatalog {
  return {
    version: 'campus-tools-canonical-v1',
    id: randomUUID(),
    campusId,
    expectedHead: null,
    applicability: 'applicable',
    coverage: 'complete',
    status: 'active',
    source: {
      reference: 'synthetic:test-only',
      digest: 'a'.repeat(64),
      policyReference: 'synthetic:policy',
      maintainer: 'Synthetic maintainer',
      attribution: 'Synthetic acceptance only',
      observedAt: '2026-01-01T00:00:00Z',
      publishedAt: '2026-01-01T00:00:00Z',
    },
    validity: {
      kind: 'finite',
      effectiveAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    linkPolicy: { id: randomUUID(), version: 1, rules: [] },
    entries: [],
    ...overrides,
  };
}
export function syntheticMapEntry(ordinal = 0): ToolCatalog['entries'][number] {
  return {
    id: randomUUID(),
    sourceId: 'map',
    ordinal,
    revision: randomUUID(),
    title: 'Synthetic map',
    state: 'enabled',
    kind: 'map',
    coordinateSystem: 'gcj02',
    center: { latitude: 30, longitude: 110 },
    zoom: 14,
    markers: [
      {
        id: 1,
        sourceId: 'marker',
        title: 'Synthetic marker',
        category: 'Place',
        details: 'Synthetic details',
        position: { latitude: 30.01, longitude: 110.01 },
      },
    ],
  };
}
