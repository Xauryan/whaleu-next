import { ClientError } from '../../api/errors';
import type { SessionStore } from '../../auth/session';
import {
  validateCampusQuery,
  type Campus,
  type CampusPage,
  type OwnProfile,
} from '../../profile/contract';
import type { ProfileGateway } from '../../profile/gateway';
import {
  initialAccountView,
  OwnedController,
  type AccountView,
} from '../../profile/owned-controller';
export interface CampusView extends AccountView {
  readonly q: string;
  readonly district: string;
  readonly items: readonly Campus[];
  readonly page: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly selectedId: string;
  readonly selectedName: string;
  readonly candidateId: string;
  readonly candidateName: string;
  readonly searchDirty: boolean;
}
export function initialCampusView(): CampusView {
  return {
    ...initialAccountView(),
    q: '',
    district: '',
    items: [],
    page: 1,
    total: 0,
    hasPrevious: false,
    hasNext: false,
    selectedId: '',
    selectedName: '尚未选择校园',
    candidateId: '',
    candidateName: '',
    searchDirty: false,
  };
}
export class CampusController extends OwnedController<CampusView> {
  private baseline: OwnProfile | undefined;
  private query = { q: '', district: '' };
  constructor(
    sessions: SessionStore,
    gateway: ProfileGateway | undefined,
    render: (view: CampusView) => void,
  ) {
    super(sessions, gateway, initialCampusView, render);
  }
  protected resetPrivate(): void {
    this.baseline = undefined;
    this.query = { q: '', district: '' };
  }
  async load(): Promise<void> {
    await this.searchPage(1, true);
  }
  setQuery(value: string): void {
    if (this.view.saving || this.view.loading) return;
    this.update({
      q: value,
      searchDirty:
        value.trim() !== this.query.q ||
        this.view.district.trim() !== this.query.district,
    });
  }
  setDistrict(value: string): void {
    if (this.view.saving || this.view.loading) return;
    this.update({
      district: value,
      searchDirty:
        this.view.q.trim() !== this.query.q ||
        value.trim() !== this.query.district,
    });
  }
  async search(): Promise<void> {
    await this.searchPage(1, !this.baseline);
  }
  async previous(): Promise<void> {
    if (this.view.hasPrevious && !this.view.searchDirty)
      await this.searchPage(this.view.page - 1, false);
  }
  async next(): Promise<void> {
    if (this.view.hasNext && !this.view.searchDirty)
      await this.searchPage(this.view.page + 1, false);
  }
  choose(id: string): void {
    if (!this.editable() || this.view.searchDirty) return;
    const campus = this.view.items.find((item) => item.id === id);
    if (!campus?.isActive) return;
    this.update({
      candidateId: campus.id,
      candidateName: campus.fullName,
      status:
        campus.id === this.view.selectedId
          ? '已选择该校园'
          : '请确认校园后保存',
      error: '',
    });
  }
  cancelSelection(): void {
    if (this.view.saving) return;
    this.update({
      candidateId: '',
      candidateName: '',
      status: '已取消本次选择',
    });
  }
  async save(): Promise<void> {
    if (
      !this.editable() ||
      this.view.searchDirty ||
      !this.baseline ||
      !this.view.candidateId ||
      this.view.candidateId === this.view.selectedId
    )
      return;
    const campusId = this.view.candidateId;
    const revision = this.baseline.revision;
    await this.perform(
      'save',
      (gateway, cancel) =>
        gateway.selectCampus({ expectedRevision: revision, campusId }, cancel),
      (profile) => {
        this.checkProfile(profile, revision);
        if (profile.selectedCampus?.id !== campusId)
          throw new ClientError('protocol', 'Campus selection mismatch');
        this.baseline = profile;
        this.update({
          selectedId: profile.selectedCampus.id,
          selectedName: profile.selectedCampus.fullName,
          candidateId: '',
          candidateName: '',
        });
      },
    );
  }
  private async searchPage(
    page: number,
    reloadProfile: boolean,
  ): Promise<void> {
    if (this.view.saving) return;
    const q = this.view.q.trim(),
      district = this.view.district.trim();
    if ([...q].length > 100 || [...district].length > 100) {
      this.update({ error: '校园名称和地区各最多 100 个字' });
      return;
    }
    const query = { q, district, page, pageSize: 20 };
    try {
      validateCampusQuery(query);
    } catch {
      this.update({ error: '搜索条件包含不支持的字符，请检查后重试' });
      return;
    }
    await this.perform(
      'read',
      async (gateway, cancel) => {
        const [campuses, profile] = await Promise.all([
          gateway.campuses(query, cancel),
          reloadProfile || this.view.needsReload
            ? gateway.profile(cancel)
            : Promise.resolve(this.baseline!),
        ]);
        return { campuses, profile };
      },
      ({ campuses, profile }) => {
        this.checkProfile(profile);
        this.baseline = profile;
        this.query = { q, district };
        this.showResults(campuses);
        this.update({
          q,
          district,
          selectedId: profile.selectedCampus?.id ?? '',
          selectedName: profile.selectedCampus?.fullName ?? '尚未选择校园',
          candidateId: '',
          candidateName: '',
          searchDirty: false,
        });
      },
    );
  }
  private showResults(result: CampusPage): void {
    this.update({
      items: result.items,
      page: result.page,
      total: result.total,
      hasPrevious: result.page > 1,
      hasNext:
        result.page < 10000 && result.page * result.pageSize < result.total,
    });
  }
}
