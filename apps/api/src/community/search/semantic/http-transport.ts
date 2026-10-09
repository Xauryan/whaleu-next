import { ConfiguredQwenHttpTransport } from './http-transport-base.js';
import type {
  QwenHttpOptions,
  SemanticHttpDependencies,
} from './http-transport-base.js';
import type { QwenSemanticProfile } from './profile.js';

export { SEMANTIC_HTTP_MAX_RESPONSE_BYTES } from './http-transport-base.js';
export type {
  SemanticHttpDependencies,
  SemanticHttpFetch,
} from './http-transport-base.js';

export const SILICONFLOW_QWEN_ORIGIN = 'https://api.siliconflow.cn';
export type SiliconFlowQwenHttpOptions = Omit<QwenHttpOptions, 'origin'> & {
  origin: typeof SILICONFLOW_QWEN_ORIGIN;
};

/** Separate nondefault protocol, never a fallback destination for Tumuer keys.
 * References reviewed 2026-10-09; no live-provider acceptance is claimed:
 * https://api-docs.siliconflow.cn/docs/api/embeddings-post
 * https://docs.siliconflow.cn/docs/api/rerank-post
 */
export class SiliconFlowQwenHttpTransport extends ConfiguredQwenHttpTransport {
  constructor(
    profile: QwenSemanticProfile,
    options: SiliconFlowQwenHttpOptions,
    dependencies: SemanticHttpDependencies,
  ) {
    super('siliconflow', profile, options, dependencies);
  }
}
