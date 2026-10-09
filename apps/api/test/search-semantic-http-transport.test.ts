import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '../src/http/application-error.js';
import { createQwenSemanticProfile } from '../src/community/search/semantic/profile.js';
import { QwenSemanticProvider } from '../src/community/search/semantic/provider.js';
import type {
  QwenEmbeddingRequest,
  QwenRerankRequest,
  SemanticTransportEnvelope,
} from '../src/community/search/semantic/provider.js';
import {
  SiliconFlowQwenHttpTransport,
  SILICONFLOW_QWEN_ORIGIN,
  SEMANTIC_HTTP_MAX_RESPONSE_BYTES,
} from '../src/community/search/semantic/http-transport.js';
import type {
  SemanticHttpDependencies,
  SemanticHttpFetch,
  SiliconFlowQwenHttpOptions,
} from '../src/community/search/semantic/http-transport.js';

const profile = createQwenSemanticProfile({
  providerId: 'siliconflow',
  deploymentId: 'offline-http-fixture-cn',
  deploymentRevision: 'fixture-service-v1',
  embeddingModelRevision: 'fixture-embedding-v1',
  rerankerModelRevision: 'fixture-reranker-v1',
});
const settings: SiliconFlowQwenHttpOptions = {
  origin: SILICONFLOW_QWEN_ORIGIN,
  secretEnvironmentVariable: 'OFFLINE_TEST_TOKEN',
};
const controller = new AbortController();
function envelope<T>(request: T): SemanticTransportEnvelope<T> {
  return {
    profileIdentity: profile.profileIdentity,
    indexSpaceKey: profile.indexSpaceKey,
    request,
  };
}
const embeddingRequest: QwenEmbeddingRequest = {
  model: profile.embeddingModel,
  dimensions: 4096,
  encoding_format: 'float',
  input: ['原文😀\n 原样 '],
};
const rerankRequest: QwenRerankRequest = {
  model: profile.rerankerModel,
  query: '校园 query',
  documents: [
    { id: 'post:00000000-0000-4000-8000-000000000001', text: 'Post 本文' },
    {
      id: 'reply:00000000-0000-4000-8000-000000000002',
      text: 'Only reply 本文😀\n ',
    },
  ],
};
function embeddingBody(count = 1): unknown {
  return {
    model: profile.embeddingModel,
    object: 'list',
    data: Array.from({ length: count }, (_value, index) => ({
      index,
      object: 'embedding',
      embedding: [1, ...Array<number>(4095).fill(0)],
    })),
  };
}
function rerankBody(): unknown {
  return {
    id: 'remote-response-id',
    results: [
      {
        index: 1,
        relevance_score: 22,
        document: { text: 'UNTRUSTED RETURNED TEXT' },
      },
      { index: 0, relevance_score: -3 },
    ],
  };
}
function json(value: unknown, options: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}
function dependencies(fetch: SemanticHttpFetch): SemanticHttpDependencies {
  return { fetch, resolveSecret: () => 'offline-fixture-token' };
}
function transport(
  fetch: SemanticHttpFetch,
  patch: Partial<SiliconFlowQwenHttpOptions> = {},
): SiliconFlowQwenHttpTransport {
  return new SiliconFlowQwenHttpTransport(
    profile,
    { ...settings, enabled: true, ...patch },
    dependencies(fetch),
  );
}
function unavailable(error: unknown): boolean {
  assert.ok(error instanceof ApplicationError);
  assert.equal(error.code, 'COMMUNITY_UNAVAILABLE');
  assert.equal(error.message, 'Community is unavailable');
  assert.equal(error.cause, undefined);
  return true;
}

