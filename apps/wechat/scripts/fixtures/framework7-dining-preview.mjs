// Fictional native source projections only, not device/provider acceptance.
import dining from './dining-scores-preview.mjs';
const sample = (id) =>
  structuredClone(dining.find((item) => item.id === id).patch);
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-dining-${id}`,
  page,
  title: `Framework7 iOS 原生餐饮 · ${title}`,
  patch,
  expectedText,
});
const floorCatalog = sample('dining-floor-catalog');
const floor = sample('dining-floor-detail');
const catalog = sample('dining-window-catalog');
const window = sample('dining-window-detail');
const dishes = sample('dining-dishes-list');
const recovery = {
  loaded: false,
  hasSession: true,
  busy: false,
  frozen: true,
  status: '原请求待核验',
  receiptStatus: '结果尚未确认',
};
export default [
  ...dining.map((item) =>
    fixture(
      item.id.replace('dining-', ''),
      item.page,
      item.title,
      item.patch,
      item.expectedText,
    ),
  ),
  fixture(
    'floor-filter',
    'canteen-floor-scores',
    '楼层筛选',
    {
      ...floorCatalog,
      uiPanel: 'filter',
      floorDraft: floorCatalog.floorOptions[0].id,
      floorIndex: 1,
    },
    ['选择楼层', '查看楼层'],
  ),
  fixture(
    'floor-empty',
    'canteen-floor-scores',
    '没有可选楼层',
    { ...floorCatalog, floorOptions: [] },
    ['选择食堂', '暂无可选楼层'],
  ),
  fixture(
    'floor-info',
    'canteen-floor-score-detail',
    '楼层说明',
    { ...floor, uiPanel: 'info' },
    ['来源楼层', '不混入窗口评分'],
  ),
  fixture(
    'floor-unknown',
    'canteen-floor-score-detail',
    '楼层历史未知',
    {
      ...floor,
      canScore: false,
      detail: {
        ...floor.detail,
        floor: { ...floor.detail.floor, summary: { kind: 'unavailable' } },
        myScore: { kind: 'unavailable' },
      },
    },
    ['历史评分暂不能确认', '我的历史评分暂不能确认'],
  ),
  fixture(
    'floor-recorded',
    'canteen-floor-score-detail',
    '首次评分已提交',
    {
      ...floor,
      canScore: false,
      detail: { ...floor.detail, myScore: { kind: 'recorded', score: 4.75 } },
    },
    ['我的评分', '4.75'],
  ),
  fixture(
    'floor-score-confirm-busy',
    'canteen-floor-score-detail',
    '首次评分等待回执',
    {
      ...sample('dining-floor-confirmation'),
      busy: true,
      status: '正在核验评分',
    },
    ['正在核验评分', '确认楼层评分'],
  ),
  fixture(
    'window-menu',
    'window-ratings',
    '独立恢复入口',
    { uiPanel: 'menu', loaded: false },
    ['讨论与点赞恢复', '菜品推荐原请求'],
  ),
  fixture(
    'window-empty',
    'window-ratings',
    '筛选无结果',
    { ...catalog, items: [] },
    ['按均分排序', '没有符合条件的窗口'],
  ),
  fixture(
    'window-next',
    'window-ratings',
    '分页',
    { ...catalog, canNext: true },
    ['家常小炒', '下一页'],
  ),
  fixture(
    'window-restart',
    'window-ratings',
    '分页失效',
    { ...catalog, items: [], restartRequired: true },
    ['分页已失效', '从第一页重新加载'],
  ),
  fixture(
    'window-info',
    'window-rating-detail',
    '可修改评分说明',
    { ...window, uiPanel: 'info' },
    ['每个账号保留一个当前评分', '修改会替换原分数'],
  ),
  fixture(
    'window-score-confirm',
    'window-rating-detail',
    '负分修改为有效零分',
    {
      ...window,
      detail: {
        ...window.detail,
        myScore: { ...window.detail.myScore, score: -10 },
      },
      selectedScore: 0,
      confirming: 'score',
    },
    ['当前 -10 分 → 本次 0 分', '确认这个分数', '本次不会覆盖'],
  ),
  fixture(
    'window-first-confirm',
    'window-rating-detail',
    '首次窗口评分',
    {
      ...window,
      detail: { ...window.detail, myScore: { kind: 'not_submitted' } },
      selectedScore: 10,
      confirming: 'score',
    },
    ['本次 10 分', '确认这个分数'],
  ),
  fixture(
    'dishes-info',
    'window-dishes',
    '匿名汇总说明',
    { ...dishes, uiPanel: 'info' },
    ['不代表不同自然人的数量', '不展示推荐者身份'],
  ),
  fixture(
    'dishes-empty',
    'window-dishes',
    '菜品空列表',
    { ...dishes, items: [] },
    ['还没有推荐', '查找或推荐菜品'],
  ),
  fixture(
    'dishes-next',
    'window-dishes',
    '菜品分页',
    { ...dishes, canNext: true },
    ['番茄炒蛋', '下一页'],
  ),
  fixture(
    'dishes-restart',
    'window-dishes',
    '菜品分页重启',
    { ...dishes, items: [], restartRequired: true },
    ['列表已变化', '第一页重新加载'],
  ),
  fixture(
    'dishes-unknown',
    'window-dishes',
    '个人推荐历史未知',
    {
      ...dishes,
      uiPanel: 'dish',
      own: { kind: 'unavailable' },
      ownName: '番茄炒蛋',
      nameDraft: '番茄炒蛋',
    },
    ['推荐历史暂不能确认', '不能当作尚未推荐'],
  ),
  fixture(
    'dishes-recommend',
    'window-dishes',
    '明确推荐意图',
    {
      ...dishes,
      uiPanel: 'dish',
      own: { kind: 'not_recommended' },
      ownName: '番茄炒蛋',
      nameDraft: '番茄炒蛋',
      canRecommend: true,
    },
    ['已确认尚未推荐', '推荐这道菜'],
  ),
  ...['recommend', 'retract'].map((operation) =>
    fixture(
      `dishes-${operation}-confirm`,
      'window-dishes',
      '推荐操作确认',
      { ...dishes, confirming: operation, ownName: '番茄炒蛋' },
      ['只操作自己的推荐', '确认这个操作', '返回调整'],
    ),
  ),
  ...[
    'canteen-floor-scores',
    'canteen-floor-score-detail',
    'window-ratings',
    'window-rating-detail',
    'window-dishes',
  ].flatMap((page) => [
    fixture(
      `${page}-guest`,
      page,
      '未登录',
      { hasSession: false, loaded: false },
      [
        '登录后查看',
        page === 'window-dishes'
          ? '菜品推荐'
          : page.startsWith('canteen')
            ? '楼层评分'
            : '窗口评分',
      ],
    ),
    fixture(
      `${page}-error`,
      page,
      '错误与等待',
      {
        hasSession: true,
        loaded: false,
        busy: true,
        status: '正在读取',
        error: '示例网络暂不可用',
      },
      ['正在读取', '示例网络暂不可用', '停止等待'],
    ),
  ]),
  ...[
    'canteen-floor-score-detail',
    'window-rating-detail',
    'window-dishes',
  ].flatMap((page) => {
    const floorPage = page.startsWith('canteen');
    const dishPage = page === 'window-dishes';
    const identity = {
      recoveryFloorId: floor.detail.floor.id,
      recoveryWindowId: window.detail.window.id,
      recoveryScore: floorPage ? 4.75 : 0,
      recoveryName: '番茄炒蛋',
      recoveryOperation: 'window.dish.retract.v1',
    };
    return [
      fixture(
        `${page}-recovery`,
        page,
        '原请求待核验',
        { ...recovery, ...identity, recoveryPhase: 'submit' },
        [
          '查询原回执',
          '查询后申请取消原请求',
          dishPage
            ? '原菜名：番茄炒蛋'
            : floorPage
              ? '原请求分数：4.75'
              : '原请求分数：0',
        ],
      ),
      fixture(
        `${page}-cancel-confirm`,
        page,
        '服务端取消确认',
        {
          ...recovery,
          ...identity,
          recoveryPhase: 'submit',
          confirming: 'cancel',
          receiptMissing: true,
        },
        ['确认取消这个原请求', '只有', '服务端取消回执'],
      ),
      fixture(
        `${page}-cancel-recovery`,
        page,
        '持久取消意图',
        { ...recovery, ...identity, recoveryPhase: 'cancel' },
        ['已保存取消决定', '只查询回执或重试取消', '查询后重试原取消'],
      ),
    ];
  }),
];
