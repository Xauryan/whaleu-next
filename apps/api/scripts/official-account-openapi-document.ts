import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {
  OfficialAccountOperationsController,
  OfficialAccountCallbackController,
} from '../src/official-account-operations/controller.js';
import { OfficialAccountOperationsService } from '../src/official-account-operations/service.js';
import { OfficialCallbackBoundary } from '../src/official-account-operations/callback-ledger.js';
import { OfficialRequestGuard } from '../src/official-account-operations/request-guard.js';
export async function renderOfficialAccountOpenApiDocument(): Promise<string> {
  const app = (
    await Test.createTestingModule({
      controllers: [
        OfficialAccountOperationsController,
        OfficialAccountCallbackController,
      ],
      providers: [
        OfficialRequestGuard,
        { provide: OfficialAccountOperationsService, useValue: {} },
        { provide: OfficialCallbackBoundary, useValue: {} },
      ],
    }).compile()
  ).createNestApplication({ logger: false });
  try {
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Synthetic official account operations')
        .setDescription(
          'Default disabled. Daily and test create drafts only. Manual publish requires an independently confirmed owned draft. Callback profile is fictitious JSON/HMAC, not a WeChat protocol.',
        )
        .setVersion('1')
        .addBearerAuth(undefined, 'accessToken')
        .build(),
      {
        deepScanRoutes: false,
        autoTagControllers: false,
        excludeDynamicDefaults: true,
      },
    );
    const sorted = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sorted)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, x]) => [k, sorted(x)]),
            )
          : v;
    return format(JSON.stringify(sorted(document), null, 2), {
      parser: 'json',
    });
  } finally {
    await app.close();
  }
}
export async function writeOfficialAccountOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/official-account-operations.json',
      import.meta.url,
    ),
    value = await renderOfficialAccountOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== value)
      throw Error('Official-account OpenAPI artifact is stale');
  } else await writeFile(artifact, value, 'utf8');
}
