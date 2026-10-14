import {
  OwnSchoolUidController,
  initialOwnSchoolUidView,
  type OwnSchoolUidView,
} from '../school-uid/controller';
import type { WhaleuApp } from '../app';
import { clientConfiguration } from '../config';
import { WechatStorage } from '../platform/wechat';
import { HttpStudentVerificationGateway } from './student-gateway';
import { StudentCommandJournal } from './student-pending';
import {
  StudentVerificationController,
  initialStudentView,
} from './student-controller';
import type { StudentView } from './student-controller';
interface StudentNativePage {
  controller: StudentVerificationController | undefined;
  schoolUidController: OwnSchoolUidController | undefined;
  route: { applicationId?: string; regionId?: string };
  setData(
    value: Partial<StudentView> & { schoolUidView?: OwnSchoolUidView },
  ): void;
}
export function studentPage(mode: 'own' | 'review' | 'notices') {
  const definition: Record<string, unknown> & ThisType<StudentNativePage> = {
    data: { ...initialStudentView(), schoolUidView: initialOwnSchoolUidView() },
    schoolUidController: undefined as OwnSchoolUidController | undefined,
    controller: undefined as StudentVerificationController | undefined,
    route: {} as { applicationId?: string; regionId?: string },
    onLoad(query: { applicationId?: string; regionId?: string }) {
      this.route = {
        ...(query.applicationId ? { applicationId: query.applicationId } : {}),
        ...(query.regionId ? { regionId: query.regionId } : {}),
      };
    },
    onShow() {
      this.controller?.dispose();
      const app = getApp<WhaleuApp>();
      this.schoolUidController?.dispose();
      if (mode === 'own' && app.community) {
        this.schoolUidController = new OwnSchoolUidController(
          app.community,
          (view) => this.setData({ schoolUidView: view }),
        );
        void this.schoolUidController.load();
      }
      if (
        !app.identity?.api ||
        !app.community?.profiles ||
        !app.studentEvidence ||
        !app.verification
      ) {
        this.setData({
          ...initialStudentView(),
          error: '认证服务尚未配置，请先登录',
        });
        return;
      }
      this.controller = new StudentVerificationController(
        {
          sessions: app.identity.sessions,
          gateway: new HttpStudentVerificationGateway(app.identity.api),
          profiles: app.community.profiles,
          journal: new StudentCommandJournal(
            new WechatStorage(wx),
            clientConfiguration.apiOrigin,
          ),
          newRequestId: app.community.newRequestId,
          media: app.studentEvidence,
          privateViews: app.verification.privateViews,
          render: (view: StudentView) => this.setData({ ...view }),
        },
        mode,
        this.route,
      );
      void this.controller.load();
    },
    onReload() {
      void this.schoolUidController?.load();
      void this.controller?.load();
    },
    onSearchInput(e: { detail: { value: string } }) {
      this.controller?.query(e.detail.value);
    },
    onSearch() {
      void this.controller?.searchCampuses();
    },
    onChooseCampus(e: { currentTarget: { dataset: { id: string } } }) {
      this.controller?.chooseCampus(e.currentTarget.dataset.id);
    },
    onPrepare() {
      void this.controller?.prepare();
    },
    onChooseEvidence() {
      void this.controller?.pickEvidence();
    },
    onRecoverEvidence() {
      void this.controller?.pickEvidence(true);
    },
    onSubmit() {
      this.controller?.requestSubmit();
    },
    onWithdraw() {
      this.controller?.requestWithdraw();
    },
    onConfirm() {
      void this.controller?.confirm();
    },
    onDismiss() {
      this.controller?.dismiss();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onCancelRequest() {
      void this.controller?.recover(true);
    },
    onCleanup() {
      void this.controller?.cleanup();
    },
    onPreview() {
      void this.controller?.preview();
    },
    onClosePreview() {
      this.controller?.clearEvidence();
    },
    onSelect(e: { currentTarget: { dataset: { id: string } } }) {
      void this.controller?.select(e.currentTarget.dataset.id);
    },
    onReason(e: { detail: { value: string } }) {
      this.controller?.setReason(e.detail.value);
    },
    onApprove() {
      this.controller?.requestDecision('approved');
    },
    onReject() {
      this.controller?.requestDecision('rejected');
    },
    onNext() {
      this.controller?.page(1);
    },
    onPrevious() {
      this.controller?.page(-1);
    },
    onNotice(e: { currentTarget: { dataset: { id: string } } }) {
      const controller = this.controller;
      void controller
        ?.noticeTarget(e.currentTarget.dataset.id)
        .then((target) => {
          if (!target || this.controller !== controller) return;
          const page = target.regionId
            ? 'student-verification-review'
            : 'student-verification';
          wx.navigateTo?.({
            url: `/pages/${page}/${page}?applicationId=${target.applicationId}${target.regionId ? `&regionId=${target.regionId}` : ''}`,
            success() {},
            fail() {},
          });
        });
    },
    onReadNotice(e: { currentTarget: { dataset: { id: string } } }) {
      void this.controller?.readNotice(e.currentTarget.dataset.id);
    },
    onHide() {
      this.schoolUidController?.dispose();
      this.schoolUidController = undefined;
      this.controller?.dispose();
      this.controller = undefined;
    },
    onUnload() {
      this.schoolUidController?.dispose();
      this.schoolUidController = undefined;
      this.controller?.dispose();
      this.controller = undefined;
    },
  };
  return definition;
}
