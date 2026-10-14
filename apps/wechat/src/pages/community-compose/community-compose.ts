import { tradingCategories } from '../../community/trading-contract';
import type { WhaleuApp } from '../../app';
import { isCategory } from '../../community/contract';
import { isUuid } from '../../profile/contract';
import {
  ComposeController,
  initialComposeView,
  type ComposeTarget,
} from './controller';
Page({
  data: { ...initialComposeView(), tradingCategories },
  controller: undefined as ComposeController | undefined,
  target: null as ComposeTarget | null,
  copySource: null as { kind: 'comment' | 'reply'; id: string } | null,
  onLoad(
    query: {
      viewSpaceId?: string;
      spaceId?: string;
      category?: string;
      postId?: string;
      rootCommentId?: string;
      targetReplyId?: string;
      copyCommentId?: string;
      copyReplyId?: string;
      ratingActorId?: string;
      ratingTargetId?: string;
      ratingCampusId?: string;
      ratingDestinationCampusId?: string;
      ratingScope?: string;
    } = {},
  ) {
    const hasRating =
      query.ratingTargetId !== undefined ||
      query.ratingActorId !== undefined ||
      query.ratingScope !== undefined ||
      query.ratingCampusId !== undefined ||
      query.ratingDestinationCampusId !== undefined;
    if (hasRating) {
      this.copySource = null;
      this.target =
        isUuid(query.spaceId) &&
        query.category === 'discussion' &&
        isUuid(query.ratingActorId) &&
        isUuid(query.ratingTargetId) &&
        isUuid(query.ratingDestinationCampusId) &&
        (query.ratingScope === 'global'
          ? query.ratingCampusId === undefined
          : query.ratingScope === 'campus' && isUuid(query.ratingCampusId)) &&
        query.postId === undefined &&
        query.rootCommentId === undefined &&
        query.copyCommentId === undefined &&
        query.copyReplyId === undefined &&
        query.targetReplyId === undefined &&
        (query.viewSpaceId === undefined || query.viewSpaceId === query.spaceId)
          ? {
              operation: 'publish_post',
              spaceId: query.spaceId,
              category: 'discussion',
              ratingLink: {
                actorId: query.ratingActorId,
                targetId: query.ratingTargetId,
                destinationCampusId: query.ratingDestinationCampusId,
                selector:
                  query.ratingScope === 'global'
                    ? { kind: 'global' }
                    : { kind: 'campus', campusId: query.ratingCampusId! },
              },
            }
          : null;
      return;
    }
    this.copySource = isUuid(query.copyReplyId)
      ? { kind: 'reply', id: query.copyReplyId }
      : isUuid(query.copyCommentId)
        ? { kind: 'comment', id: query.copyCommentId }
        : null;
    if (
      (query.viewSpaceId !== undefined && !isUuid(query.viewSpaceId)) ||
      (query.copyReplyId !== undefined && !isUuid(query.copyReplyId)) ||
      (query.copyCommentId !== undefined && !isUuid(query.copyCommentId)) ||
      (query.copyReplyId !== undefined && query.copyCommentId !== undefined)
    ) {
      this.target = null;
      this.copySource = null;
      return;
    }
    if (
      query.rootCommentId !== undefined ||
      query.targetReplyId !== undefined
    ) {
      this.target =
        isUuid(query.postId) &&
        isUuid(query.rootCommentId) &&
        (query.targetReplyId === undefined || isUuid(query.targetReplyId))
          ? {
              ...(query.viewSpaceId ? { viewSpaceId: query.viewSpaceId } : {}),
              operation: 'publish_reply',
              postId: query.postId,
              rootCommentId: query.rootCommentId,
              targetReplyId: query.targetReplyId ?? null,
            }
          : null;
      return;
    }
    this.target = isUuid(query.postId)
      ? {
          operation: 'publish_comment',
          postId: query.postId,
          ...(query.viewSpaceId ? { viewSpaceId: query.viewSpaceId } : {}),
        }
      : isUuid(query.spaceId) && isCategory(query.category)
        ? {
            ...(query.viewSpaceId ? { viewSpaceId: query.viewSpaceId } : {}),
            operation: 'publish_post',
            spaceId: query.spaceId,
            category: query.category,
          }
        : null;
  },
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new ComposeController(
      runtime,
      this.target,
      (view) => this.setData({ ...view }),
      undefined,
      this.copySource,
    );
    void this.controller.load();
  },
  onSelectImage() {
    void this.controller?.selectImage();
  },
  onRecoverImage() {
    void this.controller?.recoverImage();
  },
  onCancelImage() {
    void this.controller?.cancelImage();
  },
  onRemoveImage(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.removeImage(event.currentTarget.dataset.id);
  },
  onMoveImage(event: {
    currentTarget: { dataset: { id: string; direction: number } };
  }) {
    const { id, direction } = event.currentTarget.dataset;
    if (Number(direction) === -1 || Number(direction) === 1)
      void this.controller?.moveImage(id, Number(direction) as -1 | 1);
  },
  onReplaceImage(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.replaceImage(event.currentTarget.dataset.id);
  },
  onFeedbackField(event: {
    detail: { value: string };
    currentTarget: { dataset: { field: string } };
  }) {
    this.controller?.setFeedbackField(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onFeedbackConsent(event: { detail: { value: boolean } }) {
    this.controller?.setFeedbackConsent(event.detail.value);
  },
  onTradingField(event: {
    detail: { value: string };
    currentTarget: { dataset: { field: string } };
  }) {
    this.controller?.setTradingField(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onTradingSubtype(event: { currentTarget: { dataset: { key: string } } }) {
    this.controller?.setTradingSubtype(event.currentTarget.dataset.key);
  },
  onTradingUrgency(event: { currentTarget: { dataset: { key: string } } }) {
    this.controller?.setTradingUrgency(event.currentTarget.dataset.key);
  },
  onContactConsent(event: { detail: { value: boolean } }) {
    this.controller?.setContactConsent(event.detail.value);
  },
  onText(event: { detail: { value: string } }) {
    this.controller?.setText(event.detail.value);
  },
  onMode(event: { currentTarget: { dataset: { mode: string } } }) {
    this.controller?.setAuthorMode(event.currentTarget.dataset.mode);
  },
  onRelatedCampusSync(event: { detail: { value: boolean } }) {
    this.controller?.setRelatedCampusSync(event.detail.value);
  },
  onAllowAnonymousDm(event: { detail: { value: boolean } }) {
    this.controller?.setAllowAnonymousDm(event.detail.value);
  },
  onRestricted(event: { detail: { value: boolean } }) {
    this.controller?.setRestricted(event.detail.value);
  },
  onPollEnabled(event: { detail: { value: boolean } }) {
    this.controller?.setPollEnabled(event.detail.value);
  },
  onPollQuestion(event: { detail: { value: string } }) {
    this.controller?.setPollQuestion(event.detail.value);
  },
  onPollMode(event: { currentTarget: { dataset: { mode: string } } }) {
    this.controller?.setPollMode(event.currentTarget.dataset.mode);
  },
  onPollOption(event: {
    detail: { value: string };
    currentTarget: { dataset: { index: number } };
  }) {
    this.controller?.setPollOption(
      Number(event.currentTarget.dataset.index),
      event.detail.value,
    );
  },
  onAddPollOption() {
    this.controller?.addPollOption();
  },
  onRemovePollOption(event: { currentTarget: { dataset: { index: number } } }) {
    this.controller?.removePollOption(
      Number(event.currentTarget.dataset.index),
    );
  },
  onPollFinal(event: { detail: { value: boolean } }) {
    this.controller?.setPollFinal(event.detail.value);
  },
  onFormationEnabled(event: { detail: { value: boolean } }) {
    this.controller?.setFormationEnabled(event.detail.value);
  },
  onFormationField(event: {
    detail: { value: string };
    currentTarget: { dataset: { field: string } };
  }) {
    this.controller?.setFormationField(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onFormationConsent(event: { detail: { value: boolean } }) {
    this.controller?.setFormationConsent(event.detail.value);
  },
  onRatingLabel(event: { detail: { value: string } }) {
    this.controller?.setRatingLinkLabel(event.detail.value);
  },
  onRemoveRatingLink() {
    this.controller?.removeRatingLink();
  },
  onGenerateRatingLabel() {
    void this.controller?.generateRatingLabel();
  },
  onAdoptRatingLabel() {
    void this.controller?.adoptRatingLabel();
  },
  onRecoverAssistance() {
    void this.controller?.recoverAssistance();
  },
  onCancelAssistance() {
    void this.controller?.cancelAssistance();
  },
  onDismissAssistance() {
    this.controller?.dismissAssistance();
  },
  onSubmit() {
    void this.controller?.submit();
  },
  onReceipt() {
    void this.controller?.recover();
  },
  onCancelReview() {
    void this.controller?.cancelReview();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onReload() {
    void this.controller?.load();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
