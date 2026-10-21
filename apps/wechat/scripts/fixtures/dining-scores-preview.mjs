/** Fictional layout-only states, never imported by the native runtime. */
const ready = {
  loaded: true,
  hasSession: true,
  configured: true,
  busy: false,
  frozen: false,
  status: '',
  error: '',
  receiptStatus: '',
  blocker: '',
};
const floor = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceFloorKey: 'synthetic-floor',
  label: '二层',
};
const canteen = {
  id: '22222222-2222-4222-8222-222222222222',
  revision: '66666666-6666-4666-8666-666666666666',
  name: '湖畔食堂',
  campusId: 'synthetic-campus',
  campusLabel: '示例校区',
  sourceCampusKey: 'synthetic-campus',
  sourceCanteenKey: 'synthetic-canteen',
  floors: [
    floor,
    { ...floor, id: '33333333-3333-4333-8333-333333333333', label: '三层' },
  ],
};
const catalog = {
  catalogRevision: '66666666-6666-4666-8666-666666666666',
  canteens: [canteen],
};
const floorOptions = canteen.floors.map((item) => ({
  id: item.id,
  label: `${canteen.name} · ${item.label}`,
}));
const canteenOptions = [
  { id: canteen.id, label: '示例校区 · 湖畔食堂', selected: true },
];
const floorDetail = {
  catalogRevision: '66666666-6666-4666-8666-666666666666',
  floor: {
    ...floor,
    canteenRevision: '66666666-6666-4666-8666-666666666666',
    canteenId: canteen.id,
    canteenName: canteen.name,
    summary: { kind: 'known', ratingCount: 26, mean: 4.3 },
  },
  myScore: { kind: 'not_submitted' },
};
const window = {
  id: '44444444-4444-4444-8444-444444444444',
  revision: '66666666-6666-4666-8666-666666666666',
  name: '家常小炒',
  canteenId: canteen.id,
  canteenName: canteen.name,
  floor,
  summary: { kind: 'known', ratingCount: 38, mean: 7.6 },
};
const detail = {
  catalogRevision: '66666666-6666-4666-8666-666666666666',
  window,
  myScore: {
    kind: 'recorded',
    score: 8,
    revision: '66666666-6666-4666-8666-666666666666',
    recordedAt: '2026-10-18T12:00:00Z',
  },
};
const dishes = [
  {
    dishIdentity: Buffer.from('番茄炒蛋').toString('hex'),
    dishName: '番茄炒蛋',
    recommendationCount: 16,
    isRecommended: true,
    myMembershipRevision: '66666666-6666-4666-8666-666666666666',
  },
  {
    dishIdentity: Buffer.from('香菇青菜').toString('hex'),
    dishName: '香菇青菜',
    recommendationCount: 9,
    isRecommended: false,
    myMembershipRevision: null,
  },
  {
    dishIdentity: Buffer.from('土豆炖牛肉').toString('hex'),
    dishName: '土豆炖牛肉',
    recommendationCount: 7,
    isRecommended: false,
    myMembershipRevision: null,
  },
];
export default [
  {
    id: 'dining-floor-catalog',
    page: 'canteen-floor-scores',
    title: '食堂楼层',
    patch: {
      ...ready,
      catalog,
      canteenOptions,
      floorOptions,
      floorLabels: ['请选择楼层', ...floorOptions.map((item) => item.label)],
      floorIndex: 0,
    },
    expectedText: ['湖畔食堂 · 二层', '湖畔食堂 · 三层', '查看楼层评分'],
  },
  {
    id: 'dining-floor-detail',
    page: 'canteen-floor-score-detail',
    title: '楼层评分',
    patch: { ...ready, detail: floorDetail, canScore: true },
    expectedText: ['湖畔食堂', '二层', '4.3', '26 条评分', '为楼层评分'],
  },
  {
    id: 'dining-floor-score',
    page: 'canteen-floor-score-detail',
    title: '楼层评分填写',
    patch: {
      ...ready,
      detail: floorDetail,
      canScore: true,
      uiPanel: 'score',
      selectedScore: 4.75,
    },
    expectedText: ['1 至 5 分，可填小数', '4.75', '继续'],
  },
  {
    id: 'dining-floor-confirmation',
    page: 'canteen-floor-score-detail',
    title: '楼层首次评分确认',
    patch: {
      ...ready,
      detail: floorDetail,
      canScore: true,
      selectedScore: 4.75,
      confirming: 'score',
    },
    expectedText: [
      '确认楼层评分',
      '4.75 分',
      '当前没有编辑或删除入口',
      '确认提交',
    ],
  },
  {
    id: 'dining-window-catalog',
    page: 'window-ratings',
    title: '窗口口碑列表',
    patch: {
      ...ready,
      catalog,
      canteenOptions,
      floorOptions,
      floorLabels: ['全部楼层', '二层', '三层'],
      floorIndex: 0,
      items: [
        window,
        {
          ...window,
          id: '55555555-5555-4555-8555-555555555555',
          name: '手工面馆',
          summary: { kind: 'known', ratingCount: 21, mean: 6.9 },
        },
      ],
      appliedFilter: '湖畔食堂',
      pageNumber: 1,
    },
    expectedText: ['家常小炒', '手工面馆', '7.6', '38 条评分'],
  },
  {
    id: 'dining-window-filter',
    page: 'window-ratings',
    title: '窗口筛选',
    patch: {
      ...ready,
      catalog,
      canteenOptions,
      floorOptions,
      floorLabels: ['全部楼层', '二层', '三层'],
      floorIndex: 0,
      items: [window],
      appliedFilter: '全部窗口',
      uiPanel: 'filter',
    },
    expectedText: ['食堂可多选', '大于 0 才按最低分筛选', '查看结果'],
  },
  {
    id: 'dining-window-detail',
    page: 'window-rating-detail',
    title: '窗口详情',
    patch: { ...ready, detail, canScore: true },
    expectedText: ['家常小炒', '7.6', '我的评分', '修改评分', '推荐菜品'],
  },
  {
    id: 'dining-window-score',
    page: 'window-rating-detail',
    title: '修改窗口评分',
    patch: {
      ...ready,
      detail,
      canScore: true,
      uiPanel: 'score',
      selectedScore: 0,
    },
    expectedText: ['-10', '+10', '0 分同样计入', '本次选择：0', '继续'],
  },
  {
    id: 'dining-window-unknown',
    page: 'window-rating-detail',
    title: '历史评分未知',
    patch: {
      ...ready,
      detail: {
        ...detail,
        window: { ...window, summary: { kind: 'unavailable' } },
        myScore: { kind: 'unavailable' },
      },
      canScore: false,
    },
    expectedText: ['家常小炒', '历史评分暂不能确认', '我的历史评分暂不能确认'],
  },
  {
    id: 'dining-window-pending',
    page: 'window-rating-detail',
    title: '原评分待确认',
    patch: {
      ...ready,
      loaded: false,
      detail: null,
      frozen: true,
      recoveryWindowId: window.id,
      recoveryScore: 0,
      recoveryPhase: 'cancel',
    },
    expectedText: [
      '原窗口评分待确认',
      '原请求分数：0',
      '只查询回执或重试取消',
      '查询原回执',
    ],
  },
  {
    id: 'dining-dishes-list',
    page: 'window-dishes',
    title: '窗口推荐菜品',
    patch: { ...ready, items: dishes, pageNumber: 1 },
    expectedText: ['番茄炒蛋', '16 条有效推荐', '香菇青菜', '查找或推荐菜品'],
  },
  {
    id: 'dining-dishes-own',
    page: 'window-dishes',
    title: '查询自己的菜品推荐',
    patch: {
      ...ready,
      loaded: false,
      uiPanel: 'dish',
      own: {
        kind: 'recorded',
        active: true,
        revision: '66666666-6666-4666-8666-666666666666',
      },
      ownName: '番茄炒蛋',
      nameDraft: '番茄炒蛋',
      canRetract: true,
    },
    expectedText: ['查询我的推荐', '我已推荐：番茄炒蛋', '撤回我的推荐'],
  },
];
