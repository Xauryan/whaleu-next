import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { exact } from '../community/contract';
import { invalidSchool, schoolUuid } from './contract';
import {
  decodeSchoolQrDescriptor,
  type SchoolQrDescriptor,
} from './qr-contract';
export type SchoolQrReadTarget =
  | { readonly campusId: string }
  | { readonly regionId: string }
  | { readonly orderId: string; readonly targetRegionId: string };
export interface SchoolQrDownloadInput {
  readonly descriptor: SchoolQrDescriptor;
  readonly target: SchoolQrReadTarget;
}
export class SchoolQrPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class SchoolQrDownload extends OwnerImageDownload<SchoolQrDownloadInput> {
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: SchoolQrPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeSchoolQrDescriptor(raw.descriptor);
        if (!raw.target || typeof raw.target !== 'object') invalidSchool();
        if ('campusId' in raw.target) {
          exact(raw.target, ['campusId']);
          if (descriptor.entryKey === 'review') invalidSchool();
          return {
            descriptor,
            target: { campusId: schoolUuid(raw.target.campusId) },
          };
        }
        if ('orderId' in raw.target) {
          exact(raw.target, ['orderId', 'targetRegionId']);
          if (
            descriptor.entryKey !== 'errand' ||
            !('targetRegionId' in raw.target) ||
            schoolUuid(raw.target.targetRegionId) !== descriptor.regionId
          )
            invalidSchool();
          return {
            descriptor,
            target: {
              orderId: schoolUuid(raw.target.orderId),
              targetRegionId: descriptor.regionId,
            },
          };
        }
        exact(raw.target, ['regionId']);
        if (schoolUuid(raw.target.regionId) !== descriptor.regionId)
          invalidSchool();
        return { descriptor, target: { regionId: descriptor.regionId } };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d, target }, variant) =>
        'orderId' in target
          ? `/v3/media/school-configuration/errands/${target.orderId}/bindings/${d.bindingId}/${variant}`
          : `/v3/media/school-configuration/${'campusId' in target ? '' : `management/regions/${target.regionId}/`}entries/${d.entryKey}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d, target }) => ({
        entryRevision: d.entryRevision,
        ...('campusId' in target ? { campusId: target.campusId } : {}),
      }),
    });
  }
}
