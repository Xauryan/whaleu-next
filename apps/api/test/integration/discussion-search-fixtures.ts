/** Canonical discussion-search fixtures and real native HTTP transport.
 * No authorization, visibility, review, identity or media provider is replaced. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
import type { EffectiveContentEnvelope } from '../../src/community/content-review/contracts.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { seedExactContent } from '../support/exact-discovery-counts.js';
import type {
  SearchActor,
  SearchHarness,
  SearchWorld,
} from './search-fixtures.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
export const {
  Cancellation,
} = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpSearchGateway,
} = require('../../../wechat/src/community/search-gateway.ts');
export const {
  searchTargetPath,
} = require('../../../wechat/src/community/search-contract.ts');
export const {
  decodeDiscussionContext,
} = require('../../../wechat/src/community/discussion-contract.ts');
const nativeOrigin = 'https://discussion-search-contract.invalid';
interface NativeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly cancellation?: {
    readonly isCancelled: boolean;
    subscribe(listener: () => void): () => void;
  };
}
class LoopbackNativeTransport {
  readonly exchanges: { path: string; status: number; authorized: boolean }[] =
    [];
  constructor(private readonly port: number) {}
  send(input: NativeRequest): Promise<unknown> {
    const url = new URL(input.url);
    assert.equal(url.origin, nativeOrigin);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    if (input.cancellation?.isCancelled)
      return Promise.reject(new ClientError('cancelled', 'Request cancelled'));
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    return new Promise((resolve, reject) => {
      const request = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: url.pathname + url.search,
          method: input.method,
          headers: {
            ...input.headers,
            ...(body === undefined
              ? {}
              : { 'content-length': Buffer.byteLength(body) }),
          },
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            unsubscribe?.();
            try {
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(response.headers))
                if (value !== undefined)
                  headers[name] = Array.isArray(value)
                    ? value.join(', ')
                    : value;
              const status = response.statusCode ?? 0;
              // Never retain credential values, input bodies or response bodies.
              this.exchanges.push({
                path: url.pathname + url.search,
                status,
                authorized: input.headers['Authorization'] !== undefined,
              });
              resolve({
                status,
                headers,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once('error', (error) => {
        unsubscribe?.();
        reject(error);
      });
      request.setTimeout(input.timeoutMs, () => request.destroy());
      const unsubscribe = input.cancellation?.subscribe(() =>
        request.destroy(),
      );
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}
export async function nativeSearch(
  h: SearchHarness,
  actor: SearchActor | null,
) {
  const server = h.http as { listening: boolean };
  if (!server.listening) await h.app.listen(0, '127.0.0.1');
  const transport = new LoopbackNativeTransport(
    Number(new URL(await h.app.getUrl()).port),
  );
  const sessions = new SessionStore();
  const auth = new AuthService(
    sessions,
    new HttpAuthGateway(nativeOrigin, transport, systemClock),
    {
      login: async () => {
        throw new Error('No synthetic external login');
      },
    },
    systemClock,
  );
  if (actor) sessions.completeLogin(sessions.beginLogin(), actor);
  const api = new ApiClient(nativeOrigin, transport, sessions, auth);
  return {
    gateway: new HttpSearchGateway(api),
    api,
    sessions,
    transport,
    cancel: new Cancellation(),
  };
}
export async function childEnvelope(
  h: SearchHarness,
  w: SearchWorld,
  postId: string,
  rootCommentId: string | null = null,
  owner = w.author,
  text = 'Synthetic child',
  authorMode: 'named' | 'anonymous' = 'named',
  targetReplyId: string | null = null,
) {
  return discussionApprovalEnvelope(
    h.app,
    h.pool,
    owner.accountId,
    postId,
    {
      clientRequestId: randomUUID(),
      text,
      imageAssetIds: [],
      authorMode,
      ...(rootCommentId ? { targetReplyId } : {}),
    },
    rootCommentId,
  );
}
export function seedChildren(
  h: SearchHarness,
  kind: 'comment' | 'reply',
  count: number,
  definition: (index: number) => EffectiveContentEnvelope,
  options: Parameters<typeof seedExactContent>[5] = {},
) {
  return seedExactContent(h.pool, h.policyId, kind, count, definition, options);
}
export const hitKeys = (body: {
  items: { kind: string; contentId: string }[];
}) => body.items.map((hit) => `${hit.kind}:${hit.contentId}`);
export const textOfSnippet = (hit: {
  snippet: { segments: { text: string }[] };
}) => hit.snippet.segments.map((segment) => segment.text).join('');
