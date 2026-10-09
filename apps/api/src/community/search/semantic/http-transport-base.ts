import { z } from 'zod';
import { ApplicationError } from '../../../http/application-error.js';
import { searchTextSchema } from '../contracts.js';
import { textSchema } from '../../text.js';
import { requireQwenSemanticProfile } from './profile.js';
import type { QwenSemanticProfile } from './profile.js';
import {
  SEMANTIC_MAX_BATCH,
  SEMANTIC_MAX_BODY_CODEPOINTS,
  SEMANTIC_MAX_TIMEOUT_MS,
} from './provider.js';
import type {
  QwenEmbeddingRequest,
  QwenRerankRequest,
  QwenSemanticTransport,
  SemanticTransportEnvelope,
  SemanticTransportReply,
} from './provider.js';

// Internal transport mechanics for two separately reviewed protocols. Each
// concrete adapter selects a fixed provider/origin pair; arbitrary endpoints
// cannot be supplied through settings and credentials never cross providers.
const protocolOrigins = Object.freeze({
  siliconflow: 'https://api.siliconflow.cn',
  tumuer: 'https://router.tumuer.me',
});
type QwenHttpProtocol = keyof typeof protocolOrigins;
export const SEMANTIC_HTTP_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const settingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  origin: z.enum(['https://api.siliconflow.cn', 'https://router.tumuer.me']),
  secretEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  timeoutMs: z.number().int().min(1).max(SEMANTIC_MAX_TIMEOUT_MS).default(2000),
  maxResponseBytes: z
    .number()
    .int()
    .min(1)
    .max(SEMANTIC_HTTP_MAX_RESPONSE_BYTES)
    .default(16 * 1024 * 1024),
});
export type QwenHttpOptions = z.input<typeof settingsSchema>;
export type SemanticHttpFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export interface SemanticHttpDependencies {
  readonly fetch: SemanticHttpFetch;
  /** Resolve only this configured environment name. The adapter never reads
   * process.env itself, persists a token, or resolves one while disabled. */
  readonly resolveSecret: (
    environmentVariable: string,
  ) => string | undefined | Promise<string | undefined>;
}
const bodySchema = textSchema(SEMANTIC_MAX_BODY_CODEPOINTS);
const canonicalBodySchema = z.string().refine((value) => {
  const parsed = bodySchema.safeParse(value);
  return parsed.success && parsed.data === value && value.trim().length > 0;
});
const canonicalQuerySchema = z.string().refine((value) => {
  const parsed = searchTextSchema.safeParse(value);
  return parsed.success && parsed.data === value;
});
const embeddingRequestSchema = z.strictObject({
  model: z.string(),
  dimensions: z.literal(4096),
  encoding_format: z.literal('float'),
  input: z.array(canonicalBodySchema).min(1).max(SEMANTIC_MAX_BATCH),
});
const rerankRequestSchema = z.strictObject({
  model: z.string(),
  query: canonicalQuerySchema,
  documents: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        text: canonicalBodySchema,
      }),
    )
    .min(1)
    .max(SEMANTIC_MAX_BATCH),
});
const embeddingResponseSchema = z.object({
  model: z.string(),
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z
          .array(z.number().finite())
          .length(4096)
          .refine((value) => value.some((component) => component !== 0)),
      }),
    )
    .min(1)
    .max(SEMANTIC_MAX_BATCH),
});
const rerankResponseSchema = z.object({
  model: z.string().optional(),
  results: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        relevance_score: z.number().finite(),
      }),
    )
    .min(1)
    .max(SEMANTIC_MAX_BATCH),
});
function unavailable(): ApplicationError {
  return new ApplicationError('COMMUNITY_UNAVAILABLE');
}
function completeIndices(indices: readonly number[], count: number): void {
  if (
    indices.length !== count ||
    new Set(indices).size !== count ||
    indices.some((index) => index >= count)
  )
    throw unavailable();
}

/** Unregistered and disabled by default. This implementation can issue HTTP only
 * when separately enabled and supplied an explicit fetch port and lazy secret
 * resolver. No global fetch, environment lookup, login or application activation
 * happens here. Source authorization and consent remain the caller's job.
 *
 * These protocols expose model aliases, not verifiable immutable model revisions;
 * operators must pin/attest the deployment profile separately before activation.
 * The local identity wrapper records that configuration, not remote attestation.
 */
export class ConfiguredQwenHttpTransport implements QwenSemanticTransport {
  private readonly profile: QwenSemanticProfile;
  private readonly settings: Readonly<z.output<typeof settingsSchema>>;
  private readonly fetch: SemanticHttpFetch;
  private readonly resolveSecret: SemanticHttpDependencies['resolveSecret'];

  protected constructor(
    protocol: QwenHttpProtocol,
    profile: QwenSemanticProfile,
    options: QwenHttpOptions,
    dependencies: SemanticHttpDependencies,
  ) {
    try {
      this.profile = requireQwenSemanticProfile(profile);
      const parsed = settingsSchema.safeParse(options);
      if (
        !parsed.success ||
        profile.providerId !== protocol ||
        parsed.data.origin !== protocolOrigins[protocol] ||
        typeof dependencies?.fetch !== 'function' ||
        typeof dependencies.resolveSecret !== 'function'
      )
        throw unavailable();
      // Exact provider-bound origin rejects username/password, alternate ports, paths,
      // query/fragment, lookalike hosts and URL parser normalization tricks.
      this.settings = Object.freeze(parsed.data);
      this.fetch = dependencies.fetch;
      this.resolveSecret = dependencies.resolveSecret;
      Object.freeze(this);
    } catch {
      throw unavailable();
    }
  }

