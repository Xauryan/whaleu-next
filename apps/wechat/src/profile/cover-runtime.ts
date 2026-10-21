import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { SessionStore } from '../auth/session';
import type { Clock, Storage } from '../platform/contracts';
import { ProfileCoverController, type CoverEditView } from './cover-controller';
import { unavailableCoverGateway, type CoverGateway } from './cover-gateway';
import { PendingCoverStore } from './cover-pending';
import { CoverPrincipalOwner } from './cover-principal';
import type { CoverReadTransfer } from './cover-read-controller';
import {
  createProfileCoverReaders,
  type ProfileCoverReaders,
} from './cover-reader-runtime';
import type { CoverUploadTransfer } from './cover-transfer';
export interface ProfileCoverRuntime extends ProfileCoverReaders {
  createEditor(
    render: (view: CoverEditView) => void,
    changed?: () => void,
  ): ProfileCoverController;
}
/** Dedicated cover authority and native adapters; backend capability independently gates uploads.
 * No avatar/media asset or publication authority is accepted here. */
export function createProfileCoverRuntime(options: {
  sessions: SessionStore;
  storage: Storage;
  origin: string;
  clock: Clock;
  newRequestId: () => Promise<string>;
  principals?: CoverPrincipalOwner;
  privateViews?: PrivateViewLifecycle;
  gateway?: CoverGateway;
  upload?: CoverUploadTransfer;
  download?: CoverReadTransfer;
}): ProfileCoverRuntime {
  const principals =
    options.principals ?? new CoverPrincipalOwner(options.sessions);
  const pending = new PendingCoverStore(options.storage, options.origin);
  const gateway = options.gateway ?? unavailableCoverGateway;
  const readers = createProfileCoverReaders({
    ...options,
    principals,
    gateway,
  });
  return {
    ...readers,
    createEditor: (render, changed) => {
      const editor = new ProfileCoverController(
        options.sessions,
        principals,
        gateway,
        pending,
        options.upload,
        options.clock,
        options.newRequestId,
        render,
        () => {
          readers.invalidate();
          changed?.();
        },
      );
      return readers.registerEditor(editor);
    },
  };
}
