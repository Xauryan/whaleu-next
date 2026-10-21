// Fictional, repository-owned visual-QA examples only. No runtime data, real orders or contacts.
const id = (number) =>
  `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const stamp = '2026-10-20T09:30:00.000Z';
const order = (number, title, patch = {}) => ({
  id: id(number),
  revision: id(10 + number),
  title,
  publicText:
    '从示例驿站取一件小包裹，送到示例宿舍楼下。到达后联系我即可，谢谢！',
  expectedTimeText: '今天 18:00 前',
  reward: '8',
  state: 'pending',
  createdAt: stamp,
  acceptedAt: null,
  completedAt: null,
  cancelledAt: null,
  targetRegion: { id: id(90), label: '示例北校区' },
  sourceRegion: { id: id(91), label: '示例北校区' },
  scope: 'home',
  ...patch,
});
const orders = [
  order(1, '帮取一件快递，送到宿舍楼下'),
  order(2, '从图书馆带两本书回来', {
    reward: '6.5',
    expectedTimeText: '今晚 20:00 前',
    publicText: '书已经放在服务台，送到示例宿舍区即可。',
    state: 'accepted',
    acceptedAt: stamp,
  }),
  order(3, '打印资料后送到教学楼', {
    reward: '12',
    expectedTimeText: '明天上午 9:00 前',
    publicText: '需要双面黑白打印，具体文件和教室号接单后联系。',
  }),
];
const base = {
  configured: true,
  hasSession: true,
  loaded: true,
  busy: false,
  error: '',
  regionId: id(90),
  regionLabel: '示例北校区',
  status: '已到当前范围末尾',
};
const capabilities = {
  accept: false,
  cancel: false,
  complete: false,
  delete: false,
};
const pending = {
  ...orders[0],
  relation: 'none',
  capabilities: { ...capabilities, accept: true },
};
const accepted = {
  ...orders[0],
  state: 'accepted',
  acceptedAt: stamp,
  relation: 'publisher',
  privateText: '取件后请放在一层门厅，到达时发微信联系我。',
  oppositeContact: {
    display: { status: 'available', displayName: '示例接单同学' },
    contacts: { wechat: 'synthetic-contact', phone: '00000000000' },
  },
  capabilities: { ...capabilities, cancel: true, complete: true, delete: true },
};
const form = {
  title: '帮取一件快递，送到宿舍楼下',
  publicText: orders[0].publicText,
  privateText: '',
  expectedTimeText: '今天 18:00 前',
  reward: '8',
  wechat: '',
  phone: '',
};
export default [
  {
    id: 'errand-market-sample',
    page: 'errand-list',
    title: '跑腿广场',
    patch: { ...base, discoveryMode: 'home', items: orders },
    expectedText: ['示例北校区', '帮取一件快递', '从图书馆带两本书', '6.5'],
  },
  {
    id: 'errand-mine-sample',
    page: 'errand-mine',
    title: '我的跑腿',
    patch: {
      ...base,
      items: [
        accepted,
        order(4, '帮忙取回雨伞', {
          state: 'completed',
          acceptedAt: stamp,
          completedAt: stamp,
        }),
      ],
    },
    expectedText: ['帮取一件快递', '帮忙取回雨伞', '已完成'],
  },
  {
    id: 'errand-detail-sample',
    page: 'errand-detail',
    title: '待接单详情',
    patch: { ...base, detail: pending },
    expectedText: [
      '帮取一件快递',
      '示例北校区',
      '接取此订单',
      '从示例驿站取一件小包裹',
    ],
  },
  {
    id: 'errand-participant-sample',
    page: 'errand-detail',
    title: '订单进行中',
    patch: { ...base, detail: accepted },
    expectedText: ['取件后请放在一层门厅', '示例接单同学', '确认完成'],
  },
  {
    id: 'errand-compose-sample',
    page: 'errand-compose',
    title: '发布跑腿',
    patch: {
      ...base,
      form,
      formCounts: {
        title: Array.from(form.title).length,
        publicText: Array.from(form.publicText).length,
      },
    },
    expectedText: ['示例北校区', '联系方式', '这里不产生线上付款'],
  },
  {
    id: 'errand-compose-options-sample',
    page: 'errand-compose',
    title: '可选说明与图片',
    patch: {
      ...base,
      form,
      formCounts: {
        title: Array.from(form.title).length,
        publicText: Array.from(form.publicText).length,
      },
      uiPanels: {
        campus: false,
        sort: false,
        private: true,
        images: true,
        details: false,
      },
    },
    expectedText: ['示例北校区', '公开图片1', '私密图片3', '仅你与接单者可见'],
  },
  {
    id: 'errand-notices-sample',
    page: 'errand-notices',
    title: '跑腿通知',
    patch: {
      ...base,
      unreadCount: 1,
      status: '已到跑腿通知末尾',
      timeLabels: {
        [id(30)]: { createdAt: '2026年10月20日 17:30' },
        [id(31)]: { createdAt: '2026年10月20日 17:30' },
      },
      items: [
        {
          noticeId: id(30),
          kind: 'accepted',
          orderId: id(1),
          createdAt: stamp,
          readAt: null,
        },
        {
          noticeId: id(31),
          kind: 'completed',
          orderId: id(2),
          createdAt: stamp,
          readAt: stamp,
        },
      ],
    },
    expectedText: [
      '1 条未读',
      '你发布的跑腿已有人接单',
      '你接取的跑腿已由发布者确认完成',
    ],
  },
  {
    id: 'errand-recovery-sample',
    page: 'errand-detail',
    title: '结果待确认',
    patch: {
      ...base,
      loaded: false,
      frozen: true,
      status: '原操作结果待确认，仅可查询或重试原请求',
      recoveryOperation: '接单',
    },
    expectedText: ['接单结果待确认', '查询原回执', '重试完全相同的请求'],
  },
  {
    id: 'errand-empty-sample',
    page: 'errand-list',
    title: '暂无订单',
    patch: { ...base, items: [], discoveryMode: 'home' },
    expectedText: ['示例北校区', '还没有相关跑腿', '发布跑腿'],
  },
];
