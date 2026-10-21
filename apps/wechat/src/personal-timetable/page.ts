import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import { colors } from './contracts';
import {
  initialTimetableView,
  parseRoute,
  type Mode,
  type Route,
  type TimetableController,
  type TermForm,
  type EntryForm,
} from './controller';
import { createTimetableController } from './runtime';
type InputEvent = {
  currentTarget: { dataset: { field: string } };
  detail: { value: string };
};
type PickerEvent = { detail: { value: string | number } };
/** Shared native registration factory, exported for emitted real-HTTP journeys. */
function definition<T extends object>(
  value: T & ThisType<T & { setData(data: object): void }>,
): T {
  return value;
}
export function timetablePage(mode: Mode) {
  return definition({
    data: {
      ...initialTimetableView(mode),
      daysOfWeek: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      colorLabels: ['蓝色', '青色', '绿色', '橙色', '红色', '紫色'],
      colors: [...colors],
    },
    controller: undefined as TimetableController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    route: null as Route | null,
    onLoad(query: Record<string, unknown> = {}) {
      try {
        this.route = parseRoute(mode, query);
      } catch {
        this.route = null;
      }
    },
    onShow() {
      this.controller?.dispose();
      this.navigator?.dispose();
      this.setData(initialTimetableView(mode));
      if (!this.route) {
        this.setData({ error: '课表入口无效，请从校园工具重新打开。' });
        return;
      }
      try {
        this.controller =
          createTimetableController(mode, getApp<WhaleuApp>(), wx, (view) =>
            this.setData(view),
          ) ?? undefined;
      } catch {
        this.controller = undefined;
      }
      if (!this.controller) {
        this.setData({ error: '当前环境尚未配置个人课表服务。' });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.controller?.navigationFailed(),
      );
      void this.controller.load(this.route);
    },
    onRefresh() {
      void this.controller?.refresh();
    },
    onTerm(event: InputEvent) {
      this.controller?.setTerm(
        event.currentTarget.dataset.field as keyof TermForm,
        event.detail.value,
      );
    },
    onEntry(event: InputEvent) {
      this.controller?.setEntry(
        event.currentTarget.dataset.field as keyof EntryForm,
        event.detail.value,
      );
    },
    onDate(event: PickerEvent) {
      this.controller?.setTerm('weekOneMonday', String(event.detail.value));
    },
    onDay(event: PickerEvent) {
      this.controller?.setEntry('dayOfWeek', Number(event.detail.value) + 1);
    },
    onColor(event: PickerEvent) {
      const value = colors[Number(event.detail.value)];
      if (value) this.controller?.setEntry('color', value);
    },
    onStart(event: PickerEvent) {
      this.controller?.setEntry('startTime', String(event.detail.value));
    },
    onEnd(event: PickerEvent) {
      this.controller?.setEntry('endTime', String(event.detail.value));
    },
    onMidnight() {
      this.controller?.setEntry('endTime', '24:00');
    },
    onWeeks(event: {
      currentTarget: { dataset: { kind: 'all' | 'odd' | 'even' } };
    }) {
      this.controller?.chooseWeeks(event.currentTarget.dataset.kind);
    },
    onTermChoice(event: PickerEvent) {
      void this.controller?.selectTerm(Number(event.detail.value));
    },
    onWeekChoice(event: PickerEvent) {
      this.controller?.selectWeek(Number(event.detail.value) + 1);
    },
    onPrevious() {
      this.controller?.selectWeek(this.data.week - 1);
    },
    onNext() {
      this.controller?.selectWeek(this.data.week + 1);
    },
    onCurrent() {
      if (this.data.currentWeek)
        this.controller?.selectWeek(this.data.currentWeek);
    },
    onDetails(event: { currentTarget: { dataset: { id: string } } }) {
      this.controller?.selectEntry(event.currentTarget.dataset.id);
    },
    onCloseDetails() {
      this.controller?.closeDetails();
    },
    onNavigate(event: {
      currentTarget: {
        dataset: { target: Parameters<TimetableController['path']>[0] };
      };
    }) {
      this.navigator?.open(
        this.controller?.path(event.currentTarget.dataset.target) ?? null,
      );
    },
    onSave() {
      void this.controller?.save();
    },
    onConfirmDateShift() {
      void this.controller?.confirmDateShift();
    },
    onCancelConfirmation() {
      this.controller?.cancelConfirmation();
    },
    onDelete() {
      this.controller?.beginDelete();
    },
    onDeleteText(event: { detail: { value: string } }) {
      this.controller?.setDeleteText(event.detail.value);
    },
    onConfirmDelete() {
      void this.controller?.confirmDelete();
    },
    onRecover() {
      void this.controller?.recover('read');
    },
    onRetry() {
      void this.controller?.recover('retry');
    },
    onCancelOriginal() {
      void this.controller?.recover('cancel');
    },
    onHide() {
      this.navigator?.dispose();
      this.navigator = undefined;
      this.controller?.dispose();
      this.controller = undefined;
      this.setData(initialTimetableView(mode));
    },
    onUnload() {
      this.onHide();
    },
  });
}
