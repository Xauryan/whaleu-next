import { ClientError } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import {
  AnnouncementController,
  initialAnnouncementView,
  type AnnouncementView,
} from './lifecycle';
import { announcementCampus, type AnnouncementPopup } from './contract';
export interface AnnouncementPopupView extends AnnouncementView {
  readonly popup: AnnouncementPopup | null;
  readonly campusId: string | null;
  readonly acknowledgement:
    'idle' | 'pending' | 'confirmed' | 'unconfirmed' | 'unavailable';
}
export const initialAnnouncementPopupView = (): AnnouncementPopupView => ({
  ...initialAnnouncementView(),
  popup: null,
  campusId: null,
  acknowledgement: 'idle',
});
export class AnnouncementPopupController extends AnnouncementController<AnnouncementPopupView> {
  private selectedCampus: string | null | undefined;
  private closed = false;
  constructor(
    runtime: CommunityRuntime,
    render: (value: AnnouncementPopupView) => void,
  ) {
    super(runtime, initialAnnouncementPopupView, render);
  }
  protected override reset(): void {
    this.selectedCampus = undefined;
    this.closed = false;
  }
  prepareScope(): void {
    this.clear();
  }
  /** Foreground scope is the user's browsing preference, never their verified identity campus. */
  async loadSelectedCampus(): Promise<void> {
    if (this.closed) return;
    this.clear();
    this.reset();
    if (!this.available(true)) return;
    await this.run(
      async (cancel, assertCurrent) => {
        if (!this.runtime.profiles)
          throw new ClientError('configuration', 'Browsing scope unavailable');
        const profile = await this.runtime.profiles.profile(cancel);
        assertCurrent();
        if (profile.accountId !== this.owner.credentials?.accountId)
          throw new ClientError('protocol', 'Profile owner mismatch');
        const campusId = profile.selectedCampus?.id ?? null;
        const result = await this.runtime.announcements!.ownerPopup(
          campusId,
          cancel,
        );
        assertCurrent();
        return { campusId, result };
      },
      ({ campusId, result }) => {
        this.selectedCampus = campusId;
        this.apply(result, campusId);
      },
    );
  }
  async load(campusId: string | null): Promise<void> {
    try {
      announcementCampus(campusId);
    } catch {
      this.reset();
      this.clear('公告浏览范围无效');
      return;
    }
    if (this.closed && this.selectedCampus === campusId) return;
    this.clear();
    this.selectedCampus = campusId;
    this.closed = false;
    if (!this.available(true)) return;
    await this.run(
      (cancel) => this.runtime.announcements!.ownerPopup(campusId, cancel),
      (result) => this.apply(result, campusId),
    );
  }
  private apply(
    result: Awaited<
      ReturnType<NonNullable<CommunityRuntime['announcements']>['ownerPopup']>
    >,
    campusId: string | null,
  ): void {
    if (this.closed) return;
    this.update({
      campusId,
      popup:
        result.candidate && result.acknowledgement.status === 'unseen'
          ? result.candidate
          : null,
      acknowledgement:
        result.candidate && result.acknowledgement.status === 'unavailable'
          ? 'unavailable'
          : 'idle',
      status:
        result.candidate && result.acknowledgement.status === 'unavailable'
          ? '公告提醒状态暂不可确认，可从公告列表查看内容'
          : '',
    });
  }
  /** This explicit button is the only marker command. Hide/dispose/navigation never call it. */
  async close(): Promise<void> {
    const popup = this.view.popup,
      campusId = this.selectedCampus;
    if (
      !popup ||
      campusId === undefined ||
      this.closed ||
      !this.available(true)
    )
      return;
    this.closed = true;
    this.stop();
    this.update({
      popup: null,
      acknowledgement: 'pending',
      status: '已关闭，正在确认本条公告',
      error: '',
    });
    await this.run(
      (cancel) =>
        this.runtime.announcements!.acknowledge(
          campusId,
          popup.id,
          popup.revision,
          cancel,
        ),
      () =>
        this.update({
          acknowledgement: 'confirmed',
          status: '已确认关闭本条公告',
        }),
      () =>
        this.update({
          popup: null,
          acknowledgement: 'unconfirmed',
          status: '已关闭，本次确认尚未证实；下次进入时会重新核验',
        }),
    );
  }
}