  private validateEnvelope(envelope: SemanticTransportEnvelope<unknown>): void {
    if (
      !this.settings.enabled ||
      envelope.profileIdentity !== this.profile.profileIdentity ||
      envelope.indexSpaceKey !== this.profile.indexSpaceKey
    )
      throw unavailable();
  }

  private wrap(response: unknown): SemanticTransportReply {
    return Object.freeze({
      profileIdentity: this.profile.profileIdentity,
      indexSpaceKey: this.profile.indexSpaceKey,
      response,
    });
  }

  private async boundedJson(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    const contentType = response.headers.get('content-type');
    const declaredLength = response.headers.get('content-length');
    if (
      !contentType ||
      !/^application\/json(?:\s*;.*)?$/i.test(contentType) ||
      (declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) > this.settings.maxResponseBytes))
    ) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    if (!response.body) throw unavailable();
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw unavailable();
        const chunk = await reader.read();
        if (signal.aborted) throw unavailable();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.settings.maxResponseBytes) throw unavailable();
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, size);
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }

  private async post(
    path: '/v1/embeddings' | '/v1/rerank',
    body: unknown,
    parentSignal: AbortSignal,
  ): Promise<unknown> {
    if (!this.settings.enabled || parentSignal.aborted) throw unavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(unavailable());
          controller.abort();
        };
        parentSignal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, this.settings.timeoutMs);
      });
      const operation = async () => {
        if (controller.signal.aborted || parentSignal.aborted)
          throw unavailable();
        const token = await this.resolveSecret(
          this.settings.secretEnvironmentVariable,
        );
        if (
          controller.signal.aborted ||
          parentSignal.aborted ||
          typeof token !== 'string' ||
          token.length < 1 ||
          token.length > 4096 ||
          !/^[A-Za-z0-9._~+/=-]+$/.test(token)
        )
          throw unavailable();
        const url = `${this.settings.origin}${path}`;
        const response = await this.fetch(url, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          parentSignal.aborted ||
          response.status !== 200 ||
          response.redirected ||
          response.type === 'opaqueredirect' ||
          (response.url !== '' && response.url !== url)
        ) {
          void response.body?.cancel().catch(() => {});
          throw unavailable();
        }
        return this.boundedJson(response, controller.signal);
      };
      const response = await Promise.race([cancelled, operation()]);
      if (controller.signal.aborted || parentSignal.aborted)
        throw unavailable();
      return response;
    } catch {
      controller.abort();
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) parentSignal.removeEventListener('abort', abort);
    }
  }

  async embed(
    envelope: SemanticTransportEnvelope<QwenEmbeddingRequest>,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      this.validateEnvelope(envelope);
      const parsed = embeddingRequestSchema.safeParse(envelope.request);
      if (!parsed.success || parsed.data.model !== this.profile.embeddingModel)
        throw unavailable();
      const response = embeddingResponseSchema.safeParse(
        await this.post('/v1/embeddings', parsed.data, signal),
      );
      if (
        !response.success ||
        response.data.model !== this.profile.embeddingModel
      )
        throw unavailable();
      completeIndices(
        response.data.data.map(({ index }) => index),
        parsed.data.input.length,
      );
      // Only approved codec fields survive; provider text, usage and IDs do not.
      return this.wrap(response.data);
    } catch {
      throw unavailable();
    }
  }

  async rerank(
    envelope: SemanticTransportEnvelope<QwenRerankRequest>,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      this.validateEnvelope(envelope);
      const parsed = rerankRequestSchema.safeParse(envelope.request);
      if (
        !parsed.success ||
        parsed.data.model !== this.profile.rerankerModel ||
        new Set(parsed.data.documents.map(({ id }) => id)).size !==
          parsed.data.documents.length
      )
        throw unavailable();
      const response = rerankResponseSchema.safeParse(
        await this.post(
          '/v1/rerank',
          {
            model: parsed.data.model,
            query: parsed.data.query,
            // Array positions are the only outbound identifiers. No content UUID,
            // local profile key, user identifier, parent text or instruction is sent.
            documents: parsed.data.documents.map(({ text }) => text),
            top_n: parsed.data.documents.length,
            return_documents: false,
          },
          signal,
        ),
      );
      if (
        !response.success ||
        (response.data.model !== undefined &&
          response.data.model !== this.profile.rerankerModel)
      )
        throw unavailable();
      completeIndices(
        response.data.results.map(({ index }) => index),
        parsed.data.documents.length,
      );
      // This protocol does not require a returned model. Bind the configured
      // deployment and request model; never claim the alias proves a revision.
      return this.wrap({
        model: this.profile.rerankerModel,
        results: response.data.results.map(({ index, relevance_score }) => ({
          index,
          id: parsed.data.documents[index]!.id,
          score: relevance_score,
        })),
      });
    } catch {
      throw unavailable();
    }
  }
}
