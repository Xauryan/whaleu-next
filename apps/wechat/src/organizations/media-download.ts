import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { exact } from '../community/contract';
import {
  invalidOrganizationMedia,
  organizationMediaUuid,
} from './media-validation';
import {
  decodeOrganizationMediaDescriptor,
  type OrganizationMediaDescriptor,
} from './media-contract';
export interface OrganizationMediaReadTarget {
  readonly organizationId: string;
  readonly audience: 'public' | 'management';
}
export interface OrganizationMediaDownloadInput {
  readonly descriptor: OrganizationMediaDescriptor;
  readonly target: OrganizationMediaReadTarget;
}
export class OrganizationMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class OrganizationMediaDownload extends OwnerImageDownload<OrganizationMediaDownloadInput> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<OrganizationMediaDownloadInput>['download']
    >
  ) {
    if (args[3].current().kind !== 'session')
      throw new ClientError('auth-required', '请先登录查看组织图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: OrganizationMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeOrganizationMediaDescriptor(raw.descriptor);
        exact(raw.target, ['organizationId', 'audience']);
        if (
          organizationMediaUuid(raw.target.organizationId) !==
            descriptor.organizationId ||
          (raw.target.audience !== 'public' &&
            raw.target.audience !== 'management') ||
          (raw.target.audience === 'public' &&
            descriptor.slot === 'managerContact')
        )
          invalidOrganizationMedia();
        return {
          descriptor,
          target: {
            organizationId: descriptor.organizationId,
            audience: raw.target.audience,
          },
        };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d, target }, variant) =>
        `/v3/media/organizations/${target.audience}/organizations/${d.organizationId}/slots/${d.slot}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d }) => ({
        applicationRevision: d.applicationRevision,
      }),
    });
  }
}