test('HTTP transport is disabled by default before all secret resolution and fetch', async () => {
  let reads = 0;
  let calls = 0;
  const options = { ...settings };
  const adapter = new SiliconFlowQwenHttpTransport(profile, options, {
    resolveSecret() {
      reads++;
      return 'offline-fixture-token';
    },
    async fetch() {
      calls++;
      throw Error('unexpected network');
    },
  });
  Object.assign(options, { enabled: true });
  assert.ok(Object.isFrozen(adapter));
  await assert.rejects(
    adapter.embed(envelope(embeddingRequest), controller.signal),
    unavailable,
  );
  await assert.rejects(
    adapter.rerank(envelope(rerankRequest), controller.signal),
    unavailable,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('explicit fixed HTTPS origin, deployment profile and bounded settings are mandatory', () => {
  const noFetch = dependencies(async () => {
    throw Error('not called');
  });
  for (const origin of [
    'http://api.siliconflow.cn',
    'https://api.siliconflow.cn/',
    'https://api.siliconflow.cn:443',
    'https://api.siliconflow.cn:8443',
    'https://user:password@api.siliconflow.cn',
    'https://api.siliconflow.cn?token=secret',
    'https://api.siliconflow.cn#fragment',
    'https://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn.evil.invalid',
    'https://127.0.0.1',
    'https://localhost',
    'https://API.SILICONFLOW.CN',
  ])
    assert.throws(
      () =>
        new SiliconFlowQwenHttpTransport(
          profile,
          { ...settings, origin } as SiliconFlowQwenHttpOptions,
          noFetch,
        ),
      unavailable,
    );
  for (const patch of [
    { origin: undefined },
    { enabled: 'true' },
    { secretEnvironmentVariable: undefined },
    { secretEnvironmentVariable: '' },
    { secretEnvironmentVariable: 'TOKEN\nOTHER' },
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: SEMANTIC_HTTP_MAX_RESPONSE_BYTES + 1 },
    { embeddingsPath: '/anything' },
    { token: 'inline-secret-not-supported' },
  ])
    assert.throws(
      () =>
        new SiliconFlowQwenHttpTransport(
          profile,
          { ...settings, ...patch } as SiliconFlowQwenHttpOptions,
          noFetch,
        ),
      unavailable,
    );
  assert.throws(
    () => new SiliconFlowQwenHttpTransport({ ...profile }, settings, noFetch),
    unavailable,
  );
  const foreign = createQwenSemanticProfile({
    providerId: 'different-provider',
    deploymentId: 'fixture',
    deploymentRevision: 'v1',
    embeddingModelRevision: 'v1',
    rerankerModelRevision: 'v1',
  });
  assert.throws(
    () => new SiliconFlowQwenHttpTransport(foreign, settings, noFetch),
    unavailable,
  );
  assert.throws(
    () =>
      new SiliconFlowQwenHttpTransport(
        profile,
        settings,
        {} as SemanticHttpDependencies,
      ),
    unavailable,
  );
});

test('embeddings translate to documented endpoint with full dimensions and safe request policy', async () => {
  let reads = 0;
  let calls = 0;
  const adapter = new SiliconFlowQwenHttpTransport(
    profile,
    { ...settings, enabled: true },
    {
      resolveSecret(name) {
        reads++;
        assert.equal(name, 'OFFLINE_TEST_TOKEN');
        return 'offline-fixture-token';
      },
      async fetch(url, init) {
        calls++;
        assert.equal(url, `${SILICONFLOW_QWEN_ORIGIN}/v1/embeddings`);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.referrerPolicy, 'no-referrer');
        assert.deepEqual(init.headers, {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer offline-fixture-token',
        });
        assert.deepEqual(JSON.parse(init.body as string), embeddingRequest);
        assert.equal(
          (init.body as string).includes(profile.indexSpaceKey),
          false,
        );
        assert.equal(init.signal?.aborted, false);
        return json(embeddingBody());
      },
    },
  );
  const result = await adapter.embed(
    envelope(embeddingRequest),
    controller.signal,
  );
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('offline-fixture-token'), false);
  assert.deepEqual(result, {
    profileIdentity: profile.profileIdentity,
    indexSpaceKey: profile.indexSpaceKey,
    response: {
      model: profile.embeddingModel,
      data: [{ index: 0, embedding: [1, ...Array<number>(4095).fill(0)] }],
    },
  });
});

test('SiliconFlow rerank sends exact text and ordinal positions only, then rebuilds local IDs', async () => {
  const adapter = transport(async (url, init) => {
    assert.equal(url, `${SILICONFLOW_QWEN_ORIGIN}/v1/rerank`);
    assert.deepEqual(JSON.parse(init.body as string), {
      model: profile.rerankerModel,
      query: rerankRequest.query,
      documents: rerankRequest.documents.map(({ text }) => text),
      top_n: 2,
      return_documents: false,
    });
    for (const document of rerankRequest.documents)
      assert.equal((init.body as string).includes(document.id), false);
    return json(rerankBody());
  });
  assert.deepEqual(
    await adapter.rerank(envelope(rerankRequest), controller.signal),
    {
      profileIdentity: profile.profileIdentity,
      indexSpaceKey: profile.indexSpaceKey,
      response: {
        model: profile.rerankerModel,
        results: [
          { index: 1, id: rerankRequest.documents[1]!.id, score: 22 },
          { index: 0, id: rerankRequest.documents[0]!.id, score: -3 },
        ],
      },
    },
  );
});

