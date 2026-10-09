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
} from '../src/community/search/semantic/http-transport.js';
import {
  TumuerQwenHttpTransport,
  TUMUER_QWEN_ORIGIN,
} from '../src/community/search/semantic/tumuer-http-transport.js';
import type {
  SemanticHttpDependencies,
  SemanticHttpFetch,
  TumuerQwenHttpOptions,
} from '../src/community/search/semantic/tumuer-http-transport.js';

const deployment = {
  deploymentId: 'offline-gateway-fixture',
  deploymentRevision: 'fixture-deployment-v1',
  embeddingModelRevision: 'fixture-embedding-v1',
  rerankerModelRevision: 'fixture-reranker-v1',
};
const profile = createQwenSemanticProfile({
  ...deployment,
  providerId: 'tumuer',
});
const siliconflowProfile = createQwenSemanticProfile({
  ...deployment,
  providerId: 'siliconflow',
});
const options: TumuerQwenHttpOptions = {
  origin: TUMUER_QWEN_ORIGIN,
  secretEnvironmentVariable: 'TUMUER_FIXTURE_KEY',
};
const signal = new AbortController().signal;
const embeddingRequest: QwenEmbeddingRequest = {
  model: profile.embeddingModel,
  dimensions: 4096,
  encoding_format: 'float',
  input: ['完整的 本文😀\n '],
};
const rerankRequest: QwenRerankRequest = {
  model: profile.rerankerModel,
  query: '搜索校园',
  documents: [
    { id: 'post:00000000-0000-4000-8000-000000000001', text: 'Post 本文' },
    {
      id: 'reply:00000000-0000-4000-8000-000000000002',
      text: 'Only reply body😀\n ',
    },
  ],
};
function envelope<T>(request: T): SemanticTransportEnvelope<T> {
  return {
    profileIdentity: profile.profileIdentity,
    indexSpaceKey: profile.indexSpaceKey,
    request,
  };
}
function embeddingResponse(count = 1) {
  return {
    object: 'list',
    model: profile.embeddingModel,
    data: Array.from({ length: count }, (_value, index) => ({
      index,
      embedding: [1, ...Array<number>(4095).fill(0)],
    })),
  };
}
function rerankResponse() {
  return {
    id: 'fixture-response-id',
    results: [
      {
        index: 1,
        relevance_score: 3.5,
        document: { text: 'untrusted-provider-text' },
      },
      { index: 0, relevance_score: -2 },
    ],
  };
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}
function dependencies(fetch: SemanticHttpFetch): SemanticHttpDependencies {
  return { fetch, resolveSecret: () => 'tumuer-fixture-token' };
}
function unavailable(error: unknown): boolean {
  assert.ok(error instanceof ApplicationError);
  assert.equal(error.code, 'COMMUNITY_UNAVAILABLE');
  assert.equal(error.message, 'Community is unavailable');
  assert.equal(error.cause, undefined);
  return true;
}
function adapter(
  fetch: SemanticHttpFetch,
  patch: Partial<TumuerQwenHttpOptions> = {},
) {
  return new TumuerQwenHttpTransport(
    profile,
    { ...options, enabled: true, ...patch },
    dependencies(fetch),
  );
}

