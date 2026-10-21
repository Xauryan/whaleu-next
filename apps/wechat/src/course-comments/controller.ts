import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { courseId, invalidCourse } from '../course-ratings/contract';
import {
  courseCommentBody,
  courseCommentBytes,
  decodeCourseCommentIntent,
  decodeCourseCommentPage,
  type CourseComment,
  type CourseCommentPage,
  type CourseCommentReceipt,
  type CourseCommentSort,
} from './contract';
import type { PendingCourseComment } from './pending';
export interface CourseCommentsView extends CommunityView {
  readonly loaded: boolean;
  readonly courseId: string;
  readonly items: readonly CourseComment[];
  readonly sort: CourseCommentSort;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly body: string;
  readonly bodyBytes: number;
  readonly canPublish: boolean;
  readonly confirming: 'publish' | 'like' | 'cancel' | null;
  readonly selectedComment: CourseComment | null;
  readonly frozen: boolean;
  readonly recoveryCourseId: string;
  readonly recoveryOperation: string;
  readonly recoveryBody: string;
  readonly recoveryCommentId: string;
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
}
export const initialCourseCommentsView = (): CourseCommentsView => ({
  ...initialCommunityView(),
  loaded: false,
  courseId: '',
  items: [],
  sort: 'likes',
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  body: '',
  bodyBytes: 0,
  canPublish: false,
  confirming: null,
  selectedComment: null,
  frozen: false,
  recoveryCourseId: '',
  recoveryOperation: '',
  recoveryBody: '',
  recoveryCommentId: '',
  receiptMissing: false,
  receiptStatus: '',
});
export function courseCommentsError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  const messages: Record<string, string> = {
    PHONE_VERIFICATION_REQUIRED: '请先完成手机号验证，再重新加载课程回复',
    COURSE_CATALOG_UNAVAILABLE:
      '课程目录来源尚未确认，暂不能展示回复；这不代表没有回复',
    COURSE_NOT_FOUND: '此课程当前不可查看；原回复操作仍可独立查询回执',
    COURSE_COMMENT_NOT_FOUND: '这条回复当前不可查看，请刷新列表',
    COURSE_COMMENT_HISTORY_UNAVAILABLE:
      '回复或点赞历史尚未确认，不能当作没有回复或零个赞',
    COURSE_COMMENT_BASE_REQUIRED:
      '发布课程回复需要当前有效的学生认证、临时认证或管理员资格',
    COURSE_COMMENT_ALREADY_LIKED:
      '此账号已经赞过这条回复，每条回复只能赞一次，不能取消',
    COURSE_REVISION_CONFLICT: '课程目录已变化，请重新加载并明确确认新请求',
    COURSE_CURSOR_INVALID: '分页已经失效，请从第一页重新加载',
    COURSE_RESTART_REQUIRED: '回复或排序已变化，请从第一页重新加载',
    DISCOVERY_RESTART_REQUIRED: '回复或排序已变化，请从第一页重新加载',
    COURSE_COMMENT_CURSOR_INVALID: '分页已经失效，请从第一页重新加载',
    COURSE_COMMENT_RESTART_REQUIRED: '回复或排序已变化，请从第一页重新加载',
    REQUEST_NOT_FOUND:
      '暂未查到原回执。可重试原请求；若要取消，必须另行确认并取得服务端取消回执',
    CONTENT_REVIEW_UNAVAILABLE:
      '尚不能确认这份原文的有效审核，原请求已保留，稍后可查询或重试',
    CONTENT_REJECTED: '原文未通过审核，请先确认原请求回执再修改',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能访问课程回复；原操作仍可查询回执',
  };
  return messages[failure.details.serverCode ?? ''] ?? communityError(error);
}
const missing = (error: unknown): boolean => {
  const value = clientError(error);
  return (
    value.kind !== 'protocol' &&
    value.details.serverCode === 'REQUEST_NOT_FOUND' &&
    value.details.httpStatus === 404
  );
};
/** List authority is ephemeral; exact confirmed writes are durable and account scoped. */
export class CourseCommentsController extends CommunityController<CourseCommentsView> {
  private selectedCourseId: string | null = null;
  private pending: PendingCourseComment | null = null;
  private snapshot: CourseCommentPage | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: CourseCommentsView) => void,
  ) {
    super(runtime, initialCourseCommentsView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.snapshot = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.courseComments || !this.runtime.pendingCourseComments) {
      this.update({ error: '当前构建未配置课程回复服务', canPublish: false });
      return false;
    }
    return true;
  }
  private clearRead(): void {
    this.snapshot = null;
    this.update({
      loaded: false,
      items: [],
      canNext: false,
      canPublish: false,
      confirming: null,
      selectedComment: null,
    });
  }
  private restore(): boolean {
    const accountId = this.accountId();
    if (!accountId || !this.runtime.pendingCourseComments) return false;
    try {
      this.pending = this.runtime.pendingCourseComments.load(accountId);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryCourseId: '',
          recoveryOperation: '',
          recoveryBody: '',
          recoveryCommentId: '',
          receiptMissing: false,
        });
      return true;
    } catch (error) {
      this.clearRead();
      this.update({
        frozen: true,
        body: '',
        bodyBytes: 0,
        error: courseCommentsError(error),
      });
      return false;
    }
  }
  private showPending(value: PendingCourseComment): void {
    this.pending = value;
    this.update({
      frozen: true,
      canPublish: false,
      confirming: null,
      selectedComment: null,
      body: '',
      bodyBytes: 0,
      recoveryCourseId: value.intent.courseId,
      recoveryOperation: value.intent.operation,
      recoveryBody:
        value.intent.operation === 'course.comment.publish.v1'
          ? value.intent.payload.body
          : '',
      recoveryCommentId:
        value.intent.operation === 'course.comment.like.v1'
          ? value.intent.commentId
          : '',
      status: '原回复操作结果待确认',
    });
  }
  async load(id: string | null = null): Promise<void> {
    if (this.view.busy) return;
    if (id !== null && !courseId(id)) {
      this.update({ error: '课程入口无效，请从课程详情重新进入' });
      return;
    }
    this.selectedCourseId = id;
    this.update({ courseId: id ?? '' });
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    this.restore();
    if (this.selectedCourseId) await this.loadPage(null);
    else
      this.update({
        status: this.pending
          ? '原回复操作结果待确认'
          : '当前账号没有待确认的课程回复操作',
      });
  }
  async setSort(sort: unknown): Promise<void> {
    if (
      this.view.busy ||
      (sort !== 'likes' && sort !== 'time') ||
      !this.ready()
    )
      return;
    this.update({ sort, confirming: null, selectedComment: null });
    if (this.selectedCourseId) await this.loadPage(null);
  }
  async next(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canNext ||
      !this.snapshot?.nextCursor ||
      !this.ready()
    )
      return;
    await this.loadPage(this.snapshot.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const id = this.selectedCourseId;
    if (!id) return;
    const prior = this.snapshot,
      sort = this.view.sort,
      pageNumber = cursor ? this.view.pageNumber + 1 : 1;
    this.clearRead();
    this.update({ restartRequired: false, status: '正在核验课程回复' });
    await this.run(
      async (cancel) => {
        const page = decodeCourseCommentPage(
          await this.runtime.courseComments!.list(id, sort, cursor, cancel),
        );
        if (page.courseId !== id || (cursor && page.nextCursor === cursor))
          invalidCourse();
        if (
          cursor &&
          (!prior ||
            prior.catalogRevision !== page.catalogRevision ||
            prior.courseRevision !== page.courseRevision ||
            prior.commentRevision !== page.commentRevision)
        )
          throw new ClientError('business', 'Comment snapshot changed', {
            serverCode: 'COURSE_COMMENT_RESTART_REQUIRED',
          });
        return page;
      },
      (page) => {
        const storageReady = this.restore();
        this.snapshot = page;
        this.update({
          loaded: true,
          items: page.items,
          pageNumber,
          canNext: page.nextCursor !== null,
          canPublish:
            storageReady && !this.pending && courseCommentBody(this.view.body),
          status: this.pending
            ? '原回复操作结果待确认'
            : page.items.length
              ? '课程回复已加载'
              : '当前已确认没有课程回复',
        });
      },
      (error) => {
        this.clearRead();
        this.update({
          pageNumber: 0,
          restartRequired: cursor !== null,
          error: courseCommentsError(error),
          status: '课程回复暂不可用',
        });
      },
    );
  }
  setBody(body: string): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.loaded
    )
      return;
    if (!this.restore() || this.pending) return;
    this.update({
      body,
      bodyBytes: courseCommentBytes(body),
      canPublish: courseCommentBody(body),
    });
  }
  confirmPublish(): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.view.canPublish ||
      !this.snapshot ||
      !this.ready()
    )
      return;
    if (!this.restore() || this.pending) return;
    this.update({ confirming: 'publish', selectedComment: null });
  }
  confirmLike(id: string): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirming ||
      !this.view.loaded ||
      !this.snapshot ||
      !this.ready()
    )
      return;
    const comment = this.view.items.find((item) => item.id === id);
    if (!comment || !this.restore() || this.pending) return;
    this.update({ confirming: 'like', selectedComment: comment });
  }
  closeConfirmation(): void {
    if (this.view.busy) return;
    this.update({ confirming: null, selectedComment: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.snapshot ||
      (this.view.confirming !== 'publish' && this.view.confirming !== 'like') ||
      !this.ready()
    )
      return;
    const operation = this.view.confirming,
      body = this.view.body,
      comment = this.view.selectedComment,
      snapshot = this.snapshot;
    if (
      (operation === 'publish' && !courseCommentBody(body)) ||
      (operation === 'like' && !comment) ||
      !this.restore() ||
      this.pending
    )
      return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = {
          clientRequestId: requestId,
          expectedCatalogRevision: snapshot.catalogRevision,
          expectedCourseRevision: snapshot.courseRevision,
        };
        const intent = decodeCourseCommentIntent(
          operation === 'publish'
            ? {
                operation: 'course.comment.publish.v1',
                courseId: snapshot.courseId,
                payload: { ...command, body },
              }
            : {
                operation: 'course.comment.like.v1',
                courseId: snapshot.courseId,
                commentId: comment!.id,
                payload: command,
              },
        );
        const attempt = this.runtime.pendingCourseComments!.freeze({
          version: 1,
          accountId,
          intent,
        });
        this.clearRead();
        this.showPending(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.clearRead();
        if (this.pending) this.showPending(this.pending);
        else this.update({ frozen: true });
        this.update({ error: courseCommentsError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private assertAttempt(
    attempt: PendingCourseComment,
    cancel: Cancellation,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingCourseComments!.assertOriginal(attempt);
  }
  private dispatch(
    attempt: PendingCourseComment,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt> {
    this.assertAttempt(attempt, cancel);
    return this.runtime.courseComments!.submit(attempt.intent, cancel);
  }
  /** Even explicit retry always asks for the receipt before resending the original bytes. */
  async recover(retry = false, prepareCancel = false): Promise<void> {
    if (this.view.busy || !this.ready() || !this.restore() || !this.pending)
      return;
    const attempt = this.pending;
    this.clearRead();
    this.update({ receiptMissing: false });
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(attempt, cancel);
        try {
          return await this.runtime.courseComments!.receipt(
            attempt.intent.payload.clientRequestId,
            cancel,
          );
        } catch (error) {
          if (!missing(error)) throw error;
          this.assertAttempt(attempt, cancel);
          if (retry) return this.dispatch(attempt, cancel);
          throw error;
        }
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.showPending(attempt);
        this.update({
          receiptMissing: missing(error),
          confirming: missing(error) && prepareCancel ? 'cancel' : null,
          error: courseCommentsError(error),
        });
      },
    );
    if (settled) await this.reload();
  }
  async confirmCancellation(): Promise<void> {
    if (
      this.view.busy ||
      this.view.confirming !== 'cancel' ||
      !this.view.receiptMissing ||
      !this.pending ||
      !this.ready()
    )
      return;
    const attempt = this.pending;
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(attempt, cancel);
        // The server's serialized tombstone resolves races with delayed commands.
        return this.runtime.courseComments!.cancel(attempt.intent, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.showPending(attempt);
        this.update({
          receiptMissing: false,
          error: courseCommentsError(error),
        });
      },
    );
    if (settled) await this.reload();
  }
  private settle(receipt: CourseCommentReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidCourse();
    const result = this.runtime.pendingCourseComments!.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.clearRead();
    this.update({
      frozen: false,
      recoveryCourseId: '',
      recoveryOperation: '',
      recoveryBody: '',
      recoveryCommentId: '',
      receiptMissing: false,
      body: '',
      bodyBytes: 0,
      receiptStatus:
        result.outcome === 'applied'
          ? result.operation === 'course.comment.publish.v1'
            ? '原回复已确认发布。当前列表将单独重新核验。'
            : '原点赞已确认成功，不能取消。当前列表将单独重新核验。'
          : result.code === 'COURSE_COMMENT_CANCELLED'
            ? '服务端已确认取消原请求；原请求不会再写入。'
            : result.code === 'COURSE_COMMENT_ALREADY_LIKED'
              ? '原请求已确认未写入：此账号已经赞过这条回复。'
              : result.code === 'CONTENT_REJECTED'
                ? '原请求已确认未写入：原文未通过审核，可重新编辑并确认。'
                : '原请求已确认未写入：课程版本已变化，请刷新后重新确认。',
    });
  }
  override cancel(): void {
    super.cancel();
    this.clearRead();
    this.update({ receiptMissing: false });
  }
}
