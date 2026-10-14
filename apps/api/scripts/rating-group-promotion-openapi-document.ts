import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { RatingGroupPromotionController } from '../src/ratings/group-promotion/controller.js';
import { RatingGroupPromotionService } from '../src/ratings/group-promotion/service.js';
import { PromotionRequestGuard } from '../src/ratings/group-promotion/request-guard.js';
export async function renderRatingGroupPromotionOpenApiDocument(): Promise<string> {
  const app = (
    await Test.createTestingModule({
      controllers: [RatingGroupPromotionController],
      providers: [
        PromotionRequestGuard,
        { provide: RatingGroupPromotionService, useValue: {} },
      ],
    }).compile()
  ).createNestApplication({ logger: false });
  try {
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rating category group promotion')
        .setDescription(
          'Default disabled. Source-backed course/canteen category links target explicitly enrolled synthetic groups. Copy generation, shortlinks and delivery have separate recovery states; no real provider is enabled.',
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
export async function writeRatingGroupPromotionOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/rating-group-promotion.json',
      import.meta.url,
    ),
    value = await renderRatingGroupPromotionOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== value)
      throw Error('Rating-group-promotion OpenAPI artifact is stale');
  } else await writeFile(artifact, value, 'utf8');
}