test('Tumuer gateway is explicit, disabled by default, and immutable before any credential lookup', async () => {
  let reads = 0;
  let calls = 0;
  const settings = { ...options };
  const transport = new TumuerQwenHttpTransport(profile, settings, {
    resolveSecret() {
      reads++;
      return 'tumuer-fixture-token';
    },
    async fetch() {
      calls++;
      throw Error('unexpected network');
    },
  });
  Object.assign(settings, { enabled: true, origin: SILICONFLOW_QWEN_ORIGIN });
  assert.ok(Object.isFrozen(transport));
  await assert.rejects(
    transport.embed(envelope(embeddingRequest), signal),
    unavailable,
  );
  await assert.rejects(
    transport.rerank(envelope(rerankRequest), signal),
    unavailable,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('Tumuer and SiliconFlow origins and provider profiles cannot be substituted or used as fallbacks', () => {
  let reads = 0;
  let calls = 0;
  const ports = {
    resolveSecret() {
      reads++;
      return 'tumuer-fixture-token';
    },
    async fetch() {
      calls++;
      throw Error('unexpected network');
    },
  };
  for (const origin of [
    SILICONFLOW_QWEN_ORIGIN,
    'http://router.tumuer.me',
    'https://router.tumuer.me/',
    'https://router.tumuer.me/v1',
    'https://router.tumuer.me:443',
    'https://router.tumuer.me?key=private',
    'https://router.tumuer.me#private',
    'https://user:password@router.tumuer.me',
    'https://router.tumuer.me.evil.invalid',
    'https://127.0.0.1',
    'https://localhost',
  ])
    assert.throws(
      () =>
        new TumuerQwenHttpTransport(
          profile,
          { ...options, origin } as TumuerQwenHttpOptions,
          ports,
        ),
      unavailable,
    );
  assert.throws(
    () => new TumuerQwenHttpTransport(siliconflowProfile, options, ports),
    unavailable,
  );
  assert.throws(
    () =>
      new SiliconFlowQwenHttpTransport(
        profile,
        {
          origin: SILICONFLOW_QWEN_ORIGIN,
          secretEnvironmentVariable: 'TUMUER_FIXTURE_KEY',
        },
        ports,
      ),
    unavailable,
  );
  assert.throws(
    () =>
      new SiliconFlowQwenHttpTransport(
        siliconflowProfile,
        {
          origin: TUMUER_QWEN_ORIGIN,
          secretEnvironmentVariable: 'SILICONFLOW_FIXTURE_KEY',
        } as never,
        ports,
      ),
    unavailable,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.notEqual(profile.indexSpaceKey, siliconflowProfile.indexSpaceKey);
});

test('Tumuer documented endpoints preserve raw text and 4096 dimensions with ordinal-only remote identifiers', async () => {
  const observed: { url: string; init: RequestInit }[] = [];
  const transport = adapter(async (url, init) => {
    observed.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(init.headers, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer tumuer-fixture-token',
    });
    return json(
      url.endsWith('/embeddings') ? embeddingResponse() : rerankResponse(),
    );
  });
  await transport.embed(envelope(embeddingRequest), signal);
  const ranked = await transport.rerank(envelope(rerankRequest), signal);
  assert.equal(observed[0]!.url, 'https://router.tumuer.me/v1/embeddings');
  assert.equal(observed[1]!.url, 'https://router.tumuer.me/v1/rerank');
  assert.deepEqual(
    JSON.parse(observed[0]!.init.body as string),
    embeddingRequest,
  );
  assert.deepEqual(JSON.parse(observed[1]!.init.body as string), {
    model: profile.rerankerModel,
    query: rerankRequest.query,
    documents: rerankRequest.documents.map(({ text }) => text),
    top_n: 2,
    return_documents: false,
  });
  for (const { init } of observed) {
    assert.equal(
      (init.body as string).includes(profile.profileIdentity),
      false,
    );
    for (const { id } of rerankRequest.documents)
      assert.equal((init.body as string).includes(id), false);
  }
  assert.deepEqual(ranked, {
    profileIdentity: profile.profileIdentity,
    indexSpaceKey: profile.indexSpaceKey,
    response: {
      model: profile.rerankerModel,
      results: [
        { index: 1, id: rerankRequest.documents[1]!.id, score: 3.5 },
        { index: 0, id: rerankRequest.documents[0]!.id, score: -2 },
      ],
    },
  });
  assert.equal(
    JSON.stringify(ranked).includes('untrusted-provider-text'),
    false,
  );
});

test('separate lazy secret resolvers send each fixture credential only to its bound gateway', async () => {
  const destinations: { origin: string; authorization: string }[] = [];
  const resolved: string[] = [];
  const ports: SemanticHttpDependencies = {
    resolveSecret(name) {
      resolved.push(name);
      if (name === 'TUMUER_FIXTURE_KEY') return 'tumuer-fixture-only';
      if (name === 'SILICONFLOW_FIXTURE_KEY') return 'siliconflow-fixture-only';
      throw Error('unexpected secret name');
    },
    async fetch(url, init) {
      const origin = new URL(url).origin;
      const authorization = new Headers(init.headers).get('authorization')!;
      destinations.push({ origin, authorization });
      assert.equal(
        authorization,
        origin === TUMUER_QWEN_ORIGIN
          ? 'Bearer tumuer-fixture-only'
          : 'Bearer siliconflow-fixture-only',
      );
      return json(embeddingResponse());
    },
  };
  const tumuer = new TumuerQwenHttpTransport(
    profile,
    { ...options, enabled: true },
    ports,
  );
  const siliconflow = new SiliconFlowQwenHttpTransport(
    siliconflowProfile,
    {
      enabled: true,
      origin: SILICONFLOW_QWEN_ORIGIN,
      secretEnvironmentVariable: 'SILICONFLOW_FIXTURE_KEY',
    },
    ports,
  );
  await tumuer.embed(envelope(embeddingRequest), signal);
  await siliconflow.embed(
    {
      profileIdentity: siliconflowProfile.profileIdentity,
      indexSpaceKey: siliconflowProfile.indexSpaceKey,
      request: embeddingRequest,
    },
    signal,
  );
  assert.deepEqual(resolved, ['TUMUER_FIXTURE_KEY', 'SILICONFLOW_FIXTURE_KEY']);
  assert.deepEqual(destinations, [
    { origin: TUMUER_QWEN_ORIGIN, authorization: 'Bearer tumuer-fixture-only' },
    {
      origin: SILICONFLOW_QWEN_ORIGIN,
      authorization: 'Bearer siliconflow-fixture-only',
    },
  ]);
  await assert.rejects(
    tumuer.embed(
      {
        profileIdentity: siliconflowProfile.profileIdentity,
        indexSpaceKey: siliconflowProfile.indexSpaceKey,
        request: embeddingRequest,
      },
      signal,
    ),
    unavailable,
  );
  assert.equal(resolved.length, 2);
  assert.equal(destinations.length, 2);
});

test('Tumuer never redirects or retries into SiliconFlow and discards private failure bodies', async () => {
  for (const response of [
    () =>
      new Response('private body', {
        status: 307,
        headers: { location: `${SILICONFLOW_QWEN_ORIGIN}/v1/embeddings` },
      }),
    () => new Response('private body', { status: 429 }),
    () => new Response('private body', { status: 503 }),
    () =>
      Object.defineProperties(json(embeddingResponse()), {
        redirected: { value: true },
        url: { value: `${SILICONFLOW_QWEN_ORIGIN}/v1/embeddings` },
      }),
    () =>
      Object.defineProperty(json(embeddingResponse()), 'url', {
        value: `${SILICONFLOW_QWEN_ORIGIN}/v1/embeddings`,
      }),
  ]) {
    let calls = 0;
    const transport = adapter(async (url) => {
      calls++;
      assert.equal(new URL(url).origin, TUMUER_QWEN_ORIGIN);
      return response();
    });
    await assert.rejects(
      transport.embed(envelope(embeddingRequest), signal),
      unavailable,
    );
    assert.equal(calls, 1);
  }
});

test('Tumuer response schema rejects foreign model, invalid vectors and incomplete or duplicate rerank indices', async () => {
  for (const response of [
    { ...embeddingResponse(), model: 'another-model' },
    { ...embeddingResponse(), data: [] },
    { ...embeddingResponse(), data: [{ index: 0, embedding: [1] }] },
    {
      ...embeddingResponse(),
      data: [{ index: 1, embedding: Array<number>(4096).fill(1) }],
    },
  ])
    await assert.rejects(
      adapter(async () => json(response)).embed(
        envelope(embeddingRequest),
        signal,
      ),
      unavailable,
    );
  for (const response of [
    { ...rerankResponse(), model: 'another-model' },
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
  ])
    await assert.rejects(
      adapter(async () => json(response)).rerank(
        envelope(rerankRequest),
        signal,
      ),
      unavailable,
    );
});

test('Tumuer enforces response byte boundaries and aborts hanging response streams', async () => {
  const body = JSON.stringify(rerankResponse());
  const size = Buffer.byteLength(body);
  await adapter(async () => json(rerankResponse()), {
    maxResponseBytes: size,
  }).rerank(envelope(rerankRequest), signal);
  await assert.rejects(
    adapter(async () => json(rerankResponse()), {
      maxResponseBytes: size - 1,
    }).rerank(envelope(rerankRequest), signal),
    unavailable,
  );
  let cancelled = false;
  let fetchSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const transport = adapter(
    async (_url, init) => {
      fetchSignal = init.signal;
      return new Response(stream, {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(
    transport.embed(envelope(embeddingRequest), signal),
    unavailable,
  );
  assert.equal(cancelled, true);
  assert.equal(fetchSignal?.aborted, true);
  let reads = 0;
  const aborted = new AbortController();
  aborted.abort();
  const pending = new TumuerQwenHttpTransport(
    profile,
    { ...options, enabled: true },
    {
      resolveSecret() {
        reads++;
        return 'tumuer-fixture-token';
      },
      async fetch() {
        throw Error('not called');
      },
    },
  );
  await assert.rejects(
    pending.embed(envelope(embeddingRequest), aborted.signal),
    unavailable,
  );
  assert.equal(reads, 0);
});

test('Tumuer provider composes Qwen query syntax and maximum canonical document batches entirely offline', async () => {
  const documents = Array.from({ length: 128 }, (_value, index) => ({
    id: `reply:${index}`,
    text: '😀'.repeat(2500),
  }));
  const transport = adapter(async (url, init) => {
    const request = JSON.parse(init.body as string) as {
      input?: string[];
      documents?: string[];
      query?: string;
    };
    assert.equal(new URL(url).origin, TUMUER_QWEN_ORIGIN);
    if (request.input) {
      if (request.input.length === 1)
        assert.deepEqual(request.input, [
          `Instruct: ${profile.queryInstruction}\nQuery: ${'鲸'.repeat(200)}`,
        ]);
      else
        assert.deepEqual(
          request.input,
          documents.map(({ text }) => text),
        );
      return json(embeddingResponse(request.input.length));
    }
    assert.equal(request.query, '鲸'.repeat(200));
    assert.deepEqual(
      request.documents,
      documents.map(({ text }) => text),
    );
    return json({
      results: documents.map((_document, index) => ({
        index,
        relevance_score: index,
      })),
    });
  });
  const provider = new QwenSemanticProvider(profile, transport);
  assert.equal(
    (await provider.embedQuery('鲸'.repeat(200))).vector.length,
    4096,
  );
  assert.equal((await provider.embedDocuments(documents)).length, 128);
  assert.equal(
    (await provider.rerank('鲸'.repeat(200), documents)).length,
    128,
  );
});
