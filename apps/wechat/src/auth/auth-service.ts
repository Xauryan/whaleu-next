import { ClientError, clientError } from '../api/errors';
import { cancellable } from '../platform/cancellable';
import {
  Cancellation,
  type Clock,
  type LoginProvider,
} from '../platform/contracts';
import { bounded } from '../platform/deadline';
import { SessionStore, type Credentials, type SessionTicket } from './session';

export interface GatewayOptions {
  readonly cancellation?: Cancellation;
  /** Recheck ownership immediately before a concrete adapter dispatches. */
  readonly beforeDispatch?: () => void;
}
export interface AuthGateway {
  login(code: string, options?: GatewayOptions): Promise<Credentials>;
  refresh(
    credentials: Readonly<Credentials>,
    options?: GatewayOptions,
  ): Promise<Credentials>;
  logout(
    credentials: Readonly<Credentials>,
    options?: GatewayOptions,
  ): Promise<void>;
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

  /** A later login explicitly supersedes earlier attempts. No stale attempt can commit. */
  async login(cancellation?: Cancellation): Promise<SessionTicket> {
    if (cancellation?.isCancelled)
      throw new ClientError('cancelled', 'The request was cancelled');
    const epoch = this.sessions.beginLogin();
    const requestCancellation = new Cancellation();
    const unsubscribe = cancellation?.subscribe(() =>
      requestCancellation.cancel(),
    );
    let active = true;
    let credentials: Credentials;
    const checkAttempt = () => {
      if (this.sessions.snapshot().epoch !== epoch)
        throw new ClientError(
          'stale-session',
          'This login attempt was superseded',
        );
      if (!active)
        throw new ClientError('timeout', 'This login attempt has expired');
      if (requestCancellation.isCancelled)
        throw new ClientError('cancelled', 'The request was cancelled');
    };
    try {
      credentials = await cancellable(
        bounded(
          async () => {
            checkAttempt();
            const code = await cancellable(
              this.platformLogin.login(),
              requestCancellation,
            );
            checkAttempt();
            return cancellable(
              this.gateway.login(code, {
                cancellation: requestCancellation,
                beforeDispatch: checkAttempt,
              }),
              requestCancellation,
            );
          },
          this.timeoutMs,
          this.clock,
        ),
        requestCancellation,
      );
      checkAttempt();
    } catch (error) {
      if (this.sessions.snapshot().epoch !== epoch)
        throw new ClientError(
          'stale-session',
          'This login attempt was superseded',
        );
      throw clientError(error);
    } finally {
      active = false;
      requestCancellation.cancel();
      unsubscribe?.();
    }
    // Storage failures deliberately change the epoch and keep their storage category.
    this.sessions.completeLogin(epoch, credentials);
    return this.sessions.snapshot();
  }

  /** Forget locally immediately, even if the server cannot confirm revocation. */
  async logout(): Promise<void> {
    const credentials = this.sessions.snapshot().credentials;
    let storageFailure: ClientError | undefined;
    try {
      this.sessions.logout();
    } catch (error) {
      storageFailure = clientError(error);
    }
    const cancellation = new Cancellation();
    try {
      if (credentials)
        await bounded(
          () => this.gateway.logout(credentials, { cancellation }),
          this.timeoutMs,
          this.clock,
        );
    } catch (error) {
      if (storageFailure) throw storageFailure;
      throw clientError(error);
    } finally {
      cancellation.cancel();
    }
    if (storageFailure) throw storageFailure;
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
    if (ticket.revision !== current.revision) return Promise.resolve(current);
    if (this.flight?.epoch === ticket.epoch) return this.flight.promise;
    const credentials = current.credentials;
    const cancellation = new Cancellation();
    const checkOwner = () => {
      this.sessions.assertCurrent(ticket);
      if (cancellation.isCancelled)
        throw new ClientError('cancelled', 'The refresh has ended');
    };
    const promise = bounded(
      () => {
        // Logout may happen synchronously after refresh() but before this microtask.
        checkOwner();
        return this.gateway.refresh(credentials, {
          cancellation,
          beforeDispatch: checkOwner,
        });
      },
      this.timeoutMs,
      this.clock,
    )
      .then((next) => this.sessions.rotate(ticket, next))
      .catch((error) => {
        // A storage failure already cleared memory. Preserve that useful recovery signal.
        const failure = clientError(error);
        if (failure.kind === 'storage') throw failure;
        this.sessions.assertCurrent(ticket);
        // A refresh token is one-use. Even a lost response must never lead to reuse.
        this.sessions.logoutIfCurrent(ticket);
        throw failure;
      })
      .finally(() => {
        cancellation.cancel();
        if (this.flight?.promise === promise) this.flight = undefined;
      });
    this.flight = { epoch: ticket.epoch, promise };
    return promise;
  }
}
