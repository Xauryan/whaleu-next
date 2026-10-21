import {
  DEFAULT_TEXT_SOURCE,
  decodeTextSourceDescriptor,
  sourceTextAvailable,
  type TextSourceDescriptor,
  type TextSourceCapability,
} from '../../community/text-source-contract';
import { systemClock } from '../../platform/clock';
import {
  AssistanceController,
  initialAssistanceView,
  type AssistanceView,
} from '../../ratings/assistance-controller';
import {
  decodeRatingScopedCommandContext,
  canonicalRatingScopedJson,
  type RatingScopedContext,
} from '../../ratings/scoped-contract';
import {
  decodeRatingTargetLinkComponent,
  ratingLinkFallback,
  ratingLinkLabel,
  type RatingTargetLinkCapability,
  type RatingLinkHandoff,
} from '../../community/rating-link-contract';
import {
  emptyFeedbackDraft,
  feedbackDraftInput,
  type FeedbackDraft,
} from '../../community/feedback-contract';
import { batchPublicationReference } from '../../media/batch-publication';
import {
  matchReviewCancellation,
  type ReviewCancellationResult,
  matchPublicationReview,
  supportsTextReview,
  type PublicationReview,
} from '../../community/review-contract';
import type { BatchTarget } from '../../media/batch-engine-contracts';
import type {
  MediaBatchController,
  BatchMemberView,
} from '../../media/batch-controller';
import type {
  MediaUploadController,
  UploadView,
} from '../../media/upload-controller';
import {
  emptyTradingDraft,
  intentTradingDraft,
  tradingDraftIntent,
  type TradingDraft,
} from '../../community/trading-draft';
import { isTradingSubtype } from '../../community/trading-contract';
import {
  checkDiscussionPrivacy,
  decodeReplyIntent,
} from '../../community/discussion-contract';
import { ClientError } from '../../api/errors';
import type { Preferences } from '../../profile/contract';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from '../../community/controller';
import {
  boundedText,
  decodeCommentIntent,
  decodePostIntent,
  decodeReceipt,
  type AuthorMode,
  type Capabilities,
  type CommentCapabilities,
  type Category,
  type Post,
  type Receipt,
} from '../../community/contract';
import {
  componentDraft,
  emptyPollDraft,
  pollDraftComponent,
  type PollDraft,
} from '../../community/poll-draft';
import {
  componentFormationDraft,
  emptyFormationDraft,
  formationDraftComponent,
  type FormationDraft,
} from '../../community/formation-draft';
import type { PendingAttempt } from '../../community/pending-attempt';
import type { CommunityRuntime } from '../../community/runtime';
import type { Cancellation } from '../../platform/contracts';
export type ComposeTarget = { readonly viewSpaceId?: string } & (
  | {
      readonly operation: 'publish_post';
      readonly spaceId: string;
      readonly category: Category;
      readonly ratingLink?: RatingLinkHandoff;
    }
  | { readonly operation: 'publish_comment'; readonly postId: string }
  | {
      readonly operation: 'publish_reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly targetReplyId: string | null;
    }
);
export interface ComposeView extends CommunityView {
  readonly textSource: TextSourceDescriptor | null;
  readonly canChooseTextSource: boolean;
  readonly sourcePreview: boolean;
  readonly sourceNotice: string;
  readonly assistance: AssistanceView;
  readonly ratingLinkName: string;
  readonly ratingLinkLabel: string;
  readonly hasRatingLink: boolean;
  readonly syncToRelatedCampuses: boolean;
  readonly canChooseRelatedCampusSync: boolean;
  readonly relatedCampusSyncNotice: string;
  readonly viewSpaceId: string;
  readonly viewSpaceQuery: string;
  readonly isFeedback: boolean;
  readonly feedbackDraft: FeedbackDraft;
  readonly allowAnonymousDm: boolean;
  readonly canChooseAnonymousDm: boolean;
  readonly loaded: boolean;
  readonly text: string;
  readonly authorMode: AuthorMode;
  readonly effectiveIdentity: string;
  readonly identityForced: boolean;
  readonly commentsPolicy: 'open' | 'restricted';
  readonly canDisableComments: boolean;
  readonly frozen: boolean;
  readonly canSubmit: boolean;
  readonly canOpenIdentityCampus: boolean;
  readonly blocker: string;
  readonly mediaNotice: string;
  readonly canSelectImage: boolean;
  readonly mediaStatus: UploadView['status'];
  readonly mediaProgress: number;
  readonly batchMode: boolean;
  readonly mediaMembers: readonly BatchMemberView[];
  readonly mediaReady: number;
  readonly mediaSelected: number;
  readonly maxImages: number;
  readonly mediaCanEdit: boolean;
  readonly mediaBusy: boolean;
  readonly maxText: number;
  readonly canCancelReview: boolean;
  readonly reviewStatus: PublicationReview['status'] | '';
  readonly receiptStatus: string;
  readonly resourceId: string;
  readonly resourcePostId: string;
  readonly resourceRootCommentId: string;
  readonly resourceReplyId: string;
  readonly replyTargetName: string;
  readonly recoveryOperation: string;
  readonly pollDraft: PollDraft;
  readonly canAddPoll: boolean;
  readonly formationDraft: FormationDraft;
  readonly canAddFormation: boolean;
  readonly isTrading: boolean;
  readonly tradingDraft: TradingDraft;
}
export const initialComposeView = (): ComposeView => ({
  ...initialCommunityView(),
  textSource: null,
  canChooseTextSource: false,
  sourcePreview: false,
  sourceNotice: '',
  assistance: initialAssistanceView(),
  ratingLinkName: '',
  ratingLinkLabel: '',
  hasRatingLink: false,
  syncToRelatedCampuses: false,
  canChooseRelatedCampusSync: false,
  relatedCampusSyncNotice: '',
  viewSpaceId: '',
  viewSpaceQuery: '',
  isFeedback: false,
  feedbackDraft: emptyFeedbackDraft(),
  allowAnonymousDm: false,
  canChooseAnonymousDm: false,
  loaded: false,
  text: '',
  authorMode: 'named',
  effectiveIdentity: '',
  identityForced: false,
  commentsPolicy: 'open',
  canDisableComments: false,
  frozen: false,
  canSubmit: false,
  canOpenIdentityCampus: false,
  blocker: '',
  mediaNotice: '图片上传、预览与审核尚未接入，暂不能添加图片',
  canSelectImage: false,
  mediaStatus: 'idle',
  mediaProgress: 0,
  batchMode: false,
  mediaMembers: [],
  mediaReady: 0,
  mediaSelected: 0,
  maxImages: 9,
  mediaCanEdit: false,
  mediaBusy: false,
  maxText: 2500,
  canCancelReview: false,
  reviewStatus: '',
  receiptStatus: '',
  resourceId: '',
  resourcePostId: '',
  resourceRootCommentId: '',
  resourceReplyId: '',
  replyTargetName: '',
  recoveryOperation: '',
  pollDraft: emptyPollDraft(),
  canAddPoll: false,
  formationDraft: emptyFormationDraft(),
  canAddFormation: false,
  isTrading: false,
  tradingDraft: emptyTradingDraft(),
});
/** An inconsistent imported default must require a choice, never silently reveal a named identity. */
export function commentIdentity(
  forcedAnonymous: boolean,
  explicit: AuthorMode | null,
  preferences: Pick<
    Preferences,
    'defaultCommentAnonymousEnabled' | 'defaultCommentNonAnonymousEnabled'
  >,
  lastMode: AuthorMode | null = null,
  anonymousParent = false,
): { mode: AuthorMode; conflict: boolean } {
  if (forcedAnonymous) return { mode: 'anonymous', conflict: false };
  if (explicit) return { mode: explicit, conflict: false };
  if (lastMode) return { mode: lastMode, conflict: false };
  if (
    preferences.defaultCommentAnonymousEnabled &&
    preferences.defaultCommentNonAnonymousEnabled
  )
    return { mode: 'anonymous', conflict: true };
  return {
    mode: preferences.defaultCommentAnonymousEnabled
      ? 'anonymous'
      : preferences.defaultCommentNonAnonymousEnabled
        ? 'named'
        : anonymousParent
          ? 'anonymous'
          : 'named',
    conflict: false,
  };
}
const targetKey = (target: ComposeTarget): string =>
  target.operation === 'publish_post'
    ? `post:${target.spaceId}:${target.category}`
    : target.operation === 'publish_comment'
      ? `comment:${target.postId}`
      : `reply:${target.postId}:${target.rootCommentId}:${target.targetReplyId ?? 'root'}`;
const attemptTarget = (attempt: PendingAttempt): ComposeTarget =>
  attempt.operation === 'publish_post'
    ? {
        operation: 'publish_post',
        spaceId: attempt.payload.spaceId,
        category: attempt.payload.category,
      }
    : attempt.operation === 'publish_comment'
      ? { operation: 'publish_comment', postId: attempt.postId }
      : {
          operation: 'publish_reply',
          postId: attempt.postId,
          rootCommentId: attempt.rootCommentId,
          targetReplyId: attempt.payload.targetReplyId,
        };
