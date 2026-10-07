import { ApiClient } from '../api/client';
import { ClientError, clientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Clock } from '../platform/contracts';
import {
  WechatLogin,
  WechatStorage,
  WechatTransport,
  type WxApi,
} from '../platform/wechat';
import { AuthService } from './auth-service';
import { HttpAuthGateway } from './http-auth-gateway';
import { SessionStore } from './session';
import { decodeCredentials } from './session-contract';

export interface IdentityRuntime {
  readonly sessions: SessionStore;
  readonly auth?: AuthService;
  readonly api?: ApiClient;
  readonly startupError?: ClientError;
}
export interface IdentityConfiguration {
  readonly apiOrigin: string;
  readonly providerLoginEnabled: boolean;
}
/** Local adapters only. Startup never requests a provider code or sends a request. */
export function createIdentityRuntime(
  config: IdentityConfiguration,
  wx: WxApi,
  clock: Clock,
): IdentityRuntime {
  let origin: string;
  try {
    if (!config.providerLoginEnabled)
      throw new ClientError('configuration', 'Provider login is not enabled');
    origin = normalizeOrigin(config.apiOrigin);
  } catch (error) {
    return {
      sessions: new SessionStore(),
      startupError: clientError(error, 'configuration'),
    };
  }
  // A build pointed at a different environment must never restore another origin's credentials.
  const sessions = new SessionStore(
    new WechatStorage(wx),
    `whaleu.identity.v1:${origin}`,
    decodeCredentials,
  );
  let startupError: ClientError | undefined;
  try {
    sessions.restore();
  } catch (error) {
    startupError = clientError(error);
  }
  const transport = new WechatTransport(wx, clock);
  const auth = new AuthService(
    sessions,
    new HttpAuthGateway(origin, transport, clock),
    new WechatLogin(wx, clock),
    clock,
  );
  return {
    sessions,
    auth,
    api: new ApiClient(origin, transport, sessions, auth),
    ...(startupError ? { startupError } : {}),
  };
}
