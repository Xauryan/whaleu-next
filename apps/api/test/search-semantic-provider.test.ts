import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ApplicationError } from '../src/http/application-error.js';
import {
  createQwenSemanticProfile,
  QWEN_EMBEDDING_DIMENSIONS,
  QWEN_EMBEDDING_MODEL,
  QWEN_QUERY_INSTRUCTION,
  QWEN_RERANKER_MODEL,
} from '../src/community/search/semantic/profile.js';
import type { QwenSemanticProfileInput } from '../src/community/search/semantic/profile.js';
import {
  normalizeSemanticVector,
  QwenSemanticProvider,
  semanticBodyDigest,
  SEMANTIC_MAX_BATCH,
  SEMANTIC_MAX_TIMEOUT_MS,
} from '../src/community/search/semantic/provider.js';
import type {
  QwenSemanticTransport,
  SemanticDocument,
  SemanticTransportReply,
} from '../src/community/search/semantic/provider.js';

const identity: QwenSemanticProfileInput = {
  providerId: 'offline-fixture-provider',
  deploymentId: 'offline-fixture-deployment',
  deploymentRevision: 'fixture-deployment-v1',
  embeddingModelRevision: 'fixture-embedding-v1',
  rerankerModelRevision: 'fixture-reranker-v1',
};
const profile = createQwenSemanticProfile(identity);
const documents = [
  { id: 'post:one', text: ' 整段原文😀\n不加父级文本 ' },
  { id: 'reply:two', text: 'Only this reply body.' },
];
function vector(first = 3, second = 4): number[] {
  const output = Array<number>(QWEN_EMBEDDING_DIMENSIONS).fill(0);
  output[0] = first;
  output[1] = second;
  return output;
}
function reply(response: unknown, bound = profile): SemanticTransportReply {
  return {
    profileIdentity: bound.profileIdentity,
    indexSpaceKey: bound.indexSpaceKey,
    response,
  };
}
function embeddingResponse(count = 1): unknown {
  return {
    model: profile.embeddingModel,
    data: Array.from({ length: count }, (_value, index) => ({
      index,
      embedding: vector(index + 3),
    })).reverse(),
  };
}
function fixtureTransport(
  overrides: Partial<QwenSemanticTransport> = {},
): QwenSemanticTransport {
  return {
    async embed({ request }) {
      return reply(embeddingResponse(request.input.length));
    },
    async rerank({ request }) {
      return reply({
        model: request.model,
        results: request.documents.map(({ id }, index) => ({
          index,
          id,
          score: index + 1,
        })),
      });
    },
    ...overrides,
  };
}
function unavailable(error: unknown): boolean {
  assert.ok(error instanceof ApplicationError);
  assert.equal(error.code, 'COMMUNITY_UNAVAILABLE');
  assert.equal(error.getStatus(), 503);
  assert.equal(error.message, 'Community is unavailable');
  assert.equal(error.cause, undefined);
  return true;
}

test('Qwen profile is immutable, explicit, full-dimensional, and deterministically keyed', () => {
  assert.equal(profile.embeddingModel, QWEN_EMBEDDING_MODEL);
  assert.equal(profile.rerankerModel, QWEN_RERANKER_MODEL);
  assert.equal(profile.dimensions, 4096);
  assert.equal(profile.queryInstruction, QWEN_QUERY_INSTRUCTION);
  assert.match(profile.indexSpaceKey, /^[a-f0-9]{64}$/);
  assert.match(profile.profileIdentity, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(profile));
  assert.throws(() => Object.assign(profile, { dimensions: 1 }));
  assert.deepEqual(createQwenSemanticProfile({ ...identity }), profile);
  assert.deepEqual(
    createQwenSemanticProfile({
      rerankerModelRevision: identity.rerankerModelRevision,
      embeddingModelRevision: identity.embeddingModelRevision,
      deploymentRevision: identity.deploymentRevision,
      deploymentId: identity.deploymentId,
      providerId: identity.providerId,
    }),
    profile,
  );
  for (const patch of [
    { providerId: 'offline-other-provider' },
    { deploymentId: 'offline-other-deployment' },
    { deploymentRevision: 'fixture-deployment-v2' },
    { embeddingModelRevision: 'fixture-embedding-v2' },
    { queryInstruction: 'Retrieve the most relevant community discussion.' },
  ]) {
    const changed = createQwenSemanticProfile({ ...identity, ...patch });
    assert.equal(changed.embeddingModel, profile.embeddingModel);
    assert.notEqual(changed.indexSpaceKey, profile.indexSpaceKey);
    assert.notEqual(changed.profileIdentity, profile.profileIdentity);
  }
  const changedReranker = createQwenSemanticProfile({
    ...identity,
    rerankerModelRevision: 'fixture-reranker-v2',
  });
  assert.equal(changedReranker.indexSpaceKey, profile.indexSpaceKey);
  assert.notEqual(changedReranker.profileIdentity, profile.profileIdentity);
});

