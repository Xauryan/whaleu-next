import type { WhaleuApp } from '../app';
import { clientConfiguration } from '../config';
import {
  OwnSchoolUidController,
  initialOwnSchoolUidView,
  type OwnSchoolUidView,
} from '../school-uid/controller';
import {
  VerificationController,
  initialVerificationView,
  type VerificationView,
} from '../pages/verification/controller';
import {
  InstitutionalController,
  initialInstitutionalView,
  type InstitutionalRuntime,
  type InstitutionalView,
} from './institutional-controller';
interface InstitutionalPage {
  controller: InstitutionalController | undefined;
  verificationController: VerificationController | undefined;
  schoolUidController: OwnSchoolUidController | undefined;
  route: { campusId?: string };
  backPending: boolean;
  backGeneration: number;
  setData(
    value: Partial<InstitutionalView> & {
      verificationView?: VerificationView;
      schoolUidView?: OwnSchoolUidView;
    },
  ): void;
  refreshSummaries(): void;
}
/** Injection is composition-only. Shipping registration always reads the unavailable app port. */
export function institutionalPage(
  readRuntime: () => InstitutionalRuntime | undefined = () =>
    getApp<WhaleuApp>().institutionalSso,
) {
  const definition: Record<string, unknown> & ThisType<InstitutionalPage> = {
    data: {
      ...initialInstitutionalView(),
      verificationView: initialVerificationView(),
      schoolUidView: initialOwnSchoolUidView(),
    },
    controller: undefined,
    verificationController: undefined,
    schoolUidController: undefined,
    route: {},
    backPending: false,
    backGeneration: 0,
    onLoad(query: { campusId?: string }) {
      this.route = query.campusId ? { campusId: query.campusId } : {};
    },
    refreshSummaries() {
      this.verificationController?.dispose();
      this.schoolUidController?.dispose();
      this.verificationController = undefined;
      this.schoolUidController = undefined;
      this.setData({
        verificationView: initialVerificationView(),
        schoolUidView: initialOwnSchoolUidView(),
      });
      const app = getApp<WhaleuApp>();
      if (app.identity && app.verification) {
        this.verificationController = new VerificationController(
          app.identity.sessions,
          app.verification.gateway,
          (view) => this.setData({ verificationView: view }),
          app.verification.privateViews,
        );
        void this.verificationController.load();
      }
      if (app.community) {
        this.schoolUidController = new OwnSchoolUidController(
          app.community,
          (view) => this.setData({ schoolUidView: view }),
        );
        void this.schoolUidController.load();
      }
    },
    onShow() {
      this.backGeneration++;
      this.backPending = false;
      this.controller?.dispose();
      this.controller = undefined;
      const runtime = readRuntime();
      this.refreshSummaries();
      if (!runtime) {
        this.setData({
          ...initialInstitutionalView(),
          error: '学校认证服务尚未配置，请先登录。',
        });
        return;
      }
      this.controller = new InstitutionalController(
        runtime,
        (view) => this.setData({ ...view }),
        this.route.campusId ?? '',
        () => this.refreshSummaries(),
        () =>
          runtime === readRuntime() &&
          runtime.origin === clientConfiguration.apiOrigin,
      );
      void this.controller.load();
    },
    onSearchInput(event: { detail: { value: string } }) {
      this.controller?.query(event.detail.value);
    },
    onSearch() {
      void this.controller?.searchCampuses();
    },
    onChooseCampus(event: { currentTarget: { dataset: { id: string } } }) {
      void this.controller?.chooseCampus(event.currentTarget.dataset.id);
    },
    onConsent(event: { detail: { value: string[] } }) {
      this.controller?.setConsent(event.detail.value.includes('consent'));
    },
    onPrepare() {
      void this.controller?.prepare();
    },
    onAuthorize() {
      void this.controller?.authorize();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onClose() {
      void this.controller?.close();
    },
    onReload() {
      void this.controller?.load();
      this.refreshSummaries();
    },
    onBack() {
      if (this.backPending) return;
      this.backPending = true;
      const generation = ++this.backGeneration;
      this.controller?.dispose();
      this.controller = undefined;
      this.verificationController?.dispose();
      this.schoolUidController?.dispose();
      const current = () => generation === this.backGeneration;
      const failed = () => {
        if (current()) {
          this.backPending = false;
          this.setData({ error: '暂时无法返回，请使用下方认证入口。' });
        }
      };
      const fallback = () => {
        if (!current()) return;
        try {
          if (!wx.reLaunch) {
            failed();
            return;
          }
          wx.reLaunch({
            url: '/pages/verification/verification',
            success: () => {
              if (current()) this.backPending = false;
            },
            fail: failed,
          });
        } catch {
          failed();
        }
      };
      try {
        if (!wx.navigateBack) {
          fallback();
          return;
        }
        wx.navigateBack({
          delta: 1,
          success: () => {
            if (current()) this.backPending = false;
          },
          fail: fallback,
        });
      } catch {
        fallback();
      }
    },
    onHide() {
      this.backGeneration++;
      this.controller?.dispose();
      this.controller = undefined;
      this.verificationController?.dispose();
      this.verificationController = undefined;
      this.schoolUidController?.dispose();
      this.schoolUidController = undefined;
    },
    onUnload() {
      this.backGeneration++;
      this.controller?.dispose();
      this.controller = undefined;
      this.verificationController?.dispose();
      this.verificationController = undefined;
      this.schoolUidController?.dispose();
      this.schoolUidController = undefined;
    },
  };
  return definition;
}
