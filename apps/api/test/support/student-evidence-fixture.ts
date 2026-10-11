import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { WechatIdentityProvider } from '../../src/identity/wechat-provider.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import {
  WECHAT_PHONE_PROVIDER,
  WechatPhoneProvider,
} from '../../src/verification/wechat-phone-provider.js';
import type { PhoneProvider } from '../../src/verification/wechat-phone-provider.js';
import type { TestingModuleBuilder } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './media/runtime-fixture.js';
import {
  VERIFICATION_EVIDENCE_MEDIA_RUNTIME,
  VerificationEvidenceMediaService,
} from '../../src/verification/evidence/facade.js';
import type { VerificationEvidenceRetentionPolicy } from '../../src/verification/evidence/facade.js';
import {
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  verificationEvidenceMediaStatusSchema,
  verificationEvidenceMediaGrantSchema,
  verificationEvidenceMediaUploadObservedSchema,
} from '../../src/media/contracts-verification-evidence.js';
import { sha256 } from '../../src/media/processing/protocol.js';
export const verificationEvidenceMediaPrefix =
  '/v3/media/verification-evidence';
export function verificationEvidenceMediaOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
/** Only synthetic byte/storage/decoder/Review provider ports are supplied.
 * Identity, campus, school grants, application ledger and all owner proofs are real. */
export async function studentEvidenceFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  retention: VerificationEvidenceRetentionPolicy = {
    policyRef: 'synthetic-student-evidence-v1',
    evidenceTtlSeconds: 3600,
    cleanupEnabled: true,
  },
  options: {
    phoneProvider?: PhoneProvider;
    configureTestModule?: (
      builder: TestingModuleBuilder,
      config: RuntimeConfig,
    ) => void;
  } = {},
) {
  const exchanges = { identity: 0, token: 0, phone: 0 };
  // Fixed provider host/routes only. This function never invokes global fetch.
  // Real adapter parsers, bounded streams, single-use behavior and watermark
  // validation remain active; no URL/code/token/phone is recorded in the journal.
  const syntheticFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.weixin.qq.com');
    assert.equal(init?.redirect, 'error');
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/sns/jscode2session') {
      assert.equal(init?.method, 'GET');
      assert.equal(url.searchParams.get('appid'), 'wx0000000000000000');
      const code = url.searchParams.get('js_code');
      assert.ok(code && /^[A-Za-z0-9_-]{1,128}$/.test(code));
      exchanges.identity++;
      return json({
        errcode: 0,
        openid: code,
        session_key: 'AAAAAAAAAAAAAAAAAAAAAA==',
      });
    }
    if (url.pathname === '/cgi-bin/token') {
      assert.equal(init?.method, 'GET');
      exchanges.token++;
      return json({
        access_token: 'synthetic-student-phone-token',
        expires_in: 7200,
      });
    }
    if (url.pathname === '/wxa/business/getuserphonenumber') {
      assert.equal(init?.method, 'POST');
      assert.equal(
        url.searchParams.get('access_token'),
        'synthetic-student-phone-token',
      );
      assert.ok(
        typeof init?.body === 'string' &&
          typeof JSON.parse(init.body).code === 'string',
      );
      exchanges.phone++;
      return json({
        errcode: 0,
        phone_info: {
          phoneNumber: '13000000000',
          purePhoneNumber: '13000000000',
          countryCode: 86,
          watermark: {
            appid: 'wx0000000000000000',
            timestamp: Math.floor(Date.now() / 1000),
          },
        },
      });
    }
    throw new Error('Synthetic WeChat transport refuses unregistered route');
  };
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage, runtimeConfig }) {
      const config: RuntimeConfig = {
        ...runtimeConfig,
        NATIVE_VERIFICATION_ENROLLMENT: 'enabled',
        WECHAT_APP_ID: 'wx0000000000000000',
        WECHAT_APP_SECRET: 'synthetic-student-fixture-only-value',
        AUTH_RATE_LIMIT_KEY: '03'.repeat(32),
        WECHAT_PHONE_BINDING: 'enabled',
        WECHAT_PHONE_PROOF_TTL_SECONDS: 3600,
      };
      builder.overrideProvider(APP_CONFIG).useValue(config);
      builder
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue(new WechatIdentityProvider(config, syntheticFetch));
      builder
        .overrideProvider(WECHAT_PHONE_PROVIDER)
        .useValue(
          options.phoneProvider ??
            new WechatPhoneProvider(config, syntheticFetch),
        );
      builder.overrideProvider(VERIFICATION_EVIDENCE_MEDIA_RUNTIME).useValue({
        planning: ingressStorage,
        storage,
        ingressStorage,
        retention,
      });
      options.configureTestModule?.(builder, config);
    },
  });
  return {
    ...base,
    providerExchanges: () => ({ ...exchanges }),
    // The ordinary Identity endpoint appends native-enrollment unverified facts.
    // Never use base.actor/certify or mutate a verification head in this fixture.
    actor: async (code: string = randomUUID()): Promise<SessionCredentials> => {
      const response = await request(base.app.getHttpServer())
        .post('/v1/auth/wechat/login')
        .send({ code });
      verificationEvidenceMediaOk(response);
      return response.body as SessionCredentials;
    },
    evidence: base.app.get(VerificationEvidenceMediaService),
  };
}
export type StudentEvidenceFixture = Awaited<
  ReturnType<typeof studentEvidenceFixture>
>;
export async function readyVerificationEvidenceImage(
  f: {
    app: INestApplication;
    worker: { runOne(kind: 'seal' | 'process' | 'review'): Promise<boolean> };
  },
  actor: { accessToken: string },
  applicationId: string,
  revision: number,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    clientRequestId: randomUUID(),
    applicationId,
    revision,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  const prepared = await request(http)
    .post(`${verificationEvidenceMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  verificationEvidenceMediaOk(prepared);
  const initial = verificationEvidenceMediaStatusSchema.parse(prepared.body);
  const granted = await request(http)
    .post(
      `${verificationEvidenceMediaPrefix}/upload-intents/${initial.intentId}/grant`,
    )
    .set('Authorization', auth)
    .send({});
  verificationEvidenceMediaOk(granted);
  const grant = verificationEvidenceMediaGrantSchema.parse(granted.body);
  const uploaded = await request(http)
    .post(
      `${verificationEvidenceMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'ignored-verificationEvidence-image',
      contentType: 'image/png',
    });
  verificationEvidenceMediaOk(uploaded);
  assert.equal(
    verificationEvidenceMediaUploadObservedSchema.parse(uploaded.body).sha256,
    sha256(bytes),
  );
  verificationEvidenceMediaOk(
    await request(http)
      .post(
        `${verificationEvidenceMediaPrefix}/upload-intents/${initial.intentId}/finalize`,
      )
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(
      `${verificationEvidenceMediaPrefix}/upload-intents/${initial.intentId}`,
    )
    .set('Authorization', auth);
  verificationEvidenceMediaOk(response);
  return {
    input,
    status: verificationEvidenceMediaStatusSchema.parse(response.body),
  };
}
