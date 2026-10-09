import { SessionStore } from '../src/auth/session';
import { PendingMessagingStore } from '../src/messaging/pending';
import type { MessagingRuntime } from '../src/messaging/runtime';
import type { MessagingGateway } from '../src/messaging/gateway';
import type {
  Conversation,
  History,
  Intent,
  Message,
  Receipt,
} from '../src/messaging/contract';
import { MemoryStorage, FakeClock } from './helpers';
import { wireCredentials, accountId } from './identity-helpers';
export { accountId };
export const conversationId = '55555555-5555-4555-8555-555555555555';
export const messageId = '66666666-6666-4666-8666-666666666666';
export const requestId = '77777777-7777-4777-8777-777777777777';
export const observationId = '88888888-8888-4888-8888-888888888888';
export const otherId = '99999999-9999-4999-8999-999999999999';
export const timestamp = '2026-10-09T18:00:00.000Z';
export const conversation = (
  patch: Partial<Conversation> = {},
): Conversation => ({
  id: conversationId,
  self: { mode: 'named', displayName: '自己', profileId: accountId },
  peer: { mode: 'named', displayName: '对方', profileId: otherId },
  source: null,
  unreadCount: 1,
  hidden: false,
  sendAvailability: 'available',
  blockScope: 'named',
  blockedByYou: false,
  ...patch,
});
export const message = (patch: Partial<Message> = {}): Message => ({
  id: messageId,
  sequence: '1',
  sender: 'peer',
  state: 'text',
  text: '本地合成私信',
  createdAt: timestamp,
  canRecall: false,
  ...patch,
});
export const history = (patch: Partial<History> = {}): History => ({
  items: [message()],
  nextCursor: null,
  observationId,
  throughSequence: '1',
  eventCursor: 'initial_cursor',
  coverage: 'local',
  ...patch,
});
export const sendIntent = (text = '原文'): Intent => ({
  operation: 'send',
  clientRequestId: requestId,
  conversationId,
  text,
});
export const receipt = (intent: Intent): Receipt => ({
  requestId: intent.clientRequestId,
  operation: intent.operation,
  outcome: 'applied',
  conversationId:
    intent.operation === 'open' ? conversationId : intent.conversationId,
  messageId:
    intent.operation === 'send'
      ? messageId
      : intent.operation === 'recall'
        ? intent.messageId
        : null,
  occurredAt: timestamp,
});
export function harness() {
  const sessions = new SessionStore(),
    storage = new MemoryStorage(),
    clock = new FakeClock();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const applied: Intent[] = [],
    queried: string[] = [],
    events: string[] = [];
  const gateway: MessagingGateway = {
    list: async () => ({
      items: [
        {
          conversation: conversation(),
          latest: message(),
          updatedAt: timestamp,
        },
      ],
      nextCursor: null,
      coverage: 'local',
    }),
    unread: async () => ({ count: 1, coverage: 'local' }),
    conversation: async () => conversation(),
    history: async () => history(),
    events: async (_id, cursor) => {
      events.push(cursor);
      return {
        items: [],
        nextCursor: cursor,
        hasMore: false,
        observationId,
        throughSequence: '0',
      };
    },
    apply: async (intent) => {
      applied.push(intent);
      return receipt(intent);
    },
    cancel: async (id, operation) => ({
      outcome: 'cancelled',
      receipt: {
        requestId: id,
        operation,
        outcome: 'rejected',
        code: 'DM_COMMAND_CANCELLED',
      },
    }),
    receipt: async (id) => {
      queried.push(id);
      return receipt(sendIntent());
    },
  };
  const runtime: MessagingRuntime = {
    sessions,
    clock,
    gateway,
    pending: new PendingMessagingStore(storage, 'synthetic'),
    newRequestId: async () => requestId,
    assertStorage: () => undefined,
  };
  return {
    runtime,
    sessions,
    storage,
    clock,
    gateway,
    applied,
    queried,
    events,
  };
}
