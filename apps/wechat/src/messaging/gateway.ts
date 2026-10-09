import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  cursor,
  decodeConversation,
  decodeCancellationResult,
  decodeEvents,
  decodeHistory,
  decodeIntent,
  decodeList,
  decodeReceipt,
  decodeUnread,
  id,
  invalid,
  matchReceipt,
  type Conversation,
  type CancellationResult,
  type Events,
  type History,
  type Intent,
  type Operation,
  type ListPage,
  type Receipt,
  type Unread,
} from './contract';
export interface MessagingGateway {
  list(cursor: string | null, cancel: Cancellation): Promise<ListPage>;
  unread(cancel: Cancellation): Promise<Unread>;
  conversation(
    conversationId: string,
    cancel: Cancellation,
  ): Promise<Conversation>;
  history(
    conversationId: string,
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<History>;
  events(
    conversationId: string,
    cursor: string,
    cancel: Cancellation,
  ): Promise<Events>;
  apply(intent: Intent, cancel: Cancellation): Promise<Receipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<Receipt>;
  cancel(
    requestId: string,
    operation: Operation,
    intentHash: string,
    cancel: Cancellation,
  ): Promise<CancellationResult>;
}
const root = '/v1/private-messages';
export class HttpMessagingGateway implements MessagingGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
      {
        path: root + path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  private page(cursorValue: string | null) {
    if (cursorValue !== null && !cursor(cursorValue)) invalid();
    return {
      limit: 50,
      ...(cursorValue === null ? {} : { cursor: cursorValue }),
    };
  }
  async list(
    cursorValue: string | null,
    cancel: Cancellation,
  ): Promise<ListPage> {
    return this.read(
      '/conversations',
      decodeList,
      cancel,
      this.page(cursorValue),
    );
  }
  async unread(cancel: Cancellation): Promise<Unread> {
    return this.read('/unread', decodeUnread, cancel);
  }
  async conversation(
    conversationId: string,
    cancel: Cancellation,
  ): Promise<Conversation> {
    if (!id(conversationId)) invalid();
    const result = await this.read(
      `/conversations/${conversationId}`,
      decodeConversation,
      cancel,
    );
    if (result.id !== conversationId) invalid();
    return result;
  }
  async history(
    conversationId: string,
    cursorValue: string | null,
    cancel: Cancellation,
  ): Promise<History> {
    if (!id(conversationId)) invalid();
    return this.read(
      `/conversations/${conversationId}/messages`,
      decodeHistory,
      cancel,
      this.page(cursorValue),
    );
  }
  async events(
    conversationId: string,
    cursorValue: string,
    cancel: Cancellation,
  ): Promise<Events> {
    if (!id(conversationId) || !cursor(cursorValue)) invalid();
    const result = await this.read(
      `/conversations/${conversationId}/events`,
      decodeEvents,
      cancel,
      this.page(cursorValue),
    );
    if (result.items.length && result.nextCursor === cursorValue) invalid();
    return result;
  }
  async apply(raw: Intent, cancel: Cancellation): Promise<Receipt> {
    const intent = decodeIntent(raw);
    let path: string;
    let body: Json = { clientRequestId: intent.clientRequestId };
    if (intent.operation === 'open') {
      path = '/conversations';
      body = {
        ...body,
        entry: { ...intent.entry },
        initiationMode: intent.initiationMode,
      };
    } else {
      const base = `/conversations/${intent.conversationId}`;
      path =
        intent.operation === 'send'
          ? base + '/messages'
          : intent.operation === 'recall'
            ? base + `/messages/${intent.messageId}/recall`
            : base + '/' + intent.operation;
      if (intent.operation === 'send') body = { ...body, text: intent.text };
      if (intent.operation === 'read')
        body = { ...body, observationId: intent.observationId };
    }
    const receipt = await this.api.request(
      {
        path: root + path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeReceipt,
      },
      { body, cancellation: cancel },
    );
    matchReceipt(intent, receipt);
    return receipt;
  }
  async cancel(
    requestId: string,
    operation: Operation,
    intentHash: string,
    cancel: Cancellation,
  ): Promise<CancellationResult> {
    if (
      !id(requestId) ||
      !/^[a-f0-9]{64}$/.test(intentHash) ||
      !['open', 'send', 'read', 'hide', 'reopen', 'recall', 'block'].includes(
        operation,
      )
    )
      invalid();
    const result = await this.api.request(
      {
        path: root + `/requests/${requestId}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeCancellationResult,
      },
      { body: { operation, intentHash }, cancellation: cancel },
    );
    if (
      result.receipt.requestId !== requestId ||
      result.receipt.operation !== operation
    )
      invalid();
    return result;
  }
  async receipt(requestId: string, cancel: Cancellation): Promise<Receipt> {
    if (!id(requestId)) invalid();
    const result = await this.read(
      `/requests/${requestId}`,
      decodeReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
}