test('HTTP adapter composes with existing provider without source text or IDs added to requests', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const adapter = transport(async (url, init) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push({ url, body });
    return json(
      url.endsWith('/embeddings')
        ? embeddingBody((body['input'] as unknown[]).length)
        : rerankBody(),
    );
  });
  const provider = new QwenSemanticProvider(profile, adapter);
  const query = await provider.embedQuery(' campus ');
  const embeddings = await provider.embedDocuments(rerankRequest.documents);
  const ranked = await provider.rerank('campus', rerankRequest.documents);
  assert.equal(query.vector.length, 4096);
  assert.equal(embeddings.length, 2);
  assert.deepEqual(
    ranked.map(({ id }) => id),
    [rerankRequest.documents[1]!.id, rerankRequest.documents[0]!.id],
  );
  assert.deepEqual(requests[0]!.body['input'], [
    `Instruct: ${profile.queryInstruction}\nQuery: campus`,
  ]);
  assert.deepEqual(
    requests[1]!.body['input'],
    rerankRequest.documents.map(({ text }) => text),
  );
});

test('invalid local envelopes and source bounds fail before any secret or HTTP operation', async () => {
  let reads = 0;
  let calls = 0;
  const adapter = new SiliconFlowQwenHttpTransport(
    profile,
    { ...settings, enabled: true },
    {
      resolveSecret() {
        reads++;
        return 'offline-fixture-token';
      },
      async fetch() {
        calls++;
        throw Error('not called');
      },
    },
  );
  for (const invalid of [
    { ...envelope(embeddingRequest), profileIdentity: 'foreign' },
    { ...envelope(embeddingRequest), indexSpaceKey: 'foreign' },
    envelope({ ...embeddingRequest, model: 'other-model' }),
    envelope({ ...embeddingRequest, dimensions: 1024 }),
    envelope({ ...embeddingRequest, input: [] }),
    envelope({ ...embeddingRequest, input: Array<string>(129).fill('body') }),
    envelope({ ...embeddingRequest, input: ['😀'.repeat(2501)] }),
    envelope({ ...embeddingRequest, input: ['not\r\ncanonical'] }),
    envelope({ ...embeddingRequest, input: ['\ud800'] }),
    envelope({ ...embeddingRequest, user: 'do-not-transmit' }),
  ])
    await assert.rejects(
      adapter.embed(
        invalid as SemanticTransportEnvelope<QwenEmbeddingRequest>,
        controller.signal,
      ),
      unavailable,
    );
  for (const invalid of [
    { ...envelope(rerankRequest), profileIdentity: 'foreign' },
    envelope({ ...rerankRequest, model: 'other-model' }),
    envelope({ ...rerankRequest, query: 'a'.repeat(201) }),
    envelope({ ...rerankRequest, query: ' noncanonical ' }),
    envelope({ ...rerankRequest, documents: [] }),
    envelope({
      ...rerankRequest,
      documents: [rerankRequest.documents[0], rerankRequest.documents[0]],
    }),
    envelope({
      ...rerankRequest,
      documents: [{ id: 'one', text: 'a'.repeat(2501) }],
    }),
  ])
    await assert.rejects(
      adapter.rerank(
        invalid as SemanticTransportEnvelope<QwenRerankRequest>,
        controller.signal,
      ),
      unavailable,
    );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('secrets are lazy, header-safe, not persisted and missing/failed resolution is sanitized', async () => {
  for (const token of [undefined, '', 'a b', 'a\r\nb', 'a'.repeat(4097)]) {
    let calls = 0;
    const adapter = new SiliconFlowQwenHttpTransport(
      profile,
      { ...settings, enabled: true },
      {
        resolveSecret: () => token,
        async fetch() {
          calls++;
          throw Error('not called');
        },
      },
    );
    await assert.rejects(
      adapter.embed(envelope(embeddingRequest), controller.signal),
      unavailable,
    );
    assert.equal(calls, 0);
  }
  let reads = 0;
  const adapter = new SiliconFlowQwenHttpTransport(
    profile,
    { ...settings, enabled: true },
    {
      resolveSecret() {
        reads++;
        if (reads === 2) throw Error('private-resolver-error');
        return 'offline-fixture-token';
      },
      async fetch() {
        return json(embeddingBody());
      },
    },
  );
  await adapter.embed(envelope(embeddingRequest), controller.signal);
  await assert.rejects(
    adapter.embed(envelope(embeddingRequest), controller.signal),
    unavailable,
  );
  assert.equal(reads, 2);
});

test('redirects, changed response URLs and all HTTP failures including 429 get no retry', async () => {
  for (const status of [
    301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 503, 504,
  ]) {
    let calls = 0;
    const adapter = transport(async () => {
      calls++;
      return new Response('PRIVATE PROVIDER BODY', {
        status,
        headers: { location: 'https://evil.invalid' },
      });
    });
    await assert.rejects(
      adapter.embed(envelope(embeddingRequest), controller.signal),
      unavailable,
    );
    assert.equal(calls, 1);
  }
  for (const patch of [
    { redirected: true },
    { url: 'https://evil.invalid/v1/embeddings' },
    { type: 'opaqueredirect' },
  ]) {
    const adapter = transport(async () =>
      Object.defineProperties(
        json(embeddingBody()),
        Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, { value }]),
        ),
      ),
    );
    await assert.rejects(
      adapter.embed(envelope(embeddingRequest), controller.signal),
      unavailable,
    );
  }
  let calls = 0;
  const adapter = transport(async () => {
    calls++;
    throw Error('private token network failure');
  });
  await assert.rejects(
    adapter.rerank(envelope(rerankRequest), controller.signal),
    unavailable,
  );
  assert.equal(calls, 1);
});

