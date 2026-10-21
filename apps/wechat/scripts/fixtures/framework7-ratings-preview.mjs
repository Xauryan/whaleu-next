// Fictional source-only fixtures. No provider/account data and no business actions.
import ratings from './ratings-preview.mjs';
const pages = [
  'rating-catalog',
  'rating-detail',
  'rating-thread',
  'rating-create',
  'rating-scoped',
];
const sample = (id) =>
  structuredClone(ratings.find((item) => item.id === id).patch);
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-ratings-${id}`,
  page,
  title: `Framework7 iOS 原生评分 · ${title}`,
  patch,
  expectedText,
});
const catalog = sample('ratings-catalog-populated');
const detail = sample('ratings-detail-populated');
const thread = sample('ratings-thread-populated');
const create = sample('ratings-create-ready');
const scoped = sample('ratings-scoped-detail');
const scopeCatalog = sample('ratings-scoped-catalog');
const recovery = {
  frozen: true,
  loaded: false,
  ready: false,
  receiptStatus: '原请求的结果尚未确认',
  status: '请先核验原请求',
  busy: false,
};
export default [
  ...ratings
    .filter((item) => pages.includes(item.page))
    .map((item) =>
      fixture(
        item.id.replace('ratings-', ''),
        item.page,
        item.title,
        item.patch,
        item.expectedText.filter(
          (text) => !['校园评分', '添加评分对象'].includes(text),
        ),
      ),
    ),
  fixture(
    'catalog-scope',
    'rating-catalog',
    '浏览范围',
    {
      ...catalog,
      uiPanel: 'scope',
      regionsLoaded: true,
      regions: [
        { id: 'fictional-region', label: '示例地区', relation: 'home' },
      ],
    },
    ['查看可访问地区', '示例地区', '身份地区'],
  ),
  fixture(
    'catalog-empty',
    'rating-catalog',
    '空目录',
    { ...catalog, categories: [] },
    ['当前范围暂无分类', '全局目录'],
  ),
  fixture(
    'catalog-more',
    'rating-catalog',
    '分类操作',
    { ...catalog, uiPanel: `category:${catalog.categories[0].id}` },
    ['随机选一个', '添加评分对象'],
  ),
  fixture(
    'catalog-subscription-unavailable',
    'rating-catalog',
    '订阅状态未知',
    { ...sample('ratings-targets-populated'), subscriptions: {} },
    ['订阅状态暂不可用', '码住暂不可用'],
  ),
  fixture(
    'detail-summary-unavailable',
    'rating-detail',
    '评分状态未知',
    {
      ...detail,
      summary: { status: 'unavailable' },
      myScoreKnown: false,
      uiPanel: 'score',
    },
    ['评分数据暂不可用', '暂未确认你的评分'],
  ),
  fixture(
    'detail-score-confirm',
    'rating-detail',
    '独立评分确认',
    { ...detail, selectedScore: 5 },
    ['提交 5 分？', '只修改评分，不发布文字', '确认评分'],
  ),
  fixture(
    'detail-delete-confirm',
    'rating-detail',
    '删除评价确认',
    { ...detail, deleteId: detail.comments[0].id },
    ['删除我的评价？', '评分仍保留', '确认删除'],
  ),
  fixture(
    'detail-author-required',
    'rating-detail',
    '不预选发布身份',
    { ...detail, composerOpen: true, authorMode: '', text: '', textLength: 0 },
    ['请选择发布身份', '公开', '分身', '发布评价'],
  ),
  fixture(
    'detail-sort',
    'rating-detail',
    '评价排序',
    { ...detail, uiPanel: 'sort' },
    ['最新', '最早', '赞最多', '赞最少'],
  ),
  fixture(
    'thread-compose',
    'rating-thread',
    '分身回复',
    {
      ...thread,
      composerOpen: true,
      authorMode: 'anonymous',
      replyToName: '示例同学',
      text: '示例回复草稿',
      textLength: 6,
    },
    ['回复 示例同学', '分身', '发布回复', '关闭并清空'],
  ),
  fixture(
    'thread-collapsed',
    'rating-thread',
    '收起后不显示私有回复',
    {
      ...thread,
      loaded: false,
      collapsed: true,
      discussion: null,
      replies: [],
      detail: null,
    },
    ['展开回复', '重新加载'],
  ),
  fixture(
    'thread-quote-unavailable',
    'rating-thread',
    '引用不可见',
    {
      ...thread,
      replies: [
        {
          ...thread.replies[0],
          replyTo: { kind: 'reply', status: 'unavailable' },
        },
      ],
    },
    ['原回复当前不可查看', '蓝鲸分身'],
  ),
  fixture(
    'thread-delete-confirm',
    'rating-thread',
    '删除单条回复',
    { ...thread, deleteId: thread.replies[0].id },
    ['删除我的回复？', '后续回复和独立评分保留', '确认删除回复'],
  ),
  fixture(
    'create-cancel-confirm',
    'rating-create',
    '撤销未完成申请',
    {
      ...create,
      ...recovery,
      canCancelCreation: true,
      cancelCreationConfirmation: true,
    },
    ['停止这次创建？', '不会删除对象', '保留申请'],
  ),
  fixture(
    'scoped-campus-picker',
    'rating-scoped',
    '校园选择不改变权限',
    {
      ...scopeCatalog,
      uiPanel: 'scope',
      pickerOpen: true,
      campusQuery: '',
      campuses: [
        {
          id: 'fictional-campus',
          fullName: '示例学校 · 北校区',
          isActive: true,
        },
      ],
      campusPage: 2,
      hasMoreCampuses: true,
    },
    ['浏览选择不会改变发布权限', '示例学校 · 北校区', '关闭选择'],
  ),
  fixture(
    'scoped-thread',
    'rating-scoped',
    '校园回复',
    {
      ...scoped,
      mode: 'thread',
      discussion: thread.discussion,
      replies: thread.replies,
      likes: thread.likes,
    },
    ['回复这条评价', '周末也开门吗？'],
  ),
  fixture(
    'scoped-subscriptions',
    'rating-scoped',
    '订阅对象',
    { ...scopeCatalog, mode: 'subscriptions', detail: null },
    ['已码住', '订阅更新', '湖畔自习室'],
  ),
  fixture(
    'scoped-updates-count-unavailable',
    'rating-scoped',
    '未读数未知',
    {
      ...scopeCatalog,
      mode: 'updates',
      detail: null,
      unreadCount: null,
      notices: [],
    },
    ['未读数暂不可用', '回复更新', '订阅更新'],
  ),
  fixture(
    'scoped-random',
    'rating-scoped',
    '限定范围随机',
    {
      ...scopeCatalog,
      mode: 'random',
      detail: null,
      randomResult: { candidateCount: 7, item: { target: detail.detail } },
    },
    ['候选对象：7', '湖畔自习室', '查看评分'],
  ),
  fixture(
    'scoped-definition-confirm',
    'rating-scoped',
    '对象提交确认',
    {
      ...scopeCatalog,
      mode: 'create',
      detail: null,
      name: '示例自习空间',
      description: '示例描述',
      definitionConfirmation: true,
    },
    ['创建评分对象', '本次提交绑定当前校园、分类和来源版本', '确认提交'],
  ),
  fixture(
    'scoped-edit',
    'rating-scoped',
    '对象编辑草稿',
    {
      ...scopeCatalog,
      mode: 'edit',
      detail: null,
      name: '示例自习空间',
      description: '',
      definitionConfirmation: false,
    },
    ['编辑评分对象', '核对并确认内容', '关闭并清空草稿'],
  ),
  fixture(
    'scoped-score-confirm',
    'rating-scoped',
    '校园评分确认',
    { ...scoped, selectedScore: 4 },
    ['确认评分 4 分？', '确认评分', '关闭并清空'],
  ),
  fixture(
    'scoped-author-required',
    'rating-scoped',
    '校园身份明确选择',
    {
      ...scoped,
      composerOpen: true,
      authorModes: ['named', 'anonymous'],
      authorMode: '',
      text: '',
    },
    ['请明确选择发布身份', '公开', '分身', '确认发布'],
  ),
  fixture(
    'scoped-cancel-confirm',
    'rating-scoped',
    '请求取消仍需服务端回执',
    {
      ...scopeCatalog,
      ...recovery,
      canCancelPending: true,
      cancelPendingConfirmation: true,
    },
    ['服务端确认取消或返回原回执后才会释放请求编号', '确认取消'],
  ),
  ...pages.flatMap((page) => [
    fixture(
      `${page}-guest`,
      page,
      '访客',
      {
        hasSession: false,
        loaded: false,
        ready: false,
        status: '请先登录后继续',
      },
      ['登录后继续', '请先登录后继续'],
    ),
    fixture(
      `${page}-busy`,
      page,
      '处理中允许停止等待',
      {
        hasSession: true,
        loaded: false,
        ready: false,
        busy: true,
        status: '正在核验示例请求',
      },
      ['正在核验示例请求', '停止等待'],
    ),
    fixture(
      `${page}-recovery`,
      page,
      '结果未知不重复提交',
      { hasSession: true, ...recovery },
      ['查询原回执', '重试原请求', '不要重复提交'],
    ),
    fixture(
      `${page}-error`,
      page,
      '可恢复读取错误',
      {
        hasSession: true,
        loaded: false,
        ready: false,
        error: '示例读取失败，请稍后再试',
      },
      ['示例读取失败', '重新加载'],
    ),
  ]),
];
