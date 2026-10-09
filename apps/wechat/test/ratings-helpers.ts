import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  RatingController,
  type RatingMode,
  type RatingView,
} from '../src/ratings/controller';
import type {
  RatingCategory,
  RatingCategoryPage,
  RatingComment,
  RatingCommentPage,
  RatingContext,
  RatingIntent,
  RatingMyScore,
  RatingReceipt,
  RatingSummary,
  RatingTarget,
  RatingTargetPage,
} from '../src/ratings/contract';
import type { RatingsGateway } from '../src/ratings/gateway';
import {
  PendingRatingStore,
  isRatingReplyIntent,
  type RatingCommandIntent,
} from '../src/ratings/pending';
import { setup } from './community-helpers';
export const targetId = '11111111-1111-4111-8111-111111111111';
export const categoryId = '22222222-2222-4222-8222-222222222222';
export const regionId = '33333333-3333-4333-8333-333333333333';
export const revision = '44444444-4444-4444-8444-444444444444';
export const nextRevision = '55555555-5555-4555-8555-555555555555';
export const requestId = '66666666-6666-4666-8666-666666666666';
export const commentId = '77777777-7777-4777-8777-777777777777';
export const otherId = '88888888-8888-4888-8888-888888888888';
export const personaId = '99999999-9999-4999-8999-999999999999';
export const timestamp = '2026-10-08T12:00:00.123456Z';
export const cursor = 'a'.repeat(43);
export const body = 'Synthetic independent text review';
export const context = (patch: Partial<RatingContext> = {}): RatingContext => ({
  homeRegion: { id: regionId, label: 'Synthetic home' },
  regions: [{ id: regionId, label: 'Synthetic home', relation: 'home' }],
  ...patch,
});
export const category = (
  patch: Partial<RatingCategory> = {},
): RatingCategory => ({
  id: categoryId,
  parentId: null,
  level: 1,
  kind: 'general',
  systemKey: null,
  name: 'Synthetic category',
  description: '',
  revision,
  ...patch,
});
export const target = (patch: Partial<RatingTarget> = {}): RatingTarget => ({
  id: targetId,
  categoryId,
  name: 'Synthetic target',
  description: 'Synthetic target description',
  revision,
  allowedActions: {
    setScore: true,
    createComment: true,
    authorModes: ['named', 'anonymous'],
  },
  ...patch,
});
export const comment = (patch: Partial<RatingComment> = {}): RatingComment => ({
  id: commentId,
  targetId,
  body,
  revision,
  createdAt: timestamp,
  author: {
    mode: 'anonymous',
    targetId,
    personaId,
    displayName: 'Synthetic anonymous whale',
  },
  isMine: true,
  allowedActions: { delete: true },
  ...patch,
});
export const myScore = (score = 3): RatingMyScore => ({
  myScore: { score, revision },
});
export const summary = (score = 3): RatingSummary => ({
  status: 'known',
  count: 1,
  sum: score,
  average: score,
  distribution: {
    '1': score === 1 ? 1 : 0,
    '2': score === 2 ? 1 : 0,
    '3': score === 3 ? 1 : 0,
    '4': score === 4 ? 1 : 0,
    '5': score === 5 ? 1 : 0,
  },
  revision,
});
export const emptySummary = (): RatingSummary => ({
  status: 'known',
  count: 0,
  sum: 0,
  average: null,
  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
  revision,
});
export const categoryPage = (
  patch: Partial<RatingCategoryPage> = {},
): RatingCategoryPage => ({
  context: { regionId: null, catalogRevision: revision, parentId: null },
  items: [category()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const targetPage = (
  patch: Partial<RatingTargetPage> = {},
): RatingTargetPage => ({
  context: { regionId: null, catalogRevision: revision, categoryId },
  items: [target()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const commentPage = (
  patch: Partial<RatingCommentPage> = {},
): RatingCommentPage => ({
  context: { regionId: null, catalogRevision: revision, targetId },
  items: [comment()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export function intent(
  operation: RatingIntent['operation'] = 'set_score',
): RatingIntent {
  const base = {
    clientRequestId: requestId,
    regionId: null,
    expectedTargetRevision: revision,
  };
  if (operation === 'set_score')
    return {
      operation,
      targetId,
      payload: { ...base, expectedRevision: revision, score: 5 },
    };
  if (operation === 'create_comment')
    return {
      operation,
      targetId,
      payload: { ...base, authorMode: 'anonymous', body, assetIds: [] },
    };
  return {
    operation,
    commentId,
    payload: { ...base, targetId, expectedRevision: revision },
  };
}
export const receipt = (
  command: RatingCommandIntent = intent(),
  outcome: 'applied' | 'noop' = 'applied',
): Extract<RatingReceipt, { outcome: 'applied' | 'noop' }> => {
  if (isRatingReplyIntent(command)) throw new Error('R1-only fixture');
  return {
    requestId: command.payload.clientRequestId,
    operation: command.operation,
    outcome,
    targetId:
      command.operation === 'delete_comment'
        ? command.payload.targetId
        : command.targetId,
    subjectId:
      command.operation === 'set_score'
        ? command.targetId
        : command.operation === 'delete_comment'
          ? command.commentId
          : commentId,
    revision:
      command.operation === 'set_score' && outcome === 'noop'
        ? (command.payload.expectedRevision ?? revision)
        : nextRevision,
    occurredAt: timestamp,
  };
};
export const rejected = (
  command: RatingCommandIntent = intent(),
  code: Extract<
    RatingReceipt,
    { outcome: 'rejected' }
  >['code'] = 'RATING_REVISION_CONFLICT',
): RatingReceipt => {
  if (isRatingReplyIntent(command)) throw new Error('R1-only fixture');
  return {
    requestId: command.payload.clientRequestId,
    operation: command.operation,
    outcome: 'rejected',
    code,
  };
};
export class FakeRatingsGateway implements RatingsGateway {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];
  readonly commands: RatingIntent[] = [];
  contextImpl: RatingsGateway['context'] = async () => context();
  categoriesImpl: RatingsGateway['categories'] = async (regionId, parentId) =>
    categoryPage({
      context: { regionId, parentId, catalogRevision: revision },
      items:
        parentId === null
          ? [category()]
          : [category({ id: otherId, parentId, level: 2 })],
    });
  targetsImpl: RatingsGateway['targets'] = async (regionId, categoryId) =>
    targetPage({
      context: { regionId, categoryId, catalogRevision: revision },
      items: [target({ categoryId })],
    });
  detailImpl: RatingsGateway['detail'] = async (_regionId, id) =>
    target({ id });
  myScoreImpl: RatingsGateway['myScore'] = async () => myScore();
  summaryImpl: RatingsGateway['summary'] = async () => summary();
  commentsImpl: RatingsGateway['comments'] = async (regionId, id) =>
    commentPage({
      context: { regionId, targetId: id, catalogRevision: revision },
      items: [
        comment({
          targetId: id,
          author: {
            mode: 'anonymous',
            targetId: id,
            personaId,
            displayName: 'Synthetic anonymous whale',
          },
        }),
      ],
    });
  commentImpl: RatingsGateway['comment'] = async (_regionId, id) =>
    comment({ id });
  commandImpl: RatingsGateway['command'] = async (command) => receipt(command);
  receiptImpl: RatingsGateway['receipt'] = async () => {
    throw new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  context(...args: Parameters<RatingsGateway['context']>) {
    this.calls.push({ method: 'context', args });
    return this.contextImpl(...args);
  }
  categories(...args: Parameters<RatingsGateway['categories']>) {
    this.calls.push({ method: 'categories', args });
    return this.categoriesImpl(...args);
  }
  targets(...args: Parameters<RatingsGateway['targets']>) {
    this.calls.push({ method: 'targets', args });
    return this.targetsImpl(...args);
  }
  detail(...args: Parameters<RatingsGateway['detail']>) {
    this.calls.push({ method: 'detail', args });
    return this.detailImpl(...args);
  }
  myScore(...args: Parameters<RatingsGateway['myScore']>) {
    this.calls.push({ method: 'myScore', args });
    return this.myScoreImpl(...args);
  }
  summary(...args: Parameters<RatingsGateway['summary']>) {
    this.calls.push({ method: 'summary', args });
    return this.summaryImpl(...args);
  }
  comments(...args: Parameters<RatingsGateway['comments']>) {
    this.calls.push({ method: 'comments', args });
    return this.commentsImpl(...args);
  }
  comment(...args: Parameters<RatingsGateway['comment']>) {
    this.calls.push({ method: 'comment', args });
    return this.commentImpl(...args);
  }
  command(...args: Parameters<RatingsGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<RatingsGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
export function harness(mode: RatingMode = 'detail') {
  const s = setup(),
    ratings = new FakeRatingsGateway(),
    pendingRatings = new PendingRatingStore(s.storage, 'synthetic-ratings');
  const safetyChanges = new SafetyChanges(s.runtime.privateViews),
    directoryScopeChanges = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle();
  const ids = { count: 0, next: async (): Promise<string> => requestId };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratings,
    pendingRatings,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: RatingView[] = [];
  const controller = new RatingController(runtime, mode, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    ratings,
    pendingRatings,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
    ids,
    views,
    controller,
    view: () => views[views.length - 1]!,
  };
}
export type Harness = ReturnType<typeof harness>;
export async function prepare(
  operation: RatingIntent['operation'] = 'set_score',
): Promise<Harness> {
  const s = harness();
  await s.controller.load({ targetId });
  if (operation === 'set_score') s.controller.chooseScore(5);
  if (operation === 'create_comment') {
    s.controller.openComposer();
    s.controller.setAuthorMode('anonymous');
    s.controller.setText(body);
  }
  if (operation === 'delete_comment') s.controller.confirmDelete(commentId);
  return s;
}
export function submit(
  s: Harness,
  operation: RatingIntent['operation'],
): Promise<void> {
  return operation === 'set_score'
    ? s.controller.confirmScore()
    : operation === 'create_comment'
      ? s.controller.publish()
      : s.controller.deleteComment();
}
