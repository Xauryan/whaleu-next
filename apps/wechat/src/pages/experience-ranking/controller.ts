import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import {
  decodeExperienceRanking,
  type ExperienceRanking,
  type ExperienceRankingItem,
} from '../../experience/ranking-contract';
export interface ExperienceRankingView extends CommunityView {
  readonly items: readonly ExperienceRankingItem[];
  readonly loaded: boolean;
  readonly selectionStatus: ExperienceRanking['selectionStatus'] | null;
  readonly scope: 'global';
  readonly population: 'known_participants';
  readonly populationCompleteness: 'incomplete';
}
export const initialExperienceRankingView = (): ExperienceRankingView => ({
  ...initialCommunityView(),
  items: [],
  loaded: false,
  selectionStatus: null,
  scope: 'global',
  population: 'known_participants',
  populationCompleteness: 'incomplete',
});
export class ExperienceRankingController extends CommunityController<ExperienceRankingView> {
  constructor(
    runtime: CommunityRuntime,
    render: (view: ExperienceRankingView) => void,
  ) {
    super(runtime, initialExperienceRankingView, render);
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.update({
      items: [],
      loaded: false,
      selectionStatus: null,
      busy: false,
      error: '',
    });
    if (!this.runtime.experienceRanking) {
      this.update({
        configured: false,
        status: '等级列表暂不可用',
        error: '当前构建尚未配置等级列表服务',
      });
      return;
    }
    this.update({ configured: true, status: '正在核验当前可查看的已知参与者' });
    await this.run(
      (cancel) => this.runtime.experienceRanking!.ranking(cancel),
      (raw) => {
        const page = decodeExperienceRanking(raw);
        this.update({
          ...page,
          loaded: true,
          status:
            page.selectionStatus === 'limit_reached'
              ? '已达到本次展示上限'
              : page.selectionStatus === 'scan_limited'
                ? '因扫描上限，本次未完整查看已知来源'
                : '本次已检查的已知来源已到末尾',
        });
      },
      () => this.update({ items: [], loaded: false, selectionStatus: null }),
    );
  }
  override cancel(): void {
    this.stop();
    this.update({
      items: [],
      loaded: false,
      selectionStatus: null,
      busy: false,
      error: '',
      status: '已停止加载，可重新刷新',
    });
  }
}
