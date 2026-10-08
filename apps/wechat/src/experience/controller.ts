import { ClientError, clientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import { communityError } from '../community/controller';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import { experienceColorStyle } from './colors';
import {
  decodeExperienceAcknowledgement,
  decodeExperienceAppearance,
  decodeExperienceCatalog,
  decodeExperienceRecords,
  decodeExperienceSummary,
  decodeExperienceUnlocks,
  type ExperienceAction,
  type ExperienceAppearance,
  type ExperienceCatalog,
  type ExperienceOperation,
  type ExperienceRecord,
  type ExperienceSummary,
  type ExperienceUnlock,
  type ExperienceReceipt,
} from './contract';
import type { ExperienceRuntime } from './runtime';
export const experienceActionLabels: Readonly<
  Record<ExperienceAction, string>
> = {
  publish: '发布内容',
  comment: '发表评论或回复',
  like_save: '点赞或收藏',
  received_like_save: '收到点赞或收藏',
  received_comment: '收到评论或回复',
  delete_post: '删除自己的帖子',
  delete_comment: '删除自己的评论',
  delete_reply: '删除自己的回复',
  sign_in: '每日签到',
};
interface RecordRow extends ExperienceRecord {
  readonly label: string;
  readonly dateLabel: string;
  readonly appliedLabel: string;
  readonly deltaLabel: string;
}
interface ColorRow {
  readonly id: number;
  readonly name: string;
  readonly unlockLevel: number;
  readonly style: string;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly retained: boolean;
}
export interface ExperienceView {
  readonly configured: boolean;
  readonly hasSession: boolean;
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly status: string;
  readonly error: string;
  readonly receiptStatus: string;
  readonly summary: ExperienceSummary | null;
  readonly appearance: ExperienceAppearance | null;
  readonly catalog: ExperienceCatalog | null;
  readonly records: readonly RecordRow[];
  readonly recordsCoverage: string;
  readonly hasMore: boolean;
  readonly signInPending: boolean;
  readonly appearancePending: boolean;
  readonly signInLabel: string;
  readonly balanceLabel: string;
  readonly progressLabel: string;
  readonly tasks: readonly {
    readonly action: string;
    readonly label: string;
    readonly reward: string;
    readonly progress: string;
  }[];
  readonly titleKey: string | null;
  readonly colorId: number | null;
  readonly previewStyle: string;
  readonly previewTitle: string;
  readonly appearanceDirty: boolean;
  readonly colors: readonly ColorRow[];
  readonly unlocks: readonly (ExperienceUnlock & {
    readonly titleLabel: string;
    readonly colorLabel: string;
  })[];
  readonly acknowledgementIds: readonly string[];
}
export const initialExperienceView = (): ExperienceView => ({
  configured: false,
  hasSession: false,
  busy: false,
  loaded: false,
  status: '经验状态尚未查询',
  error: '',
  receiptStatus: '',
  summary: null,
  appearance: null,
  catalog: null,
  records: [],
  recordsCoverage: '',
  hasMore: false,
  signInPending: false,
  appearancePending: false,
  signInLabel: '签到状态未确认',
  balanceLabel: '尚未查询',
  progressLabel: '',
  tasks: [],
  titleKey: null,
  colorId: null,
  previewStyle: '',
  previewTitle: '当前未显示头衔',
  appearanceDirty: false,
  colors: [],
  unlocks: [],
  acknowledgementIds: [],
});
export function experienceError(error: unknown): string {
  const failure = clientError(error),
    messages: Readonly<Record<string, string>> = {
      EXPERIENCE_BASELINE_UNAVAILABLE:
        '历史经验基准尚未确认，暂不能签到或确认余额；已知拥有的头衔仍可选择',
      EXPERIENCE_PENDING:
        '前面的经验变动仍待处理；本次签到尚未完成，请稍后查询或重试原请求',
      EXPERIENCE_RECOVERY_REQUIRED:
        '已有原请求结果待确认，请先查询回执或重试原请求',
      EXPERIENCE_REQUEST_CONFLICT:
        '此编号与原经验请求不一致；请保留原请求并查询回执',
      EXPERIENCE_REQUEST_NOT_FOUND:
        '暂未查到回执；原请求仍可能完成，请保留原编号并稍后查询或重试',
      EXPERIENCE_APPEARANCE_CONFLICT:
        '外观已在其他操作中改变，请刷新后重新选择',
      EXPERIENCE_TITLE_INELIGIBLE:
        '不能确认该头衔属于当前账号，请刷新已拥有头衔',
      EXPERIENCE_COLOR_INELIGIBLE:
        '当前等级暂不支持新选择这个颜色，请刷新后重新选择',
    };
  return (
    (failure.kind !== 'protocol' &&
      messages[failure.details.serverCode ?? '']) ||
    communityError(failure)
  );
}
const recordRow = (r: ExperienceRecord): RecordRow => ({
  ...r,
  label: experienceActionLabels[r.action],
  dateLabel: r.occurredAt ? `发生时间：${r.occurredAt}` : '发生日期不可用',
  appliedLabel: r.appliedAt
    ? `结算时间：${r.appliedAt}`
    : `记录时间：${r.recordedAt}`,
  deltaLabel:
    r.appliedDelta === null
      ? '变动未确认'
      : r.appliedDelta.startsWith('-') || r.appliedDelta === '0'
        ? r.appliedDelta
        : `+${r.appliedDelta}`,
});
export class ExperienceController {
  private view = initialExperienceView();
  private owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private paused = false;
  private cancellation: Cancellation | undefined;
  private cursor: string | null = null;
  private refreshQueued = false;
  private refreshDeferred = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeVisibility: () => void;
  private readonly unsubscribeChanges: () => void;
  constructor(
    private readonly runtime: ExperienceRuntime,
    private readonly render: (view: ExperienceView) => void,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.unsubscribe = runtime.sessions.subscribe(() => {
      const now = runtime.sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.owner = now;
        this.clear('登录状态已改变，请重新查询');
      }
    });
    this.unsubscribeVisibility = runtime.privateViews.subscribe(() =>
      this.dispose(),
    );
    this.unsubscribeChanges = runtime.subscribe((event) => {
      if (this.disposed || this.paused) return;
      this.syncPending();
      if (event.phase === 'settled') {
        if (event.operation === 'sign_in' && this.view.appearanceDirty) {
          this.refreshDeferred = true;
          this.update({
            status: '签到已确认；完成或取消当前外观选择后刷新经验状态',
          });
        } else if (this.view.busy) this.refreshQueued = true;
        else void this.load();
      }
    });
    this.update({
      configured: !!runtime.gateway,
      hasSession: !!this.owner.credentials,
    });
  }
  private update(patch: Partial<ExperienceView>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  private stop(): void {
    this.generation += 1;
    this.cancellation?.cancel();
    this.cancellation = undefined;
    this.refreshQueued = false;
  }
  private clear(status: string): void {
    this.stop();
    this.cursor = null;
    this.update({
      ...initialExperienceView(),
      configured: !!this.runtime.gateway,
      hasSession: !!this.owner.credentials,
      status,
    });
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private available(): boolean {
    if (this.disposed) return false;
    if (!this.runtime.gateway || !this.owner.credentials) {
      this.update({
        error: !this.runtime.gateway
          ? '当前构建尚未配置经验 API 环境'
          : '请先登录，再查看自己的经验与头衔',
      });
      return false;
    }
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return true;
    } catch {
      return false;
    }
  }
  private syncPending(): void {
    if (!this.owner.credentials || this.disposed) return;
    try {
      const id = this.owner.credentials.accountId;
      this.update({
        signInPending: !!this.runtime.pending.load(id, 'sign_in'),
        appearancePending: !!this.runtime.pending.load(id, 'appearance'),
      });
    } catch (error) {
      this.update({
        signInPending: true,
        appearancePending: true,
        error: experienceError(error),
      });
    }
  }
  private async run<T>(
    work: (cancel: Cancellation) => Promise<T>,
    apply: (value: T) => void,
  ): Promise<void> {
    this.stop();
    this.paused = false;
    const generation = this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancellation = cancel;
    let sent = owner;
    this.update({ busy: true, error: '' });
    try {
      const result = await cancellable(
        Promise.resolve().then(() => {
          this.runtime.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled before dispatch');
          sent = this.runtime.sessions.snapshot();
          return work(cancel);
        }),
        cancel,
      );
      if (!this.current(generation)) return;
      this.runtime.sessions.assertCurrent(owner);
      apply(result);
    } catch (error) {
      if (!this.current(generation)) return;
      const failure = clientError(error);
      if (
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.httpStatus === 403 &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED')
      ) {
        this.clear('请重新验证登录；原请求仍保留在原账号下');
        try {
          this.runtime.sessions.logoutIfCurrent(sent);
        } catch {
          /* A newer credential must survive. */
        }
        return;
      }
      this.update({
        error: experienceError(failure),
        status: '本次结果尚未确认',
      });
      this.syncPending();
    } finally {
      if (this.current(generation)) {
        this.cancellation = undefined;
        this.update({ busy: false });
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.load();
        }
      }
    }
  }
  /** A snapshot read only. App foreground is a separate explicit command. */
  async load(): Promise<void> {
    if (this.disposed || this.view.busy) return;
    const receiptStatus = this.view.receiptStatus,
      acknowledgementIds = this.view.acknowledgementIds;
    this.refreshDeferred = false;
    this.clear('正在读取自己的经验、头衔与记录');
    this.update({ receiptStatus, acknowledgementIds });
    if (!this.available()) return;
    this.syncPending();
    await this.run(
      async (cancel) => {
        const gateway = this.runtime.gateway!;
        const [summary, appearance, catalog, records, unlocks] =
          await Promise.all([
            gateway.summary(cancel),
            gateway.appearance(cancel),
            gateway.catalog(cancel),
            gateway.records(null, cancel),
            gateway.unlocks(cancel),
          ]);
        return {
          summary: decodeExperienceSummary(summary),
          appearance: decodeExperienceAppearance(appearance),
          catalog: decodeExperienceCatalog(catalog),
          records: decodeExperienceRecords(records),
          unlocks: decodeExperienceUnlocks(unlocks),
        };
      },
      ({ summary, appearance, catalog, records, unlocks }) => {
        this.cursor = records.nextCursor;
        this.update({
          loaded: true,
          summary,
          appearance,
          catalog,
          records: records.items.map(recordRow),
          hasMore: records.nextCursor !== null,
          recordsCoverage:
            records.coverage === 'complete'
              ? '完整的已知本地经验记录'
              : '记录覆盖不完整；空列表不代表从未有过经验记录',
          titleKey: appearance.titleKey,
          colorId: appearance.colorId,
          appearanceDirty: false,
          balanceLabel:
            summary.balance === null ? '历史经验基准未确认' : summary.balance,
          progressLabel:
            summary.progress === null
              ? '等级与升级进度暂不可确认'
              : summary.progress.pointsToNextLevel === null
                ? '已达到当前最高等级'
                : `距离下一级还需 ${summary.progress.pointsToNextLevel} 经验`,
          signInLabel:
            summary.signIn.signedIn === null
              ? '签到历史尚未确认'
              : summary.signIn.signedIn
                ? `今日已签到 · 连续 ${summary.signIn.streak} 天 · 明日连续签到可得 ${summary.signIn.nextReward}`
                : `今日尚未签到 · 本次可得 ${summary.signIn.nextReward}`,
          tasks: [...summary.tasks]
            .sort(
              (a, b) => Number(a.remaining === 0) - Number(b.remaining === 0),
            )
            .map((t) => ({
              action: t.action,
              label: experienceActionLabels[t.action],
              reward: `每次 +${t.amount} · 每日 ${t.dailyLimit} 次`,
              progress:
                t.remaining === null
                  ? '今日进度尚未确认'
                  : `今日剩余 ${t.remaining} 次 · 已奖励 ${t.grossPositiveAwarded} 经验`,
            })),
          unlocks: unlocks.items
            .filter((n) => !this.runtime.isNoticeClosed(n.noticeId))
            .map((n) => ({
              ...n,
              titleLabel: n.titleKeys
                .map(
                  (key) =>
                    catalog.titles.find((t) => t.key === key)?.name ?? key,
                )
                .join('、'),
              colorLabel: n.colorIds
                .map(
                  (id) =>
                    catalog.colors.find((c) => c.id === id)?.name ?? String(id),
                )
                .join('、'),
            })),
          acknowledgementIds: [
            ...new Set([
              ...this.view.acknowledgementIds,
              ...unlocks.items
                .filter((n) => this.runtime.isNoticeClosed(n.noticeId))
                .map((n) => n.noticeId),
            ]),
          ],
          status:
            summary.baseline === 'known'
              ? '已读取服务端确认的经验状态'
              : '历史经验基准尚未确认；已知记录与拥有的头衔仍可查看',
        });
        this.refreshSelection();
        this.syncPending();
      },
    );
  }
  async moreRecords(): Promise<void> {
    if (this.view.busy || !this.cursor || !this.available()) return;
    const cursor = this.cursor;
    await this.run(
      (cancel) => this.runtime.gateway!.records(cursor, cancel),
      (raw) => {
        const page = decodeExperienceRecords(raw),
          ids = new Set(this.view.records.map((r) => r.recordId));
        if (
          page.nextCursor === cursor ||
          page.items.some((r) => ids.has(r.recordId))
        )
          throw new ClientError(
            'protocol',
            'Experience continuation repeated a record',
          );
        this.cursor = page.nextCursor;
        this.update({
          records: [...this.view.records, ...page.items.map(recordRow)],
          hasMore: page.nextCursor !== null,
          status: '已加载更多自己的经验记录',
        });
      },
    );
  }
  private refreshSelection(): void {
    const { appearance, catalog, titleKey, colorId } = this.view;
    if (!appearance || !catalog) return;
    this.update({
      previewTitle:
        appearance.titles.find((t) => t.key === titleKey)?.name ??
        '当前未显示头衔',
      previewStyle: experienceColorStyle(colorId),
      appearanceDirty:
        titleKey !== appearance.titleKey || colorId !== appearance.colorId,
      colors: catalog.colors.map((c) => ({
        ...c,
        style: experienceColorStyle(c.id),
        selectable:
          appearance.eligibleColorIds.includes(c.id) ||
          c.id === appearance.colorId,
        selected: c.id === colorId,
        retained:
          c.id === appearance.colorId &&
          !appearance.eligibleColorIds.includes(c.id),
      })),
    });
  }
  chooseTitle(key: string | null): void {
    if (
      this.disposed ||
      this.view.busy ||
      this.view.appearancePending ||
      !this.view.appearance ||
      (key !== null && !this.view.appearance.titles.some((t) => t.key === key))
    )
      return;
    this.update({ titleKey: key, error: '' });
    this.refreshSelection();
  }
  chooseColor(id: number | null): void {
    const a = this.view.appearance;
    if (
      this.disposed ||
      this.view.busy ||
      this.view.appearancePending ||
      !a ||
      (id !== null && !a.eligibleColorIds.includes(id) && id !== a.colorId)
    )
      return;
    this.update({ colorId: id, error: '' });
    this.refreshSelection();
  }
  cancelSelection(): void {
    if (this.view.busy || this.view.appearancePending || !this.view.appearance)
      return;
    this.update({
      titleKey: this.view.appearance.titleKey,
      colorId: this.view.appearance.colorId,
    });
    this.refreshSelection();
    if (this.refreshDeferred) void this.load();
  }
  private receipt(receipt: ExperienceReceipt): void {
    const message =
      receipt.operation === 'sign_in'
        ? receipt.outcome === 'awarded'
          ? `${receipt.rewardDay} 签到已确认，获得 ${receipt.appliedDelta} 经验`
          : `${receipt.rewardDay} 已签到，未重复增加经验`
        : receipt.outcome === 'applied'
          ? '原外观请求已完成，当前外观将重新查询'
          : experienceError(
              new ClientError('business', 'Appearance rejected', {
                serverCode: receipt.code,
              }),
            );
    this.update({
      receiptStatus: message,
      status: '原请求已确认；正在刷新当前状态',
    });
    this.syncPending();
  }
  async signIn(): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.syncPending();
    if (this.view.signInPending) return;
    await this.run(
      (cancel) => this.runtime.signIn(cancel),
      (r) => this.receipt(r),
    );
  }
  async saveAppearance(): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.syncPending();
    if (
      this.view.appearancePending ||
      !this.view.appearance ||
      !this.view.appearanceDirty
    )
      return;
    const selection = {
      expectedRevision: this.view.appearance.revision,
      titleKey: this.view.titleKey,
      colorId: this.view.colorId,
    };
    await this.run(
      (cancel) => this.runtime.selectAppearance(selection, cancel),
      (r) => this.receipt(r),
    );
  }
  async recover(operation: ExperienceOperation, retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    await this.run(
      (cancel) => this.runtime.recover(operation, retry, cancel),
      (r) => this.receipt(r),
    );
  }
  async closeUnlock(noticeId: string): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      (!this.view.unlocks.some((n) => n.noticeId === noticeId) &&
        !this.view.acknowledgementIds.includes(noticeId))
    )
      return;
    this.runtime.closeNotice(noticeId);
    this.update({
      unlocks: this.view.unlocks.filter((n) => n.noticeId !== noticeId),
      acknowledgementIds: [
        ...new Set([...this.view.acknowledgementIds, noticeId]),
      ],
    });
    await this.run(
      (cancel) => this.runtime.gateway!.acknowledge(noticeId, cancel),
      (raw) => {
        const ack = decodeExperienceAcknowledgement(raw);
        if (ack.noticeId !== noticeId || ack.acknowledged !== true)
          throw new ClientError('protocol', 'Unlock acknowledgement mismatch');
        this.update({
          acknowledgementIds: this.view.acknowledgementIds.filter(
            (id) => id !== noticeId,
          ),
          status: '已确认查看升级提示',
        });
      },
    );
  }
  cancel(): void {
    if (this.disposed) return;
    this.clear('已停止等待；已发送的请求仍可能完成，原请求未撤销');
    this.paused = true;
    this.syncPending();
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear('经验页面已清除');
    this.unsubscribe();
    this.unsubscribeVisibility();
    this.unsubscribeChanges();
    this.disposed = true;
  }
}