test('bounded JSON response rejects headers, oversized declared/streamed bytes, invalid UTF-8 and malformed JSON', async () => {
  const variants = [
    () => new Response('{}'),
    () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '200',
        },
      }),
    () =>
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 'unknown',
        },
      }),
    () =>
      new Response('x'.repeat(65), {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response('{invalid', {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const makeResponse of variants) {
    const adapter = transport(async () => makeResponse(), {
      maxResponseBytes: 64,
    });
    await assert.rejects(
      adapter.embed(envelope(embeddingRequest), controller.signal),
      unavailable,
    );
  }
  let cancelled = false;
  const streamed = new ReadableStream<Uint8Array>({
    start(sink) {
      sink.enqueue(new Uint8Array(40));
      sink.enqueue(new Uint8Array(40));
    },
    cancel() {
      cancelled = true;
    },
  });
  const adapter = transport(
    async () =>
      new Response(streamed, {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '20' },
      }),
    { maxResponseBytes: 64 },
  );
  await assert.rejects(
    adapter.embed(envelope(embeddingRequest), controller.signal),
    unavailable,
  );
  assert.equal(cancelled, true);
});

test('exact response-size boundary is accepted; one byte below is rejected', async () => {
  const body = JSON.stringify(rerankBody());
  const size = Buffer.byteLength(body);
  for (const maxResponseBytes of [size, size - 1]) {
    const adapter = transport(
      async () =>
        new Response(body, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      { maxResponseBytes },
    );
    const result = adapter.rerank(envelope(rerankRequest), controller.signal);
    if (maxResponseBytes === size) await result;
    else await assert.rejects(result, unavailable);
  }
});

test('remote embeddings and rerank runtime validation reject wrong model, missing/duplicate indices and malformed scores', async () => {
  const validVector = [1, ...Array<number>(4095).fill(0)];
  for (const response of [
    null,
    {},
    { model: 'other', data: [{ index: 0, embedding: validVector }] },
    { model: profile.embeddingModel, data: [] },
    {
      model: profile.embeddingModel,
      data: [{ index: 1, embedding: validVector }],
    },
    { model: profile.embeddingModel, data: [{ index: 0, embedding: [1] }] },
    {
      model: profile.embeddingModel,
      data: [{ index: 0, embedding: Array<number>(4096).fill(0) }],
    },
    {
      model: profile.embeddingModel,
      data: [{ index: 0, embedding: ['1', ...validVector.slice(1)] }],
    },
  ]) {
    const adapter = transport(async () => json(response));
    await assert.rejects(
      adapter.embed(envelope(embeddingRequest), controller.signal),
      unavailable,
    );
  }
  for (const response of [
    null,
    {},
    {
      model: 'foreign-model',
      results: [
        { index: 0, relevance_score: 1 },
        { index: 1, relevance_score: 2 },
      ],
    },
    { results: [] },
    { results: [{ index: 0, relevance_score: 1 }] },
    {
      results: [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 2 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: 1 },
        { index: 2, relevance_score: 2 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: '1' },
        { index: 1, relevance_score: 2 },
      ],
    },
    {
      results: [
        { index: -1, relevance_score: 1 },
        { index: 1, relevance_score: 2 },
      ],
    },
  ]) {
    const adapter = transport(async () => json(response));
    await assert.rejects(
      adapter.rerank(envelope(rerankRequest), controller.signal),
      unavailable,
    );
  }
  const adapter = transport(
    async () =>
      new Response(
        '{"results":[{"index":0,"relevance_score":1e400},{"index":1,"relevance_score":0}]}',
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await assert.rejects(
    adapter.rerank(envelope(rerankRequest), controller.signal),
    unavailable,
  );
});

test('pre-abort skips secrets; resolver timeout prevents a later credential from causing transmission', async () => {
  let reads = 0;
  let calls = 0;
  let resolveSecret: ((secret: string) => void) | undefined;
  const adapter = new SiliconFlowQwenHttpTransport(
    profile,
    { ...settings, enabled: true, timeoutMs: 10 },
    {
      resolveSecret() {
        reads++;
        return new Promise<string>((resolve) => {
          resolveSecret = resolve;
        });
      },
      async fetch() {
        calls++;
        return json(embeddingBody());
      },
    },
  );
  const preAborted = new AbortController();
  preAborted.abort('private');
  await assert.rejects(
    adapter.embed(envelope(embeddingRequest), preAborted.signal),
    unavailable,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    adapter.embed(envelope(embeddingRequest), controller.signal),
    unavailable,
  );
  assert.equal(reads, 1);
  resolveSecret!('late-offline-fixture-token');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('HTTP timeout/caller abort remain bounded for fetch or a response stream that never settles', async () => {
  let fetchSignal: AbortSignal | null | undefined;
  const never = transport(
    (_url, init) => {
      fetchSignal = init.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(
    never.embed(envelope(embeddingRequest), controller.signal),
    unavailable,
  );
  assert.equal(fetchSignal?.aborted, true);
  let streamCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      streamCancelled = true;
    },
  });
  const streaming = transport(
    async () =>
      new Response(stream, { headers: { 'Content-Type': 'application/json' } }),
    { timeoutMs: 10 },
  );
  await assert.rejects(
    streaming.rerank(envelope(rerankRequest), controller.signal),
    unavailable,
  );
  assert.equal(streamCancelled, true);
  const owner = new AbortController();
  const aborted = transport(async (_url, init) => {
    fetchSignal = init.signal;
    owner.abort(new Error('private-abort-reason'));
    return json(embeddingBody());
  });
  await assert.rejects(
    aborted.embed(envelope(embeddingRequest), owner.signal),
    unavailable,
  );
  assert.equal(fetchSignal?.aborted, true);
});

test('maximum 128-body batch and Unicode input bounds are transmitted intact using fixtures only', async () => {
  const documents = Array.from({ length: 128 }, (_value, index) => ({
    id: `reply:${index}`,
    text: '😀'.repeat(2500),
  }));
  const adapter = transport(async (url, init) => {
    const payload = JSON.parse(init.body as string) as {
      input?: string[];
      documents?: string[];
      query?: string;
    };
    if (url.endsWith('/embeddings')) {
      assert.deepEqual(
        payload.input,
        documents.map(({ text }) => text),
      );
      return json(embeddingBody(128));
    }
    assert.equal(payload.query, '鲸'.repeat(200));
    assert.deepEqual(
      payload.documents,
      documents.map(({ text }) => text),
    );
    return json({
      model: profile.rerankerModel,
      results: documents.map((_document, index) => ({
        index,
        relevance_score: index,
      })),
    });
  });
  const provider = new QwenSemanticProvider(profile, adapter);
  assert.equal((await provider.embedDocuments(documents)).length, 128);
  assert.equal(
    (await provider.rerank('鲸'.repeat(200), documents)).length,
    128,
  );
});
