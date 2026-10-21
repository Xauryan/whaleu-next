import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { courseId, courseScoreChoices } from './contract';
import {
  CourseRatingController,
  initialCourseRatingView,
  type CourseMode,
} from './controller';
type Tap = {
  currentTarget: {
    dataset: {
      id?: string;
      axis?: string;
      score?: string | number;
      sort?: string;
    };
  };
};
const departments = Object.freeze([
  null,
  ...Array.from({ length: 54 }, (_, index) => index + 1),
  99,
]);
export function registerCourseRatingPage(mode: CourseMode): void {
  Page({
    data: {
      ...initialCourseRatingView(),
      uiPanel: '',
      scores: courseScoreChoices,
      departmentLabels: departments.map((id) =>
        id === null
          ? '全部院系'
          : id === 99
            ? '旧分类 90–99 分组'
            : `院系 ${id}`,
      ),
      departmentIndex: 0,
    },
    courseId: null as string | null,
    validRoute: mode === 'catalog',
    controller: undefined as CourseRatingController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      this.validRoute =
        isRecord(query) &&
        (mode === 'catalog'
          ? Object.keys(query).length === 0
          : Object.keys(query).length === 1 && courseId(query.courseId));
      this.courseId =
        this.validRoute && isRecord(query) && courseId(query.courseId)
          ? query.courseId
          : null;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) return;
      let owner = runtime.sessions.snapshot();
      this.unsubscribeSession = runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          owner = current;
          this.setData({ uiPanel: '' });
          this.navigator?.dispose();
          if (this.controller)
            this.navigator = new DirectoryNavigator(wx, () =>
              this.setData({ error: '暂不能打开课程，请重试' }),
            );
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.navigator?.dispose();
      });
    },
    onShow() {
      this.setData({ uiPanel: '' });
      this.controller?.dispose();
      this.navigator?.dispose();
      this.controller = undefined;
      this.navigator = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialCourseRatingView(),
          error: runtime
            ? '课程入口无效，请从目录重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开课程，请重试' }),
      );
      this.controller = new CourseRatingController(runtime, mode, (view) =>
        this.setData({
          ...view,
          ...(!view.hasSession || !view.loaded ? { uiPanel: '' } : {}),
          departmentIndex: Math.max(
            0,
            departments.indexOf(view.departmentDraft),
          ),
        }),
      );
      void this.controller.load(this.courseId);
    },
    onTogglePanel(event: { currentTarget: { dataset: { panel?: string } } }) {
      const panel = event.currentTarget.dataset.panel;
      if (typeof panel !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(panel))
        return;
      this.setData({ uiPanel: this.data.uiPanel === panel ? '' : panel });
    },
    onClosePanel() {
      this.setData({ uiPanel: '' });
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onCancel() {
      this.controller?.cancel();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onSearchInput(event: { detail: { value: string } }) {
      this.controller?.setSearch(event.detail.value);
    },
    onCategoryInput(event: { detail: { value: string } }) {
      this.controller?.setCategory(event.detail.value);
    },
    onDepartment(event: { detail: { value: string } }) {
      const index = Number(event.detail.value);
      if (Number.isInteger(index) && index >= 0 && index < departments.length)
        this.controller?.setDepartment(departments[index]!);
    },
    onSort(event: Tap) {
      this.controller?.setSort(event.currentTarget.dataset.sort);
    },
    onSearch() {
      void this.controller?.search();
    },
    onNext() {
      void this.controller?.next();
    },
    onCourse(event: Tap) {
      this.navigator?.open(
        this.controller?.detailPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onScore(event: Tap) {
      this.controller?.chooseScore(
        event.currentTarget.dataset.axis ?? '',
        Number(event.currentTarget.dataset.score),
      );
    },
    onConfirm() {
      this.controller?.confirm();
    },
    onCloseConfirmation() {
      this.controller?.closeConfirmation();
    },
    onSubmit() {
      void this.controller?.submit();
    },
    onHide() {
      this.setData({ uiPanel: '' });
      this.navigator?.dispose();
      this.controller?.dispose();
      this.navigator = undefined;
      this.controller = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeHide?.();
    },
  });
}
