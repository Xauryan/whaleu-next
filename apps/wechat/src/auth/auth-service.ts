import { ClientError, clientError } from '../api/errors';
import type { Clock, LoginProvider } from '../platform/contracts';
import { bounded } from '../platform/deadline';
import { SessionStore, type Credentials, type SessionTicket } from './session';

export interface AuthGateway {
  login(code: string): Promise<Credentials>;
  refresh(credentials: Readonly<Credentials>): Promise<Credentials>;
}
interface RefreshFlight {
  readonly epoch: number;
  readonly promise: Promise<SessionTicket>;
}

export class AuthService {
  private flight: RefreshFlight | undefined;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: AuthGateway,
    private readonly platformLogin: LoginProvider,
    private readonly clock: Clock,
    private readonly timeoutMs = 15_000,
  ) {}

  /** A later login explicitly supersedes earlier login attempts. No stale attempt can commit. */
  async login(): Promise<SessionTicket> {
    const epoch = this.sessions.beginLogin();
    let active = true;
    let credentials: Credentials;
    try {
      credentials = await bounded(
        async () => {
          const checkAttempt = () => {
            if (!active)
              throw new ClientError(
                'timeout',
                'This login attempt has expired',
              );
            if (this.sessions.snapshot().epoch !== epoch)
              throw new ClientError(
                'stale-session',
                'This login attempt was superseded',
              );
          };
          checkAttempt();
          const code = await this.platformLogin.login();
          checkAttempt();
          return this.gateway.login(code);
        },
        this.timeoutMs,
        this.clock,
      );
    } catch (error) {
      if (this.sessions.snapshot().epoch !== epoch)
        throw new ClientError(
          'stale-session',
          'This login attempt was superseded',
        );
      throw clientError(error);
    } finally {
      active = false;
    }
    // Commit outside the gateway catch: a storage failure intentionally changes the epoch.
    this.sessions.completeLogin(epoch, credentials);
    return this.sessions.snapshot();
  }

  refresh(ticket: SessionTicket): Promise<SessionTicket> {
    try {
      this.sessions.assertCurrent(ticket);
    } catch (error) {
      return Promise.reject(error);
    }
    const current = this.sessions.snapshot();
    if (!current.credentials)
      return Promise.reject(
        new ClientError('auth-required', 'Login is required'),
      );
    // Another request has already rotated this login. Reuse it rather than rotating a second time.
    if (ticket.revision !== current.revision) return Promise.resolve(current);
    if (this.flight?.epoch === ticket.epoch) return this.flight.promise;
    const credentials = current.credentials;
    const promise = bounded(
      () => this.gateway.refresh(credentials),
      this.timeoutMs,
      this.clock,
    )
      .catch((error) => {
        this.sessions.assertCurrent(ticket);
        const failure = clientError(error);
        if (failure.kind === 'auth-required' || failure.kind === 'auth-expired')
          this.sessions.logoutIfCurrent(ticket);
        throw failure;
      })
      .then((next) => this.sessions.rotate(ticket, next))
      .finally(() => {
        if (this.flight?.promise === promise) this.flight = undefined;
      });
    this.flight = { epoch: ticket.epoch, promise };
    return promise;
  }
}
