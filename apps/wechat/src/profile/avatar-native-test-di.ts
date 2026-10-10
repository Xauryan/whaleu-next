import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { AvatarPrincipalOwner } from './avatar-principal';
import { ProfileAvatarDownload } from './avatar-download';
import { ProfileAvatarUpload } from './avatar-upload';
/** The caller MUST pass the same registry used by Community native adapters.
 * This composition cannot multiply the 2 I/O / 4 lease / 10 MiB budget. */
export function createAvatarNativeTestAdapters(options: {
  origin: string;
  wxDownload: WxMediaApi;
  wxUpload: WxUploadApi;
  files: UploadFiles;
  registry: MediaLocalFiles;
  sessions: SessionStore;
  auth: Pick<AuthService, 'refresh'>;
  clock: Clock;
}) {
  const { origin, files, registry, sessions, auth, clock } = options;
  const principals = new AvatarPrincipalOwner(sessions);
  return {
    registry,
    principals,
    upload: new ProfileAvatarUpload(
      origin,
      options.wxUpload,
      files,
      registry,
      sessions,
      clock,
      auth,
    ),
    download: new ProfileAvatarDownload(
      origin,
      options.wxDownload,
      files,
      registry,
      principals,
      auth,
      clock,
    ),
  };
}
