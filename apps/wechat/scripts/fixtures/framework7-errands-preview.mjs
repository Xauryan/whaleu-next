// Fictional source-only fixtures. No real participants, contacts or image URLs.
// Actual component templates/slots are rendered; this is not device acceptance.
import originals from './errands-preview.mjs';
const sample = (id) =>
  structuredClone(originals.find((item) => item.id === id).patch);
const make = (id, page, title, patch, expectedText) => ({
  id: `framework7-errands-${id}`,
  page,
  title: `Framework7 iOS 原生跑腿 · ${title}`,
  patch,
  expectedText,
});
const market = sample('errand-market-sample'),
  mine = sample('errand-mine-sample');
const publicDetail = sample('errand-detail-sample'),
  participant = sample('errand-participant-sample');
const compose = sample('errand-compose-options-sample'),
  notices = sample('errand-notices-sample');
const recovery = sample('errand-recovery-sample');
const panels = {
  campus: false,
  sort: false,
  private: false,
  images: false,
  details: false,
};
const capabilities = {
  accept: false,
  cancel: false,
  complete: false,
  delete: false,
};
const frozenImages = {
  status: 'recovering',
  busy: false,
  frozen: true,
  hasDraft: true,
  confirmedOrderId: '',
  message: '合成原图片发布结果待确认',
  images: [],
};
export default [
  ...originals.map((f) =>
    make(f.id, f.page, f.title, structuredClone(f.patch), f.expectedText),
  ),
  make(
    'market-busy',
    'errand-list',
    '读取可停止',
    {
      ...market,
      busy: true,
      loaded: false,
      items: [],
      status: '正在读取合成订单',
    },
    ['正在读取合成订单', '停止等待'],
  ),
  make(
    'market-own-only',
    'errand-list',
    '跨地区只看自己的近期订单',
    { ...market, discoveryMode: 'own_only', canMore: true },
    ['仅显示自己最近三天', '加载更多'],
  ),
  make(
    'market-sort',
    'errand-list',
    '排序与精确报酬',
    {
      ...market,
      sort: 'reward',
      direction: 'asc',
      uiPanels: { ...panels, sort: true },
      items: [{ ...market.items[0], reward: '12.34567890123456789' }],
    },
    ['报酬从低到高', '12.34567890123456789'],
  ),
  make(
    'market-campus',
    'errand-list',
    '目标校园独立选择',
    {
      ...market,
      uiPanels: { ...panels, campus: true },
      campuses: [
        {
          id: 'synthetic-active-campus',
          fullName: '合成可用校区',
          isActive: true,
        },
        {
          id: 'synthetic-inactive-campus',
          fullName: '合成停用校区',
          isActive: false,
        },
      ],
    },
    ['合成可用校区', '合成停用校区（不可用）', '不会更改你的身份校区'],
  ),
  make(
    'mine-accepted',
    'errand-mine',
    '我的接单与分页',
    { ...mine, relation: 'accepted', canMore: true },
    ['我接取的', '全部地区与状态', '加载更多'],
  ),
  make(
    'mine-empty',
    'errand-mine',
    '我的空订单',
    { ...mine, relation: 'accepted', items: [] },
    ['还没有接取过跑腿', '你的订单会保存在这里'],
  ),
  make(
    'detail-public-media',
    'errand-detail',
    '公开图片独立权限',
    {
      ...publicDetail,
      detail: {
        ...publicDetail.detail,
        publicMedia: [{ bindingId: 'synthetic-public', slot: 'public0' }],
      },
    },
    ['公开图片', '图片 1', '双方线下结算'],
  ),
  make(
    'detail-private-media',
    'errand-detail',
    '双方私密图片',
    {
      ...participant,
      detail: {
        ...participant.detail,
        privateMedia: [{ bindingId: 'synthetic-private', slot: 'private0' }],
      },
    },
    ['双方私密图片', '私密图片 1', '订单结束后仍保留'],
  ),
  make(
    'detail-unrelated-canary',
    'errand-detail',
    '无关系不得显示注入的私密信息',
    {
      ...participant,
      detail: {
        ...participant.detail,
        relation: 'none',
        capabilities,
        privateText: 'PRIVATE_CANARY',
        privateMedia: [{ bindingId: 'synthetic-private', slot: 'private0' }],
        oppositeContact: {
          display: { status: 'available', displayName: 'CONTACT_CANARY' },
          contacts: { wechat: 'SECRET_CANARY', phone: '00000000000' },
        },
      },
    },
    ['双方线下结算', '任务说明'],
  ),
  ...['completed', 'cancelled'].map((state) =>
    make(
      `detail-${state}`,
      'errand-detail',
      '结束后隐藏联系方式',
      {
        ...participant,
        detail: {
          ...participant.detail,
          state,
          capabilities: { ...capabilities, delete: true },
        },
      },
      ['联系方式仅在订单进行中显示', '删除订单', '取件后请放在一层门厅'],
    ),
  ),
  make(
    'detail-contact-unavailable',
    'errand-detail',
    '显示名称不可用',
    {
      ...participant,
      detail: {
        ...participant.detail,
        oppositeContact: {
          ...participant.detail.oppositeContact,
          display: { status: 'unavailable' },
        },
      },
    },
    ['对方展示名称暂不可用', '未经认证'],
  ),
  make(
    'detail-accept',
    'errand-detail',
    '接单联系方式与取消',
    {
      ...publicDetail,
      acceptModal: true,
      historyStatus: '合成上次信息暂不可用',
      contacts: { wechat: '', phone: '' },
    },
    ['至少填写一种联系方式', '暂不接单并清空', '合成上次信息暂不可用'],
  ),
  ...['cancel', 'complete', 'delete'].map((confirmAction) =>
    make(
      `detail-confirm-${confirmAction}`,
      'errand-detail',
      '原生确认表单不绕过不可逆操作',
      { ...participant, confirmAction },
      [
        confirmAction === 'cancel'
          ? '取消这个订单？'
          : confirmAction === 'complete'
            ? '订单已完成？'
            : '删除这个订单？',
        confirmAction === 'cancel'
          ? '请先与对方协商'
          : confirmAction === 'complete'
            ? '不产生线上付款'
            : '历史状态和审计记录仍保留',
        '返回',
      ],
    ),
  ),
  make(
    'detail-order-info',
    'errand-detail',
    '原始地区范围与日期',
    {
      ...participant,
      uiPanels: { ...panels, details: true },
      detailTimes: {
        createdAt: '2026年10月20日 17:30',
        acceptedAt: '2026年10月20日 17:40',
        completedAt: '',
        cancelledAt: '',
      },
    },
    ['发布地区：', '2026年10月20日 17:30', '接单于'],
  ),
  make(
    'detail-target-group',
    'errand-detail',
    '群提示与受控预览',
    {
      ...participant,
      targetServices: {
        visible: true,
        regionName: '合成目标学校',
        name: '合成互助群',
        description: '合成群说明',
        message: '只展示当前目标地区配置',
        canPreview: true,
        busy: false,
        error: '',
      },
      targetQr: {
        status: 'unavailable',
        src: '',
        message: '合成二维码暂不可用',
      },
    },
    ['查看群二维码', '不再显示跑腿群提示', '合成二维码暂不可用'],
  ),
  make(
    'detail-media-unavailable',
    'errand-detail',
    '受控图片失败可关闭',
    {
      ...participant,
      orderImage: {
        status: 'unavailable',
        src: '',
        message: '合成图片权限已失效',
      },
    },
    ['合成图片权限已失效', '关闭图片'],
  ),
  make(
    'detail-recovery-busy',
    'errand-detail',
    '查询原回执中',
    {
      ...recovery,
      busy: true,
      error: '合成连接中断',
      receiptStatus: '原编号继续保留',
    },
    ['查询原回执', '重试完全相同的请求', '停止等待', '合成连接中断'],
  ),
  make(
    'compose-image-recovery',
    'errand-compose',
    '图片发布结果待确认',
    { ...compose, imagePublication: frozenImages },
    ['发布结果待确认，图片暂不能更改', '继续原发布', '撤回原图片草稿'],
  ),
  make(
    'compose-image-busy',
    'errand-compose',
    '原图片恢复中',
    { ...compose, imagePublication: { ...frozenImages, busy: true } },
    ['恢复图片草稿或发布结果', '合成原图片发布结果待确认'],
  ),
  make(
    'compose-error',
    'errand-compose',
    '字段校验失败',
    {
      ...compose,
      error: '合成报酬格式无效，请保留原输入',
      form: { ...compose.form, reward: '12.34567890123456789' },
    },
    ['合成报酬格式无效', '微信和电话均需填写', '这里不产生线上付款'],
  ),
  make(
    'compose-frozen',
    'errand-compose',
    '文字发布不换编号',
    { ...compose, loaded: false, frozen: true, recoveryOperation: '发布' },
    ['发布结果待确认', '查询原回执', '重试完全相同的请求'],
  ),
  make(
    'notices-empty',
    'errand-notices',
    '无通知',
    { ...notices, items: [], unreadCount: 0 },
    ['全部已读', '暂无跑腿通知'],
  ),
  make(
    'notices-busy-error',
    'errand-notices',
    '读取失败可停止',
    {
      ...notices,
      loaded: false,
      busy: true,
      items: [],
      status: '合成通知读取中',
      error: '合成通知连接中断',
    },
    ['停止等待', '合成通知读取中', '合成通知连接中断'],
  ),
  make(
    'notices-more',
    'errand-notices',
    '有后续通知',
    { ...notices, canMore: true },
    ['加载更多', '1 条未读'],
  ),
  make(
    'notices-administrative',
    'errand-notices',
    '历史限制记录不能误作当前状态',
    {
      ...notices,
      items: [
        {
          noticeId: 'synthetic-deleted',
          kind: 'admin_deleted',
          orderId: 'synthetic-order',
          deletionReason: { status: 'provided', value: '合成删除原因' },
          readAt: null,
        },
        {
          noticeId: 'synthetic-restricted',
          kind: 'feature_restricted',
          restrictionId: 'synthetic-restriction',
          action: 'all',
          reason: '合成限制原因',
          endsAt: null,
          readAt: null,
        },
        {
          noticeId: 'synthetic-released',
          kind: 'feature_released',
          restrictionId: 'synthetic-restriction',
          action: 'accept',
          reason: '合成解除原因',
          readAt: null,
        },
      ],
    },
    ['合成删除原因', '不代表当前状态', '其他限制仍可能生效', '期限：永久'],
  ),
];