export class ComposeController extends CommunityController<ComposeView> {
  private readonly assistance: AssistanceController;
  private ratingLink: RatingTargetLinkCapability | null = null;
  private ratingLinkContext: RatingScopedContext | null = null;
  private linkExpiry: (() => void) | null = null;
  private readonly linkUnsubscriptions: readonly (() => void)[];
  private readonly uploader: MediaUploadController | undefined;
  private readonly batcher: MediaBatchController | undefined;
  private mediaMode: 'legacy' | 'batch' | 'conflict' = 'legacy';
  private mediaGeneration = 0;
  private mediaDisposed = false;
  private mediaAction: { kind: string; task: Promise<void> } | null = null;
  private sourceCapabilities: readonly TextSourceCapability[] = [];
  private capabilities: Capabilities | null = null;
  private commentCapabilities: CommentCapabilities | null = null;
  private parentPost: Post | null = null;
  private pending: PendingAttempt | null = null;
  private draftSaved = false;
  private identityConflict = false;
  constructor(
    runtime: CommunityRuntime,
    private readonly target: ComposeTarget | null,
    render: (view: ComposeView) => void,
    private readonly onCreated: (receipt: Receipt) => void = () => undefined,
    private readonly copySource: {
      kind: 'comment' | 'reply';
      id: string;
    } | null = null,
  ) {
    super(runtime, initialComposeView, render);
    this.assistance = new AssistanceController(
      runtime,
      (assistance) => this.update({ assistance }),
      () => this.editable(),
    );
    const invalidateLink = () => {
      if (!this.ratingLink && !this.isRatingLinkJourney()) return;
      this.stop();
      this.assistance.invalidate();
      this.ratingLink = null;
      this.ratingLinkContext = null;
      this.update({
        ratingLinkName: '',
        ratingLinkLabel: '',
        hasRatingLink: false,
        text: '',
        loaded: false,
        canSubmit: false,
        error: '评分对象、身份或范围已变化，请重新加载；原发布请求仍受保护',
      });
    };
    this.linkUnsubscriptions = [
      runtime.ratingTargetChanges?.subscribe(invalidateLink),
      runtime.ratingCatalogChanges?.subscribe(invalidateLink),
      runtime.browsingScopeChanges?.subscribe(invalidateLink),
    ].filter((v): v is () => void => !!v);
    try {
      this.mediaMode =
        runtime.mediaBatch && this.accountId()
          ? runtime.mediaBatch.modeForActor(this.accountId()!)
          : 'legacy';
    } catch {
      this.mediaMode = 'conflict';
    }
    this.batcher = runtime.mediaBatch?.create((view) => {
      if (
        this.mediaDisposed ||
        this.isRatingLinkJourney() ||
        this.mediaMode === 'legacy'
      )
        return;
      this.update({
        batchMode: true,
        mediaStatus: view.status,
        mediaProgress: view.progress,
        mediaMembers: view.members,
        mediaReady: view.ready,
        mediaSelected: view.selected,
        mediaCanEdit: view.canEdit,
        maxImages: view.maxMembers,
        ...(view.status === 'publication_pending' ? { frozen: true } : {}),
        canSelectImage: view.canAdd,
        mediaNotice: `已就绪 ${view.ready} / 已选 ${view.selected}，最多 ${view.maxMembers} 张。${view.retiring ? '有图片取消尚未确认。' : ''}任何图片状态未知时均不能发布。`,
      });
      this.recompute();
    }, this.target?.operation);
    this.uploader = runtime.mediaUpload?.create((view) => {
      if (
        this.mediaDisposed ||
        this.isRatingLinkJourney() ||
        this.mediaMode !== 'legacy'
      )
        return;
      this.update({
        mediaStatus: view.status,
        mediaProgress: view.progress,
        canSelectImage: this.uploader?.available === true,
        mediaNotice: mediaUploadNotice(view),
      });
      this.recompute();
    });
  }
  private isRatingLinkJourney(): boolean {
    // A pre-existing historical command always wins over a new rating-card route.
    return this.pending
      ? this.pending.version === 5
      : this.target?.operation === 'publish_post' && !!this.target.ratingLink;
  }
  protected override update(patch: Partial<ComposeView>): void {
    const keys = [
      'text',
      'authorMode',
      'commentsPolicy',
      'ratingLinkLabel',
      'ratingLinkName',
      'hasRatingLink',
      'frozen',
      'syncToRelatedCampuses',
    ] as const;
    if (
      this.assistance &&
      keys.some((key) => key in patch && patch[key] !== this.view[key])
    )
      this.assistance.invalidate();
    super.update(patch);
  }
  private loadPending(accountId: string): PendingAttempt | null {
    const legacy = this.runtime.pending.load(accountId),
      link = this.runtime.pendingRatingLinks?.load(accountId) ?? null;
    if (legacy && link)
      throw new ClientError(
        'storage',
        'Conflicting publication journals require original-key recovery',
      );
    return legacy ?? link;
  }
  setRatingLinkLabel(value: string): void {
    if (!this.editable() || !this.ratingLink) return;
    this.update({ ratingLinkLabel: value });
    this.recompute();
  }
  removeRatingLink(): void {
    if (!this.editable()) return;
    try {
      if (
        this.target &&
        this.runtime.drafts.load(this.accountId()!, targetKey(this.target))
      ) {
        this.update({
          error:
            '此范围已有普通草稿，请先从普通发帖入口处理；不会用评分卡片草稿覆盖它',
        });
        return;
      }
    } catch (error) {
      this.update({ error: communityError(error) });
      return;
    }
    this.assistance.invalidate();
    this.ratingLink = null;
    this.ratingLinkContext = null;
    this.update({
      hasRatingLink: false,
      ratingLinkName: '',
      ratingLinkLabel: '',
    });
    this.recompute();
  }
  async generateRatingLabel(): Promise<void> {
    const link = this.ratingLink,
      context = this.ratingLinkContext,
      target = this.target;
    if (
      !this.editable() ||
      !link ||
      !context ||
      this.capabilities?.ratingTargetLink?.availability !== 'allowed' ||
      !this.capabilities.ratingTargetLink.authorModes.includes(
        this.view.authorMode,
      ) ||
      target?.operation !== 'publish_post' ||
      context.purpose !== 'read' ||
      context.mode !== 'public' ||
      context.heads.length !== 1
    )
      return;
    await this.assistance.generate({
      purpose: 'rating_publish_title',
      selector: link.selector,
      context: decodeRatingScopedCommandContext({
        id: context.id,
        token: context.token,
        tokenDigest: context.tokenDigest,
        selector: context.selector,
        scopeRevision: context.scopeRevision,
        protocolGeneration: context.protocolGeneration,
        catalogRevision: context.heads[0]!.catalogRevision,
        headRevision: context.heads[0]!.headRevision,
        sourceDigest: context.sourceDigest,
      }),
      payload: {
        targetId: link.targetId,
        expectedTargetRevision: link.expectedTargetRevision,
        expectedCategoryRevision: link.expectedCategoryRevision,
        expectedSourceRevision: link.expectedSourceRevision,
        destination: {
          spaceId: target.spaceId,
          category: 'discussion',
          authorMode: this.view.authorMode,
        },
      },
    });
  }
  adoptRatingLabel(): Promise<void> {
    return this.assistance.adopt((text) => this.setRatingLinkLabel(text));
  }
  recoverAssistance(): Promise<void> {
    return this.assistance.recover();
  }
  cancelAssistance(): Promise<void> {
    return this.assistance.cancel();
  }
  dismissAssistance(): void {
    this.assistance.dismiss();
  }
  private useBatch(): boolean {
    return (
      !this.isRatingLinkJourney() &&
      this.mediaMode === 'batch' &&
      !!this.batcher
    );
  }
  private activeUploader():
    MediaBatchController | MediaUploadController | undefined {
    return this.isRatingLinkJourney() || this.mediaMode === 'conflict'
      ? undefined
      : this.useBatch()
        ? this.batcher
        : this.uploader;
  }
  private refreshMediaMode(): boolean {
    try {
      this.mediaMode =
        this.runtime.mediaBatch && this.accountId()
          ? this.runtime.mediaBatch.modeForActor(this.accountId()!)
          : 'legacy';
      if (this.mediaMode === 'conflict')
        throw new ClientError(
          'storage',
          'Legacy and batch recovery both require confirmation',
        );
      return true;
    } catch (error) {
      this.mediaMode = 'conflict';
      this.update({
        frozen: true,
        canSubmit: false,
        canSelectImage: false,
        batchMode: !!this.batcher,
        error: communityError(error),
        blocker:
          '旧图片与整批图片记录需先分别恢复；无法读取的记录不会被当作不存在',
      });
      return false;
    }
  }
  protected override resetPrivate(): void {
    this.sourceCapabilities = [];
    this.assistance?.invalidate();
    this.ratingLink = null;
    this.ratingLinkContext = null;
    this.linkExpiry?.();
    this.linkExpiry = null;
    this.mediaGeneration++;
    this.mediaAction = null;
    this.uploader?.hide();
    this.batcher?.hide();
    this.capabilities = null;
    this.commentCapabilities = null;
    this.parentPost = null;
    this.pending = null;
    this.draftSaved = false;
    this.identityConflict = false;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    if (!this.available()) return;
    this.stop();
    this.resetPrivate();
    this.update({
      ...initialComposeView(),
      configured: !!this.runtime.gateway,
      hasSession: !!this.accountId(),
    });
    const accountId = this.accountId()!;
    if (!this.refreshMediaMode()) return;
    if (this.activeUploader()?.available) {
      this.update({ canSelectImage: true });
      void this.recoverImage();
    }
    try {
      const pending = this.loadPending(accountId);
      if (pending) {
        this.showPending(pending);
        return;
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        blocker: '无法读取发布记录，禁止新建请求以免重复发布',
      });
      return;
    }
    if (!this.target) {
      this.update({
        loaded: true,
        status: '当前账号没有待确认的发布',
        blocker: '可以返回社区创建帖子',
      });
      return;
    }
    if (!this.runtime.profiles) return;
    const target = this.target;
    if (
      target.operation === 'publish_post' &&
      target.ratingLink?.actorId !== undefined &&
      target.ratingLink.actorId !== accountId
    ) {
      this.update({
        loaded: false,
        error: '此评分卡片入口属于另一登录账号，请从当前评分对象重新进入',
      });
      return;
    }
    this.assistance.refresh();
    await this.run(
      async (cancel) => {
        const [profile, post] = await Promise.all([
          this.runtime.profiles!.profile(cancel),
          target.operation !== 'publish_post'
            ? this.runtime.gateway!.post(
                target.postId,
                cancel,
                target.viewSpaceId,
              )
            : Promise.resolve(null),
        ]);
        if (profile.accountId !== accountId)
          throw new ClientError('protocol', 'Profile owner mismatch');
        const capability =
          target.operation === 'publish_post'
            ? await this.runtime.gateway!.capabilities(
                target.spaceId,
                target.category,
                cancel,
              )
            : null;
        const commentCapability =
          target.operation !== 'publish_post'
            ? await this.runtime.gateway!.commentCapabilities(
                target.postId,
                cancel,
              )
            : null;
        let linkRead: {
          capability: RatingTargetLinkCapability;
          context: RatingScopedContext;
          name: string;
        } | null = null;
        if (target.operation === 'publish_post' && target.ratingLink) {
          if (
            target.category !== 'discussion' ||
            !this.runtime.ratingScoped ||
            !this.runtime.pendingRatingLinks
          )
            throw new ClientError(
              'configuration',
              'Rating link owner unavailable',
            );
          const handoff = target.ratingLink,
            context = await this.runtime.ratingScoped.context(
              { purpose: 'read', mode: 'public', selector: handoff.selector },
              cancel,
            );
          if (
            Date.parse(context.expiresAt) <= systemClock.now() ||
            context.actorId !== accountId ||
            context.mode !== 'public' ||
            context.purpose !== 'read' ||
            context.heads.length !== 1 ||
            canonicalRatingScopedJson(context.selector) !==
              canonicalRatingScopedJson(handoff.selector)
          )
            throw new ClientError('protocol', 'Rating link context mismatch');
          const [rating, spaces] = await Promise.all([
            this.runtime.ratingScoped.detail(context, handoff.targetId, cancel),
            this.runtime.gateway!.spaces(handoff.destinationCampusId, cancel),
          ]);
          const capability = rating.ratingTargetLink;
          if (
            !capability ||
            rating.id !== handoff.targetId ||
            capability.targetId !== rating.id ||
            capability.expectedTargetRevision !== rating.revision ||
            canonicalRatingScopedJson(capability.selector) !==
              canonicalRatingScopedJson(handoff.selector) ||
            !spaces.regional?.isActive ||
            spaces.regional.id !== target.spaceId
          )
            throw new ClientError(
              'business',
              'Current rating target or destination unavailable',
            );
          linkRead = { capability, context, name: rating.name };
        }
        let replyTargetName = '';
        if (target.operation === 'publish_reply') {
          const root = await this.runtime.gateway!.comment(
            target.rootCommentId,
            cancel,
          );
          if (!post || root.postId !== post.id)
            throw new ClientError('protocol', 'Root target mismatch');
          checkDiscussionPrivacy(post, [root.author]);
          if (target.targetReplyId) {
            const reply = await this.runtime.gateway!.reply(
              target.targetReplyId,
              cancel,
            );
            if (reply.postId !== post.id || reply.rootCommentId !== root.id)
              throw new ClientError('protocol', 'Reply target mismatch');
            checkDiscussionPrivacy(post, [
              reply.author,
              ...(reply.target.status === 'available'
                ? [reply.target.author]
                : []),
            ]);
            replyTargetName = reply.author.displayName;
          } else replyTargetName = root.author.displayName;
        }
        let copiedText: string | null = null;
        if (this.copySource) {
          if (!post || target.operation === 'publish_post')
            throw new ClientError('protocol', 'Invalid copy destination');
          const source =
            this.copySource.kind === 'comment'
              ? await this.runtime.gateway!.comment(this.copySource.id, cancel)
              : await this.runtime.gateway!.reply(this.copySource.id, cancel);
          if (source.postId !== post.id)
            throw new ClientError('protocol', 'Copy parent mismatch');
          checkDiscussionPrivacy(post, [source.author]);
          if (this.copySource.kind === 'reply') {
            if (
              !('target' in source) ||
              target.operation !== 'publish_reply' ||
              source.rootCommentId !== target.rootCommentId ||
              source.target.status !== 'available' ||
              (source.target.kind === 'reply' ? source.target.id : null) !==
                target.targetReplyId
            )
              throw new ClientError(
                'protocol',
                'Original reply target unavailable or changed',
              );
            checkDiscussionPrivacy(post, [source.target.author]);
          } else if (target.operation !== 'publish_comment')
            throw new ClientError('protocol', 'Root copy must create a root');
          copiedText = source.text;
        }
        const sourceContext =
          target.operation === 'publish_post'
            ? { spaceId: target.spaceId, category: target.category }
            : post
              ? { spaceId: post.space.id, category: post.category }
              : null;
        const canChooseTextSource =
          !!this.runtime.gateway!.textSourceCapabilities &&
          !!sourceContext &&
          sourceContext.category !== 'trading' &&
          sourceContext.category !== 'feedback' &&
          !linkRead;
        // Source advisory failure cannot silently downgrade a new source draft,
        // and must not prevent recovery of an already-existing legacy draft.
        const sourceCapabilities: TextSourceCapability[] = [];
        if (canChooseTextSource && sourceContext) {
          try {
            sourceCapabilities.push(
              ...(await Promise.all(
                (['named', 'anonymous'] as const).map((mode) =>
                  this.runtime.gateway!.textSourceCapabilities!(
                    sourceContext.spaceId,
                    sourceContext.category,
                    mode,
                    cancel,
                  ),
                ),
              )),
            );
          } catch (error) {
            if (
              !(error instanceof ClientError) ||
              [
                'auth-required',
                'auth-expired',
                'stale-session',
                'cancelled',
              ].includes(error.kind)
            )
              throw error;
          }
        }
        return {
          canChooseTextSource,
          sourceCapabilities,
          profile,
          post,
          capability,
          commentCapability,
          replyTargetName,
          copiedText,
          linkRead,
        };
      },
      (result) => {
        // Another page may have frozen a request while profile/capabilities were loading.
        const pending = this.loadPending(accountId);
        if (pending) {
          this.showPending(pending);
          return;
        }
        this.sourceCapabilities = result.sourceCapabilities;
        this.capabilities = result.capability;
        this.commentCapabilities = result.commentCapability;
        this.parentPost = result.post;
        if (this.useBatch()) {
          try {
            this.batcher!.assertTarget(this.mediaTarget(''));
          } catch (error) {
            this.update({
              frozen: true,
              canSubmit: false,
              blocker: '请先恢复或取消原回复对象的整批图片',
            });
            throw error;
          }
        }
        this.ratingLink = result.linkRead?.capability ?? null;
        this.ratingLinkContext = result.linkRead?.context ?? null;
        this.linkExpiry?.();
        this.linkExpiry = null;
        if (result.linkRead)
          this.linkExpiry = systemClock.schedule(
            () => {
              this.assistance.invalidate();
              this.ratingLink = null;
              this.ratingLinkContext = null;
              if (this.pending) {
                this.update({ ratingLinkName: '' });
                return;
              }
              this.stop();
              this.update({
                text: '',
                ratingLinkLabel: '',
                ratingLinkName: '',
                hasRatingLink: false,
                loaded: false,
                canSubmit: false,
                error: '评分对象查看凭据已过期，请重新加载',
              });
            },
            Date.parse(result.linkRead.context.expiresAt) - systemClock.now(),
          );
        const draft = this.isRatingLinkJourney()
          ? null
          : this.runtime.drafts.load(accountId, targetKey(target));
        const forced =
          result.commentCapability?.forcedAuthorMode === 'anonymous' ||
          (result.post?.viewer.isSelf === true &&
            result.post.author.kind === 'anonymous');
        const trading =
          target.operation === 'publish_post' && target.category === 'trading';
        const feedback =
          target.operation === 'publish_post' && target.category === 'feedback';
        const remembered = trading
          ? this.runtime.drafts.loadTradingPreferences(accountId)
          : null;
        const initialTrading = remembered
          ? {
              ...emptyTradingDraft(),
              location: remembered.location,
              ...remembered.contacts,
            }
          : emptyTradingDraft();
        const chosen =
          target.operation !== 'publish_post'
            ? commentIdentity(
                forced,
                draft?.authorMode ?? null,
                result.profile.preferences,
                result.commentCapability?.lastAuthorMode ?? null,
                result.post?.author.kind === 'anonymous',
              )
            : {
                mode:
                  draft?.authorMode ??
                  (result.profile.preferences.defaultAnonymousEnabled
                    ? 'anonymous'
                    : 'named'),
                conflict: false,
              };
        if (trading) {
          chosen.mode = 'named';
          chosen.conflict = false;
        }
        this.identityConflict = chosen.conflict;
        this.update({
          loaded: true,
          canChooseTextSource: result.canChooseTextSource,
          // Absent legacy draft descriptors remain absent; never auto-upgrade.
          textSource: draft
            ? (draft.textSource ?? null)
            : result.canChooseTextSource &&
                result.sourceCapabilities.some(
                  (item) =>
                    item.authorMode === chosen.mode &&
                    item.availability === 'available' &&
                    item.operations.includes(target.operation),
                ) &&
                !this.activeUploader()?.hasPendingDraft &&
                !result.profile.preferences.defaultAllowAnonymousDm
              ? DEFAULT_TEXT_SOURCE
              : null,
          sourcePreview: false,
          hasRatingLink: !!result.linkRead,
          ratingLinkName: result.linkRead?.name ?? '',
          ratingLinkLabel: result.linkRead
            ? ratingLinkFallback(result.linkRead.name)
            : '',
          ...(result.linkRead
            ? {
                canSelectImage: false,
                mediaNotice:
                  '评分卡片仅支持本地区普通文字讨论；正文与卡片标签分别填写',
              }
            : {}),
          viewSpaceQuery: target.viewSpaceId
            ? `&viewSpaceId=${encodeURIComponent(target.viewSpaceId)}`
            : '',
          viewSpaceId:
            target.viewSpaceId ??
            (target.operation === 'publish_post' ? target.spaceId : ''),
          syncToRelatedCampuses: false,
          canChooseRelatedCampusSync:
            target.operation === 'publish_post' &&
            !trading &&
            !feedback &&
            !result.linkRead &&
            result.capability?.relatedCampusSync?.availability === 'allowed',
          relatedCampusSyncNotice:
            target.operation === 'publish_post' && !trading && !feedback
              ? result.capability?.relatedCampusSync?.availability === 'allowed'
                ? '自愿将这一条帖子展示给当前关联学校。回复、点赞和分身共用同一条内容；关联关系变化会改变展示范围。不会公开你的具体身份校区。'
                : '当前无法启用关联学校同步，仍可按原范围发帖。需身份校区与发帖学校一致，并由服务端核验学校配置和同步策略。'
              : '',
          isTrading: trading,
          isFeedback: feedback,
          feedbackDraft: feedback
            ? (draft?.feedback ?? emptyFeedbackDraft())
            : emptyFeedbackDraft(),
          tradingDraft: trading
            ? (draft?.trading ?? initialTrading)
            : emptyTradingDraft(),
          replyTargetName: result.replyTargetName,
          text: draft?.text ?? result.copiedText ?? '',
          pollDraft:
            target.operation === 'publish_post' && !trading && !feedback
              ? (draft?.poll ?? emptyPollDraft())
              : emptyPollDraft(),
          canAddPoll:
            target.operation === 'publish_post' &&
            !trading &&
            !feedback &&
            !result.linkRead,
          formationDraft:
            target.operation === 'publish_post' && !trading && !feedback
              ? (draft?.formation ?? emptyFormationDraft())
              : emptyFormationDraft(),
          canAddFormation:
            target.operation === 'publish_post' &&
            !trading &&
            !feedback &&
            !result.linkRead,
          authorMode: chosen.mode,
          canChooseAnonymousDm:
            target.operation === 'publish_post' &&
            !feedback &&
            !result.linkRead,
          allowAnonymousDm: result.linkRead
            ? false
            : (draft?.allowAnonymousDm ??
              result.profile.preferences.defaultAllowAnonymousDm ??
              false),
          commentsPolicy: draft?.commentsPolicy ?? 'open',
          identityForced: forced || trading,
          canDisableComments:
            target.operation === 'publish_post' &&
            result.capability?.canDisableComments === true,
          maxText: target.operation === 'publish_post' ? 2500 : 500,
          status: draft
            ? this.copySource
              ? '已有草稿已保留，复制文字没有覆盖它'
              : '已恢复此账号的本地草稿'
            : this.copySource
              ? '已复制原文字，请检查目标和身份后确认发布'
              : '草稿仅保存在本机当前账号下',
        });
        this.persistDraft();
        this.recompute();
      },
      () => {
        this.capabilities = null;
        this.commentCapabilities = null;
        this.parentPost = null;
        this.update({ loaded: false, canSubmit: false });
      },
    );
  }
  private showPending(pending: PendingAttempt): void {
    this.assistance.invalidate();
    this.ratingLink = null;
    this.ratingLinkContext = null;
    this.pending = pending;
    this.update({
      textSource: pending.payload.textSource ?? null,
      canChooseTextSource: false,
      sourcePreview: false,
      sourceNotice: pending.payload.textSource
        ? '原文格式与排版选择已随原请求冻结；恢复不会更换请求编号。'
        : '',
      hasRatingLink: pending.version === 5,
      ratingLinkName: '',
      // Original-owner recovery never releases target-identifying text before fresh public proof.
      ratingLinkLabel: '',
      ...(pending.version === 5
        ? {
            canSelectImage: false,
            mediaNotice: '原评分卡片与正文已冻结；显示名称需要发布后重新核验',
          }
        : {}),
      canCancelReview:
        supportsTextReview(pending) && !!this.runtime.gateway?.cancelReview,
      reviewStatus: '',
      loaded: true,
      viewSpaceQuery: pending.viewSpaceId
        ? `&viewSpaceId=${encodeURIComponent(pending.viewSpaceId)}`
        : '',
      viewSpaceId:
        pending.viewSpaceId ??
        (pending.operation === 'publish_post' ? pending.payload.spaceId : ''),
      syncToRelatedCampuses:
        pending.operation === 'publish_post' &&
        pending.payload.syncToRelatedCampuses === true,
      canChooseRelatedCampusSync: false,
      relatedCampusSyncNotice:
        pending.operation === 'publish_post' &&
        pending.payload.syncToRelatedCampuses === true
          ? '原请求已选择关联学校同步；恢复、重试和取消始终使用这个原始选择。'
          : '',
      frozen: true,
      canSubmit: false,
      text: pending.version === 5 ? '' : pending.payload.text,
      maxImages: pending.operation === 'publish_post' ? 9 : 3,
      isFeedback:
        pending.operation === 'publish_post' &&
        pending.payload.category === 'feedback',
      feedbackDraft:
        pending.operation === 'publish_post' && pending.payload.feedback
          ? { ...pending.payload.feedback.contacts, consent: true }
          : emptyFeedbackDraft(),
      isTrading:
        pending.operation === 'publish_post' &&
        pending.payload.category === 'trading',
      tradingDraft:
        pending.operation === 'publish_post' && pending.payload.trading
          ? intentTradingDraft(pending.payload.trading)
          : emptyTradingDraft(),
      identityForced:
        pending.operation === 'publish_post' &&
        pending.payload.category === 'trading',
      pollDraft:
        pending.operation === 'publish_post' &&
        pending.payload.component?.kind === 'poll'
          ? componentDraft(pending.payload.component)
          : emptyPollDraft(),
      canAddPoll:
        pending.operation === 'publish_post' &&
        pending.payload.category !== 'trading' &&
        pending.payload.category !== 'feedback',
      formationDraft:
        pending.operation === 'publish_post' &&
        pending.payload.component?.kind === 'formation'
          ? componentFormationDraft(pending.payload.component)
          : emptyFormationDraft(),
      canAddFormation:
        pending.operation === 'publish_post' &&
        pending.payload.category !== 'trading' &&
        pending.payload.category !== 'feedback',
      authorMode: pending.payload.authorMode,
      canChooseAnonymousDm:
        pending.operation === 'publish_post' &&
        pending.payload.category !== 'feedback',
      allowAnonymousDm:
        pending.operation === 'publish_post'
          ? pending.payload.allowAnonymousDm === true
          : false,
      effectiveIdentity:
        pending.payload.authorMode === 'anonymous'
          ? '分身身份（原请求，保持不变）'
          : '公开身份（原请求，保持不变）',
      commentsPolicy:
        pending.operation === 'publish_post'
          ? pending.payload.commentsPolicy
          : 'open',
      blocker:
        '发布结果尚未确认。内容与请求编号已冻结；只能查询回执或重试完全相同的请求',
      status: '有待确认的发布',
      recoveryOperation:
        pending.operation === 'publish_post'
          ? '帖子'
          : pending.operation === 'publish_comment'
            ? '回复'
            : '回复',
      replyTargetName:
        pending.operation === 'publish_reply' ? '原回复对象（目标已冻结）' : '',
      maxText: pending.operation === 'publish_post' ? 2500 : 500,
      error: '',
    });
  }
  private editable(): boolean {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.accountId() ||
      !this.target
    )
      return false;
    try {
      const pending = this.loadPending(this.accountId()!);
      if (pending) {
        this.showPending(pending);
        return false;
      }
    } catch (error) {
      this.update({
        frozen: true,
        canSubmit: false,
        error: communityError(error),
      });
      return false;
    }
    return true;
  }
  setText(text: string): void {
    if (!this.editable()) return;
    this.update({ text });
    this.persistDraft();
    this.recompute();
  }
  setSourceFormat(format: string): void {
    if (
      !this.editable() ||
      !this.view.canChooseTextSource ||
      !['plain', 'markdown', 'legacy'].includes(format)
    )
      return;
    const textSource =
      format === 'legacy'
        ? null
        : format === 'markdown'
          ? decodeTextSourceDescriptor({ version: 1, format: 'markdown' })
          : DEFAULT_TEXT_SOURCE;
    this.update({ textSource, sourcePreview: false });
    this.persistDraft();
    this.recompute();
  }
  setReadingFormatting(enabled: boolean): void {
    if (!this.editable() || this.view.textSource?.format !== 'plain') return;
    this.update({
      textSource: {
        version: 1,
        format: 'plain',
        readingFormatting: enabled ? 'auto' : 'off',
      },
    });
    this.persistDraft();
    this.recompute();
  }
  toggleSourcePreview(): void {
    if (
      !this.view.loaded ||
      !this.accountId() ||
      this.view.busy ||
      !this.view.textSource
    )
      return;
    this.update({ sourcePreview: !this.view.sourcePreview });
  }
  setAuthorMode(mode: string): void {
    if (
      !this.editable() ||
      this.view.identityForced ||
      (mode !== 'named' && mode !== 'anonymous')
    )
      return;
    this.identityConflict = false;
    this.update({
      authorMode: mode,
      ...(mode !== this.view.authorMode
        ? {
            formationDraft: {
              ...this.view.formationDraft,
              contactConsent: false,
            },
          }
        : {}),
    });
    this.persistDraft();
    this.recompute();
  }
  setRelatedCampusSync(value: boolean): void {
    if (
      !this.editable() ||
      !this.view.canChooseRelatedCampusSync ||
      this.target?.operation !== 'publish_post'
    )
      return;
    this.update({ syncToRelatedCampuses: value === true });
    this.recompute();
  }
  setAllowAnonymousDm(value: boolean): void {
    if (
      !this.editable() ||
      !this.view.canChooseAnonymousDm ||
      this.view.authorMode !== 'named'
    )
      return;
    this.update({ allowAnonymousDm: value });
    this.persistDraft();
    this.recompute();
  }
  setRestricted(restricted: boolean): void {
    if (!this.editable() || (restricted && !this.view.canDisableComments))
      return;
    this.update({ commentsPolicy: restricted ? 'restricted' : 'open' });
    this.persistDraft();
    this.recompute();
  }
  setTradingField(field: string, value: string): void {
    if (
      !this.editable() ||
      !this.view.isTrading ||
      !['price', 'location', 'wechat', 'qq', 'phone'].includes(field)
    )
      return;
    this.editTrading({ [field]: value });
  }
  setTradingSubtype(subtype: string): void {
    if (!isTradingSubtype(subtype)) return;
    this.editTrading({
      subtype,
      urgency:
        subtype === 'qiugou'
          ? 'normal'
          : this.view.tradingDraft.subtype === 'qiugou'
            ? 'urgent'
            : this.view.tradingDraft.urgency,
    });
  }
  setTradingUrgency(urgency: string): void {
    if (
      (urgency !== 'normal' && urgency !== 'urgent') ||
      this.view.tradingDraft.subtype === 'qiugou'
    )
      return;
    this.editTrading({ urgency });
  }
  setContactConsent(contactConsent: boolean): void {
    this.editTrading({ contactConsent });
  }
  private editTrading(patch: Partial<TradingDraft>): void {
    if (!this.editable() || !this.view.isTrading) return;
    this.update({
      tradingDraft: { ...this.view.tradingDraft, ...patch },
      error: '',
    });
    this.persistDraft();
    this.recompute();
  }
  private editPoll(patch: Partial<PollDraft>): void {
    if (!this.editable() || !this.view.canAddPoll) return;
    this.update({ pollDraft: { ...this.view.pollDraft, ...patch }, error: '' });
    this.persistDraft();
    this.recompute();
  }
  setPollEnabled(enabled: boolean): void {
    if (!this.editable() || !this.view.canAddPoll) return;
    if (enabled && this.view.formationDraft.enabled) {
      this.update({
        error: '投票和组队不能同时添加，请先关闭组队；已填内容会保留',
      });
      return;
    }
    this.editPoll({ enabled });
  }
  setPollQuestion(question: string): void {
    this.editPoll({ question });
  }
  setPollMode(mode: string): void {
    if (mode === 'single' || mode === 'multiple')
      this.editPoll({ selectionMode: mode });
  }
  setPollOption(index: number, label: string): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.view.pollDraft.options.length
    )
      return;
    this.editPoll({
      options: this.view.pollDraft.options.map((option, i) =>
        i === index ? label : option,
      ),
    });
  }
  addPollOption(): void {
    const draft = this.view.pollDraft;
    if (!this.editable() || !this.view.canAddPoll) return;
    if (draft.options.length + (draft.finalOption ? 1 : 0) >= 5) {
      this.update({ error: '投票最多五个选项，吃瓜🍉也占用一个名额' });
      return;
    }
    this.editPoll({ options: [...draft.options, ''] });
  }
  removePollOption(index: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.view.pollDraft.options.length ||
      this.view.pollDraft.options.length <= 2
    )
      return;
    this.editPoll({
      options: this.view.pollDraft.options.filter((_option, i) => i !== index),
    });
  }
  setPollFinal(enabled: boolean): void {
    if (!this.editable() || !this.view.canAddPoll) return;
    if (enabled && this.view.pollDraft.options.length >= 5) {
      this.update({ error: '已有五个普通选项，请先删除一个再启用吃瓜🍉' });
      return;
    }
    this.editPoll({ finalOption: enabled });
  }
  setFormationEnabled(enabled: boolean): void {
    if (!this.editable() || !this.view.canAddFormation) return;
    if (enabled && this.view.pollDraft.enabled) {
      this.update({
        error: '组队和投票不能同时添加，请先关闭投票；已填内容会保留',
      });
      return;
    }
    this.editFormation({ enabled, contactConsent: false });
  }
  setFormationField(field: string, value: string): void {
    if (!['theme', 'capacity', 'wechat', 'qq', 'phone'].includes(field)) return;
    this.editFormation({ [field]: value, contactConsent: false });
  }
  setFormationConsent(contactConsent: boolean): void {
    this.editFormation({ contactConsent });
  }
  private editFormation(patch: Partial<FormationDraft>): void {
    if (!this.editable() || !this.view.canAddFormation) return;
    this.update({
      formationDraft: { ...this.view.formationDraft, ...patch },
      error: '',
    });
    this.persistDraft();
    this.recompute();
  }
  setFeedbackField(field: string, value: string): void {
    if (
      !this.editable() ||
      !this.view.isFeedback ||
      !['wechat', 'qq', 'phone'].includes(field)
    )
      return;
    this.update({
      feedbackDraft: {
        ...this.view.feedbackDraft,
        [field]: value,
        consent: false,
      },
    });
    this.persistDraft();
    this.recompute();
  }
  setFeedbackConsent(consent: boolean): void {
    if (!this.editable() || !this.view.isFeedback) return;
    this.update({ feedbackDraft: { ...this.view.feedbackDraft, consent } });
    this.persistDraft();
    this.recompute();
  }
  private persistDraft(): void {
    const accountId = this.accountId();
    if (!accountId || !this.target) return;
    if (this.isRatingLinkJourney()) {
      this.draftSaved = true;
      return;
    }
    try {
      this.runtime.drafts.save(accountId, targetKey(this.target), {
        version: 1,
        ...(this.view.textSource ? { textSource: this.view.textSource } : {}),
        text: this.view.text,
        ...(this.target.operation === 'publish_post'
          ? { allowAnonymousDm: this.view.allowAnonymousDm }
          : {}),
        authorMode: this.view.authorMode,
        commentsPolicy: this.view.commentsPolicy,
        ...(this.target.operation === 'publish_post'
          ? this.view.isFeedback
            ? { feedback: this.view.feedbackDraft }
            : this.view.isTrading
              ? { trading: this.view.tradingDraft }
              : {
                  poll: this.view.pollDraft,
                  ...(this.view.formationDraft.enabled ||
                  this.view.formationDraft.theme ||
                  this.view.formationDraft.capacity ||
                  this.view.formationDraft.wechat ||
                  this.view.formationDraft.qq ||
                  this.view.formationDraft.phone ||
                  this.view.formationDraft.contactConsent
                    ? { formation: this.view.formationDraft }
                    : {}),
                }
          : {}),
      });
      this.draftSaved = true;
    } catch (error) {
      this.draftSaved = false;
      this.update({ error: communityError(error) });
    }
  }
  private sourceShapeSupported(): boolean {
    return (
      !this.view.isTrading &&
      !this.view.isFeedback &&
      !this.ratingLink &&
      !this.view.syncToRelatedCampuses &&
      !this.view.pollDraft.enabled &&
      !this.view.formationDraft.enabled &&
      !this.view.allowAnonymousDm &&
      this.view.commentsPolicy === 'open' &&
      this.view.mediaSelected === 0 &&
      ['idle', 'terminal', 'bound_history'].includes(this.view.mediaStatus)
    );
  }
  private sourceCapabilityCurrent(): boolean {
    return (
      !!this.target &&
      !!this.runtime.gateway?.submitReview &&
      !!this.runtime.gateway.reviewStatus &&
      this.sourceCapabilities.some(
        (item) =>
          item.authorMode === this.view.authorMode &&
          item.availability === 'available' &&
          item.operations.includes(this.target!.operation),
      )
    );
  }
  /** Format preference is not an immutable request. Ordinary plain media/components
   * use the existing reviewed publication path; explicit Markdown is never rerouted.
   * Called only before freeze, never as recovery from source-owner rejection. */
  private effectiveTextSource(): TextSourceDescriptor | undefined {
    const descriptor = this.view.textSource;
    if (!descriptor) return undefined;
    return descriptor.format === 'markdown' ||
      (this.sourceShapeSupported() && this.sourceCapabilityCurrent())
      ? descriptor
      : undefined;
  }
  private recompute(): void {
    const cap = this.capabilities,
      isComment = !!this.target && this.target.operation !== 'publish_post',
      publication = isComment
        ? this.commentCapabilities
        : this.ratingLink
          ? cap?.ratingTargetLink
          : this.view.syncToRelatedCampuses
            ? cap?.relatedCampusSync
            : cap?.publish,
      modes = isComment
        ? this.commentCapabilities?.authorModes
        : this.ratingLink
          ? cap?.ratingTargetLink?.authorModes
          : this.view.syncToRelatedCampuses
            ? (cap?.relatedCampusSync?.authorModes ?? cap?.authorModes)
            : cap?.authorModes,
      canDisableComments =
        !isComment &&
        (this.view.syncToRelatedCampuses
          ? cap?.relatedCampusSync?.canDisableComments === true
          : cap?.canDisableComments === true);
    let blocker = '';
    if (isComment && this.mediaMode === 'legacy' && this.runtime.mediaBatch)
      blocker = '请先恢复原帖子的图片操作';
    else if (this.mediaMode === 'conflict')
      blocker = '先分别恢复旧图片与整批图片记录';
    else if (this.identityConflict)
      blocker = '历史回复身份偏好冲突，请明确选择分身或公开身份';
    else if (!this.draftSaved) blocker = '草稿尚未可靠保存，暂不能发布';
    else if (!publication || publication.availability !== 'allowed')
      blocker = reasonMessage(publication?.reason ?? 'COMMUNITY_UNAVAILABLE');
    else if (
      this.view.syncToRelatedCampuses &&
      (isComment || cap?.relatedCampusSync?.availability !== 'allowed')
    )
      blocker = '关联学校同步资格已不可确认，请重新加载并明确选择';
    else if (!modes?.includes(this.view.authorMode))
      blocker = '所选身份不被允许；不会自动改成公开身份，请自行选择';
    else if (isComment && !this.parentPost?.viewer.canComment)
      blocker = '此帖当前不可回复';
    else if (this.view.commentsPolicy === 'restricted' && !canDisableComments)
      blocker = '当前账号无权限制回复，请手动改为开放回复';
    else if (
      !boundedText(
        this.view.text.replace(/\r\n/g, '\n'),
        isComment ? 0 : 1,
        this.view.maxText,
      ) ||
      (!this.view.text.trim() &&
        !(
          isComment &&
          this.view.batchMode &&
          this.view.mediaSelected > 0 &&
          this.view.mediaReady === this.view.mediaSelected
        ))
    )
      blocker = isComment
        ? `请填写不超过 ${this.view.maxText} 字的正文或添加 1–3 张图片`
        : `请输入 1–${this.view.maxText} 个有效字符，保留你输入的空格与换行`;
    if (
      !blocker &&
      this.runtime.gateway?.submitReview &&
      !this.view.syncToRelatedCampuses &&
      !(
        isComment &&
        this.commentCapabilities?.inheritsRelatedCampusSync === true
      ) &&
      modes?.length === 1 &&
      modes[0] === 'named' &&
      (isComment || cap?.mediaAvailability === 'unavailable') &&
      (this.view.pollDraft.enabled ||
        this.view.formationDraft.enabled ||
        (!isComment && this.view.allowAnonymousDm) ||
        this.view.mediaSelected > 0)
    )
      blocker =
        '当前仅开放实名纯文字审核。请明确关闭投票、组队和分身私信，并移除图片；不会自动改动原草稿';
    if (!blocker && this.view.pollDraft.enabled) {
      try {
        pollDraftComponent(this.view.pollDraft);
      } catch {
        blocker =
          '投票需独立问题及至少两个普通选项；问题和选项各 1–255 字，不可留空或重复，总数不超过五个';
      }
    }
    if (!blocker && this.view.formationDraft.enabled) {
      if (this.view.pollDraft.enabled || this.view.isTrading)
        blocker = '组队仅用于非交易帖子，不能与投票或内部链接同时添加';
      else if (!this.view.formationDraft.contactConsent)
        blocker =
          '请阅读并确认：填写的联系方式将向有权查看此帖的组内成员提供，分身时也可能识别你的身份';
      else {
        try {
          formationDraftComponent(this.view.formationDraft);
        } catch {
          blocker =
            '请填写 1–20 的整数人数、1–12 字的活动主题及至少一种联系方式；微信最多 100、QQ 最多 50、电话最多 20 UTF-8 字节，不会截断或自动修正';
        }
      }
    }
    if (!blocker && this.view.isFeedback) {
      try {
        feedbackDraftInput(this.view.feedbackDraft);
      } catch {
        blocker = '联系方式每项最多 50 字节；填写后请确认联系方式展示说明';
      }
    }
    if (!blocker && this.view.isTrading) {
      try {
        tradingDraftIntent(this.view.tradingDraft);
      } catch {
        blocker =
          '请填写交易分类、大于零且不超过 99999 元的十进制价格、地点（最多 200 UTF-8 字节）及至少一种联系方式（每项最多 50 UTF-8 字节）；不截断、不取整';
      }
      if (!blocker && !this.view.tradingDraft.contactConsent)
        blocker = '请确认愿意将所填联系方式公开给可查看此帖的用户';
    }
    if (
      !blocker &&
      this.view.batchMode &&
      this.view.mediaSelected > 0 &&
      this.view.mediaReady !== this.view.mediaSelected
    )
      blocker = '全部所选图片确认就绪后才能发布；失败或未知图片需明确移除';
    if (
      !blocker &&
      this.ratingLink &&
      !ratingLinkLabel(this.view.ratingLinkLabel)
    )
      blocker = '评分卡片标签需为 1–12 个有效字符';
    if (
      !blocker &&
      this.ratingLink &&
      (this.view.syncToRelatedCampuses ||
        this.view.allowAnonymousDm ||
        this.view.pollDraft.enabled ||
        this.view.formationDraft.enabled ||
        this.view.mediaSelected > 0)
    )
      blocker = '评分卡片不能与同步、图片、投票、组队或分身私信同时发布';
    if (!blocker && this.view.textSource?.format === 'markdown') {
      if (!this.sourceCapabilityCurrent())
        blocker =
          'Markdown 原文审核能力暂不可确认，请重新加载；不会自动更改格式';
      else if (!this.sourceShapeSupported())
        blocker =
          'Markdown 当前仅支持纯文字、开放回复；请保留原文并明确处理图片、组件、同步和分身私信，或自行选择纯文字格式';
      else if (!sourceTextAvailable(this.view.text, this.view.textSource))
        blocker =
          'Markdown 的图片和内部内容引用尚未支持；请保留原文并明确修改，不会自动删除引用';
    }
    if (!blocker && this.view.mediaBusy) blocker = '请先等待当前图片操作完成';
    if (
      !blocker &&
      !['idle', 'ready', 'terminal', 'bound_history'].includes(
        this.view.mediaStatus,
      )
    )
      blocker = '请先确认原图片的上传、审核或取消结果';
    this.update({
      blocker,
      sourceNotice:
        this.view.textSource?.format === 'markdown'
          ? 'Markdown 为明确选择的纯文字格式，不会自动排版或调用 AI；当前预览不执行 HTML、图片或链接。'
          : this.view.textSource?.format === 'plain'
            ? !this.effectiveTextSource()
              ? '当前内容按原有发布方式发送；图片、组件等内容暂不提供长文阅读排版，文字与附件保持不变。'
              : this.view.textSource.readingFormatting === 'auto'
                ? '纯文字原文完整保留；帖子满 300 字、回复满 200 字时允许后台生成可选阅读排版，未完成仍显示原文。'
                : '已关闭本次阅读排版，仍完整保留纯文字原文。'
            : '纯文字不推断 Markdown；原有图片、组件、草稿与发布记录保持不变。',
      canDisableComments,
      canSubmit: !blocker && !this.view.frozen && this.view.loaded,
      canOpenIdentityCampus:
        this.draftSaved && !this.view.frozen && this.view.loaded,
      effectiveIdentity:
        this.view.authorMode === 'anonymous'
          ? this.view.identityForced
            ? '分身楼主（本帖回复必须分身）'
            : this.view.formationDraft.enabled
              ? '分身身份（公开展示分身形象；组内联系方式仍可能识别你）'
              : '分身身份（不会公开个人资料）'
          : '公开身份（显示昵称与公开资料身份）',
    });
  }
  async submit(): Promise<void> {
    if (!this.refreshMediaMode() || !this.editable() || !this.available())
      return;
    this.recompute();
    if (!this.view.canSubmit || !this.target) return;
    const target = this.target,
      accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    this.assistance.invalidate();
    const component = this.ratingLink
      ? decodeRatingTargetLinkComponent({
          kind: 'rating_target_link',
          targetId: this.ratingLink.targetId,
          label: this.view.ratingLinkLabel,
          selector: this.ratingLink.selector,
          expectedTargetRevision: this.ratingLink.expectedTargetRevision,
          expectedCategoryRevision: this.ratingLink.expectedCategoryRevision,
          expectedSourceRevision: this.ratingLink.expectedSourceRevision,
        })
      : this.view.formationDraft.enabled
        ? formationDraftComponent(this.view.formationDraft)
        : pollDraftComponent(this.view.pollDraft);
    const trading = this.view.isTrading
      ? tradingDraftIntent(this.view.tradingDraft)
      : undefined;
    const source = this.effectiveTextSource();
    const draft = {
      ...(source ? { textSource: source } : {}),
      ...(component.kind !== 'none' ? { component } : {}),
      ...(trading ? { trading } : {}),
      ...(this.view.isFeedback
        ? { feedback: feedbackDraftInput(this.view.feedbackDraft) }
        : {}),
      allowAnonymousDm: this.view.allowAnonymousDm,
      syncToRelatedCampuses: this.view.syncToRelatedCampuses,
      text: this.view.text.replace(/\r\n/g, '\n'),
      authorMode: this.view.authorMode,
      commentsPolicy: this.view.commentsPolicy,
    };
    await this.run(
      async (cancel) => {
        const imageTarget = this.mediaTarget('');
        const imageAssetIds = this.isRatingLinkJourney()
          ? []
          : this.useBatch()
            ? await this.batcher!.publicationAssets(
                imageTarget.spaceId,
                cancel,
                imageTarget.target,
              )
            : target.operation === 'publish_post' && this.uploader
              ? await this.uploader.publicationAssets(target.spaceId, cancel)
              : [];
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const attempt: PendingAttempt =
          target.operation === 'publish_post'
            ? {
                ...(component.kind === 'rating_target_link'
                  ? {
                      version: 5 as const,
                      kind: 'community_rating_target_link_v5' as const,
                    }
                  : { version: 1 as const }),
                accountId,
                operation: 'publish_post',
                ...(target.viewSpaceId
                  ? { viewSpaceId: target.viewSpaceId }
                  : {}),
                payload: decodePostIntent({
                  clientRequestId: requestId,
                  spaceId: target.spaceId,
                  category: target.category,
                  ...(draft.component ? { component: draft.component } : {}),
                  ...(draft.trading ? { trading: draft.trading } : {}),
                  ...(draft.feedback ? { feedback: draft.feedback } : {}),
                  text: draft.text,
                  ...(draft.textSource ? { textSource: draft.textSource } : {}),
                  authorMode: draft.authorMode,
                  commentsPolicy: draft.commentsPolicy,
                  imageAssetIds,
                  ...(draft.authorMode === 'named' &&
                  !draft.feedback &&
                  component.kind !== 'rating_target_link'
                    ? { allowAnonymousDm: draft.allowAnonymousDm }
                    : {}),
                  ...(draft.syncToRelatedCampuses
                    ? { syncToRelatedCampuses: true }
                    : {}),
                }),
              }
            : target.operation === 'publish_reply'
              ? {
                  version: 1,
                  accountId,
                  operation: 'publish_reply',
                  ...(target.viewSpaceId
                    ? { viewSpaceId: target.viewSpaceId }
                    : {}),
                  postId: target.postId,
                  rootCommentId: target.rootCommentId,
                  payload: decodeReplyIntent({
                    clientRequestId: requestId,
                    text: draft.text,
                    ...(draft.textSource
                      ? { textSource: draft.textSource }
                      : {}),
                    authorMode: draft.authorMode,
                    imageAssetIds,
                    targetReplyId: target.targetReplyId,
                  }),
                }
              : {
                  version: 1,
                  accountId,
                  operation: 'publish_comment',
                  ...(target.viewSpaceId
                    ? { viewSpaceId: target.viewSpaceId }
                    : {}),
                  postId: target.postId,
                  payload: decodeCommentIntent({
                    clientRequestId: requestId,
                    text: draft.text,
                    ...(draft.textSource
                      ? { textSource: draft.textSource }
                      : {}),
                    authorMode: draft.authorMode,
                    imageAssetIds,
                  }),
                };
        if (
          this.isRatingLinkJourney() &&
          attempt.version !== 5 &&
          this.runtime.drafts.load(accountId, targetKey(target))
        )
          throw new ClientError(
            'storage',
            'An existing ordinary draft must be handled first',
          );
        // Text-only links still honor existing image cancellation barriers without attaching media.
        if (
          this.useBatch() ||
          (this.isRatingLinkJourney() && this.runtime.mediaBatch)
        )
          this.runtime.mediaBatch!.reservePublication(attempt);
        let frozen: PendingAttempt;
        try {
          if (this.loadPending(accountId))
            throw new ClientError(
              'storage',
              'Original publication is unresolved',
            );
          frozen =
            attempt.version === 5
              ? this.runtime.pendingRatingLinks!.freeze(attempt)
              : this.runtime.pending.freeze(attempt);
        } catch (error) {
          // A reserved Media WAL may already exist. Storage failure must not let
          // editing create a second key or dispatch before the cross-key link.
          if (this.useBatch())
            this.update({
              frozen: true,
              canSubmit: false,
              blocker: '发布保存尚未确认，请恢复原记录或明确取消整批图片',
            });
          throw error;
        }
        this.showPending(frozen);
        if (this.usesTextReview(frozen))
          return this.submitReview(frozen, cancel);
        const receipt = await this.dispatch(frozen, cancel);
        return this.useBatch()
          ? this.runtime.mediaBatch!.verifyReceipt(frozen, receipt, cancel)
          : receipt;
      },
      (result) => this.acceptPublicationResult(result),
      () => {
        if (this.pending)
          this.update({
            frozen: true,
            canSubmit: false,
            status: '发布结果待确认',
            blocker: '即使提示拒绝、超时或未找到，也请查询原回执；不要新建请求',
          });
      },
    );
  }
  private usesTextReview(attempt: PendingAttempt): boolean {
    return (
      !!this.runtime.gateway?.submitReview &&
      !!this.runtime.gateway.reviewStatus &&
      supportsTextReview(attempt)
    );
  }
  private async submitReview(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<PublicationReview | ReviewCancellationResult> {
    // Recovery can outlive the original capability snapshot; never infer eligibility from a review.
    const capability =
      attempt.operation === 'publish_post'
        ? await this.runtime
            .gateway!.capabilities(
              attempt.payload.spaceId,
              attempt.payload.category,
              cancel,
            )
            .then((current) =>
              attempt.payload.component?.kind === 'rating_target_link'
                ? (current.ratingTargetLink ?? {
                    availability: 'unavailable' as const,
                    reason: 'COMMUNITY_UNAVAILABLE',
                  })
                : attempt.payload.syncToRelatedCampuses === true
                  ? (current.relatedCampusSync ?? {
                      availability: 'unavailable' as const,
                      reason: 'COMMUNITY_UNAVAILABLE',
                    })
                  : current.publish,
            )
        : await this.runtime.gateway!.commentCapabilities(
            attempt.postId,
            cancel,
          );
    if (capability.availability !== 'allowed')
      throw new ClientError('business', 'Review unavailable', {
        serverCode: capability.reason ?? 'COMMUNITY_UNAVAILABLE',
      });
    if (attempt.payload.textSource) {
      if (!this.runtime.gateway?.textSourceCapabilities)
        throw new ClientError(
          'configuration',
          'Source review owner unavailable',
        );
      const parent =
        attempt.operation === 'publish_post'
          ? null
          : await this.runtime.gateway.post(
              attempt.postId,
              cancel,
              attempt.viewSpaceId,
            );
      const context =
        attempt.operation === 'publish_post'
          ? {
              spaceId: attempt.payload.spaceId,
              category: attempt.payload.category,
            }
          : { spaceId: parent!.space.id, category: parent!.category };
      const source = await this.runtime.gateway.textSourceCapabilities(
        context.spaceId,
        context.category,
        attempt.payload.authorMode,
        cancel,
      );
      if (
        source.availability !== 'available' ||
        !source.operations.includes(attempt.operation)
      )
        throw new ClientError('business', 'Source review unavailable', {
          serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
        });
    }
    this.assertOriginalAttempt(attempt);
    const review = matchPublicationReview(
      attempt,
      await this.runtime.gateway!.submitReview!(attempt, cancel),
    );
    this.assertOriginalAttempt(attempt);
    return review.status === 'cancelled'
      ? this.requestReviewCancellation(attempt, cancel)
      : review;
  }
  private assertOriginalAttempt(attempt: PendingAttempt): void {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.loadPending(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending request changed');
  }
  private acceptPublicationResult(
    result: ReviewCancellationResult | PublicationReview,
  ): void {
    if (!('status' in result)) {
      if (result.outcome === 'cancelled') this.settleReviewCancellation(result);
      else this.settle(result);
      return;
    }
    if (!this.pending)
      throw new ClientError('protocol', 'Missing original request');
    const review = matchPublicationReview(this.pending, result);
    const messages = {
      pending: '原内容正在审核，可查询审核状态；尚未发布',
      approved: '原内容审核已通过，请明确重试完全相同的原请求以发布',
      rejected: '原内容审核未通过，请重试原请求取得拒绝回执后再修改',
      unavailable: '审核暂不可用，原请求已保留；可查询或重试原内容审核',
      settled: '原请求已有回执，请查询原请求结果',
      cancelled: '原请求已取消，请查询服务器取消凭据以确认解除冻结',
    };
    this.update({
      reviewStatus: review.status,
      frozen: true,
      canSubmit: false,
      status: messages[review.status],
      receiptStatus: '',
      blocker: messages[review.status],
      error: '',
    });
  }
  private async recoverReview(
    attempt: PendingAttempt,
    retry: boolean,
    cancel: Cancellation,
  ): Promise<ReviewCancellationResult | PublicationReview> {
    this.assertOriginalAttempt(attempt);
    try {
      const receipt = await this.runtime.gateway!.receipt(
        attempt.payload.clientRequestId,
        cancel,
      );
      return this.useBatch()
        ? this.runtime.mediaBatch!.verifyReceipt(attempt, receipt, cancel)
        : receipt;
    } catch (error) {
      if (
        !(error instanceof ClientError) ||
        error.kind === 'protocol' ||
        error.details.httpStatus !== 404 ||
        error.details.serverCode !== 'REQUEST_NOT_FOUND'
      )
        throw error;
    }
    this.assertOriginalAttempt(attempt);
    let review: PublicationReview;
    try {
      review = matchPublicationReview(
        attempt,
        await this.runtime.gateway!.reviewStatus!(attempt, cancel),
      );
    } catch (error) {
      if (
        !retry ||
        !(error instanceof ClientError) ||
        error.kind === 'protocol' ||
        error.details.httpStatus !== 404 ||
        error.details.serverCode !== 'REQUEST_NOT_FOUND'
      )
        throw error;
      return this.submitReview(attempt, cancel);
    }
    this.assertOriginalAttempt(attempt);
    if (review.status === 'cancelled')
      return this.requestReviewCancellation(attempt, cancel);
    if (review.status === 'settled') {
      const receipt = await this.runtime.gateway!.receipt(
        attempt.payload.clientRequestId,
        cancel,
      );
      return this.useBatch()
        ? this.runtime.mediaBatch!.verifyReceipt(attempt, receipt, cancel)
        : receipt;
    }
    if (
      retry &&
      (review.status === 'approved' || review.status === 'rejected')
    ) {
      const receipt = await this.dispatch(attempt, cancel);
      return this.useBatch()
        ? this.runtime.mediaBatch!.verifyReceipt(attempt, receipt, cancel)
        : receipt;
    }
    return retry && review.status === 'unavailable'
      ? this.submitReview(attempt, cancel)
      : review;
  }
  private async requestReviewCancellation(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<ReviewCancellationResult> {
    this.assertOriginalAttempt(attempt);
    if (!supportsTextReview(attempt) || !this.runtime.gateway?.cancelReview)
      throw new ClientError('configuration', 'Review cancellation unavailable');
    const result = matchReviewCancellation(
      attempt,
      await this.runtime.gateway.cancelReview(attempt, cancel),
    );
    this.assertOriginalAttempt(attempt);
    return result.outcome !== 'cancelled' && this.useBatch()
      ? this.runtime.mediaBatch!.verifyReceipt(attempt, result, cancel)
      : result;
  }
  async cancelReview(): Promise<void> {
    if (this.view.busy || !this.available()) return;
    let attempt: PendingAttempt | null;
    try {
      attempt = this.loadPending(this.accountId()!);
      if (
        !attempt ||
        !supportsTextReview(attempt) ||
        !this.runtime.gateway?.cancelReview
      )
        return;
      this.showPending(attempt);
    } catch (error) {
      this.update({
        frozen: true,
        canSubmit: false,
        error: communityError(error),
      });
      return;
    }
    const original = attempt;
    await this.run(
      (cancel) => this.requestReviewCancellation(original, cancel),
      (result) => this.acceptPublicationResult(result),
      () =>
        this.update({
          frozen: true,
          canSubmit: false,
          status: '取消尚未确认，原请求仍被冻结',
        }),
    );
  }
  private settleReviewCancellation(raw: ReviewCancellationResult): void {
    const attempt = this.pending;
    if (!attempt || !supportsTextReview(attempt))
      throw new ClientError('protocol', 'Missing original text review');
    this.assertOriginalAttempt(attempt);
    const result = matchReviewCancellation(attempt, raw);
    if (result.outcome !== 'cancelled')
      throw new ClientError('protocol', 'Missing cancellation fence');
    if (attempt.version === 5)
      this.runtime.pendingRatingLinks!.settleCancelled(attempt, result);
    else
      this.runtime.pending.settleCancelled(
        attempt,
        result,
        batchPublicationReference(attempt).intentHash,
      );
    this.pending = null;
    this.update({
      frozen: false,
      loaded: false,
      canSubmit: false,
      canCancelReview: false,
      reviewStatus: '',
      receiptStatus: '服务器已确认取消，原请求不能再发布',
      status:
        attempt.version === 5
          ? '原评分卡片发布请求已取消；重新加载后可填写新草稿'
          : '原请求已取消，草稿已保留',
      blocker: '重新加载草稿，检查并明确提交后才会建立新请求',
      recoveryOperation: '',
      error: '',
    });
  }
  private async dispatch(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<Receipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    const stored = this.loadPending(attempt.accountId);
    if (JSON.stringify(stored) !== JSON.stringify(attempt))
      throw new ClientError('storage', 'Pending request changed');
    if (this.useBatch() || (attempt.version === 5 && this.runtime.mediaBatch))
      await this.runtime.mediaBatch!.beforePublication(attempt, cancel);
    else if (attempt.version !== 5)
      this.runtime.mediaUpload?.beforePublication(attempt);
    return attempt.operation === 'publish_post'
      ? this.runtime.gateway!.publishPost(attempt.payload, cancel)
      : attempt.operation === 'publish_reply'
        ? this.runtime.gateway!.publishReply(
            attempt.rootCommentId,
            attempt.payload,
            cancel,
          )
        : this.runtime.gateway!.publishComment(
            attempt.postId,
            attempt.payload,
            cancel,
          );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.refreshMediaMode()) return;
    let pending: PendingAttempt | null;
    try {
      pending = this.loadPending(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到本机待确认记录，请重新加载' });
        return;
      }
    } catch (error) {
      this.update({ error: communityError(error), frozen: true });
      return;
    }
    this.showPending(pending);
    const attempt = pending;
    await this.run(
      async (cancel) => {
        if (this.usesTextReview(attempt))
          return this.recoverReview(attempt, retry, cancel);
        let receipt: Receipt;
        if (this.useBatch()) {
          try {
            receipt = await this.runtime.gateway!.receipt(
              attempt.payload.clientRequestId,
              cancel,
            );
          } catch (error) {
            if (
              !retry ||
              !(error instanceof ClientError) ||
              error.details.serverCode !== 'REQUEST_NOT_FOUND'
            )
              throw error;
            receipt = await this.dispatch(attempt, cancel);
          }
          return this.runtime.mediaBatch!.verifyReceipt(
            attempt,
            receipt,
            cancel,
          );
        }
        return retry
          ? this.dispatch(attempt, cancel)
          : this.runtime.gateway!.receipt(
              attempt.payload.clientRequestId,
              cancel,
            );
      },
      (result) => this.acceptPublicationResult(result),
      () =>
        this.update({
          frozen: true,
          canSubmit: false,
          status: '原发布仍待确认',
        }),
    );
  }
  private settle(raw: Receipt): void {
    const attempt = this.pending;
    if (!attempt || attempt.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original request');
    const receipt = decodeReceipt(raw);
    if (
      receipt.operation !== attempt.operation ||
      receipt.requestId !== attempt.payload.clientRequestId
    )
      throw new ClientError('protocol', 'Receipt mismatch');
    if (
      receipt.outcome === 'created' &&
      attempt.operation === 'publish_post' &&
      attempt.payload.trading
    )
      this.runtime.drafts.rememberTrading(
        attempt.accountId,
        attempt.payload.trading.location,
        attempt.payload.trading.contacts,
      );
    // Clear a successful draft before dropping recovery protection; failed local writes keep the request frozen.
    if (receipt.outcome === 'created' && attempt.version !== 5)
      this.runtime.drafts.clear(
        attempt.accountId,
        targetKey(attemptTarget(attempt)),
      );
    if (attempt.version === 5)
      this.runtime.pendingRatingLinks!.settle(attempt, receipt);
    else this.runtime.pending.settle(attempt, receipt);
    if (this.useBatch()) this.runtime.mediaBatch!.publicationSettled(attempt);
    this.pending = null;
    this.update({
      frozen: false,
      canCancelReview: false,
      reviewStatus: '',
      loaded: false,
      text: receipt.outcome === 'created' ? '' : this.view.text,
      pollDraft:
        receipt.outcome === 'created' ? emptyPollDraft() : this.view.pollDraft,
      formationDraft:
        receipt.outcome === 'created'
          ? emptyFormationDraft()
          : this.view.formationDraft,
      feedbackDraft:
        receipt.outcome === 'created'
          ? emptyFeedbackDraft()
          : this.view.feedbackDraft,
      tradingDraft:
        receipt.outcome === 'created'
          ? emptyTradingDraft()
          : this.view.tradingDraft,
      canSubmit: false,
      receiptStatus:
        receipt.outcome === 'created'
          ? '发布已确认'
          : '服务器已确认拒绝，本次请求未创建内容',
      resourceId: receipt.outcome === 'created' ? receipt.resourceId : '',
      resourcePostId:
        receipt.outcome === 'created'
          ? attempt.operation === 'publish_post'
            ? receipt.resourceId
            : attempt.postId
          : '',
      resourceRootCommentId:
        receipt.outcome === 'created'
          ? attempt.operation === 'publish_reply'
            ? attempt.rootCommentId
            : attempt.operation === 'publish_comment'
              ? receipt.resourceId
              : ''
          : '',
      resourceReplyId:
        receipt.outcome === 'created' && attempt.operation === 'publish_reply'
          ? receipt.resourceId
          : '',
      status: receipt.outcome === 'created' ? '发布成功' : '已确认未发布',
      blocker:
        receipt.outcome === 'rejected'
          ? reasonMessage(receipt.code)
          : '回到帖子查看，或重新加载开始新草稿',
      recoveryOperation: '',
      error: '',
    });
    if (receipt.outcome === 'created') this.onCreated(receipt);
  }
  private mediaTarget(draftId: string): BatchTarget {
    const target = this.target;
    if (!target)
      throw new ClientError('business', 'Original publication target required');
    if (target.operation === 'publish_post')
      return { draftId, spaceId: target.spaceId };
    if (!this.parentPost || this.parentPost.id !== target.postId)
      throw new ClientError(
        'business',
        'Original discussion parent must be loaded',
      );
    return {
      draftId,
      spaceId: this.parentPost.space.id,
      target:
        target.operation === 'publish_comment'
          ? { kind: 'comment', postId: target.postId }
          : {
              kind: 'reply',
              rootCommentId: target.rootCommentId,
              targetReplyId: target.targetReplyId,
            },
    };
  }
  selectImage(): Promise<void> {
    if (
      !this.refreshMediaMode() ||
      !this.activeUploader()?.available ||
      !this.target ||
      (this.target.operation !== 'publish_post' && !this.useBatch()) ||
      this.view.frozen ||
      this.view.busy
    )
      return Promise.resolve();
    return this.runMediaAction('select', async (current) => {
      const draftId = await this.runtime.newRequestId();
      current();
      await this.activeUploader()!.select(this.mediaTarget(draftId));
      current();
      if (!this.useBatch()) await this.uploader!.start();
    });
  }
  recoverImage(): Promise<void> {
    return this.runMediaAction('recover', async (current) => {
      current();
      if (this.mediaMode === 'conflict') {
        await this.uploader?.recover();
        current();
        await this.batcher?.recover();
        current();
        this.refreshMediaMode();
      } else await this.activeUploader()?.recover();
    });
  }
  cancelImage(): Promise<void> {
    return this.runMediaAction('cancel', async (current) => {
      current();
      if (!this.refreshMediaMode()) return;
      await this.activeUploader()?.cancelOriginal();
      current();
      if (
        this.useBatch() &&
        this.view.frozen &&
        !this.loadPending(this.accountId()!)
      )
        await this.load();
    });
  }
  removeImage(memberId: string): Promise<void> {
    if (
      !this.useBatch() ||
      !this.refreshMediaMode() ||
      this.view.frozen ||
      this.view.busy
    )
      return Promise.resolve();
    return this.runMediaAction('layout', async () =>
      this.batcher!.remove(memberId),
    );
  }
  moveImage(memberId: string, direction: -1 | 1): Promise<void> {
    if (
      !this.useBatch() ||
      !this.refreshMediaMode() ||
      this.view.frozen ||
      this.view.busy
    )
      return Promise.resolve();
    return this.runMediaAction('layout', async () =>
      this.batcher!.move(memberId, direction),
    );
  }
  replaceImage(memberId: string): Promise<void> {
    if (
      !this.useBatch() ||
      !this.refreshMediaMode() ||
      !this.target ||
      this.view.frozen ||
      this.view.busy
    )
      return Promise.resolve();
    return this.runMediaAction('layout', async (current) => {
      const draftId = await this.runtime.newRequestId();
      current();
      await this.batcher!.replace(memberId, this.mediaTarget(draftId));
    });
  }
  private runMediaAction(
    kind: 'select' | 'recover' | 'cancel' | 'layout',
    action: (current: () => void) => Promise<void>,
  ): Promise<void> {
    if (
      (!this.uploader && !this.batcher) ||
      this.mediaDisposed ||
      !this.accountId()
    )
      return Promise.resolve();
    if (
      this.mediaAction &&
      (this.mediaAction.kind === kind || kind !== 'cancel')
    )
      return this.mediaAction.task;
    const generation = ++this.mediaGeneration;
    const owner = this.runtime.sessions.snapshot();
    const current = () => {
      this.runtime.sessions.assertCurrent(owner);
      if (this.mediaDisposed || generation !== this.mediaGeneration)
        throw new ClientError('cancelled', 'Media page action replaced');
    };
    this.update({ mediaBusy: true });
    this.recompute();
    const task = Promise.resolve()
      .then(async () => {
        current();
        await action(current);
        current();
      })
      .catch((error) => {
        try {
          current();
        } catch {
          return;
        }
        this.update({ error: communityError(error) });
      })
      .finally(() => {
        try {
          current();
        } catch {
          return;
        }
        this.mediaAction = null;
        this.update({ mediaBusy: false });
        this.recompute();
      });
    this.mediaAction = { kind, task };
    return task;
  }
  override dispose(): void {
    this.assistance.dispose();
    for (const unsubscribe of this.linkUnsubscriptions) unsubscribe();
    this.mediaDisposed = true;
    this.mediaGeneration++;
    this.mediaAction = null;
    this.uploader?.dispose();
    this.batcher?.dispose();
    this.update({
      syncToRelatedCampuses: false,
      canChooseRelatedCampusSync: false,
    });
    super.dispose();
  }
  override cancel(): void {
    super.cancel();
    if (!this.pending) {
      this.update({ syncToRelatedCampuses: false });
      this.recompute();
    }
    if (this.pending)
      this.update({ frozen: true, canSubmit: false, status: '发布结果待确认' });
  }
}

function mediaUploadNotice(view: UploadView): string {
  switch (view.status) {
    case 'ready':
      return '单张图片已由服务器确认可用于当前草稿；发布时会再次核验';
    case 'uploading':
      return `图片传输 ${Math.floor(view.progress)}%，尚未确认审核结果`;
    case 'processing':
      return '正在确认图片上传与审核';
    case 'needs_reselection':
      return '本次原图已不在内存；先确认取消原上传，再重新选择';
    case 'cancel_pending':
      return '取消结果待确认，不能据此认定服务器已删除图片';
    case 'publication_pending':
      return '先确认原发布回执，再处理图片';
    case 'bound_history':
      return '原图片已有绑定历史；查看或删除内容需使用帖子入口';
    case 'terminal':
      return view.cleanup === 'confirmed'
        ? '服务器已确认原操作终止及清理'
        : '服务器已确认原操作终止；物理清理仍待确认';
    case 'unavailable':
      return '图片状态暂不能确认，请查询原操作';
    case 'selecting':
      return '正在选择并核验原图';
    case 'selected':
      return '原图意图已保存，等待上传';
    default:
      return '此入口只支持当前草稿的一张 JPEG 或 PNG';
  }
}