test('profiles fail closed without exact supported settings and pinned identities', () => {
  for (const patch of [
    { providerId: undefined },
    { providerId: '' },
    { deploymentId: undefined },
    { deploymentId: 'bad deployment' },
    { deploymentRevision: undefined },
    { deploymentRevision: 'latest' },
    { embeddingModelRevision: undefined },
    { embeddingModelRevision: 'main' },
    { rerankerModelRevision: undefined },
    { rerankerModelRevision: 'unconfigured' },
    { embeddingModel: 'another-model' },
    { rerankerModel: 'another-reranker' },
    { dimensions: 1024 },
    { dimensions: '4096' },
    { queryInstruction: '' },
    { queryInstruction: 'x\nQuery: other' },
    { queryInstruction: '\ud800' },
    { queryInstruction: '😀'.repeat(1001) },
    { preprocessingVersion: 'silent-truncation-v1' },
    { normalizationVersion: 'none' },
    { apiKey: 'must-not-be-configured-here' },
  ])
    assert.throws(
      () =>
        createQwenSemanticProfile({
          ...identity,
          ...patch,
        } as QwenSemanticProfileInput),
      unavailable,
    );
  assert.throws(
    () => createQwenSemanticProfile({} as QwenSemanticProfileInput),
    unavailable,
  );
  assert.throws(
    () => new QwenSemanticProvider({ ...profile }, fixtureTransport()),
    unavailable,
  );
  assert.throws(
    () =>
      new QwenSemanticProvider(
        profile,
        undefined as unknown as QwenSemanticTransport,
      ),
    unavailable,
  );
  for (const timeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    SEMANTIC_MAX_TIMEOUT_MS + 1,
  ])
    assert.throws(
      () =>
        new QwenSemanticProvider(profile, fixtureTransport(), { timeoutMs }),
      unavailable,
    );
});

test('query codec uses Qwen instruction syntax and whole documents stay raw with exact digest', async () => {
  const observed: string[][] = [];
  const provider = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async embed(envelope, signal) {
        assert.equal(envelope.profileIdentity, profile.profileIdentity);
        assert.equal(envelope.indexSpaceKey, profile.indexSpaceKey);
        assert.equal(envelope.request.model, QWEN_EMBEDDING_MODEL);
        assert.equal(envelope.request.dimensions, 4096);
        assert.equal(envelope.request.encoding_format, 'float');
        assert.ok(Object.isFrozen(envelope));
        assert.ok(Object.isFrozen(envelope.request));
        assert.ok(Object.isFrozen(envelope.request.input));
        assert.equal(signal.aborted, false);
        observed.push([...envelope.request.input]);
        return reply(embeddingResponse(envelope.request.input.length));
      },
    }),
  );
  const queryResult = await provider.embedQuery(' \t 海鲸\r\n校园 😀 \n');
  assert.deepEqual(observed[0], [
    `Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery: 海鲸\n校园 😀`,
  ]);
  assert.equal(queryResult.indexSpaceKey, profile.indexSpaceKey);
  assert.equal(queryResult.vector.length, 4096);
  assert.equal(queryResult.vector[0], 0.6);
  assert.equal(queryResult.vector[1], 0.8);
  assert.ok(Object.isFrozen(queryResult));
  assert.ok(Object.isFrozen(queryResult.vector));
  const embedded = await provider.embedDocuments(documents);
  assert.deepEqual(
    observed[1],
    documents.map(({ text }) => text),
  );
  assert.deepEqual(
    embedded.map(({ id }) => id),
    documents.map(({ id }) => id),
  );
  assert.equal(embedded[0]!.vector[0], 0.6);
  assert.ok(Math.abs(embedded[1]!.vector[0]! - Math.SQRT1_2) < 1e-15);
  for (const [index, result] of embedded.entries()) {
    assert.equal(
      result.bodyDigest,
      createHash('sha256').update(documents[index]!.text).digest('hex'),
    );
    assert.equal(result.bodyDigest, semanticBodyDigest(documents[index]!.text));
    assert.ok(Object.isFrozen(result));
    assert.equal('text' in result, false);
  }
  assert.ok(Object.isFrozen(embedded));
  assert.notEqual(semanticBodyDigest('body '), semanticBodyDigest('body'));
  assert.notEqual(semanticBodyDigest('é'), semanticBodyDigest('e\u0301'));
});

