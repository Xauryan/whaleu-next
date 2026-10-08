import { ClientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { bounded } from '../platform/deadline';
import { systemClock } from '../platform/clock';
import type { ActivityPage } from './contract';
import type { PendingActivityVisit } from './pending';
export interface ActivityVisitView extends CommunityView {
  readonly pending: boolean;
  readonly confirmed: boolean;
}
export const initialActivityVisitView = (): ActivityVisitView => ({
  ...initialCommunityView(),
  pending: false,
  confirmed: false,
  status: '',
});
export class ActivityVisitController extends CommunityController<ActivityVisitView> {
  private attempt: PendingActivityVisit | null = null;
  private inactive = false;
  constructor(
    runtime: CommunityRuntime,
    render: (view: ActivityVisitView) => void,
  ) {
    super(runtime, initialActivityVisitView, render);
  }
  protected override resetPrivate(): void {
    this.attempt = null;
  }
  protected override available(): boolean {
    return (
      !this.inactive &&
      !!this.accountId() &&
      !!this.runtime.activities &&
      !!this.runtime.pendingActivityVisits
    );
  }
  restore(): void {
    if (!this.available()) return;
    try {
      this.attempt = this.runtime.pendingActivityVisits!.load(
        this.accountId()!,
      );
      this.update({
        pending: !!this.attempt,
        status: this.attempt ? '有一笔活动访问结果待确认，可重试原请求' : '',
        error: '',
      });
    } catch (error) {
      this.update({
        pending: true,
        error: communityError(error),
        status: '访问记录暂不可写入',
      });
    }
  }
  async acknowledge(context: ActivityPage['context']): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      this.view.pending ||
      this.view.confirmed
    )
      return;
    await this.run(
      async (cancel) => {
        const owner = this.owner,
          accountId = this.accountId()!;
        const previous = this.runtime.pendingActivityVisits!.load(accountId);
        if (previous) {
          this.attempt = previous;
          throw new ClientError(
            'storage',
            'Original visit requires explicit recovery',
          );
        }
        const requestId = await bounded(
          this.runtime.newRequestId,
          5000,
          systemClock,
        );
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled || this.inactive)
          throw new ClientError('cancelled', 'Visit no longer visible');
        const attempt = this.runtime.pendingActivityVisits!.freeze({
          version: 1,
          accountId,
          requestId,
          regionId: context.regionId,
          expectedCatalogRevision: context.catalogRevision,
        });
        this.attempt = attempt;
        this.update({ pending: true, status: '正在记录本次活动中心访问' });
        this.runtime.pendingActivityVisits!.assertOriginal(attempt);
        return this.runtime.activities!.visit(
          {
            requestId: attempt.requestId,
            regionId: attempt.regionId,
            expectedCatalogRevision: attempt.expectedCatalogRevision,
          },
          cancel,
        );
      },
      (receipt) => {
        this.runtime.pendingActivityVisits!.settle(this.attempt!, receipt);
        this.attempt = null;
        this.update({
          pending: false,
          confirmed: true,
          status: '本次访问已记录',
          error: '',
        });
      },
      (error) => this.failed(error),
    );
  }
  async retry(): Promise<void> {
    if (!this.available() || this.view.busy) return;
    this.restore();
    if (!this.attempt) return;
    const attempt = this.attempt;
    await this.run(
      async (cancel) => {
        this.runtime.pendingActivityVisits!.assertOriginal(attempt);
        return this.runtime.activities!.visit(
          {
            requestId: attempt.requestId,
            regionId: attempt.regionId,
            expectedCatalogRevision: attempt.expectedCatalogRevision,
          },
          cancel,
        );
      },
      (receipt) => {
        this.runtime.pendingActivityVisits!.settle(attempt, receipt);
        this.attempt = null;
        this.update({
          pending: false,
          confirmed: true,
          status: '原访问回执已确认；不代表当前活动内容仍可查看',
          error: '',
        });
      },
      (error) => this.failed(error),
    );
  }
  private failed(error: ClientError): void {
    if (
      error.kind !== 'protocol' &&
      error.details.serverCode === 'ACTIVITY_REVISION_CHANGED' &&
      error.details.httpStatus === 409 &&
      this.attempt
    ) {
      try {
        this.runtime.pendingActivityVisits!.release(this.attempt);
      } catch (storageError) {
        this.update({
          pending: true,
          confirmed: false,
          status: '访问请求保留待确认',
          error: communityError(storageError),
        });
        return;
      }
      this.attempt = null;
      this.update({
        pending: false,
        confirmed: false,
        status: '活动目录已变化，请重新进入后查看',
        error: '本次访问未记录，未确认新目录',
      });
      return;
    }
    this.update({
      pending: !!this.attempt || error.kind === 'storage',
      confirmed: false,
      status: this.attempt ? '访问结果待确认，请重试原请求' : '访问尚未发送',
      error: communityError(error),
    });
  }
  override cancel(): void {
    this.stop();
    this.update({
      busy: false,
      pending: !!this.attempt,
      confirmed: false,
      status: this.attempt ? '已停止等待，原访问请求仍可能完成' : '',
      error: '',
    });
  }
  override dispose(): void {
    this.inactive = true;
    super.dispose();
  }
}
