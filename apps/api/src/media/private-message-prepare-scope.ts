import type { PoolClient } from 'pg';
import type { PreparePrivateMessageMediaInput } from './contracts-private-message.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedPrivateMessageMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'messaging';
  readonly resourceKind: 'private_message_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'conversation-private';
  readonly purpose: 'private-message-image';
  readonly slot: 'image';
  readonly ordinal: 0;
}
export interface PrivateMessageMediaDraftOwnerPort {
  /** Current private-message role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PreparePrivateMessageMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedPrivateMessageMediaEdit>;
}
export class MediaPrivateMessagePrepareScopes extends MediaPrepareScopes {
  constructor(owner: PrivateMessageMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
