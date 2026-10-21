import type { WhaleuApp } from '../../app';
import {
  initialToolHubView,
  type ToolHubController,
} from '../../campus-tools/controller';
import { ToolNavigator, toolHubPath } from '../../campus-tools/navigation';

const tools = [
  {
    kind: 'map',
    title: '校园地图',
    subtitle: '找到下一站',
    icon: 'map',
    tone: 'blue',
  },
  {
    kind: 'shuttle',
    title: '校车时刻',
    subtitle: '出发前看一眼',
    icon: 'bus',
    tone: 'orange',
  },
  {
    kind: 'research',
    title: '科研资源',
    subtitle: '让探索更进一步',
    icon: 'book',
    tone: 'purple',
  },
];

Page({
  data: {
    tools,
    campus: initialToolHubView(),
    campusLabel: '选择你的校园',
    authRecovery: false,
    navigationError: '',
    learning: [
      {
        title: '课程评价',
        subtitle: '选课之前，听听真实体验',
        icon: 'book',
        tone: 'blue',
        url: '/pages/course-ratings/course-ratings',
      },
      {
        title: '院系专业',
        subtitle: '了解专业，也找到同路人',
        icon: 'cap',
        tone: 'purple',
        url: '/pages/major-directory/major-directory',
      },
    ],
    life: [
      {
        title: '校园评分',
        subtitle: '发现值得体验的校园日常',
        icon: 'star',
        tone: 'orange',
        url: '/pages/rating-catalog/rating-catalog',
      },
      {
        title: '食堂口碑',
        subtitle: '看看大家怎么选',
        icon: 'meal',
        tone: 'green',
        url: '/pages/canteen-floor-scores/canteen-floor-scores',
      },
      {
        title: '校园目录',
        subtitle: '社群、组织与实用信息',
        icon: 'grid',
        tone: 'blue',
        url: '/pages/directory-hub/directory-hub',
      },
      {
        title: '活动发现',
        subtitle: '让课余时间更有意思',
        icon: 'calendar',
        tone: 'pink',
        url: '/pages/activity-list/activity-list',
      },
      {
        title: '校园跑腿',
        subtitle: '生活里的小事，互相搭把手',
        icon: 'bag',
        tone: 'purple',
        url: '/pages/errand-list/errand-list',
      },
      {
        title: '校园公告',
        subtitle: '查看已发布的校园通知',
        icon: 'notice',
        tone: 'orange',
        url: '/pages/announcements/announcements',
      },
    ],
  },
  controller: undefined as ToolHubController | undefined,
  navigator: undefined as ToolNavigator | undefined,
  onShow() {
    this.onHide();
    this.setData({ navigationError: '', authRecovery: false });
    this.navigator = new ToolNavigator(wx, () =>
      this.setData({ navigationError: '暂时无法打开，请稍后重试。' }),
    );
    const runtime = getApp<WhaleuApp>().campusTools;
    if (!runtime) {
      this.setData({
        campus: {
          ...initialToolHubView(),
          error: '校园工具服务暂未连接。其他入口仍可查看。',
        },
      });
      return;
    }
    if (runtime.needsRecovery()) {
      this.setData({ authRecovery: true });
      return;
    }
    this.controller = runtime.createHub((campus) => {
      this.navigator?.dispose();
      this.navigator = new ToolNavigator(wx, () =>
        this.setData({ navigationError: '暂时无法打开，请稍后重试。' }),
      );
      const hasName =
        campus.campusName && campus.campusName !== campus.campusId;
      this.setData({
        campus,
        campusLabel: hasName
          ? campus.campusName
          : campus.campusId
            ? '当前浏览校园'
            : '选择你的校园',
      });
    });
    void this.controller.load();
  },
  onTool(event: { currentTarget: { dataset: { kind: string } } }) {
    if (this.data.campus.busy) return;
    const entry = this.data.campus.entries.find(
      (item) =>
        item.kind === event.currentTarget.dataset.kind &&
        item.state === 'enabled',
    );
    // Detail pages need an authoritative catalog entry, not guessed identifiers.
    // The catalog is the safe fallback when this campus has not published one.
    this.navigator?.open(
      entry ? (this.controller?.route(entry.id) ?? toolHubPath) : toolHubPath,
    );
  },
  async onPullDownRefresh() {
    try {
      await this.controller?.refresh();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onRetry() {
    this.onShow();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.setData({
      campus: initialToolHubView(),
      campusLabel: '选择你的校园',
      authRecovery: false,
    });
  },
  onUnload() {
    this.onHide();
  },
});
