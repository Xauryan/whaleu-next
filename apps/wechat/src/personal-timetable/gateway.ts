import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import {
  base,
  uuid,
  decodeTerms,
  decodeDetail,
  decodeCommand,
  decodeReceipt,
  decodeRecovery,
  matchReceipt,
  invalid,
} from './contracts';
import type { Command, Detail, Receipt, Recovery, Term } from './contracts';
export interface TimetableGateway {
  terms(cancel: Cancellation): Promise<{ terms: Term[] }>;
  detail(termId: string, cancel: Cancellation): Promise<Detail>;
  command(command: Command, cancel: Cancellation): Promise<Receipt>;
  recover(requestId: string, cancel: Cancellation): Promise<Recovery>;
  cancel(command: Command, cancel: Cancellation): Promise<Receipt>;
}
export class HttpTimetableGateway implements TimetableGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
    path: string,
    decode: (input: unknown) => T,
    cancellation: Cancellation,
  ) {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation },
    );
  }
  terms(cancel: Cancellation) {
    return this.get(`${base}/terms`, decodeTerms, cancel);
  }
  async detail(termId: string, cancel: Cancellation) {
    const detail = await this.get(
      `${base}/terms/${uuid(termId)}`,
      decodeDetail,
      cancel,
    );
    if (detail.term.termId !== termId) invalid();
    return detail;
  }
  private async post(
    path: string,
    command: Command,
    cancellation: Cancellation,
  ) {
    const original = decodeCommand(command);
    const result = await this.api.request(
      {
        path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeReceipt,
      },
      { body: original as unknown as Json, cancellation },
    );
    matchReceipt(original, result);
    return result;
  }
  command(command: Command, cancel: Cancellation) {
    return this.post(`${base}/commands`, command, cancel);
  }
  async recover(requestId: string, cancel: Cancellation) {
    const result = await this.get(
      `${base}/requests/${uuid(requestId)}`,
      decodeRecovery,
      cancel,
    );
    if (
      (result.status === 'unknown'
        ? result.requestId
        : result.receipt.requestId) !== requestId
    )
      invalid();
    return result;
  }
  cancel(command: Command, cancel: Cancellation) {
    return this.post(
      `${base}/requests/${uuid(command.requestId)}/cancel`,
      command,
      cancel,
    );
  }
}
