import { ApiClient, type Endpoint } from '../api/client';
import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import { SessionStore } from '../auth/session';
import type { Cancellation, Json, Transport } from '../platform/contracts';
import type {
  MediaGateway,
  MediaIntentStatus,
  MediaPrepare,
  MediaSession,
  MediaUploadPlan,
} from './contracts';
import {
  decodeMediaIntentStatus,
  decodeMediaPrepare,
  mediaUuid,
} from './decoders';

/** Unwired HTTP adapter for the frozen S0 protocol; routes and provider availability
 * must be verified separately. Owns ApiClient construction to bind both to one SessionStore. */
export class HttpMediaGateway implements MediaGateway {
  private readonly api: ApiClient;
  constructor(
    origin: string,
    transport: Transport,
    private readonly sessions: SessionStore,
    auth: Pick<AuthService, 'refresh'>,
  ) {
    this.api = new ApiClient(origin, transport, sessions, auth);
  }
  async prepare(
    input: MediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus> {
    const checked = decodeMediaPrepare(input);
    return this.call('POST', '/v1/media/upload-intents', session, cancel, {
      ...checked,
      declaration: { ...checked.declaration },
    });
  }
  async status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus> {
    return this.call('GET', this.path(intentId), session, cancel);
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus> {
    return this.call(
      'POST',
      `${this.path(intentId)}/finalize`,
      session,
      cancel,
      {},
    );
  }
  async cancel(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void> {
    this.current(session, cancel);
    await this.api.request(
      {
        path: `${this.path(intentId)}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 204,
        decode: (value) => {
          // wx represents an empty HTTP body as an empty string; no JSON object is accepted.
          if (value !== undefined && value !== null && value !== '')
            throw new ClientError(
              'protocol',
              'Expected empty media cancellation response',
            );
        },
      },
      { body: {}, cancellation: cancel },
    );
    this.current(session, cancel);
  }
  async grant(
    _intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaUploadPlan> {
    this.current(session, cancel);
    throw new ClientError('configuration', 'Media upload mode is unavailable');
  }
  private async call(
    method: 'POST' | 'GET',
    path: string,
    session: MediaSession,
    cancel: Cancellation,
    body?: Json,
  ): Promise<MediaIntentStatus> {
    this.current(session, cancel);
    const endpoint: Endpoint<MediaIntentStatus> = {
      path,
      method,
      authentication: 'required',
      // No implicit mutation replay until server routes/idempotency are implemented and verified.
      authReplay: method === 'GET' ? 'once' : 'never',
      decode: decodeMediaIntentStatus,
    };
    const result = await this.api.request(endpoint, {
      cancellation: cancel,
      ...(body === undefined ? {} : { body }),
    });
    this.current(session, cancel);
    if (
      path !== '/v1/media/upload-intents' &&
      path.split('/')[4] !== result.intentId
    )
      throw new ClientError(
        'protocol',
        'Media intent response does not match request',
      );
    return result;
  }
  private current(session: MediaSession, cancel: Cancellation): void {
    const ticket = session.current();
    this.sessions.assertCurrent(ticket);
    if (!ticket.credentials)
      throw new ClientError('auth-required', 'Sign in to use media');
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Media request cancelled');
  }
  private path(intentId: string): string {
    if (!mediaUuid(intentId))
      throw new ClientError('protocol', 'Invalid media intent');
    return `/v1/media/upload-intents/${intentId}`;
  }
}
