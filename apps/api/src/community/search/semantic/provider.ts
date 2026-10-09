import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../http/application-error.js';
import { textSchema } from '../../text.js';
import { searchTextSchema } from '../contracts.js';
import { requireQwenSemanticProfile } from './profile.js';
import type { QwenSemanticProfile } from './profile.js';

export const SEMANTIC_MAX_BATCH = 128;
export const SEMANTIC_MAX_BODY_CODEPOINTS = 2500;
export const SEMANTIC_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 2000;
const bodySchema = textSchema(SEMANTIC_MAX_BODY_CODEPOINTS).refine(
  (value) => value.trim().length > 0,
);
const documentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/),
  text: z.string(),
});

export interface SemanticDocument {
  readonly id: string;
  readonly text: string;
}
export interface SemanticEmbedding {
  readonly indexSpaceKey: string;
  readonly vector: readonly number[];
}
export interface SemanticDocumentEmbedding extends SemanticEmbedding {
  readonly id: string;
  readonly bodyDigest: string;
}
export interface SemanticRerankResult {
  readonly id: string;
  readonly indexSpaceKey: string;
  readonly score: number;
}
export interface SemanticCallOptions {
  readonly signal?: AbortSignal;
}
export interface SemanticProviderOptions {
  readonly timeoutMs?: number;
}

export interface QwenEmbeddingRequest {
  readonly model: string;
  readonly dimensions: number;
  readonly encoding_format: 'float';
  readonly input: readonly string[];
}
export interface QwenRerankRequest {
  readonly model: string;
  readonly query: string;
  readonly documents: readonly SemanticDocument[];
}
export interface SemanticTransportEnvelope<T> {
  readonly profileIdentity: string;
  readonly indexSpaceKey: string;
  readonly request: T;
}
/** Local transport reply, not a published Qwen hosted response schema. The
 * embedding response within it is OpenAI-compatible; reranking is deliberately
 * provider-neutral: {model, results:[{index, id, score}]}. An adapter must bind
 * the actual deployment to these identities, not infer it from a model alias. */
export interface SemanticTransportReply {
  readonly profileIdentity: string;
  readonly indexSpaceKey: string;
  readonly response: unknown;
}
/** Offline port only. There is no endpoint, credential, global fetch or retry.
 * An eventual separately reviewed adapter owns hosted protocol translation and
 * cancellation. Abort is still bounded here if a transport ignores its signal. */
export interface QwenSemanticTransport {
  embed(
    envelope: SemanticTransportEnvelope<QwenEmbeddingRequest>,
    signal: AbortSignal,
  ): Promise<unknown>;
  rerank(
    envelope: SemanticTransportEnvelope<QwenRerankRequest>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function unavailable(): ApplicationError {
  return new ApplicationError('COMMUNITY_UNAVAILABLE');
}

/** The digest is of the exact canonical source body, with no instruction,
 * parent text, normalization, whitespace trimming or silent truncation. */
export function semanticBodyDigest(text: string): string {
  const parsed = bodySchema.safeParse(text);
  if (!parsed.success || parsed.data !== text) throw unavailable();
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function documentsSnapshot(
  documents: readonly SemanticDocument[],
): readonly SemanticDocument[] {
  if (
    !Array.isArray(documents) ||
    documents.length < 1 ||
    documents.length > SEMANTIC_MAX_BATCH
  )
    throw unavailable();
  const ids = new Set<string>();
  return Object.freeze(
    Array.from(documents, (document: unknown) => {
      const parsed = documentSchema.safeParse(document);
      if (!parsed.success || ids.has(parsed.data.id)) throw unavailable();
      const { id, text } = parsed.data;
      semanticBodyDigest(text);
      ids.add(id);
      return Object.freeze({ id, text });
    }),
  );
}

/** Scale before summing squares: neither MAX_VALUE nor subnormal finite input
 * may overflow/underflow the norm into an all-zero or non-finite embedding. */
export function normalizeSemanticVector(
  value: unknown,
  dimensions: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 4096 ||
    !Array.isArray(value) ||
    value.length !== dimensions
  )
    throw unavailable();
  let scale = 0;
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component))
      throw unavailable();
    scale = Math.max(scale, Math.abs(component));
  }
  if (scale === 0) throw unavailable();
  const scaled = value.map((component: number) => component / scale);
  const norm = Math.sqrt(
    scaled.reduce((sum, component) => sum + component ** 2, 0),
  );
  return Object.freeze(scaled.map((component) => component / norm));
}

const replySchema = z.object({
  profileIdentity: z.string(),
  indexSpaceKey: z.string(),
  response: z.unknown(),
});
function boundResponse(profile: QwenSemanticProfile, value: unknown): unknown {
  const parsed = replySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.profileIdentity !== profile.profileIdentity ||
    parsed.data.indexSpaceKey !== profile.indexSpaceKey
  )
    throw unavailable();
  return parsed.data.response;
}
const embeddingResponseSchema = z.object({
  model: z.string(),
  data: z.array(
    z.object({ index: z.number().int().nonnegative(), embedding: z.unknown() }),
  ),
});
const rerankResponseSchema = z.object({
  model: z.string(),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      id: z.string(),
      score: z.number().finite(),
    }),
  ),
});

export class QwenSemanticProvider {
  readonly profile: QwenSemanticProfile;
  private readonly timeoutMs: number;

