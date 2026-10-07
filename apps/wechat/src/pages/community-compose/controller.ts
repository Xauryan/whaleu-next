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
import type { PendingAttempt } from '../../community/pending-attempt';
import type { CommunityRuntime } from '../../community/runtime';
import type { Cancellation } from '../../platform/contracts';
export type ComposeTarget =
  | {
      readonly operation: 'publish_post';
      readonly spaceId: string;
      readonly category: Category;
    }
  | { readonly operation: 'publish_comment'; readonly postId: string };
export interface ComposeView extends CommunityView {
  readonly loaded: boolean;
  readonly text: string;
  readonly authorMode: AuthorMode;
  readonly effectiveIdentity: string;
  readonly identityForced: boolean;
  readonly commentsPolicy: 'open' | 'restricted';
  readonly canDisableComments: boolean;
  readonly frozen: boolean;
  readonly canSubmit: boolean;
  readonly blocker: string;
  readonly mediaNotice: string;
  readonly maxText: number;
  readonly receiptStatus: string;
  readonly resourceId: string;
  readonly resourcePostId: string;
  readonly recoveryOperation: string;
}
export const initialComposeView = (): ComposeView => ({
  ...initialCommunityView(),
  loaded: false,
  text: '',
  authorMode: 'named',
  effectiveIdentity: '',
  identityForced: false,
  commentsPolicy: 'open',
  canDisableComments: false,
  frozen: false,
  canSubmit: false,
  blocker: '',
  mediaNotice: '图片上传、预览与审核尚未接入，暂不能添加图片',
  maxText: 2500,
  receiptStatus: '',
  resourceId: '',
  resourcePostId: '',
  recoveryOperation: '',
});
/** An inconsistent imported default must require a choice, never silently reveal a named identity. */
export function commentIdentity(
  forcedAnonymous: boolean,
  explicit: AuthorMode | null,
  preferences: Pick<
    Preferences,
    'defaultCommentAnonymousEnabled' | 'defaultCommentNonAnonymousEnabled'
  >,
): { mode: AuthorMode; conflict: boolean } {
  if (forcedAnonymous) return { mode: 'anonymous', conflict: false };
  if (explicit) return { mode: explicit, conflict: false };
  if (
    preferences.defaultCommentAnonymousEnabled &&
    preferences.defaultCommentNonAnonymousEnabled
  )
    return { mode: 'anonymous', conflict: true };
  return {
    mode: preferences.defaultCommentAnonymousEnabled ? 'anonymous' : 'named',
    conflict: false,
  };
}
const targetKey = (target: ComposeTarget): string =>
  target.operation === 'publish_post'
    ? `post:${target.spaceId}:${target.category}`
    : `comment:${target.postId}`;
const attemptTarget = (attempt: PendingAttempt): ComposeTarget =>
  attempt.operation === 'publish_post'
    ? {
        operation: 'publish_post',
        spaceId: attempt.payload.spaceId,
        category: attempt.payload.category,
      }
    : { operation: 'publish_comment', postId: attempt.postId };
