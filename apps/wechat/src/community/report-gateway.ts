import type { ApiClient, Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { invalid, uuid4 } from './contract';
import {
  decodeReportIntent,
  decodeReportProgress,
  decodeReportReceipt,
  decodeReportTarget,
  matchReportReceipt,
  type ReportIntent,
  type ReportProgress,
  type ReportReceipt,
  type ReportTarget,
} from './report-contract';
export interface ReportGateway {
  apply(intent: ReportIntent, cancel: Cancellation): Promise<ReportReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<ReportReceipt>;
  progress(target: ReportTarget, cancel: Cancellation): Promise<ReportProgress>;
}
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
  method: Endpoint<T>['method'] = 'GET',
): Endpoint<T> => ({
  path,
  decode,
  method,
  authentication: 'required',
  successStatus: 200,
  authReplay: 'once',
});
export class HttpReportGateway implements ReportGateway {
  constructor(private readonly api: ApiClient) {}
  async apply(
    raw: ReportIntent,
    cancellation: Cancellation,
  ): Promise<ReportReceipt> {
    const intent = decodeReportIntent(raw);
    const result = await this.api.request(
      endpoint(
        intent.operation === 'report'
          ? '/v1/me/safety/reports'
          : '/v1/me/safety/jury-votes',
        decodeReportReceipt,
        'POST',
      ),
      {
        body:
          intent.operation === 'report'
            ? {
                clientRequestId: intent.clientRequestId,
                target: { kind: intent.target.kind, id: intent.target.id },
              }
            : {
                clientRequestId: intent.clientRequestId,
                postId: intent.postId,
                juryId: intent.juryId,
                vote: intent.vote,
              },
        cancellation,
      },
    );
    matchReportReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<ReportReceipt> {
    if (!uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/safety/report-requests/${requestId}`,
        decodeReportReceipt,
      ),
      { cancellation },
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
  async progress(
    raw: ReportTarget,
    cancellation: Cancellation,
  ): Promise<ReportProgress> {
    const target = decodeReportTarget(raw);
    const result = await this.api.request(
      endpoint(
        `/v1/me/safety/report-progress/${target.kind}/${target.id}`,
        decodeReportProgress,
      ),
      { cancellation },
    );
    if (result.kind !== target.kind || result.id !== target.id) invalid();
    return result;
  }
}
