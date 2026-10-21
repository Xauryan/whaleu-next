import { ProfileCoverController, type CoverEditView } from './cover-controller';
import type { NativeProfileCoverRuntime } from './cover-native-runtime';
import { PendingCoverStore } from './cover-pending';
import { ProfileCoverUpload } from './cover-upload';

// One transfer/pending owner per app runtime, not per page activation. In
// particular, an outstanding native callback must keep its original I/O credit.
const owners = new WeakMap<
  NativeProfileCoverRuntime,
  { pending: PendingCoverStore; upload: ProfileCoverUpload }
>();

/** Statically imported only by the deep profile page. No runtime module loading
 * or independent media ledger is needed to defer editor-only implementation. */
export function createNativeProfileCoverEditor(
  runtime: NativeProfileCoverRuntime,
  render: (view: CoverEditView) => void,
  changed?: () => void,
): ProfileCoverController {
  const options = runtime.editorContext;
  let owner = owners.get(runtime);
  if (!owner) {
    owner = {
      pending: new PendingCoverStore(options.storage, options.origin),
      upload: new ProfileCoverUpload(
        options.origin,
        options.wx,
        options.files,
        options.registry,
        options.sessions,
        options.clock,
        options.auth,
      ),
    };
    owners.set(runtime, owner);
  }
  return runtime.registerEditor(
    new ProfileCoverController(
      options.sessions,
      options.principals,
      options.gateway,
      owner.pending,
      owner.upload,
      options.clock,
      options.newRequestId,
      render,
      () => {
        runtime.invalidate();
        changed?.();
      },
    ),
  );
}
