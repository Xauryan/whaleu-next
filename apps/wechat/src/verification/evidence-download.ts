import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { exact } from '../community/contract';
import {
  invalidVerificationEvidence,
  verificationEvidenceUuid,
} from './evidence-validation';
import {
  decodeVerificationEvidenceDescriptor,
  type VerificationEvidenceDescriptor,
} from './evidence-contract';
export interface VerificationEvidenceReadTarget {
  readonly applicationId: string;
  readonly reviewRegionId: string | null;
}
export interface VerificationEvidenceDownloadInput {
  readonly descriptor: VerificationEvidenceDescriptor;
  readonly target: VerificationEvidenceReadTarget;
}
export class VerificationEvidencePrincipalOwner extends OptionalMediaPrincipalOwner {}
/** Session mandatory, including every retry. Optional/guest engine capability is
 * deliberately rejected at the boundary; bytes stay in revocable temp storage. */
export class VerificationEvidenceDownload extends OwnerImageDownload<VerificationEvidenceDownloadInput> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<VerificationEvidenceDownloadInput>['download']
    >
  ) {
    const context = args[3];
    const required = {
      current: () => {
        const principal = context.current();
        if (principal.kind !== 'session')
          throw new ClientError('auth-required', '请先登录查看认证材料');
        return principal;
      },
    };
    required.current();
    return super.download(args[0], args[1], args[2], required, args[4]);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: VerificationEvidencePrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeVerificationEvidenceDescriptor(raw.descriptor);
        exact(raw.target, ['applicationId', 'reviewRegionId']);
        if (
          verificationEvidenceUuid(raw.target.applicationId) !==
          descriptor.applicationId
        )
          invalidVerificationEvidence();
        return {
          descriptor,
          target: {
            applicationId: descriptor.applicationId,
            reviewRegionId:
              raw.target.reviewRegionId === null
                ? null
                : verificationEvidenceUuid(raw.target.reviewRegionId),
          },
        };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d }, variant) =>
        `/v3/media/verification-evidence/applications/${d.applicationId}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d, target }) => ({
        revision: d.revision,
        ...(target.reviewRegionId === null
          ? {}
          : { reviewRegionId: target.reviewRegionId }),
      }),
    });
  }
}