test('text and batch bounds fail before transport without truncation or parent concatenation', async () => {
  let calls = 0;
  const provider = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async embed() {
        calls++;
        throw Error('should not invoke');
      },
      async rerank() {
        calls++;
        throw Error('should not invoke');
      },
    }),
  );
  for (const query of [
    '',
    ' \n',
    '😀'.repeat(201),
    '\ud800',
    '\u0000q',
    'q\u007f',
  ]) {
    await assert.rejects(provider.embedQuery(query), unavailable);
    await assert.rejects(provider.rerank(query, documents), unavailable);
  }
  const invalidDocuments: unknown[] = [
    [],
    [{ id: 'post:one', text: '' }],
    [{ id: 'post:one', text: ' \t\n' }],
    [{ id: 'post:one', text: '😀'.repeat(2501) }],
    [{ id: 'post:one', text: 'not\r\ncanonical' }],
    [{ id: 'post:one', text: '\udfff' }],
    [{ id: 'post:one', text: 'hidden\u0000body' }],
    [{ id: '', text: 'body' }],
    [{ id: 'bad id', text: 'body' }],
    [
      { id: 'post:one', text: 'body' },
      { id: 'post:one', text: 'other' },
    ],
    Array.from({ length: 129 }, (_value, index) => ({
      id: `post:${index}`,
      text: 'body',
    })),
    null,
    Array(1),
  ];
  for (const invalid of invalidDocuments) {
    await assert.rejects(
      provider.embedDocuments(invalid as SemanticDocument[]),
      unavailable,
    );
    await assert.rejects(
      provider.rerank('query', invalid as SemanticDocument[]),
      unavailable,
    );
  }
  assert.equal(calls, 0);
  assert.throws(() => semanticBodyDigest('not\r\ncanonical'), unavailable);
});

test('boundary-sized Unicode query, body and 128-document batch are accepted intact', async () => {
  const provider = new QwenSemanticProvider(profile, fixtureTransport());
  const query = '😀'.repeat(200);
  await provider.embedQuery(query);
  const bodies = Array.from(
    { length: SEMANTIC_MAX_BATCH },
    (_value, index) => ({
      id: `reply:${index}`,
      text: '😀'.repeat(2500),
    }),
  );
  const embedded = await provider.embedDocuments(bodies);
  const reranked = await provider.rerank(query, bodies);
  assert.equal(embedded.length, 128);
  assert.equal(reranked.length, 128);
  assert.equal(
    embedded[127]!.bodyDigest,
    semanticBodyDigest(bodies[127]!.text),
  );
});

test('embedding response validates model, complete unique indices, dimensions and finite nonzero vectors', async () => {
  const validEntry = { index: 0, embedding: vector() };
  const malformed: unknown[] = [
    null,
    'provider failure detail',
    {},
    { model: 'other-model', data: [validEntry] },
    { data: [validEntry] },
    { model: QWEN_EMBEDDING_MODEL, data: [] },
    { model: QWEN_EMBEDDING_MODEL, data: [validEntry, validEntry] },
    ...[-1, 1, 0.1, '0', NaN, Infinity].map((index) => ({
      model: QWEN_EMBEDDING_MODEL,
      data: [{ ...validEntry, index }],
    })),
    ...[
      [],
      vector().slice(1),
      [...vector(), 0],
      Array<number>(4096).fill(0),
      new Float32Array(4096),
      vector(NaN),
      vector(Infinity),
      vector(-Infinity),
      [null, ...vector().slice(1)],
      ['3', ...vector().slice(1)],
      { 0: 3, length: 4096 },
    ].map((embedding) => ({
      model: QWEN_EMBEDDING_MODEL,
      data: [{ index: 0, embedding }],
    })),
  ];
  for (const response of malformed) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async embed() {
          return reply(response);
        },
      }),
    );
    await assert.rejects(provider.embedQuery('query'), unavailable);
  }
  for (const indices of [
    [0, 0],
    [0, 2],
    [1, 1],
  ]) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async embed() {
          return reply({
            model: QWEN_EMBEDDING_MODEL,
            data: indices.map((index) => ({ index, embedding: vector() })),
          });
        },
      }),
    );
    await assert.rejects(provider.embedDocuments(documents), unavailable);
  }
});

