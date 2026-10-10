import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { SessionStore } from '../auth/session';
import type { Clock, Storage } from '../platform/contracts';
import {
  ProfileAvatarController,
  type AvatarEditView,
} from './avatar-controller';
import { unavailableAvatarGateway, type AvatarGateway } from './avatar-gateway';
import { PendingAvatarStore } from './avatar-pending';
import { AvatarPrincipalOwner } from './avatar-principal';
import {
  AvatarReadController,
  type AvatarReadTransfer,
  type AvatarReadView,
} from './avatar-read-controller';
import type { AvatarUploadTransfer } from './avatar-transfer';
export interface ProfileAvatarRuntime {
  createEditor(
    render: (view: AvatarEditView) => void,
    changed?: () => void,
  ): ProfileAvatarController;
  createReader(render: (view: AvatarReadView) => void): AvatarReadController;
  invalidate(): void;
  hide(): void;
}
/** Ordinary App passes no gateway/transfer. Synthetic catalogs and native drivers
 * are injected only by tests; no build flag, URL, environment or login enables them. */
export function createProfileAvatarRuntime(options: {
  sessions: SessionStore;
  storage: Storage;
  origin: string;
  clock: Clock;
  newRequestId: () => Promise<string>;
  principals?: AvatarPrincipalOwner;
  privateViews?: PrivateViewLifecycle;
  gateway?: AvatarGateway;
  upload?: AvatarUploadTransfer;
  download?: AvatarReadTransfer;
}): ProfileAvatarRuntime {
  const principals =
    options.principals ?? new AvatarPrincipalOwner(options.sessions);
  const pending = new PendingAvatarStore(options.storage, options.origin);
  const gateway = options.gateway ?? unavailableAvatarGateway;
  const readers = new Set<AvatarReadController>();
  const editors = new Set<ProfileAvatarController>();
  const invalidate = () => {
    for (const reader of readers) reader.clear();
  };
  options.privateViews?.subscribe(() => invalidate());
  return {
    createEditor: (render, changed) => {
      const editor = new ProfileAvatarController(
        options.sessions,
        principals,
        gateway,
        pending,
        options.upload,
        options.clock,
        options.newRequestId,
        render,
        () => {
          invalidate();
          changed?.();
        },
      );
      editors.add(editor);
      const dispose = editor.dispose.bind(editor);
      editor.dispose = () => {
        editors.delete(editor);
        dispose();
      };
      return editor;
    },
    createReader: (render) => {
      const reader = new AvatarReadController(
        principals,
        gateway,
        options.download,
        options.clock,
        render,
      );
      readers.add(reader);
      // One application-wide avatar viewing window; no per-row prefetch or queue.
      const activate = () => {
        for (const other of readers) if (other !== reader) other.clear();
      };
      const load = reader.load.bind(reader),
        open = reader.open.bind(reader),
        close = reader.close.bind(reader);
      reader.load = (profileId, expanded) => {
        activate();
        return load(profileId, expanded);
      };
      reader.open = () => {
        activate();
        return open();
      };
      reader.close = () => {
        activate();
        return close();
      };
      const dispose = reader.dispose.bind(reader);
      reader.dispose = () => {
        readers.delete(reader);
        dispose();
      };
      return reader;
    },
    invalidate,
    hide: () => {
      invalidate();
      for (const editor of editors) editor.hide();
    },
  };
}
