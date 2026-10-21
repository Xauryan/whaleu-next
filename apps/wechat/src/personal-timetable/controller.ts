import type { SessionStore } from '../auth/session';
import { ClientError } from '../api/errors';
import { Cancellation } from '../platform/contracts';
import {
  colors,
  decodeCommand,
  decodeEntryFields,
  decodeTermFields,
  integer,
  uuid,
  matchReceipt,
} from './contracts';
import type {
  Color,
  Command,
  Detail,
  Entry,
  EntryFields,
  Receipt,
  Term,
  TermFields,
} from './contracts';
import {
  clockTime,
  conflicts,
  currentMonday,
  explicitWeeks,
  monday,
  shanghaiToday,
  timeMinutes,
  weekAt,
  weekDates,
  weeksFor,
} from './calendar';
import type { TimetableGateway } from './gateway';
import { TimetableJournal, type Pending } from './journal';
export type Mode = 'agenda' | 'term' | 'entry';
export interface Route {
  termId: string | null;
  entryId: string | null;
  duplicate: boolean;
}
export function parseRoute(mode: Mode, raw: Record<string, unknown>): Route {
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'termId',
          ...(mode === 'entry' ? ['entryId', 'duplicate'] : []),
        ].includes(key),
    )
  )
    throw new Error('课表入口无效');
  const termId = raw.termId === undefined ? null : uuid(raw.termId),
    entryId = raw.entryId === undefined ? null : uuid(raw.entryId);
  if (
    (mode === 'entry' && !termId) ||
    (raw.duplicate !== undefined && (raw.duplicate !== '1' || !entryId))
  )
    throw new Error('课表入口无效');
  return { termId, entryId, duplicate: raw.duplicate === '1' };
}
export interface TermForm {
  name: string;
  weekOneMonday: string;
  weekCount: string;
}
export interface EntryForm {
  name: string;
  teacher: string;
  location: string;
  note: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  weeksText: string;
  color: Color;
}
export interface AgendaEntry extends Entry {
  timeLabel: string;
  conflicting: boolean;
}
export interface AgendaDay {
  dayOfWeek: number;
  label: string;
  date: string;
  today: boolean;
  entries: AgendaEntry[];
}
export interface TimetableView {
  mode: Mode;
  busy: boolean;
  ready: boolean;
  authenticated: boolean;
  blocked: boolean;
  pending: boolean;
  cancelPending: boolean;
  requestId: string;
  terms: Term[];
  term: Term | null;
  termIndex: number;
  week: number;
  weekOptions: string[];
  currentWeek: number | null;
  currentLabel: string;
  days: AgendaDay[];
  selected: (Entry & { timeLabel: string }) | null;
  termForm: TermForm;
  entryForm: EntryForm;
  editing: boolean;
  duplicate: boolean;
  conflictWarning: string;
  message: string;
  error: string;
  dateShiftPrompt: string;
  deletePrompt: boolean;
  deleteText: string;
}
const emptyTerm = (): TermForm => ({
  name: '',
  weekOneMonday: '',
  weekCount: '20',
});
const emptyEntry = (): EntryForm => ({
  name: '',
  teacher: '',
  location: '',
  note: '',
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '08:45',
  weeksText: '',
  color: 'blue',
});
export const initialTimetableView = (mode: Mode = 'agenda'): TimetableView => ({
  mode,
  busy: false,
  ready: false,
  authenticated: false,
  blocked: false,
  pending: false,
  cancelPending: false,
  requestId: '',
  terms: [],
  term: null,
  termIndex: 0,
  week: 1,
  weekOptions: [],
  currentWeek: null,
  currentLabel: '',
  days: [],
  selected: null,
  termForm: emptyTerm(),
  entryForm: emptyEntry(),
  editing: false,
  duplicate: false,
  conflictWarning: '',
  message: '',
  error: '',
  dateShiftPrompt: '',
  deletePrompt: false,
  deleteText: '',
});
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const rejectLabels: Record<string, string> = {
  TIMETABLE_NOT_FOUND: '该学期或课程已不存在，请刷新后查看。',
  TIMETABLE_REVISION_CONFLICT:
    '课表已在其他设备更新，本次未保存。请刷新后重新编辑。',
  TIMETABLE_ID_REUSED: '该记录标识已使用，本次未保存。请重新打开编辑页。',
  TIMETABLE_TERM_LIMIT: '最多保留 32 个学期，请先整理已有学期。',
  TIMETABLE_ENTRY_LIMIT: '每学期最多 200 条课程，请先整理已有课程。',
  TIMETABLE_WEEKS_OUT_OF_RANGE:
    '已有课程超出新学期周数，本次未保存。请先修改相关课程，不会自动裁剪。',
  SAFETY_ACCESS_SUSPENDED: '当前账户暂不能修改课表。',
  SAFETY_ACTION_RESTRICTED: '当前账户暂不能修改课表。',
};
/** Page-local state; mutations always go through the durable account/origin journal. */
export class TimetableController {
  private view: TimetableView;
  private detail: Detail | null = null;
  private pending: Pending | null = null;
  private route: Route = { termId: null, entryId: null, duplicate: false };
  private generation = 0;
  private cancellation = new Cancellation();
  private active = false;
  private disposed = false;
  private flight: Promise<void> | null = null;
  private dateShiftIntent = '';
  private readonly unsubscribe: () => void;
  private readonly unsubscribeVisibility: () => void;
  constructor(
    private readonly mode: Mode,
    private readonly sessions: SessionStore,
    private readonly gateway: TimetableGateway,
    private readonly journal: TimetableJournal,
    private readonly newId: () => Promise<string>,
    private readonly render: (view: TimetableView) => void,
    private readonly now: () => number = Date.now,
    visibility?: {
      subscribe(listener: (accountId?: string) => void): () => void;
    },
  ) {
    this.view = initialTimetableView(mode);
    let owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      )
        this.hide();
      owner = current;
    });
    this.unsubscribeVisibility =
      visibility?.subscribe((actor) => {
        if (!actor || actor === sessions.snapshot().credentials?.accountId)
          this.hide();
      }) ?? (() => {});
  }
  private emit() {
    this.render({
      ...this.view,
      termForm: { ...this.view.termForm },
      entryForm: { ...this.view.entryForm },
    });
  }
  private invalidate() {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.flight = null;
  }
  hide(): void {
    this.active = false;
    this.invalidate();
    this.detail = null;
    this.pending = null;
    this.dateShiftIntent = '';
    this.view = initialTimetableView(this.mode);
    this.emit();
  }
  dispose(): void {
    this.hide();
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeVisibility();
  }
  private actor(): string {
    const account = this.sessions.snapshot().credentials?.accountId;
    if (!account)
      throw new ClientError('auth-required', '请先登录后使用个人课表');
    return account;
  }
  private showPending(value: Pending | null) {
    this.pending = value;
    this.view.pending = !!value;
    this.view.cancelPending = value?.phase === 'cancel';
    this.view.requestId = value?.command.requestId ?? '';
    if (value) {
      this.view.dateShiftPrompt = '';
      this.view.deletePrompt = false;
      this.view.deleteText = '';
      this.view.selected = null;
    }
  }
  private run(
    work: (current: () => boolean, cancel: Cancellation) => Promise<void>,
  ): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.active || this.disposed) return Promise.resolve();
    const generation = this.generation,
      cancel = this.cancellation,
      ticket = this.sessions.snapshot();
    const current = () =>
      this.active &&
      !this.disposed &&
      generation === this.generation &&
      !cancel.isCancelled &&
      ticket.epoch === this.sessions.snapshot().epoch &&
      ticket.credentials?.accountId ===
        this.sessions.snapshot().credentials?.accountId;
    this.view.busy = true;
    this.view.error = '';
    this.emit();
    const flight = Promise.resolve()
      .then(() => (current() ? work(current, cancel) : undefined))
      .catch((error: unknown) => {
        if (!current()) return;
        if (error instanceof ClientError && error.kind === 'storage') {
          this.view.blocked = true;
          this.view.error =
            '原请求记录无法安全保存或读取，已停止发送。请重试读取，不要清理本地记录。';
        } else if (
          error instanceof ClientError &&
          (['auth-required', 'auth-expired', 'stale-session'].includes(
            error.kind,
          ) ||
            ['ACCOUNT_BLOCKED', 'SAFETY_ACCESS_SUSPENDED'].includes(
              error.details.serverCode ?? '',
            ))
        ) {
          const pending = this.view.pending,
            requestId = this.view.requestId,
            cancelPending = this.view.cancelPending;
          this.detail = null;
          this.pending = null;
          this.dateShiftIntent = '';
          this.view = {
            ...initialTimetableView(this.mode),
            busy: true,
            pending,
            requestId,
            cancelPending,
            error:
              '访问状态已失效，请重新登录或确认账户状态。原请求仍按账户保留。',
          };
        } else
          this.view.error = this.view.pending
            ? '结果尚未确认。请查询原请求，或明确重试、取消原请求。'
            : '需要联网读取或保存课表，请检查网络后重试。';
      })
      .finally(() => {
        if (current()) {
          this.view.busy = false;
          this.flight = null;
          this.emit();
        }
      });
    this.flight = flight;
    return flight;
  }
  load(route: Route): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.invalidate();
    this.active = true;
    this.route = { ...route };
    this.detail = null;
    this.pending = null;
    this.dateShiftIntent = '';
    this.view = initialTimetableView(this.mode);
    this.view.authenticated = !!this.sessions.snapshot().credentials;
    if (!this.view.authenticated) {
      this.view.error = '请先登录后使用个人课表';
      this.emit();
      return Promise.resolve();
    }
    return this.run(async (current, cancel) => {
      this.showPending(this.journal.read(this.actor()));
      if (this.pending) {
        this.view.message = '发现未确认的原请求，请先处理。';
        return;
      }
      await this.read(current, cancel);
    });
  }
  refresh(): Promise<void> {
    if (this.view.busy) return this.flight ?? Promise.resolve();
    return this.load(this.route);
  }
  private async read(current: () => boolean, cancel: Cancellation) {
    const result = await this.gateway.terms(cancel);
    if (!current()) return;
    this.view.terms = result.terms;
    if (this.mode === 'term' && !this.route.termId) {
      this.view.termForm = {
        name: '',
        weekOneMonday: currentMonday(this.now()),
        weekCount: '20',
      };
      this.view.ready = true;
      return;
    }
    const termId =
      this.route.termId ??
      (this.mode === 'agenda' ? result.terms[0]?.termId : null);
    if (!termId) {
      this.view.ready = true;
      return;
    }
    const detail = await this.gateway.detail(termId, cancel);
    if (!current()) return;
    this.route.termId = termId;
    this.detail = detail;
    this.view.term = detail.term;
    this.view.termIndex = Math.max(
      0,
      result.terms.findIndex((term) => term.termId === termId),
    );
    this.view.weekOptions = Array.from(
      { length: detail.term.weekCount },
      (_, index) => `第 ${index + 1} 周`,
    );
    this.view.editing =
      this.mode === 'term' || (!!this.route.entryId && !this.route.duplicate);
    this.view.duplicate = this.route.duplicate;
    this.view.termForm = {
      name: detail.term.name,
      weekOneMonday: detail.term.weekOneMonday,
      weekCount: String(detail.term.weekCount),
    };
    if (this.mode === 'entry') {
      const entry = this.route.entryId
        ? detail.entries.find((entry) => entry.entryId === this.route.entryId)
        : undefined;
      if (this.route.entryId && !entry)
        throw new ClientError('business', '课程不存在');
      this.view.entryForm = entry
        ? {
            name: entry.name,
            teacher: entry.teacher,
            location: entry.location,
            note: entry.note,
            dayOfWeek: entry.dayOfWeek,
            startTime: clockTime(entry.startMinute),
            endTime: clockTime(entry.endMinute),
            weeksText: entry.weeks.join(','),
            color: entry.color,
          }
        : {
            ...emptyEntry(),
            weeksText: weeksFor('all', detail.term.weekCount).join(','),
          };
    }
    const position = weekAt(
      detail.term.weekOneMonday,
      detail.term.weekCount,
      shanghaiToday(this.now()),
    );
    // Browsing week 1 outside term is explicit, never misrepresented as the current week.
    this.view.week = position.week ?? 1;
    this.view.ready = true;
    this.updateAgenda();
    this.updateConflicts();
  }
  private updateAgenda() {
    if (!this.detail) return;
    const { term, entries } = this.detail,
      today = shanghaiToday(this.now()),
      position = weekAt(term.weekOneMonday, term.weekCount, today);
    this.view.currentWeek = position.week;
    this.view.currentLabel =
      position.state === 'before'
        ? '学期尚未开始 · 当前日期不在学期内'
        : position.state === 'after'
          ? '学期已结束 · 当前日期不在学期内'
          : `当前第 ${position.week} 周`;
    this.view.days = weekDates(term.weekOneMonday, this.view.week).map(
      (date, index) => ({
        dayOfWeek: index + 1,
        label: days[index]!,
        date,
        today: date === today,
        entries: entries
          .filter(
            (entry) =>
              entry.dayOfWeek === index + 1 &&
              entry.weeks.includes(this.view.week),
          )
          .sort(
            (a, b) =>
              a.startMinute - b.startMinute ||
              a.entryId.localeCompare(b.entryId),
          )
          .map((entry) => ({
            ...entry,
            timeLabel: `${clockTime(entry.startMinute)}–${clockTime(entry.endMinute)}`,
            conflicting: entries.some(
              (other) =>
                other.entryId !== entry.entryId &&
                other.weeks.includes(this.view.week) &&
                conflicts(entry, other),
            ),
          })),
      }),
    );
  }
  private editable() {
    return (
      this.active &&
      !this.disposed &&
      this.view.ready &&
      !this.view.busy &&
      !this.view.pending &&
      !this.view.blocked
    );
  }
  setTerm(field: keyof TermForm, value: string): void {
    if (
      !this.editable() ||
      this.mode !== 'term' ||
      !['name', 'weekOneMonday', 'weekCount'].includes(field)
    )
      return;
    this.view.termForm[field] = value;
    this.resetConfirmation();
    this.emit();
  }
  setEntry(field: keyof EntryForm, value: string | number): void {
    if (
      !this.editable() ||
      this.mode !== 'entry' ||
      !Object.prototype.hasOwnProperty.call(this.view.entryForm, field)
    )
      return;
    if (field === 'dayOfWeek') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 7
      )
        return;
      this.view.entryForm.dayOfWeek = value;
    } else if (field === 'color') {
      if (!colors.includes(value as Color)) return;
      this.view.entryForm.color = value as Color;
    } else {
      if (typeof value !== 'string') return;
      this.view.entryForm[field] = value;
    }
    this.resetConfirmation();
    this.updateConflicts();
    this.emit();
  }
  chooseWeeks(kind: 'all' | 'odd' | 'even'): void {
    if (
      !this.editable() ||
      !this.detail ||
      !['all', 'odd', 'even'].includes(kind)
    )
      return;
    this.setEntry(
      'weeksText',
      weeksFor(kind, this.detail.term.weekCount).join(','),
    );
  }
  private resetConfirmation() {
    this.dateShiftIntent = '';
    this.view.dateShiftPrompt = '';
    this.view.deletePrompt = false;
    this.view.deleteText = '';
    this.view.error = '';
    this.view.message = '';
  }
  private termPayload(): TermFields {
    const form = this.view.termForm;
    monday(form.weekOneMonday);
    if (!/^\d{1,2}$/.test(form.weekCount)) throw new Error('学期周数须为 1–30');
    return decodeTermFields({
      name: form.name.trim(),
      weekOneMonday: form.weekOneMonday,
      weekCount: Number(form.weekCount),
      timeZone: 'Asia/Shanghai',
    });
  }
  private entryPayload(): EntryFields {
    const form = this.view.entryForm;
    return decodeEntryFields(
      {
        name: form.name.trim(),
        teacher: form.teacher.trim(),
        location: form.location.trim(),
        note: form.note.replace(/\r\n/g, '\n'),
        dayOfWeek: form.dayOfWeek,
        startMinute: timeMinutes(form.startTime),
        endMinute: timeMinutes(form.endTime),
        weeks: explicitWeeks(form.weeksText, this.detail!.term.weekCount),
        color: form.color,
      },
      this.detail!.term.weekCount,
    );
  }
  private updateConflicts() {
    this.view.conflictWarning = '';
    if (this.mode !== 'entry' || !this.detail) return;
    try {
      const candidate = this.entryPayload();
      const count = this.detail.entries.filter(
        (entry) =>
          (this.route.duplicate || entry.entryId !== this.route.entryId) &&
          conflicts(candidate, entry),
      ).length;
      if (count)
        this.view.conflictWarning = `与 ${count} 条课程时间重叠，仍可保存。`;
    } catch {
      /* Incomplete editable input is validated on save. */
    }
  }
  selectTerm(index: number): Promise<void> {
    if (!this.editable() || this.mode !== 'agenda' || !Number.isInteger(index))
      return Promise.resolve();
    const term = this.view.terms[index];
    return term
      ? this.load({ termId: term.termId, entryId: null, duplicate: false })
      : Promise.resolve();
  }
  selectWeek(week: number): void {
    if (!this.editable() || !this.detail) return;
    try {
      integer(week, 1, this.detail.term.weekCount);
    } catch {
      return;
    }
    this.view.week = week;
    this.view.selected = null;
    this.updateAgenda();
    this.emit();
  }
  selectEntry(entryId: string): void {
    if (!this.editable()) return;
    const entry = this.detail?.entries.find(
      (entry) =>
        entry.entryId === entryId && entry.weeks.includes(this.view.week),
    );
    this.view.selected = entry
      ? {
          ...entry,
          timeLabel: `${clockTime(entry.startMinute)}–${clockTime(entry.endMinute)}`,
        }
      : null;
    this.emit();
  }
  closeDetails(): void {
    this.view.selected = null;
    this.emit();
  }
  save(): Promise<void> {
    if (!this.editable() || this.mode === 'agenda') return Promise.resolve();
    let payload: TermFields | EntryFields;
    try {
      payload = this.mode === 'term' ? this.termPayload() : this.entryPayload();
    } catch (error) {
      this.view.error =
        error instanceof ClientError
          ? '请检查名称、周数和时间，结束时间须晚于开始时间，不能跨天。'
          : (error as Error).message;
      this.emit();
      return Promise.resolve();
    }
    if (
      this.mode === 'term' &&
      this.detail &&
      (payload as TermFields).weekOneMonday !==
        this.detail.term.weekOneMonday &&
      this.dateShiftIntent !== JSON.stringify(payload)
    ) {
      this.view.dateShiftPrompt = `将第一周周一从 ${this.detail.term.weekOneMonday} 改为 ${(payload as TermFields).weekOneMonday}，所有课程日期会随之移动。`;
      this.emit();
      return Promise.resolve();
    }
    const operation =
      this.mode === 'term'
        ? this.detail
          ? 'term.update'
          : 'term.create'
        : this.route.entryId && !this.route.duplicate
          ? 'entry.update'
          : 'entry.create';
    return this.submit(operation, payload);
  }
  confirmDateShift(): Promise<void> {
    if (!this.editable() || !this.view.dateShiftPrompt)
      return Promise.resolve();
    try {
      this.dateShiftIntent = JSON.stringify(this.termPayload());
    } catch {
      return Promise.resolve();
    }
    return this.save();
  }
  cancelConfirmation(): void {
    if (!this.editable()) return;
    this.resetConfirmation();
    this.emit();
  }
  beginDelete(): void {
    if (
      !this.editable() ||
      !this.view.editing ||
      !this.detail ||
      this.mode === 'agenda'
    )
      return;
    this.resetConfirmation();
    this.view.deletePrompt = true;
    this.emit();
  }
  setDeleteText(text: string): void {
    if (!this.editable() || !this.view.deletePrompt) return;
    this.view.deleteText = text;
    this.emit();
  }
  confirmDelete(): Promise<void> {
    if (!this.editable() || !this.view.deletePrompt || !this.detail)
      return Promise.resolve();
    if (
      this.mode === 'term' &&
      this.view.deleteText !== this.detail.term.name
    ) {
      this.view.error = '请输入完整学期名称以确认删除';
      this.emit();
      return Promise.resolve();
    }
    return this.submit(
      this.mode === 'term' ? 'term.delete' : 'entry.delete',
      {},
    );
  }
  private submit(
    operation: Command['operation'],
    payload: Command['payload'],
  ): Promise<void> {
    // Freeze intended content/revision before secure-ID awaits. Edits are locked synchronously by run().
    const termId = this.route.termId,
      entryId = this.route.entryId,
      revision = this.detail?.term.revision ?? 0;
    return this.run(async (current, cancel) => {
      const actor = this.actor(),
        existing = this.journal.read(actor);
      if (existing) {
        this.showPending(existing);
        return;
      }
      const requestId = uuid(await this.newId());
      if (!current()) return;
      const targetTerm = termId ?? uuid(await this.newId());
      if (!current()) return;
      const targetEntry = operation.startsWith('entry.')
        ? operation === 'entry.create'
          ? uuid(await this.newId())
          : uuid(entryId)
        : undefined;
      if (!current()) return;
      const command = decodeCommand({
        version: 1,
        requestId,
        operation,
        termId: targetTerm,
        expectedRevision: revision,
        ...(targetEntry ? { entryId: targetEntry } : {}),
        payload,
      });
      // Another page may have written while native random bytes were pending.
      const afterId = this.journal.read(actor);
      if (afterId) {
        this.showPending(afterId);
        return;
      }
      const pending = this.journal.write(actor, command);
      this.showPending(pending);
      this.emit();
      const receipt = await this.gateway.command(pending.command, cancel);
      if (current()) this.settle(pending, receipt);
    });
  }
  private settle(pending: Pending, receipt: Receipt) {
    matchReceipt(pending.command, receipt);
    this.journal.settle(pending, receipt);
    this.showPending(null);
    this.view.ready = false;
    this.view.blocked = false;
    this.detail = null;
    this.view.terms = [];
    this.view.term = null;
    this.view.days = [];
    this.view.selected = null;
    this.view.termForm = emptyTerm();
    this.view.entryForm = emptyEntry();
    this.view.editing = false;
    this.view.deletePrompt = false;
    this.view.deleteText = '';
    this.view.dateShiftPrompt = '';
    this.dateShiftIntent = '';
    if (receipt.outcome === 'applied') {
      this.view.message = pending.command.operation.endsWith('.delete')
        ? '已删除。返回课表或刷新查看。'
        : '已保存到当前账户。刷新可读取最新课表。';
      if (pending.command.operation === 'term.delete')
        this.route = { termId: null, entryId: null, duplicate: false };
      else if (pending.command.operation === 'entry.delete')
        this.route = {
          termId: pending.command.termId,
          entryId: null,
          duplicate: false,
        };
      else
        this.route = {
          termId: pending.command.termId,
          entryId: pending.command.entryId ?? null,
          duplicate: false,
        };
    } else if (receipt.outcome === 'cancelled')
      this.view.message = '原请求已取消，未执行。刷新后可重新编辑。';
    else
      this.view.error =
        rejectLabels[receipt.code ?? ''] ?? '本次未保存，请刷新后重试。';
    // No automatic replay, rebase, new request, or post-write navigation.
  }
  recover(action: 'read' | 'retry' | 'cancel' = 'read'): Promise<void> {
    return this.run(async (current, cancel) => {
      const pending = this.journal.read(this.actor());
      this.showPending(pending);
      if (!pending) {
        this.view.message = '没有待恢复的原请求，请刷新课表。';
        return;
      }
      const recovery = await this.gateway.recover(
        pending.command.requestId,
        cancel,
      );
      if (!current()) return;
      if (recovery.status === 'settled') {
        this.settle(pending, recovery.receipt);
        return;
      }
      if (recovery.requestId !== pending.command.requestId)
        throw new ClientError('protocol', '原请求不匹配');
      if (action === 'read') {
        this.view.message =
          '服务器尚未记录结果，不代表失败或取消。可重试同一原请求，或取消原请求。';
        return;
      }
      const original =
        action === 'cancel' || pending.phase === 'cancel'
          ? this.journal.write(pending.actorId, pending.command, 'cancel')
          : pending;
      this.showPending(original);
      this.emit();
      const receipt =
        original.phase === 'cancel'
          ? await this.gateway.cancel(original.command, cancel)
          : await this.gateway.command(original.command, cancel);
      if (current()) this.settle(original, receipt);
    });
  }
  path(
    target:
      | 'newTerm'
      | 'editTerm'
      | 'newEntry'
      | 'editEntry'
      | 'duplicate'
      | 'agenda',
  ): string | null {
    if (
      !this.active ||
      this.disposed ||
      this.view.busy ||
      this.view.pending ||
      this.view.blocked
    )
      return null;
    const termId = this.route.termId;
    if (target === 'agenda')
      return `/pages/personal-timetable/personal-timetable${termId ? `?termId=${uuid(termId)}` : ''}`;
    if (target === 'newTerm')
      return '/pages/personal-timetable-term/personal-timetable-term';
    if (!termId || !this.view.ready) return null;
    if (target === 'editTerm')
      return `/pages/personal-timetable-term/personal-timetable-term?termId=${uuid(termId)}`;
    if (target === 'newEntry')
      return `/pages/personal-timetable-entry/personal-timetable-entry?termId=${uuid(termId)}`;
    const entryId = this.view.selected?.entryId;
    if (!entryId) return null;
    return `/pages/personal-timetable-entry/personal-timetable-entry?termId=${uuid(termId)}&entryId=${uuid(entryId)}${target === 'duplicate' ? '&duplicate=1' : ''}`;
  }
  navigationFailed(): void {
    if (this.active) {
      this.view.error = '页面暂时无法打开，请重试。课表数据未改变。';
      this.emit();
    }
  }
}
