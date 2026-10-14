import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { decodeAuthorization } from '../identity-privacy/overlay';
import type { Campus } from '../profile/contract';
import {
  decodeSchoolUid,
  decodeSchoolUidLookup,
  parseSchoolUid,
  type SchoolUid,
  type SchoolUidLookup,
} from './contract';
export interface OwnSchoolUidView extends CommunityView {
  readonly loaded: boolean;
  readonly schoolUid: SchoolUid | null;
}
export const initialOwnSchoolUidView = (): OwnSchoolUidView => ({
  ...initialCommunityView(),
  loaded: false,
  schoolUid: null,
});
export class OwnSchoolUidController extends CommunityController<OwnSchoolUidView> {
  constructor(
    runtime: CommunityRuntime,
    render: (view: OwnSchoolUidView) => void,
  ) {
    super(runtime, initialOwnSchoolUidView, render);
  }
  async load(): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.update({ loaded: false, schoolUid: null });
    if (!this.runtime.schoolUid) {
      this.update({ error: '校内 UID 服务尚未配置' });
      return;
    }
    await this.run(
      (cancel) => this.runtime.schoolUid!.own(cancel),
      (raw) => {
        const schoolUid = decodeSchoolUid(raw);
        this.update({
          loaded: true,
          schoolUid,
          status:
            schoolUid.status === 'assigned'
              ? '当前学校与校内 UID 已确认'
              : schoolUid.status === 'unassigned'
                ? '当前没有校内 UID'
                : '校内 UID 暂不可用',
        });
      },
    );
  }
}
export interface SchoolUidLookupView extends CommunityView {
  readonly loaded: boolean;
  readonly canLookup: boolean;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly campusPage: number;
  readonly campusTotal: number;
  readonly schoolCode: string;
  readonly schoolName: string;
  readonly uid: string;
  readonly result: SchoolUidLookup | null;
}
export const initialSchoolUidLookupView = (): SchoolUidLookupView => ({
  ...initialCommunityView(),
  loaded: false,
  canLookup: false,
  campusQuery: '',
  campuses: [],
  campusPage: 1,
  campusTotal: 0,
  schoolCode: '',
  schoolName: '',
  uid: '',
  result: null,
});
export class SchoolUidLookupController extends CommunityController<SchoolUidLookupView> {
  constructor(
    runtime: CommunityRuntime,
    render: (view: SchoolUidLookupView) => void,
  ) {
    super(runtime, initialSchoolUidLookupView, render);
  }
  async load(): Promise<void> {
    if (this.view.busy || !this.available() || !this.runtime.schoolUid) return;
    this.update({ loaded: false, canLookup: false, result: null });
    await this.run(
      async (cancel) =>
        decodeAuthorization(await this.runtime.schoolUid!.capabilities(cancel)),
      (capability) =>
        this.update({
          loaded: true,
          canLookup: capability.schoolIdentityManagement,
          status: capability.schoolIdentityManagement
            ? '选择准确学校并输入校内 UID'
            : '仅具有当前超级管理员权限的账号可查询',
        }),
    );
  }
  setQuery(value: string): void {
    if (this.view.busy) return;
    this.update({
      campusQuery: value,
      campuses: [],
      campusPage: 1,
      campusTotal: 0,
      schoolCode: '',
      schoolName: '',
      result: null,
    });
  }
  setUid(value: string): void {
    if (this.view.busy) return;
    this.update({ uid: value, result: null });
  }
  async search(page = 1): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.view.canLookup ||
      !this.runtime.profiles
    )
      return;
    this.update({ result: null });
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { q: this.view.campusQuery.trim(), district: '', page, pageSize: 20 },
          cancel,
        ),
      (result) =>
        this.update({
          campuses: result.items.filter(
            (item) => item.isActive && item.institutionId !== null,
          ),
          campusPage: result.page,
          campusTotal: result.total,
        }),
    );
  }
  selectCampus(id: string): void {
    if (this.view.busy || !this.available() || !this.view.canLookup) return;
    const campus = this.view.campuses.find((item) => item.id === id);
    if (!campus?.institutionId) return;
    this.update({
      schoolCode: campus.institutionId,
      schoolName: campus.institutionName,
      result: null,
    });
  }
  async lookup(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.view.canLookup ||
      !this.runtime.schoolUid ||
      !this.view.schoolCode
    )
      return;
    let uid: string;
    try {
      uid = parseSchoolUid(this.view.uid);
    } catch {
      this.update({
        error:
          '请输入 1–19 位正整数 UID，可保留前导零；不接受空格、符号或超出范围的数值',
        result: null,
      });
      return;
    }
    const schoolCode = this.view.schoolCode;
    this.update({ result: null });
    await this.run(
      async (cancel) =>
        decodeSchoolUidLookup(
          await this.runtime.schoolUid!.lookup(schoolCode, uid, cancel),
        ),
      (result) =>
        this.update({
          result,
          status:
            result.status === 'found'
              ? '已找到当前公开主页；打开时将重新核验'
              : '此学校与 UID 当前不可查询',
        }),
    );
  }
}