  constructor(
    profile: QwenSemanticProfile,
    private readonly transport: QwenSemanticTransport,
    options: SemanticProviderOptions = {},
  ) {
    this.profile = requireQwenSemanticProfile(profile);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > SEMANTIC_MAX_TIMEOUT_MS ||
      !transport ||
      typeof transport.embed !== 'function' ||
      typeof transport.rerank !== 'function'
    )
      throw unavailable();
  }

  private envelope<T>(request: T): SemanticTransportEnvelope<T> {
    return Object.freeze({
      profileIdentity: this.profile.profileIdentity,
      indexSpaceKey: this.profile.indexSpaceKey,
      request,
    });
  }

  private async invoke(
    call: (signal: AbortSignal) => Promise<unknown>,
    options: SemanticCallOptions,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      if (options.signal?.aborted) throw unavailable();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          // Reject first so even a synchronously abort-aware transport cannot
          // replace cancellation with its own success or detailed error.
          reject(unavailable());
          controller.abort();
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, this.timeoutMs);
      });
      const response = await Promise.race([
        cancelled,
        Promise.resolve().then(() => {
          if (controller.signal.aborted || options.signal?.aborted)
            throw unavailable();
          return call(controller.signal);
        }),
      ]);
      if (controller.signal.aborted || options.signal?.aborted)
        throw unavailable();
      return response;
    } catch {
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
  }

  private async embeddings(
    input: readonly string[],
    options: SemanticCallOptions,
  ): Promise<readonly SemanticEmbedding[]> {
    const request = Object.freeze({
      model: this.profile.embeddingModel,
      dimensions: this.profile.dimensions,
      encoding_format: 'float' as const,
      input: Object.freeze([...input]),
    });
    const response = boundResponse(
      this.profile,
      await this.invoke(
        (signal) => this.transport.embed(this.envelope(request), signal),
        options,
      ),
    );
    const parsed = embeddingResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.model !== this.profile.embeddingModel ||
      parsed.data.data.length !== input.length
    )
      throw unavailable();
    const indexed = new Map<number, SemanticEmbedding>();
    for (const entry of parsed.data.data) {
      if (entry.index >= input.length || indexed.has(entry.index))
        throw unavailable();
      indexed.set(
        entry.index,
        Object.freeze({
          indexSpaceKey: this.profile.indexSpaceKey,
          vector: normalizeSemanticVector(
            entry.embedding,
            this.profile.dimensions,
          ),
        }),
      );
    }
    // Exact count plus unique in-range indices proves complete coverage.
    return Object.freeze(input.map((_text, index) => indexed.get(index)!));
  }

  async embedQuery(
    query: string,
    options: SemanticCallOptions = {},
  ): Promise<SemanticEmbedding> {
    try {
      const parsed = searchTextSchema.safeParse(query);
      if (!parsed.success) throw unavailable();
      const input = `Instruct: ${this.profile.queryInstruction}\nQuery: ${parsed.data}`;
      return (await this.embeddings([input], options))[0]!;
    } catch {
      throw unavailable();
    }
  }

  async embedDocuments(
    documents: readonly SemanticDocument[],
    options: SemanticCallOptions = {},
  ): Promise<readonly SemanticDocumentEmbedding[]> {
    try {
      const snapshot = documentsSnapshot(documents);
      const embeddings = await this.embeddings(
        snapshot.map(({ text }) => text),
        options,
      );
      return Object.freeze(
        snapshot.map((document, index) =>
          Object.freeze({
            ...embeddings[index]!,
            id: document.id,
            bodyDigest: semanticBodyDigest(document.text),
          }),
        ),
      );
    } catch {
      throw unavailable();
    }
  }

  /** Caller must reauthorize and reread each exact source body immediately
   * before this call. The codec neither proves source visibility nor accepts
   * provider-returned text as a source, snippet, or cached authorization. */
  async rerank(
    query: string,
    documents: readonly SemanticDocument[],
    options: SemanticCallOptions = {},
  ): Promise<readonly SemanticRerankResult[]> {
    try {
      const parsedQuery = searchTextSchema.safeParse(query);
      if (!parsedQuery.success) throw unavailable();
      const snapshot = documentsSnapshot(documents);
      const request = Object.freeze({
        model: this.profile.rerankerModel,
        query: parsedQuery.data,
        documents: snapshot,
      });
      const response = boundResponse(
        this.profile,
        await this.invoke(
          (signal) => this.transport.rerank(this.envelope(request), signal),
          options,
        ),
      );
      const parsed = rerankResponseSchema.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.model !== this.profile.rerankerModel ||
        parsed.data.results.length !== snapshot.length
      )
        throw unavailable();
      const seen = new Set<number>();
      for (const result of parsed.data.results) {
        if (seen.has(result.index) || snapshot[result.index]?.id !== result.id)
          throw unavailable();
        seen.add(result.index);
      }
      // Scores can be uncalibrated logits. Comparing avoids subtraction
      // overflow; input index supplies deterministic ties without foreign IDs.
      const ranked = [...parsed.data.results].sort((a, b) =>
        a.score === b.score ? a.index - b.index : a.score > b.score ? -1 : 1,
      );
      return Object.freeze(
        ranked.map(({ id, score }) =>
          Object.freeze({
            id,
            indexSpaceKey: this.profile.indexSpaceKey,
            score,
          }),
        ),
      );
    } catch {
      throw unavailable();
    }
  }
}
