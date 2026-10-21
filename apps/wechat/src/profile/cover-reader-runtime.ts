import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Clock } from '../platform/contracts';
import type { CoverGateway } from './cover-gateway';
import type { CoverPrincipalOwner } from './cover-principal';
import {
  CoverReadController,
  type CoverReadTransfer,
  type CoverReadView,
} from './cover-read-controller';

export interface CoverEditorLifecycle {
  hide(): void;
  invalidate(): void;
  dispose(): void;
}
export interface ProfileCoverReaders {
  createReader(render: (view: CoverReadView) => void): CoverReadController;
  registerEditor<T extends CoverEditorLifecycle>(editor: T): T;
  invalidate(): void;
  hide(): void;
}

/** Main-package lifecycle owner. Editor implementations are registered by the
 * deep page, never imported here. Every reader shares one viewing window. */
export function createProfileCoverReaders(options: {
  principals: CoverPrincipalOwner;
  gateway: CoverGateway;
  clock: Clock;
  download?: CoverReadTransfer;
  privateViews?: PrivateViewLifecycle;
}): ProfileCoverReaders {
  const readers = new Set<CoverReadController>();
  const editors = new Set<CoverEditorLifecycle>();
  const invalidate = () => {
    for (const reader of readers) reader.clear();
  };
  const visitEditors = (action: (editor: CoverEditorLifecycle) => void) => {
    for (const editor of editors) {
      try {
        action(editor);
      } catch {
        // One renderer must not prevent another editor from being revoked.
      }
    }
  };
  options.privateViews?.subscribe((accountId) => {
    invalidate();
    visitEditors((editor) => {
      if (accountId === undefined) editor.hide();
      else editor.invalidate();
    });
  });
  return {
    registerEditor: (editor) => {
      if (editors.has(editor)) return editor;
      editors.add(editor);
      const dispose = editor.dispose.bind(editor);
      editor.dispose = () => {
        editors.delete(editor);
        dispose();
      };
      return editor;
    },
    createReader: (render) => {
      const reader = new CoverReadController(
        options.principals,
        options.gateway,
        options.download,
        options.clock,
        render,
      );
      readers.add(reader);
      const activate = () => {
        for (const other of readers) if (other !== reader) other.clear();
      };
      const load = reader.load.bind(reader);
      const open = reader.open.bind(reader);
      const close = reader.close.bind(reader);
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
      visitEditors((editor) => editor.hide());
    },
  };
}
