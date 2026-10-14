import {
  OwnSchoolUidController,
  initialOwnSchoolUidView,
} from '../../school-uid/controller';
import type { WhaleuApp } from '../../app';
import { initialVerificationView, VerificationController } from './controller';

Page({
  data: {
    ...initialVerificationView(),
    schoolUidView: initialOwnSchoolUidView(),
  },
  controller: undefined as VerificationController | undefined,
  schoolUidController: undefined as OwnSchoolUidController | undefined,
  onShow() {
    this.schoolUidController?.dispose();
    const schoolUidRuntime = getApp<WhaleuApp>().community;
    if (schoolUidRuntime) {
      this.schoolUidController = new OwnSchoolUidController(
        schoolUidRuntime,
        (view) => this.setData({ schoolUidView: view }),
      );
      void this.schoolUidController.load();
    }
    this.controller?.dispose();
    this.controller = undefined;
    const app = getApp<WhaleuApp>();
    if (!app.identity || !app.verification) {
      this.setData({
        ...initialVerificationView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new VerificationController(
      app.identity.sessions,
      app.verification.gateway,
      (view) => this.setData({ ...view }),
      app.verification.privateViews,
    );
    void this.controller.load();
  },
  onReload() {
    void this.schoolUidController?.load();
    void this.controller?.load();
  },
  onCancel() {
    this.controller?.cancel();
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
});
