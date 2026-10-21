// Fictional visual-QA data only. Never used by runtime or as live campus evidence.
const provenance = {
  maintainer: '示例校园服务中心',
  attribution: '合成展示资料',
  publishedAt: '2026-10-20',
  observedAt: '2026-10-20',
  validity: {
    kind: 'finite',
    effectiveAt: '2026-10-20',
    expiresAt: '2026-11-20',
  },
};
const base = { state: 'enabled', sourceId: 'qa', revision: 'qa', ordinal: 0 };
const slot = (id, alt) => ({
  id,
  bindingId: id,
  assetId: id,
  manifestDigest: 'qa',
  alt,
});
const mapEntry = {
  ...base,
  id: 'qa-map',
  title: '校园地图',
  kind: 'map',
  coordinateSystem: 'gcj02',
  center: { latitude: 30, longitude: 120 },
  zoom: 16,
  markers: [
    {
      id: 1,
      sourceId: 'qa-library',
      title: '示例图书馆',
      category: '学习',
      details: '示例地点说明，仅用于界面排版。',
      position: { latitude: 30, longitude: 120 },
    },
    {
      id: 2,
      sourceId: 'qa-dining',
      title: '示例食堂',
      category: '生活',
      details: '示例地点说明。',
      position: { latitude: 30.001, longitude: 120.001 },
    },
    {
      id: 3,
      sourceId: 'qa-stadium',
      title: '示例运动场',
      category: '运动',
      details: '示例地点说明。',
      position: { latitude: 30.002, longitude: 120.002 },
    },
  ],
};
const shuttleEntry = {
  ...base,
  id: 'qa-shuttle',
  title: '校园校车',
  kind: 'shuttle',
  groups: [
    {
      id: 'qa-weekday',
      title: '示例校区 · 工作日',
      slots: [
        slot('qa-shuttle-1', '示例工作日时刻表'),
        slot('qa-shuttle-2', '示例站点说明'),
      ],
    },
    {
      id: 'qa-weekend',
      title: '示例校区 · 周末',
      slots: [slot('qa-shuttle-3', '示例周末时刻表')],
    },
    { id: 'qa-holiday', title: '示例校区 · 节假日', slots: [] },
  ],
};
const researchEntry = {
  ...base,
  id: 'qa-research',
  title: '科研资源',
  kind: 'research',
  description:
    '学术资源导航\n\n从论文检索到文献管理，整理日常研究中常用的资源入口与使用方法。\n\n先了解检索方式，再开始你的下一项研究。',
  compatibility: '适合在电脑浏览器中使用。部分资源可能需要校园网络。',
  image: slot('qa-research-image', '示例资源使用指南'),
  link: { action: 'copy', state: 'available' },
};
const webEntry = {
  ...base,
  id: 'qa-web',
  title: '示例校园服务',
  kind: 'web-link',
  link: { action: 'webview', state: 'webview_unconfigured' },
};
const entryPatch = (entry) => ({
  busy: false,
  state: 'enabled',
  status: '当前已确认的工具资料',
  error: '',
  entry,
  provenance,
});
const mapPatch = {
  ...entryPatch(mapEntry),
  center: mapEntry.center,
  zoom: 16,
  markers: mapEntry.markers.map(({ id, title, position }) => ({
    id,
    title,
    ...position,
  })),
  locateEnabled: false,
  located: false,
};
export default [
  {
    id: 'campus-tools-loaded',
    page: 'campus-tools',
    title: '校园工具 · 合成内容',
    patch: {
      state: 'ready',
      status: '当前校园工具',
      campusId: 'qa-campus',
      campusName: '示例大学 · 主校区',
      provenance,
      entries: [
        mapEntry,
        shuttleEntry,
        researchEntry,
        webEntry,
        {
          ...base,
          id: 'qa-disabled',
          title: '示例停用服务',
          state: 'disabled',
          kind: 'web-link',
        },
      ],
    },
    expectedText: [
      '示例大学 · 主校区',
      '校园地图',
      '校园校车',
      '科研资源',
      '已停用',
    ],
  },
  {
    id: 'campus-tools-search',
    page: 'campus-tools',
    title: '选择浏览校区 · 合成内容',
    patch: {
      choosing: true,
      query: '示例',
      searchQuery: '示例',
      campuses: [
        { id: 'qa-campus-one', fullName: '示例大学 · 主校区', isActive: true },
        { id: 'qa-campus-two', fullName: '示例大学 · 北校区', isActive: true },
        {
          id: 'qa-campus-three',
          fullName: '示例大学 · 旧校区',
          isActive: false,
        },
      ],
      campusPage: 1,
      hasNext: true,
    },
    expectedText: ['搜索', '示例大学 · 北校区', '示例大学 · 旧校区', '下一页'],
  },
  {
    id: 'campus-tools-map-loaded',
    page: 'campus-tools-map',
    title: '校园地图 · 原生地图占位',
    patch: mapPatch,
    expectedText: ['校园地点', '示例图书馆', '示例食堂', '暂不支持定位'],
  },
  {
    id: 'campus-tools-map-place',
    page: 'campus-tools-map',
    title: '校园地点详情 · 合成内容',
    patch: { ...mapPatch, marker: mapEntry.markers[0] },
    expectedText: ['示例地点说明，仅用于界面排版。', '校园地点', '示例运动场'],
  },
  {
    id: 'campus-tools-shuttle-loaded',
    page: 'campus-tools-shuttle',
    title: '校车资料 · 合成内容',
    patch: {
      ...entryPatch(shuttleEntry),
      expandedGroups: { 'qa-weekday': true },
    },
    expectedText: [
      '示例校区 · 工作日',
      '示例工作日时刻表',
      '示例站点说明',
      '示例校区 · 周末',
    ],
  },
  {
    id: 'campus-tools-shuttle-retry',
    page: 'campus-tools-shuttle',
    title: '校车图片重试 · 无真实图片',
    patch: {
      ...entryPatch(shuttleEntry),
      expandedGroups: { 'qa-weekday': true },
      image: {
        expanded: true,
        selected: 0,
        total: 2,
        src: '',
        viewId: '',
        alt: '示例工作日时刻表',
        status: 'unavailable',
        message: '图片暂时无法显示',
      },
    },
    expectedText: ['重试当前图片', '图片暂时无法显示', '下一张'],
  },
  {
    id: 'campus-tools-research-loaded',
    page: 'campus-tools-research',
    title: '科研资源 · 合成内容',
    patch: entryPatch(researchEntry),
    expectedText: [
      '学术资源导航',
      '适用说明',
      '示例资源使用指南',
      '复制资源链接',
    ],
  },
  {
    id: 'campus-tools-webview-unavailable',
    page: 'campus-tools-webview',
    title: '外部工具暂不可用',
    patch: {
      ...entryPatch(webEntry),
      state: 'webview_unconfigured',
      status: '此工具尚未配置可信的嵌入能力',
      webviewSrc: '',
    },
    expectedText: [
      '暂未开放访问',
      '此工具暂不支持在小程序内打开。',
      '全部校园工具',
    ],
  },
  {
    id: 'campus-tools-auth-recovery',
    page: 'campus-tools',
    title: '登录恢复',
    patch: {
      authRecovery: true,
      error: '登录状态未能恢复。请重新登录，或明确选择以访客继续。',
    },
    expectedText: ['重新登录', '以访客继续'],
  },
];