test('normalization remains finite for huge and subnormal values without altering input', async () => {
  for (const magnitude of [Number.MAX_VALUE, Number.MIN_VALUE, 1e-300, 1e300]) {
    const input = vector(magnitude, -magnitude);
    const snapshot = [...input];
    const normalized = normalizeSemanticVector(input, 4096);
    assert.deepEqual(input, snapshot);
    assert.ok(normalized.every(Number.isFinite));
    assert.ok(Math.abs(normalized[0]! - Math.SQRT1_2) < 1e-15);
    assert.ok(Math.abs(normalized[1]! + Math.SQRT1_2) < 1e-15);
    assert.ok(
      Math.abs(normalized.reduce((sum, value) => sum + value * value, 0) - 1) <
        1e-15,
    );
  }
  assert.deepEqual(normalizeSemanticVector([Number.MIN_VALUE], 1), [1]);
  for (const dimensions of [0, 4097, 1.5, NaN])
    assert.throws(() => normalizeSemanticVector([], dimensions), unavailable);
  const provider = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async embed() {
        return reply({
          model: QWEN_EMBEDDING_MODEL,
          data: [
            { index: 0, embedding: vector(Number.MAX_VALUE, Number.MAX_VALUE) },
          ],
        });
      },
    }),
  );
  assert.ok((await provider.embedQuery('q')).vector.every(Number.isFinite));
});

test('transport binding rejects another profile, another space or an unwrapped hosted payload', async () => {
  const changed = createQwenSemanticProfile({
    ...identity,
    deploymentRevision: 'fixture-deployment-v2',
  });
  const rerankerChanged = createQwenSemanticProfile({
    ...identity,
    rerankerModelRevision: 'fixture-reranker-v2',
  });
  const rerankResponse = {
    model: QWEN_RERANKER_MODEL,
    results: [{ index: 0, id: documents[0]!.id, score: 7 }],
  };
  for (const bound of [changed, rerankerChanged]) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async embed() {
          return reply(embeddingResponse(), bound);
        },
        async rerank() {
          return reply(rerankResponse, bound);
        },
      }),
    );
    await assert.rejects(provider.embedQuery('query'), unavailable);
    await assert.rejects(
      provider.rerank('query', [documents[0]!]),
      unavailable,
    );
  }
  for (const patch of [
    { profileIdentity: 'foreign-profile' },
    { indexSpaceKey: 'foreign-space' },
  ]) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async embed() {
          return { ...reply(embeddingResponse()), ...patch };
        },
      }),
    );
    await assert.rejects(provider.embedQuery('query'), unavailable);
  }
  const unwrapped = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async embed() {
        return embeddingResponse();
      },
    }),
  );
  await assert.rejects(unwrapped.embedQuery('query'), unavailable);
});

test('rerank accepts finite logits, reorders complete results, ignores returned text and snapshots fresh input', async () => {
  const input = documents.map((document) => ({ ...document }));
  const provider = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async rerank(envelope) {
        assert.equal(envelope.profileIdentity, profile.profileIdentity);
        assert.equal(envelope.request.model, QWEN_RERANKER_MODEL);
        assert.equal(envelope.request.query, 'fresh\nquery');
        assert.deepEqual(envelope.request.documents, documents);
        assert.ok(Object.isFrozen(envelope.request.documents));
        assert.ok(Object.isFrozen(envelope.request.documents[0]));
        input[0]!.text = 'changed after call';
        return reply({
          model: QWEN_RERANKER_MODEL,
          results: [
            {
              index: 1,
              id: 'reply:two',
              score: 37.5,
              text: 'forged secret text',
              document: { text: 'forged parent' },
            },
            { index: 0, id: 'post:one', score: -10, text: 'forged original' },
          ],
        });
      },
    }),
  );
  const results = await provider.rerank(' fresh\r\nquery ', input);
  assert.deepEqual(results, [
    { id: 'reply:two', score: 37.5, indexSpaceKey: profile.indexSpaceKey },
    { id: 'post:one', score: -10, indexSpaceKey: profile.indexSpaceKey },
  ]);
  assert.ok(Object.isFrozen(results));
  assert.ok(results.every(Object.isFrozen));
  assert.equal(JSON.stringify(results).includes('forged'), false);
});

