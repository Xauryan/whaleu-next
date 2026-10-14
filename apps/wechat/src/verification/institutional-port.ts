import type { Cancellation } from '../platform/contracts';
import type { InstitutionalContext } from './institutional-contract';
export interface InstitutionalHandoff {
  readonly requestId: string;
  readonly requestHash: string;
  readonly context: InstitutionalContext;
  readonly expiresAt: string;
}
export type InstitutionalNativeResult =
  | { readonly state: 'authorized'; readonly authorizationResponse: string }
  | {
      readonly state:
        | 'cancelled'
        | 'challenge_required'
        | 'provider_unavailable'
        | 'rejected'
        | 'protocol_error';
    };
export interface InstitutionalNativePort {
  readonly available: boolean;
  authorize(
    context: InstitutionalHandoff,
    cancellation: Cancellation,
  ): Promise<InstitutionalNativeResult>;
}
/** No credential entry, webview, wx.login, provider call or environment activation switch. */
export class UnavailableInstitutionalNativePort implements InstitutionalNativePort {
  readonly available = false;
  async authorize(): Promise<InstitutionalNativeResult> {
    return { state: 'provider_unavailable' };
  }
}
