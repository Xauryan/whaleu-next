import type { WhaleuApp } from '../../app';
import { isRecord } from '../../api/errors';
import { courseId } from '../../course-ratings/contract';
import {
  CourseCommentsController,
  initialCourseCommentsView,
} from '../../course-comments/controller';
Page({
  data: initialCourseCommentsView(),
  courseId: null as string | null,
  validRoute: false,
  controller: undefined as CourseCommentsController | undefined,
  onLoad(query: unknown = {}) {
    this.validRoute =
      isRecord(query) &&
      (Object.keys(query).length === 0 ||
        (Object.keys(query).length === 1 && courseId(query.courseId)));
    this.courseId =
      this.validRoute && isRecord(query) && courseId(query.courseId)
        ? query.courseId
        : null;
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.validRoute) {
      this.setData({
        ...initialCourseCommentsView(),
        error: runtime
          ? '课程入口无效，请从课程详情重新进入'
          : '环境尚未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new CourseCommentsController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.courseId);
  },
  onRefresh() {
    void this.controller?.reload();
  },
  onNext() {
    void this.controller?.next();
  },
  onSort(event: { currentTarget: { dataset: { sort?: string } } }) {
    void this.controller?.setSort(event.currentTarget.dataset.sort);
  },
  onBody(event: { detail: { value: string } }) {
    this.controller?.setBody(event.detail.value);
  },
  onConfirmPublish() {
    this.controller?.confirmPublish();
  },
  onConfirmLike(event: { currentTarget: { dataset: { id?: string } } }) {
    this.controller?.confirmLike(event.currentTarget.dataset.id ?? '');
  },
  onSubmit() {
    void this.controller?.submit();
  },
  onCloseConfirmation() {
    this.controller?.closeConfirmation();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onRequestCancellation() {
    void this.controller?.recover(false, true);
  },
  onConfirmCancellation() {
    void this.controller?.confirmCancellation();
  },
  onCancelWait() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
