import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { isContentReferenceCode } from './text';
import {
  decodeReferenceCapability,
  decodeReferenceDestination,
  decodeReferenceLookup,
  decodeReferenceTarget,
  invalidReference,
  referenceTargetKey,
  type ReferenceCode,
  type ReferenceDestination,
  type ReferenceTarget,
} from './contract';
export interface ContentReferencesGateway {
  capability(cancel: Cancellation): Promise<{ available: boolean }>;
  resolve(
    code: string,
    cancel: Cancellation,
    viewSpaceId?: string,
  ): Promise<ReferenceDestination>;
  lookup(
    targets: readonly ReferenceTarget[],
    cancel: Cancellation,
    viewSpaceId?: string,
  ): Promise<{ items: ReferenceCode[] }>;
}
/** Read-only even for the two bounded POSTs. Nothing allocates or acknowledges reads. */
export class HttpContentReferencesGateway implements ContentReferencesGateway {
  constructor(private readonly api: ApiClient) {}
  capability(cancellation: Cancellation): Promise<{ available: boolean }> {
    return this.api.request(
      {
        path: '/v1/community/content-references/capability',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeReferenceCapability,
      },
      { cancellation },
    );
  }
  async resolve(
    code: string,
    cancellation: Cancellation,
    viewSpaceId?: string,
  ): Promise<ReferenceDestination> {
    if (
      !isContentReferenceCode(code) ||
      (viewSpaceId !== undefined && !isUuid(viewSpaceId))
    )
      invalidReference();
    const result = await this.api.request(
      {
        path: '/v1/community/content-references/resolve',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeReferenceDestination,
      },
      { cancellation, body: { code, ...(viewSpaceId ? { viewSpaceId } : {}) } },
    );
    if (result.viewSpaceId !== viewSpaceId) invalidReference();
    return result;
  }
  async lookup(
    targets: readonly ReferenceTarget[],
    cancellation: Cancellation,
    viewSpaceId?: string,
  ): Promise<{ items: ReferenceCode[] }> {
    if (
      !Array.isArray(targets) ||
      targets.length < 1 ||
      targets.length > 30 ||
      (viewSpaceId !== undefined && !isUuid(viewSpaceId))
    )
      invalidReference();
    const checked = targets.map(decodeReferenceTarget);
    const expected = new Set(checked.map(referenceTargetKey));
    const result = await this.api.request(
      {
        path: '/v1/community/content-references/lookup',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeReferenceLookup,
      },
      {
        cancellation,
        body: {
          targets: checked.map((target) => ({ ...target })),
          ...(viewSpaceId ? { viewSpaceId } : {}),
        },
      },
    );
    if (result.items.some((item) => !expected.has(referenceTargetKey(item))))
      invalidReference();
    return result;
  }
}
