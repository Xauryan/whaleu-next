import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeViewEpoch,
  decodeViewIntent,
  decodeViewReceipt,
  matchViewReceipt,
  type ViewEpoch,
  type ViewIntent,
  type ViewReceipt,
} from './view-contract';
export interface ViewGateway {
  epoch(cancellation: Cancellation): Promise<ViewEpoch>;
  report(intent: ViewIntent, cancellation: Cancellation): Promise<ViewReceipt>;
}
export class HttpViewGateway implements ViewGateway {
  constructor(private readonly api: ApiClient) {}
  epoch(cancellation: Cancellation): Promise<ViewEpoch> {
    return this.api.request(
      {
        path: '/v1/me/community/view-reporting-epoch',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeViewEpoch,
      },
      { body: { version: 1 }, cancellation },
    );
  }
  async report(
    value: ViewIntent,
    cancellation: Cancellation,
  ): Promise<ViewReceipt> {
    const intent = decodeViewIntent(value);
    const receipt = await this.api.request(
      {
        path: '/v1/me/community/view-reports',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeViewReceipt,
      },
      { body: { ...intent, postIds: [...intent.postIds] }, cancellation },
    );
    return matchViewReceipt(intent, receipt);
  }
}
