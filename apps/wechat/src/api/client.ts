import type { AuthService } from '../auth/auth-service';
import { cancellable } from '../platform/cancellable';
import { SessionStore } from '../auth/session';
import type {
  Cancellation,
  Json,
  Method,
  Transport,
} from '../platform/contracts';
import { ClientError, clientError } from './errors';
import { decodeResponse, responseError, type Decoder } from './envelopes';
import { endpointUrl, normalizeOrigin } from './origin';

export interface Endpoint<T> {
  readonly path: string;
  readonly method: Method;
  readonly authentication: 'required' | 'optional' | 'none';
  /** Opt in only after verifying auth rejection precedes side effects (or server idempotency). */
  readonly authReplay: 'once' | 'never';
  readonly decode: Decoder<T>;
  readonly successStatus?: number;
}
export interface RequestOptions {
  readonly body?: Json;
  readonly cancellation?: Cancellation;
  readonly query?: Readonly<Record<string, string | number>>;
}

export class ApiClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly transport: Transport,
    private readonly sessions: SessionStore,
    private readonly auth: Pick<AuthService, 'refresh'>,
    private readonly timeoutMs = 15_000,
  ) {
    this.origin = normalizeOrigin(origin);
  }

  async request<T>(
    endpoint: Endpoint<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const owner = this.sessions.snapshot();
    if (endpoint.authentication === 'required' && !owner.credentials)
      throw new ClientError('auth-required', 'Login is required');
    const url = endpointUrl(this.origin, endpoint.path, options.query);
    // Snapshot input before awaiting. Replays must not silently send mutated caller state.
    let body: Json | undefined;
    try {
      body =
        options.body === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(options.body)) as Json);
    } catch {
      throw new ClientError(
        'configuration',
        'The request body is not valid JSON',
      );
    }
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      this.sessions.assertCurrent(owner);
      if (options.cancellation?.isCancelled)
        throw new ClientError('cancelled', 'The request was cancelled');
      const sent = this.sessions.snapshot();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (endpoint.authentication !== 'none' && sent.credentials)
        headers.Authorization = `Bearer ${sent.credentials.accessToken}`;
      const response = await Promise.resolve()
        .then(() => {
          this.sessions.assertCurrent(owner);
          if (options.cancellation?.isCancelled)
            throw new ClientError('cancelled', 'The request was cancelled');
          return this.transport.send({
            url,
            method: endpoint.method,
            headers,
            timeoutMs: this.timeoutMs,
            ...(body === undefined ? {} : { body }),
            ...(options.cancellation
              ? { cancellation: options.cancellation }
              : {}),
          });
        })
        .catch((error) => {
          this.sessions.assertCurrent(owner);
          throw clientError(error);
        });
      this.sessions.assertCurrent(owner);
      if (options.cancellation?.isCancelled)
        throw new ClientError('cancelled', 'The request was cancelled');
      const failure = responseError(response);
      if (
        failure?.kind === 'auth-expired' &&
        attempt === 0 &&
        endpoint.authReplay === 'once' &&
        endpoint.authentication !== 'none' &&
        sent.credentials
      ) {
        await cancellable(this.auth.refresh(sent), options.cancellation);
        continue;
      }
      if (
        !failure &&
        endpoint.successStatus !== undefined &&
        response.status !== endpoint.successStatus
      )
        throw new ClientError('protocol', 'Unexpected endpoint success status');
      return decodeResponse(response, endpoint.decode);
    }
    throw new ClientError('auth-required', 'Login is required');
  }
}
