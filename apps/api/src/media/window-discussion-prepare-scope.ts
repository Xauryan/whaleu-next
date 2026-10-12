import type { PoolClient } from 'pg';
import type { PrepareWindowDiscussionMediaInput } from './contracts-window-discussion.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedWindowDiscussionMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'ratings';
  readonly resourceKind: 'window_discussion_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'window-discussion-image';
  readonly slot: 'images';
  readonly ordinal: number;
}
export interface WindowDiscussionMediaDraftOwnerPort {
  /** Current window-discussion role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareWindowDiscussionMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedWindowDiscussionMediaEdit>;
}
export class MediaWindowDiscussionPrepareScopes extends MediaPrepareScopes {
  constructor(owner: WindowDiscussionMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      owner,
    );
  }
}
