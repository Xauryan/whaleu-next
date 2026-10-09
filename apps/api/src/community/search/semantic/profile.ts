import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../http/application-error.js';
import { textSchema } from '../../text.js';

export const QWEN_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B';
export const QWEN_RERANKER_MODEL = 'Qwen/Qwen3-Reranker-8B';
export const QWEN_EMBEDDING_DIMENSIONS = 4096;
export const QWEN_QUERY_INSTRUCTION =
  'Given a web search query, retrieve relevant passages that answer the query';
export const SEMANTIC_PREPROCESSING_VERSION = 'community-canonical-body-v1';
export const SEMANTIC_NORMALIZATION_VERSION = 'l2-scaled-v1';

const identitySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/);
const revisionSchema = identitySchema.refine(
  (value) => !['main', 'latest', 'default', 'unconfigured'].includes(value),
);
const profileInputSchema = z.strictObject({
  providerId: identitySchema,
  deploymentId: identitySchema,
  deploymentRevision: revisionSchema,
  embeddingModelRevision: revisionSchema,
  rerankerModelRevision: revisionSchema,
  embeddingModel: z.literal(QWEN_EMBEDDING_MODEL).default(QWEN_EMBEDDING_MODEL),
  dimensions: z
    .literal(QWEN_EMBEDDING_DIMENSIONS)
    .default(QWEN_EMBEDDING_DIMENSIONS),
  rerankerModel: z.literal(QWEN_RERANKER_MODEL).default(QWEN_RERANKER_MODEL),
  queryInstruction: textSchema(1000)
    .refine(
      (value) =>
        value.length > 0 && value === value.trim() && !/[\r\n]/.test(value),
    )
    .default(QWEN_QUERY_INSTRUCTION),
  preprocessingVersion: z
    .literal(SEMANTIC_PREPROCESSING_VERSION)
    .default(SEMANTIC_PREPROCESSING_VERSION),
  normalizationVersion: z
    .literal(SEMANTIC_NORMALIZATION_VERSION)
    .default(SEMANTIC_NORMALIZATION_VERSION),
});

export type QwenSemanticProfileInput = z.input<typeof profileInputSchema>;
export type QwenSemanticProfile = Readonly<
  z.output<typeof profileInputSchema> & {
    indexSpaceKey: string;
    profileIdentity: string;
  }
>;

const profiles = new WeakSet<object>();
const digest = (value: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/** No active default deployment exists. The caller must pin the actual provider,
 * deployment and model revisions; these labels are not endpoint discovery or
 * attestation of a hosted service. This foundation supports full 4096 only. */
export function createQwenSemanticProfile(
  input: QwenSemanticProfileInput,
): QwenSemanticProfile {
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const config = parsed.data;
  // An explicit ordered tuple makes the digest independent of object-key order.
  const indexSpaceKey = digest([
    'community-qwen-index-space-v1',
    config.providerId,
    config.deploymentId,
    config.deploymentRevision,
    config.embeddingModelRevision,
    config.embeddingModel,
    config.dimensions,
    config.queryInstruction,
    config.preprocessingVersion,
    config.normalizationVersion,
  ]);
  const profileIdentity = digest([
    'community-qwen-profile-v1',
    indexSpaceKey,
    config.rerankerModel,
    config.rerankerModelRevision,
  ]);
  const profile = Object.freeze({ ...config, indexSpaceKey, profileIdentity });
  profiles.add(profile);
  return profile;
}

/** Require a validated, immutable factory result, not a cast or deserialized
 * object whose digest could disagree with its preprocessing or deployment. */
export function requireQwenSemanticProfile(
  profile: QwenSemanticProfile,
): QwenSemanticProfile {
  if (!profiles.has(profile))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return profile;
}
