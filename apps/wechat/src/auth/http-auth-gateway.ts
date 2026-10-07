import { decodeResponse, responseError, type Decoder } from '../api/envelopes';
import { ClientError, clientError } from '../api/errors';
import { endpointUrl, normalizeOrigin } from '../api/origin';
import { cancellable } from '../platform/cancellable';
import {
  Cancellation,
  type Clock,
  type Json,
  type Method,
  type Transport,
} from '../platform/contracts';
import { bounded } from '../platform/deadline';
import type { AuthGateway, GatewayOptions } from './auth-service';
import { decodeCredentials, type Credentials } from './session-contract';

/** The only boundary allowed to send a provider code or refresh token. Never retries. */
export class HttpAuthGateway implements AuthGateway {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly transport: Transport,
    private readonly clock: Clock,
    private readonly timeoutMs = 15_000,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  login(code: string, options: GatewayOptions = {}): Promise<Credentials> {
    if (
      typeof code !== 'string' ||
      code.length < 1 ||
      code.length > 256 ||
      code.trim() !== code ||
      !/^[A-Za-z0-9_-]+$/.test(code)
    )
      return Promise.reject(
        new ClientError('configuration', 'Invalid provider login code'),
      );
    return this.send(
      '/v1/auth/wechat/login',
      'POST',
      200,
      decodeCredentials,
      { code },
      undefined,
      options,
    );
  }
  refresh(
    credentials: Readonly<Credentials>,
    options: GatewayOptions = {},
  ): Promise<Credentials> {
    const checked = decodeCredentials(credentials);
    return this.send(
      '/v1/auth/refresh',
      'POST',
      200,
      decodeCredentials,
      { refreshToken: checked.refreshToken },
      undefined,
      options,
    );
  }
  logout(
    credentials: Readonly<Credentials>,
    options: GatewayOptions = {},
  ): Promise<void> {
    const checked = decodeCredentials(credentials);
    return this.send(
      '/v1/auth/logout',
      'POST',
      204,
      (value) => {
        if (value !== undefined && value !== null && value !== '')
          throw new ClientError('protocol', 'Invalid logout response');
      },
      undefined,
      checked.accessToken,
      options,
    );
  }
  private async send<T>(
    path: string,
    method: Method,
    expectedStatus: number,
    decode: Decoder<T>,
    body: Json | undefined,
    accessToken: string | undefined,
    options: GatewayOptions,
  ): Promise<T> {
    const cancellation = new Cancellation();
    const unsubscribe = options.cancellation?.subscribe(() =>
      cancellation.cancel(),
    );
    try {
      const response = await cancellable(
        bounded(
          () => {
            if (cancellation.isCancelled)
              throw new ClientError('cancelled', 'The request was cancelled');
            options.beforeDispatch?.();
            return cancellable(
              this.transport.send({
                url: endpointUrl(this.origin, path),
                method,
                headers: {
                  'content-type': 'application/json',
                  ...(accessToken
                    ? { Authorization: `Bearer ${accessToken}` }
                    : {}),
                },
                ...(body === undefined ? {} : { body }),
                timeoutMs: this.timeoutMs,
                cancellation,
              }),
              cancellation,
            );
          },
          this.timeoutMs,
          this.clock,
        ),
        cancellation,
      );
      if (cancellation.isCancelled)
        throw new ClientError('cancelled', 'The request was cancelled');
      const failure = responseError(response);
      if (failure) throw failure;
      if (response.status !== expectedStatus)
        throw new ClientError(
          'protocol',
          'Unexpected authentication response status',
        );
      return decodeResponse(response, decode);
    } catch (error) {
      throw clientError(error);
    } finally {
      // Abort on timeout or completion; late native callbacks cannot change the result.
      cancellation.cancel();
      unsubscribe?.();
    }
  }
}
