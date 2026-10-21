import type { ApiClient } from '../api/client';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { MediaLocalFiles } from '../media/local-files';
import type { Clock, Storage } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { ProfileCoverDownload } from './cover-download';
import { HttpCoverGateway } from './cover-gateway';
import { CoverPrincipalOwner } from './cover-principal';
import {
  createProfileCoverReaders,
  type ProfileCoverReaders,
} from './cover-reader-runtime';

export interface NativeProfileCoverOptions {
  api: ApiClient;
  auth: Pick<AuthService, 'refresh'>;
  sessions: SessionStore;
  storage: Storage;
  origin: string;
  wx: WxMediaApi & WxUploadApi;
  files: UploadFiles;
  registry: MediaLocalFiles;
  clock: Clock;
  newRequestId: () => Promise<string>;
  privateViews?: PrivateViewLifecycle;
}
export interface NativeProfileCoverRuntime extends ProfileCoverReaders {
  readonly editorContext: Readonly<
    NativeProfileCoverOptions & {
      principals: CoverPrincipalOwner;
      gateway: HttpCoverGateway;
    }
  >;
}
/** Only shared reading/lifecycle lives in main. The deep editor factory receives
 * these same native dependencies without loading its implementation at launch. */
export function createNativeProfileCoverRuntime(
  options: NativeProfileCoverOptions,
): NativeProfileCoverRuntime {
  const principals = new CoverPrincipalOwner(options.sessions);
  const gateway = new HttpCoverGateway(options.api);
  const readers = createProfileCoverReaders({
    ...options,
    principals,
    gateway,
    download: new ProfileCoverDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    ),
  });
  return {
    ...readers,
    editorContext: Object.freeze({ ...options, principals, gateway }),
  };
}