test('rerank ties use original index and extreme logits sort without subtraction overflow', async () => {
  for (const scores of [
    [5, 5],
    [Number.MAX_VALUE, -Number.MAX_VALUE],
  ]) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async rerank() {
          return reply({
            model: QWEN_RERANKER_MODEL,
            results: [
              { index: 1, id: 'reply:two', score: scores[1] },
              { index: 0, id: 'post:one', score: scores[0] },
            ],
          });
        },
      }),
    );
    assert.deepEqual(
      (await provider.rerank('query', documents)).map(({ id }) => id),
      ['post:one', 'reply:two'],
    );
  }
});

test('rerank rejects incomplete, duplicate, foreign, mislabeled and non-finite results', async () => {
  const one = { index: 0, id: 'post:one', score: 3 };
  const two = { index: 1, id: 'reply:two', score: 5 };
  const invalidResults = [
    [],
    [one],
    [one, one],
    [one, two, two],
    [one, { ...two, index: 0 }],
    [one, { ...two, index: 2 }],
    [one, { ...two, index: -1 }],
    [one, { ...two, index: 0.5 }],
    [one, { ...two, id: 'foreign' }],
    [one, { ...two, id: one.id }],
    [one, { ...two, score: Infinity }],
    [one, { ...two, score: NaN }],
    [one, { ...two, score: '0.9' }],
    [one, { index: 1, score: 1 }],
    [one, { index: 1, id: two.id }],
  ];
  for (const results of invalidResults) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async rerank() {
          return reply({ model: QWEN_RERANKER_MODEL, results });
        },
      }),
    );
    await assert.rejects(provider.rerank('query', documents), unavailable);
  }
  for (const response of [
    null,
    {},
    { model: QWEN_EMBEDDING_MODEL, results: [one, two] },
  ]) {
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        async rerank() {
          return reply(response);
        },
      }),
    );
    await assert.rejects(provider.rerank('query', documents), unavailable);
  }
});

test('provider failures are sanitized with no retry for embeddings and reranking', async () => {
  for (const method of ['embedQuery', 'rerank'] as const) {
    let calls = 0;
    const fail = () => {
      calls++;
      throw Error('https://secret-provider.invalid?api_key=private raw-body');
    };
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({ embed: fail, rerank: fail }),
    );
    await assert.rejects(
      method === 'embedQuery'
        ? provider.embedQuery('query')
        : provider.rerank('query', documents),
      unavailable,
    );
    assert.equal(calls, 1);
  }
});

test('timeout aborts transport and returns bounded unavailable even if transport never settles', async () => {
  for (const method of ['embedQuery', 'rerank'] as const) {
    let calls = 0;
    let seenSignal: AbortSignal | undefined;
    const pending = (signal: AbortSignal): Promise<never> => {
      calls++;
      seenSignal = signal;
      return new Promise(() => {});
    };
    const provider = new QwenSemanticProvider(
      profile,
      fixtureTransport({
        embed: (_envelope, signal) => pending(signal),
        rerank: (_envelope, signal) => pending(signal),
      }),
      { timeoutMs: 10 },
    );
    await assert.rejects(
      method === 'embedQuery'
        ? provider.embedQuery('query')
        : provider.rerank('query', documents),
      unavailable,
    );
    assert.equal(calls, 1);
    assert.equal(seenSignal?.aborted, true);
  }
});

test('caller abort is immediate, sanitized, forwards cancellation and prevents pre-aborted calls', async () => {
  const preAborted = new AbortController();
  preAborted.abort('private-abort-reason');
  let calls = 0;
  const immediate = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      async embed() {
        calls++;
        return reply(embeddingResponse());
      },
    }),
  );
  await assert.rejects(
    immediate.embedQuery('q', { signal: preAborted.signal }),
    unavailable,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  const provider = new QwenSemanticProvider(
    profile,
    fixtureTransport({
      embed(_envelope, signal) {
        calls++;
        transportSignal = signal;
        controller.abort(new Error('private abort reason'));
        // Completion after cancellation must not turn this into a successful call.
        return Promise.resolve(reply(embeddingResponse()));
      },
    }),
    { timeoutMs: 1000 },
  );
  await assert.rejects(
    provider.embedQuery('query', { signal: controller.signal }),
    unavailable,
  );
  assert.equal(calls, 1);
  assert.equal(transportSignal?.aborted, true);
});
