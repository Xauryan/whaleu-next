import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ViewReportingController } from '../src/community/view-component/controller.js';
import { ViewReportingService } from '../src/community/view-component/service.js';
import type { ViewReport } from '../src/community/view-component/contracts.js';
import { ViewReportingRequestGuard } from '../src/request-throttling/view-request.guard.js';
import { configureHttp } from '../src/http/http.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';
import { AppLogger } from '../src/observability/logger.js';
import { mintToken } from '../src/identity/tokens.js';

test('real view controller retains strict pipe decoding with schema metadata and mounts no docs routes', async () => {
  const token = mintToken('access');
  const calls: unknown[] = [];
  const noop = () => {};
  const module = await Test.createTestingModule({
    controllers: [ViewReportingController],
    providers: [
      {
        provide: AppLogger,
        useValue: {
          log: noop,
          warn: noop,
          error: noop,
          structured: { info: noop, error: noop },
        },
      },
      {
        provide: ViewReportingService,
        useValue: {
          issueEpoch: (receivedToken: string) => {
            calls.push(receivedToken);
            return { fixture: 'epoch' };
          },
          report: (receivedToken: string, body: ViewReport) => {
            calls.push({ receivedToken, body });
            return { fixture: 'receipt' };
          },
        },
      },
    ],
  })
    .overrideGuard(ViewReportingRequestGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  try {
    const epochPath = '/v1/me/community/view-reporting-epoch';
    const reportPath = '/v1/me/community/view-reports';
    const input = {
      version: 1,
      epochId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
      batchId: 'BCDEFABC-DEFA-4BCD-9EFA-BCDEFABCDEFA',
      kind: 'detail_visit',
      postIds: ['CDEFABCD-EFAB-1CDE-AFAB-CDEFABCDEFAB'],
    };
    for (const [path, body] of [
      [epochPath, { version: 1, extra: true }],
      [epochPath, { version: 2 }],
      [reportPath, { ...input, extra: true }],
      [reportPath, { ...input, postIds: [...input.postIds, ...input.postIds] }],
      [reportPath, { ...input, batchId: 'invalid' }],
      [reportPath, {}],
    ] as const) {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      assert.equal(
        safeErrorResponseSchema.parse(response.body).error.code,
        'BAD_REQUEST',
      );
    }
    assert.deepEqual(calls, []);
    const epoch = await request(app.getHttpServer())
      .post(epochPath)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1 })
      .expect(200);
    assert.equal(epoch.headers['cache-control'], 'no-store');
    assert.ok(epoch.headers['x-request-id']);
    await request(app.getHttpServer())
      .post(reportPath)
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(200);
    assert.deepEqual(calls, [
      token,
      {
        receivedToken: token,
        body: {
          ...input,
          epochId: input.epochId.toLowerCase(),
          batchId: input.batchId.toLowerCase(),
          postIds: input.postIds.map((id) => id.toLowerCase()),
        },
      },
    ]);
    for (const path of [
      '/docs',
      '/api',
      '/api-json',
      '/openapi.json',
      '/swagger',
    ]) {
      const response = await request(app.getHttpServer()).get(path).expect(404);
      assert.equal(
        safeErrorResponseSchema.parse(response.body).error.code,
        'NOT_FOUND',
      );
    }
  } finally {
    await app.close();
  }
});
