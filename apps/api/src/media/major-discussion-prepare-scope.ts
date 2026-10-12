import type { PoolClient } from 'pg';
import type { PrepareMajorDiscussionMediaInput } from './contracts-major-discussion.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedMajorDiscussionMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'majors';
  readonly resourceKind: 'major_discussion_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'major-discussion-image';
  readonly slot: 'images';
  readonly ordinal: number;
}
export interface MajorDiscussionMediaDraftOwnerPort {
  /** Current major-discussion role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareMajorDiscussionMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedMajorDiscussionMediaEdit>;
}
export class MediaMajorDiscussionPrepareScopes extends MediaPrepareScopes {
  constructor(owner: MajorDiscussionMediaDraftOwnerPort) {
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
      undefined,
      owner,
    );
  }
}
