import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { exact } from '../community/contract';
import { invalidErrandMedia, errandMediaUuid } from './media-validation';
import {
  decodeErrandMediaDescriptor,
  type ErrandMediaDescriptor,
} from './media-contract';
export interface ErrandMediaReadTarget {
  readonly orderId: string;
}
export interface ErrandMediaDownloadInput {
  readonly descriptor: ErrandMediaDescriptor;
  readonly target: ErrandMediaReadTarget;
}
export class ErrandMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class ErrandMediaDownload extends OwnerImageDownload<ErrandMediaDownloadInput> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<ErrandMediaDownloadInput>['download']
    >
  ) {
    if (args[3].current().kind !== 'session')
      throw new ClientError('auth-required', '请先登录查看跑腿图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: ErrandMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeErrandMediaDescriptor(raw.descriptor);
        exact(raw.target, ['orderId']);
        if (errandMediaUuid(raw.target.orderId) !== descriptor.orderId)
          invalidErrandMedia();
        return {
          descriptor,
          target: {
            orderId: descriptor.orderId,
          },
        };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d }, variant) =>
        `/v3/media/errands/orders/${d.orderId}/${d.slot}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d }) => ({
        revision: d.revision,
      }),
    });
  }
}
