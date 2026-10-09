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

export const TUMUER_QWEN_ORIGIN = 'https://router.tumuer.me';
export type TumuerQwenHttpOptions = Omit<QwenHttpOptions, 'origin'> & {
  origin: typeof TUMUER_QWEN_ORIGIN;
};

/** User-selected gateway, disabled by default and wired only by explicit configuration. Fixed
 * endpoints are /v1/embeddings and /v1/rerank; model revisions require separate
 * deployment verification. No credentials or inference requests were used to
 * implement this adapter. Public protocol references reviewed 2026-10-09:
 * https://embedding-docs.tumuer.me/api/embeddings
 * https://embedding-docs.tumuer.me/api/rerank
 */
export class TumuerQwenHttpTransport extends ConfiguredQwenHttpTransport {
  constructor(
    profile: QwenSemanticProfile,
    options: TumuerQwenHttpOptions,
    dependencies: SemanticHttpDependencies,
  ) {
    super('tumuer', profile, options, dependencies);
  }
}
