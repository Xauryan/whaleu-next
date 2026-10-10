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
export type ComposeTarget =
  | {
      readonly operation: 'publish_post';
      readonly spaceId: string;
      readonly category: Category;
    }
  | { readonly operation: 'publish_comment'; readonly postId: string }
  | {
      readonly operation: 'publish_reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly targetReplyId: string | null;
    };
export interface ComposeView extends CommunityView {
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
  private readonly uploader: MediaUploadController | undefined;
  private readonly batcher: MediaBatchController | undefined;
  private mediaMode: 'legacy' | 'batch' | 'conflict' = 'legacy';
  private mediaGeneration = 0;
  private mediaDisposed = false;
  private mediaAction: { kind: string; task: Promise<void> } | null = null;
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
    try {
      this.mediaMode =
        runtime.mediaBatch && this.accountId()
          ? runtime.mediaBatch.modeForActor(this.accountId()!)
          : 'legacy';
    } catch {
      this.mediaMode = 'conflict';
    }
    this.batcher = runtime.mediaBatch?.create((view) => {
      if (this.mediaDisposed || this.mediaMode === 'legacy') return;
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
      if (this.mediaDisposed || this.mediaMode !== 'legacy') return;
      this.update({
        mediaStatus: view.status,
        mediaProgress: view.progress,
        canSelectImage: this.uploader?.available === true,
        mediaNotice: mediaUploadNotice(view),
      });
      this.recompute();
    });
  }
  private useBatch(): boolean {
    return this.mediaMode === 'batch' && !!this.batcher;
  }
  private activeUploader():
    MediaBatchController | MediaUploadController | undefined {
    return this.mediaMode === 'conflict'
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
      const pending = this.runtime.pending.load(accountId);
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
    await this.run(
      async (cancel) => {
        const [profile, post] = await Promise.all([
          this.runtime.profiles!.profile(cancel),
          target.operation !== 'publish_post'
            ? this.runtime.gateway!.post(target.postId, cancel)
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
        return {
          profile,
          post,
          capability,
          commentCapability,
          replyTargetName,
          copiedText,
        };
      },
      (result) => {
        // Another page may have frozen a request while profile/capabilities were loading.
        const pending = this.runtime.pending.load(accountId);
        if (pending) {
          this.showPending(pending);
          return;
        }
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
              blocker: '请先恢复或取消原评论对象的整批图片',
            });
            throw error;
          }
        }
        const draft = this.runtime.drafts.load(accountId, targetKey(target));
        const forced =
          result.commentCapability?.forcedAuthorMode === 'anonymous' ||
          (result.post?.viewer.isSelf === true &&
            result.post.author.kind === 'anonymous');
        const trading =
          target.operation === 'publish_post' && target.category === 'trading';
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
          isTrading: trading,
          tradingDraft: trading
            ? (draft?.trading ?? initialTrading)
            : emptyTradingDraft(),
          replyTargetName: result.replyTargetName,
          text: draft?.text ?? result.copiedText ?? '',
          pollDraft:
            target.operation === 'publish_post' && !trading
              ? (draft?.poll ?? emptyPollDraft())
              : emptyPollDraft(),
          canAddPoll: target.operation === 'publish_post' && !trading,
          formationDraft:
            target.operation === 'publish_post' && !trading
              ? (draft?.formation ?? emptyFormationDraft())
              : emptyFormationDraft(),
          canAddFormation: target.operation === 'publish_post' && !trading,
          authorMode: chosen.mode,
          canChooseAnonymousDm: target.operation === 'publish_post',
          allowAnonymousDm:
            draft?.allowAnonymousDm ??
            result.profile.preferences.defaultAllowAnonymousDm ??
            false,
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
    this.pending = pending;
    this.update({
      loaded: true,
      frozen: true,
      canSubmit: false,
      text: pending.payload.text,
      maxImages: pending.operation === 'publish_post' ? 9 : 3,
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
        pending.payload.category !== 'trading',
      formationDraft:
        pending.operation === 'publish_post' &&
        pending.payload.component?.kind === 'formation'
          ? componentFormationDraft(pending.payload.component)
          : emptyFormationDraft(),
      canAddFormation:
        pending.operation === 'publish_post' &&
        pending.payload.category !== 'trading',
      authorMode: pending.payload.authorMode,
      canChooseAnonymousDm: pending.operation === 'publish_post',
      allowAnonymousDm:
        pending.operation === 'publish_post'
          ? pending.payload.allowAnonymousDm === true
          : false,
      effectiveIdentity:
        pending.payload.authorMode === 'anonymous'
          ? '匿名身份（原请求，保持不变）'
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
            ? '评论'
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
      const pending = this.runtime.pending.load(this.accountId()!);
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
  setAllowAnonymousDm(value: boolean): void {
    if (
      !this.editable() ||
      !this.view.canChooseAnonymousDm ||
      this.view.authorMode !== 'named'
    )
      return;
    this.update({ allowAnonymousDm: value });
    this.persistDraft();
  }
  setRestricted(restricted: boolean): void {
    if (!this.editable() || !this.view.canDisableComments) return;
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
  private persistDraft(): void {
    const accountId = this.accountId();
    if (!accountId || !this.target) return;
    try {
      this.runtime.drafts.save(accountId, targetKey(this.target), {
        version: 1,
        text: this.view.text,
        ...(this.target.operation === 'publish_post'
          ? { allowAnonymousDm: this.view.allowAnonymousDm }
          : {}),
        authorMode: this.view.authorMode,
        commentsPolicy: this.view.commentsPolicy,
        ...(this.target.operation === 'publish_post'
          ? this.view.isTrading
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
  private recompute(): void {
    const cap = this.capabilities,
      isComment = !!this.target && this.target.operation !== 'publish_post',
      publication = isComment ? this.commentCapabilities : cap?.publish,
      modes = isComment
        ? this.commentCapabilities?.authorModes
        : cap?.authorModes;
    let blocker = '';
    if (isComment && this.mediaMode === 'legacy' && this.runtime.mediaBatch)
      blocker = '请先恢复原帖子的图片操作';
    else if (this.mediaMode === 'conflict')
      blocker = '先分别恢复旧图片与整批图片记录';
    else if (this.identityConflict)
      blocker = '历史评论身份偏好冲突，请明确选择匿名或公开身份';
    else if (!this.draftSaved) blocker = '草稿尚未可靠保存，暂不能发布';
    else if (!publication || publication.availability !== 'allowed')
      blocker = reasonMessage(publication?.reason ?? 'COMMUNITY_UNAVAILABLE');
    else if (!modes?.includes(this.view.authorMode))
      blocker = '所选身份不被允许；不会自动改成公开身份，请自行选择';
    else if (isComment && !this.parentPost?.viewer.canComment)
      blocker = '此帖当前不可评论';
    else if (
      this.view.commentsPolicy === 'restricted' &&
      !cap?.canDisableComments
    )
      blocker = '当前账号无权限制评论，请手动改为开放评论';
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
          '请阅读并确认：填写的联系方式将向有权查看此帖的组内成员提供，匿名时也可能识别你的身份';
      else {
        try {
          formationDraftComponent(this.view.formationDraft);
        } catch {
          blocker =
            '请填写 1–20 的整数人数、1–12 字的活动主题及至少一种联系方式；微信最多 100、QQ 最多 50、电话最多 20 UTF-8 字节，不会截断或自动修正';
        }
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
      canSubmit: !blocker && !this.view.frozen && this.view.loaded,
      canOpenIdentityCampus:
        this.draftSaved && !this.view.frozen && this.view.loaded,
      effectiveIdentity:
        this.view.authorMode === 'anonymous'
          ? this.view.identityForced
            ? '匿名楼主（本帖评论必须匿名）'
            : this.view.formationDraft.enabled
              ? '匿名身份（公开展示匿名形象；组内联系方式仍可能识别你）'
              : '匿名身份（不会公开个人资料）'
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
    const component = this.view.formationDraft.enabled
      ? formationDraftComponent(this.view.formationDraft)
      : pollDraftComponent(this.view.pollDraft);
    const trading = this.view.isTrading
      ? tradingDraftIntent(this.view.tradingDraft)
      : undefined;
    const draft = {
      ...(component.kind !== 'none' ? { component } : {}),
      ...(trading ? { trading } : {}),
      allowAnonymousDm: this.view.allowAnonymousDm,
      text: this.view.text.replace(/\r\n/g, '\n'),
      authorMode: this.view.authorMode,
      commentsPolicy: this.view.commentsPolicy,
    };
    await this.run(
      async (cancel) => {
        const imageTarget = this.mediaTarget('');
        const imageAssetIds = this.useBatch()
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
                version: 1,
                accountId,
                operation: 'publish_post',
                payload: decodePostIntent({
                  clientRequestId: requestId,
                  spaceId: target.spaceId,
                  category: target.category,
                  ...(draft.component ? { component: draft.component } : {}),
                  ...(draft.trading ? { trading: draft.trading } : {}),
                  text: draft.text,
                  authorMode: draft.authorMode,
                  commentsPolicy: draft.commentsPolicy,
                  imageAssetIds,
                  ...(draft.authorMode === 'named'
                    ? { allowAnonymousDm: draft.allowAnonymousDm }
                    : {}),
                }),
              }
            : target.operation === 'publish_reply'
              ? {
                  version: 1,
                  accountId,
                  operation: 'publish_reply',
                  postId: target.postId,
                  rootCommentId: target.rootCommentId,
                  payload: decodeReplyIntent({
                    clientRequestId: requestId,
                    text: draft.text,
                    authorMode: draft.authorMode,
                    imageAssetIds,
                    targetReplyId: target.targetReplyId,
                  }),
                }
              : {
                  version: 1,
                  accountId,
                  operation: 'publish_comment',
                  postId: target.postId,
                  payload: decodeCommentIntent({
                    clientRequestId: requestId,
                    text: draft.text,
                    authorMode: draft.authorMode,
                    imageAssetIds,
                  }),
                };
        // Reserve metadata first; Community remains the only owner of body bytes.
        if (this.useBatch())
          this.runtime.mediaBatch!.reservePublication(attempt);
        let frozen: PendingAttempt;
        try {
          frozen = this.runtime.pending.freeze(attempt);
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
        const receipt = await this.dispatch(frozen, cancel);
        return this.useBatch()
          ? this.runtime.mediaBatch!.verifyReceipt(frozen, receipt, cancel)
          : receipt;
      },
      (receipt) => this.settle(receipt),
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
  private async dispatch(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<Receipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    const stored = this.runtime.pending.load(attempt.accountId);
    if (JSON.stringify(stored) !== JSON.stringify(attempt))
      throw new ClientError('storage', 'Pending request changed');
    if (this.useBatch())
      await this.runtime.mediaBatch!.beforePublication(attempt, cancel);
    else this.runtime.mediaUpload?.beforePublication(attempt);
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
      pending = this.runtime.pending.load(this.accountId()!);
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
      (receipt) => this.settle(receipt),
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
    if (receipt.outcome === 'created')
      this.runtime.drafts.clear(
        attempt.accountId,
        targetKey(attemptTarget(attempt)),
      );
    this.runtime.pending.settle(attempt, receipt);
    if (this.useBatch()) this.runtime.mediaBatch!.publicationSettled(attempt);
    this.pending = null;
    this.update({
      frozen: false,
      loaded: false,
      text: receipt.outcome === 'created' ? '' : this.view.text,
      pollDraft:
        receipt.outcome === 'created' ? emptyPollDraft() : this.view.pollDraft,
      formationDraft:
        receipt.outcome === 'created'
          ? emptyFormationDraft()
          : this.view.formationDraft,
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
        !this.runtime.pending.load(this.accountId()!)
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
    this.mediaDisposed = true;
    this.mediaGeneration++;
    this.mediaAction = null;
    this.uploader?.dispose();
    this.batcher?.dispose();
    super.dispose();
  }
  override cancel(): void {
    super.cancel();
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
