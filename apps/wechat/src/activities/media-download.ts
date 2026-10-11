import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { exact } from '../community/contract';
import { invalidActivityMedia, activityMediaUuid } from './media-validation';
import {
  decodeActivityMediaDescriptor,
  type ActivityMediaDescriptor,
} from './media-contract';
export interface ActivityMediaReadTarget {
  readonly activityId: string;
  readonly audience: 'public' | 'management';
}
export interface ActivityMediaDownloadInput {
  readonly descriptor: ActivityMediaDescriptor;
  readonly target: ActivityMediaReadTarget;
}
export class ActivityMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class ActivityMediaDownload extends OwnerImageDownload<ActivityMediaDownloadInput> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<ActivityMediaDownloadInput>['download']
    >
  ) {
    if (args[3].current().kind !== 'session')
      throw new ClientError('auth-required', '请先登录查看活动图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: ActivityMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeActivityMediaDescriptor(raw.descriptor);
        exact(raw.target, ['activityId', 'audience']);
        if (
          activityMediaUuid(raw.target.activityId) !== descriptor.activityId ||
          (raw.target.audience !== 'public' &&
            raw.target.audience !== 'management')
        )
          invalidActivityMedia();
        return {
          descriptor,
          target: {
            activityId: descriptor.activityId,
            audience: raw.target.audience,
          },
        };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d, target }, variant) =>
        `/v3/media/activities/${target.audience}/activities/${d.activityId}/slots/${d.slot}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d }) => ({
        revision: d.revision,
      }),
    });
  }
}
