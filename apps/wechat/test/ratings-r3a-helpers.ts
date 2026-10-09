import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  ratingAdminDeletionIntent,
  type RatingAdminDeletionContext,
  type RatingAdminDeletionIntent,
  type RatingAdminDeletionReceipt,
  type RatingDeletionContext,
  type RatingDeletionLocator,
} from '../src/ratings/deletion-contract';
import {
  RatingDeletionController,
  type RatingDeletionView,
} from '../src/ratings/deletion-controller';
import type { RatingDeletionGateway } from '../src/ratings/deletion-gateway';
import {
  commentId,
  targetId,
  revision,
  nextRevision,
  requestId,
  timestamp,
} from './ratings-helpers';
import { r2cHarness } from './ratings-r2c-helpers';
import { replyId } from './ratings-r2a-helpers';
export const token = 'x'.repeat(43);
export const locator = (reply = false): RatingDeletionLocator => ({
  subjectKind: reply ? 'reply' : 'comment',
  targetId,
  rootId: commentId,
  subjectId: reply ? replyId : commentId,
});
export const deletionContext = (
  reply = false,
  patch: Partial<RatingDeletionContext> = {},
): RatingDeletionContext => ({
  ...locator(reply),
  regionId: null,
  targetRevision: revision,
  rootRevision: revision,
  revision,
  deleted: false,
  ...patch,
});
export const adminContext = (
  reply = false,
  patch: Partial<RatingAdminDeletionContext> = {},
): RatingAdminDeletionContext => ({
  ...deletionContext(reply),
  contextRevision: token,
  ...patch,
});
export const adminIntent = (reply = false): RatingAdminDeletionIntent =>
  ratingAdminDeletionIntent(adminContext(reply), requestId);
export const adminReceipt = (
  intent = adminIntent(),
): Extract<RatingAdminDeletionReceipt, { outcome: 'applied' | 'noop' }> => ({
  requestId: intent.payload.clientRequestId,
  operation: intent.operation,
  outcome: 'applied',
  targetId: intent.payload.targetId,
  rootId:
    intent.operation === 'admin_delete_comment'
      ? intent.subjectId
      : intent.payload.rootId,
  subjectId: intent.subjectId,
  revision: nextRevision,
  occurredAt: timestamp,
});
export const missing = () =>
  new ClientError('http', 'Synthetic missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export const changed = () =>
  new ClientError('business', 'Synthetic context changed', {
    httpStatus: 409,
    serverCode: 'RATING_DELETION_CONTEXT_CHANGED',
  });
export class FakeRatingDeletionGateway implements RatingDeletionGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly commands: RatingAdminDeletionIntent[] = [];
  contextImpl: RatingDeletionGateway['context'] = async (
    authority,
    locator,
  ) => {
    const context = deletionContext(locator.subjectKind === 'reply');
    return authority === 'admin'
      ? { ...context, contextRevision: token }
      : context;
  };
  commandImpl: RatingDeletionGateway['command'] = async (intent) =>
    adminReceipt(intent);
  receiptImpl: RatingDeletionGateway['receipt'] = async () => {
    throw missing();
  };
  context(...args: Parameters<RatingDeletionGateway['context']>) {
    this.calls.push({ method: 'context', args });
    return this.contextImpl(...args);
  }
  command(...args: Parameters<RatingDeletionGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<RatingDeletionGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
export function r3aHarness() {
  const s = r2cHarness(),
    ratingDeletion = new FakeRatingDeletionGateway();
  const runtime: CommunityRuntime = { ...s.runtime, ratingDeletion };
  const deletionViews: RatingDeletionView[] = [];
  const deletionController = new RatingDeletionController(runtime, (view) =>
    deletionViews.push(view),
  );
  return {
    ...s,
    runtime,
    ratingDeletion,
    deletionController,
    deletionViews,
    deletionView: () => deletionViews[deletionViews.length - 1]!,
  };
}
