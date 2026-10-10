import { ClientError } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  isRatingScopedIntent,
  isRatingCategoryScopedIntent,
  isRatingCategoryCreationIntent,
  isRatingTargetOwnerEditingIntent,
  isRatingTargetCreationIntent,
  isRatingTargetOwnerDeletionIntent,
  isRatingReplyIntent,
  isRatingAdminDeletionIntent,
  isRatingDeletionContextChanged,
  isRatingSubscriptionIntent,
  isRatingLikeIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
export const ratingCommandLabels = {
  create_categories_scoped: '创建评分分类',
  edit_category_base_scoped: '编辑共享基础',
  set_category_override_scoped: '设置校园覆盖与继承',
  set_category_visibility_scoped: '设置视图显示状态',
  reorder_categories_scoped: '调整完整同级排序',
  set_category_scope_scoped: '替换分类适用范围',
  set_category_lifecycle_scoped: '启停、归档或恢复分类',
  batch_update_subcategories_scoped: '原子更新直接子分类',
  create_system_category_scoped: '创建已注册系统分类',
  set_score_scoped: '校园评分',
  create_comment_scoped: '校园文字评价发布',
  create_reply_scoped: '校园回复发布',
  set_comment_like_scoped: '校园评价点赞状态',
  set_reply_like_scoped: '校园回复点赞状态',
  set_target_subscription_scoped: '校园目标订阅状态',
  create_target_scoped: '校园评分对象创建',
  edit_target_scoped: '校园评分对象编辑',
  create_categories: '管理员创建评分分类',
  edit_target: '创建者编辑评分对象',
  create_target: '评分对象创建',
  delete_target: '创建者删除评分对象',
  admin_delete_comment: '管理员删除评价',
  admin_delete_reply: '管理员删除回复',
  set_target_subscription: '目标订阅状态',
  set_score: '评分',
  create_comment: '文字评价发布',
  delete_comment: '文字评价删除',
  create_reply: '回复发布',
  delete_reply: '回复删除',
  set_comment_like: '评价点赞状态',
  set_reply_like: '回复点赞状态',
} as const;
export function runRatingCommand(
  runtime: CommunityRuntime,
  attempt: PendingRating,
  cancel: Cancellation,
  retry: boolean,
): Promise<RatingCommandReceipt> {
  const owner = runtime.sessions.snapshot();
  const accountId = owner.credentials?.accountId;
  if (attempt.accountId !== accountId)
    throw new ClientError('stale-session', 'Account changed');
  runtime.pendingRatings!.assertOriginal(attempt);
  const intent = attempt.intent;
  if (isRatingCategoryScopedIntent(intent)) {
    if (!runtime.ratingCategoryScoped)
      throw new ClientError('configuration', 'Category management unavailable');
    // A generic retry must never commit an unreviewed preview. The management
    // recovery page prepares the immutable original and asks for explicit confirmation.
    return runtime.ratingCategoryScoped.receipt(
      intent.payload.clientRequestId,
      cancel,
    );
  }
  if (isRatingScopedIntent(intent)) {
    if (!runtime.ratingScoped)
      throw new ClientError('configuration', 'Scoped ratings unavailable');
    return retry
      ? runtime.ratingScoped.command(intent, cancel)
      : runtime.ratingScoped.receipt(intent.payload.clientRequestId, cancel);
  }
  if (isRatingCategoryCreationIntent(intent)) {
    if (!runtime.ratingCategoryManagement)
      throw new ClientError('configuration', 'Category management unavailable');
    return retry
      ? runtime.ratingCategoryManagement.command(intent, cancel)
      : runtime.ratingCategoryManagement.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingTargetOwnerEditingIntent(intent)) {
    if (!runtime.ratingTargetOwnerEditing)
      throw new ClientError(
        'configuration',
        'Target owner editing unavailable',
      );
    return retry
      ? runtime.ratingTargetOwnerEditing.command(intent, cancel)
      : runtime.ratingTargetOwnerEditing.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingTargetOwnerDeletionIntent(intent)) {
    if (!runtime.ratingTargetOwnerDeletion)
      throw new ClientError(
        'configuration',
        'Target owner deletion unavailable',
      );
    return retry
      ? runtime.ratingTargetOwnerDeletion.command(intent, cancel)
      : runtime.ratingTargetOwnerDeletion.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingTargetCreationIntent(intent)) {
    if (!runtime.ratingManagement)
      throw new ClientError('configuration', 'Rating management unavailable');
    return retry
      ? runtime.ratingManagement.command(intent, cancel)
      : runtime.ratingManagement.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingAdminDeletionIntent(intent)) {
    if (!runtime.ratingDeletion)
      throw new ClientError('configuration', 'Rating deletion unavailable');
    if (!retry)
      return runtime.ratingDeletion.receipt(
        intent.payload.clientRequestId,
        cancel,
      );
    return runtime.ratingDeletion
      .command(intent, cancel)
      .catch((error: unknown) => {
        // GET failures and uncertain DELETE results cannot discard any journal.
        if (!cancel.isCancelled && isRatingDeletionContextChanged(error)) {
          runtime.sessions.assertCurrent(owner);
          runtime.pendingRatings!.releaseChangedAdminContext(attempt, error);
        }
        throw error;
      });
  }
  if (isRatingSubscriptionIntent(intent)) {
    if (!runtime.ratingSubscriptions)
      throw new ClientError(
        'configuration',
        'Rating subscriptions unavailable',
      );
    return retry
      ? runtime.ratingSubscriptions.command(intent, cancel)
      : runtime.ratingSubscriptions.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingLikeIntent(intent)) {
    if (!runtime.ratingLikes)
      throw new ClientError('configuration', 'Rating likes unavailable');
    return retry
      ? runtime.ratingLikes.command(intent, cancel)
      : runtime.ratingLikes.receipt(intent.payload.clientRequestId, cancel);
  }
  if (isRatingReplyIntent(intent)) {
    if (!runtime.ratingDiscussion)
      throw new ClientError('configuration', 'Rating discussion unavailable');
    return retry
      ? runtime.ratingDiscussion.command(intent, cancel)
      : runtime.ratingDiscussion.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (!runtime.ratings)
    throw new ClientError('configuration', 'Ratings unavailable');
  return retry
    ? runtime.ratings.command(intent, cancel)
    : runtime.ratings.receipt(intent.payload.clientRequestId, cancel);
}

/** Only a verified durable receipt releases the shared slot and invalidates current public snapshots. */
export function settleRatingCommand(
  runtime: CommunityRuntime,
  attempt: PendingRating,
  raw: RatingCommandReceipt,
): RatingCommandReceipt {
  if (attempt.accountId !== runtime.sessions.snapshot().credentials?.accountId)
    throw new ClientError('stale-session', 'Account changed');
  const receipt = runtime.pendingRatings!.settle(attempt, raw);
  if (
    (receipt.operation === 'delete_target' ||
      receipt.operation === 'edit_target') &&
    receipt.outcome !== 'rejected'
  )
    runtime.ratingTargetChanges?.publish({
      targetId: receipt.targetId,
      revision: receipt.revision,
    });
  if (
    receipt.operation === 'create_categories' &&
    receipt.outcome === 'applied'
  )
    runtime.ratingCatalogChanges?.publish({
      releaseId: receipt.releaseId,
      catalogs: receipt.catalogs,
    });
  if (
    (receipt.operation === 'edit_target_scoped' ||
      receipt.operation === 'create_target_scoped') &&
    receipt.outcome !== 'closed'
  )
    runtime.ratingTargetChanges?.publish({
      targetId: receipt.result.targetId,
      revision: receipt.result.revision,
    });
  if (
    isRatingCategoryScopedIntent(attempt.intent) &&
    'protocolVersion' in receipt &&
    receipt.protocolVersion === 2 &&
    receipt.outcome !== 'closed' &&
    'result' in receipt &&
    'heads' in receipt.result &&
    receipt.result.releaseId !== null
  ) {
    runtime.ratingCatalogChanges?.publish({
      releaseId: receipt.result.releaseId,
      catalogs: [],
      scopedHeads: receipt.result.heads,
    });
  }
  return receipt;
}