export class ComposeController extends CommunityController<ComposeView> {
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
  ) {
    super(runtime, initialComposeView, render);
  }
  protected override resetPrivate(): void {
    this.capabilities = null;
    this.commentCapabilities = null;
    this.parentPost = null;
    this.pending = null;
    this.draftSaved = false;
    this.identityConflict = false;
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
          target.operation === 'publish_comment'
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
          target.operation === 'publish_comment'
            ? await this.runtime.gateway!.commentCapabilities(
                target.postId,
                cancel,
              )
            : null;
        return { profile, post, capability, commentCapability };
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
        const draft = this.runtime.drafts.load(accountId, targetKey(target));
        const forced =
          result.commentCapability?.forcedAuthorMode === 'anonymous' ||
          (result.post?.viewer.isSelf === true &&
            result.post.author.kind === 'anonymous');
        const chosen =
          target.operation === 'publish_comment'
            ? commentIdentity(
                forced,
                draft?.authorMode ?? null,
                result.profile.preferences,
              )
            : {
                mode:
                  draft?.authorMode ??
                  (result.profile.preferences.defaultAnonymousEnabled
                    ? 'anonymous'
                    : 'named'),
                conflict: false,
              };
        this.identityConflict = chosen.conflict;
        this.update({
          loaded: true,
          text: draft?.text ?? '',
          authorMode: chosen.mode,
          commentsPolicy: draft?.commentsPolicy ?? 'open',
          identityForced: forced,
          canDisableComments:
            target.operation === 'publish_post' &&
            result.capability?.canDisableComments === true,
          maxText: target.operation === 'publish_post' ? 2500 : 500,
          status: draft
            ? '已恢复此账号的本地草稿'
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
      authorMode: pending.payload.authorMode,
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
      recoveryOperation: pending.operation === 'publish_post' ? '帖子' : '评论',
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
    this.update({ authorMode: mode });
    this.persistDraft();
    this.recompute();
  }
  setRestricted(restricted: boolean): void {
    if (!this.editable() || !this.view.canDisableComments) return;
    this.update({ commentsPolicy: restricted ? 'restricted' : 'open' });
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
        authorMode: this.view.authorMode,
        commentsPolicy: this.view.commentsPolicy,
      });
      this.draftSaved = true;
    } catch (error) {
      this.draftSaved = false;
      this.update({ error: communityError(error) });
    }
  }
  private recompute(): void {
    const cap = this.capabilities,
      isComment = this.target?.operation === 'publish_comment',
      publication = isComment ? this.commentCapabilities : cap?.publish,
      modes = isComment
        ? this.commentCapabilities?.authorModes
        : cap?.authorModes;
    let blocker = '';
    if (this.identityConflict)
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
        1,
        this.view.maxText,
      ) ||
      !this.view.text.trim()
    )
      blocker = `请输入 1–${this.view.maxText} 个有效字符，保留你输入的空格与换行`;
    this.update({
      blocker,
      canSubmit: !blocker && !this.view.frozen && this.view.loaded,
      effectiveIdentity:
        this.view.authorMode === 'anonymous'
          ? this.view.identityForced
            ? '匿名楼主（本帖评论必须匿名）'
            : '匿名身份（不会公开个人资料）'
          : '公开身份（显示昵称与公开资料身份）',
    });
  }
  async submit(): Promise<void> {
    if (!this.editable() || !this.available()) return;
    this.recompute();
    if (!this.view.canSubmit || !this.target) return;
    const target = this.target,
      accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    const draft = {
      text: this.view.text.replace(/\r\n/g, '\n'),
      authorMode: this.view.authorMode,
      commentsPolicy: this.view.commentsPolicy,
    };
    await this.run(
      async (cancel) => {
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
                  ...draft,
                  imageAssetIds: [],
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
                  imageAssetIds: [],
                }),
              };
        const frozen = this.runtime.pending.freeze(attempt);
        this.showPending(frozen);
        return this.dispatch(frozen, cancel);
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
  private dispatch(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<Receipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    const stored = this.runtime.pending.load(attempt.accountId);
    if (JSON.stringify(stored) !== JSON.stringify(attempt))
      throw new ClientError('storage', 'Pending request changed');
    return attempt.operation === 'publish_post'
      ? this.runtime.gateway!.publishPost(attempt.payload, cancel)
      : this.runtime.gateway!.publishComment(
          attempt.postId,
          attempt.payload,
          cancel,
        );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
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
      (cancel) =>
        retry
          ? this.dispatch(attempt, cancel)
          : this.runtime.gateway!.receipt(
              attempt.payload.clientRequestId,
              cancel,
            ),
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
    // Clear a successful draft before dropping recovery protection; failed local writes keep the request frozen.
    if (receipt.outcome === 'created')
      this.runtime.drafts.clear(
        attempt.accountId,
        targetKey(attemptTarget(attempt)),
      );
    this.runtime.pending.settle(attempt, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      loaded: false,
      text: receipt.outcome === 'created' ? '' : this.view.text,
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
  override cancel(): void {
    super.cancel();
    if (this.pending)
      this.update({ frozen: true, canSubmit: false, status: '发布结果待确认' });
  }
}
