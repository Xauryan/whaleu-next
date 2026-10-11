import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  requireCurrentMediaSession,
  type CurrentMediaSession,
} from '../../identity/current-media-session.js';
import type { CategoryIconMediaDraftOwnerPort } from '../../media/category-icon-prepare-scope.js';
import type { CategoryIconMediaReadPort } from '../../media/category-icon-owner-proof.js';

export const RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY = Symbol(
  'RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY',
);
export const RATINGS_CATEGORY_ICON_MEDIA_RUNTIME = Symbol(
  'RATINGS_CATEGORY_ICON_MEDIA_RUNTIME',
);

/** Implemented by the original Category owner. Preparation must check the
 * complete stored request and all affected management domains. Current reads
 * must qualify the exact original release, Category path, Review and appearance.
 * Both methods enroll the owner's required facts in the supplied transaction;
 * neither an upload scope nor a historical receipt is current read authority. */
export interface CategoryIconMediaAuthority
  extends CategoryIconMediaDraftOwnerPort, CategoryIconMediaReadPort {}

export interface CategoryIconMediaCredential {
  readonly token: string;
  readonly session: CurrentMediaSession;
}

/** One DI instance shared with the Category authority. Credentials exist only
 * during authenticated work in their original transaction/read epoch. They are
 * never reconstructed from a request's actor, context or stored session ID. */
@Injectable()
export class CategoryIconMediaCredentials {
  private readonly current = new WeakMap<
    PoolClient,
    CategoryIconMediaCredential
  >();

  require(tx: PoolClient): CategoryIconMediaCredential {
    const credential = this.current.get(tx);
    if (!credential) throw new ApplicationError('MEDIA_UNAVAILABLE');
    requireCurrentMediaSession(credential.session, tx);
    return credential;
  }

  async run<T>(
    token: string,
    session: CurrentMediaSession,
    tx: PoolClient,
    work: () => Promise<T>,
  ): Promise<T> {
    requireCurrentMediaSession(session, tx);
    if (!token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const previous = this.current.get(tx);
    if (previous) {
      this.require(tx);
      if (
        previous.token !== token ||
        previous.session.accountId !== session.accountId ||
        previous.session.sessionId !== session.sessionId
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      // A nested descriptor read does not end its caller's credential lifetime.
      return work();
    }
    this.current.set(tx, Object.freeze({ token, session }));
    try {
      return await work();
    } finally {
      this.current.delete(tx);
    }
  }
}
