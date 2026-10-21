/** Synthetic source-layout QA only. No real identity, school authority, services or requests. */
const id = '11111111-1111-4111-8111-111111111111';
const region = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-20T10:00:00.000Z';
const ready = {
  hasSession: true,
  configured: true,
  loaded: true,
  busy: false,
  error: '',
  status: '',
  addressError: '',
  receiptStatus: '',
  frozen: false,
  confirming: null,
  uiPanel: '',
};
const campus = {
  id: region,
  institutionId: 'SYNTHETIC',
  institutionName: '示例大学',
  fullName: '示例大学 · 东校区',
  isActive: true,
};
const target = { profileId: id, displayName: '示例同学' };
const school = { code: 'SYNTHETIC', name: '示例大学' };
const admin = {
  target,
  currentAssignment: { id: region, name: '示例东校区', status: 'active' },
  eligibility: {
    status: 'known',
    regions: [{ id: region, name: '示例东校区' }],
    defaultRegionId: region,
  },
  actions: { appoint: false, reassign: true, revoke: true },
};
const identity = {
  target,
  current: {
    school,
    schoolUid: { status: 'assigned', formattedUid: '000123' },
  },
  destination: {
    school: { code: 'SYNTHETIC2', name: '示例理工大学' },
    campusName: '示例南校区',
  },
  actions: { correctSchool: true, completeUid: false },
};
const adminReady = {
  ...ready,
  canManage: true,
  capabilityKnown: true,
  management: admin,
  targetProfileId: id,
  selectedRegionId: region,
  selectedRegionName: '示例东校区',
};
const identityReady = {
  ...ready,
  canManage: true,
  capabilityKnown: true,
  management: identity,
  targetProfileId: id,
  campuses: [campus],
  campusQuery: '示例',
  campusPage: 1,
  campusTotal: 1,
};
const pending = {
  ...ready,
  loaded: false,
  frozen: true,
  pendingRequestId: request,
  pendingTargetProfileId: id,
  pendingPhase: 'submit',
  management: null,
};
const configReady = {
  ...ready,
  management: 'fixed',
  regionId: region,
  regionName: '示例东校区',
  pending: false,
  revision: 7,
  entries: [
    { entryKey: 'school_group', label: '学校交流群', state: 'configured' },
    { entryKey: 'admin_contact', label: '管理员联系', state: 'disabled' },
  ],
  selectedLabel: '学校交流群',
  form: {
    kind: 'group',
    enabled: true,
    name: '示例校园交流群',
    description: '一起交流校园生活。',
    joinUrl: '',
    qqGroupNumber: '',
    maxGroupNumber: '12',
  },
  qrStatus: '保留当前二维码',
  qrUpload: { status: 'idle', message: '', progress: 0 },
  qrRead: { status: 'idle', message: '', src: '' },
  campuses: [],
};
const policyReady = {
  ...ready,
  management: 'fixed',
  regionId: region,
  regionName: '示例东校区',
  pending: false,
  storageBlocked: false,
  sourceLabel: '当前生效',
  sourceState: 'active',
  revision: 4,
  currentPolicySummary: '主题：生活、问答 · 回复：允许',
  effectiveAt: at,
  expiryLabel: '2027-01-01 00:00 UTC',
  editable: true,
  blocker: '',
  form: {
    relatedSyncEnabled: false,
    unverifiedPostEnabled: true,
    unverifiedCommentEnabled: true,
    expiryKind: 'at',
    validUntil: '2027-01-01T00:00:00Z',
  },
  categories: [
    { key: 'life', label: '校园生活', checked: true },
    { key: 'questions', label: '提问求助', checked: true },
    { key: 'scenery', label: '校园风景', checked: false },
  ],
  campuses: [],
};
const officialReady = {
  ...ready,
  programInput: id,
  pending: false,
  message: '',
  author: '示例校园编辑',
  config: {
    accountLabel: '示例校园号',
    readiness: 'synthetic_ready',
    coverAppearanceId: null,
    titleAppearanceId: null,
  },
  capabilities: { canManage: true, canPreview: true, canTest: true },
  preview: null,
  status: null,
};
const announceReady = {
  ...ready,
  management: 'fixed',
  regionName: '示例东校区',
  id,
  state: 'draft',
  pending: false,
  pendingImages: [],
  revision: 3,
  dirty: false,
  form: {
    versionLabel: '秋季校园活动',
    bodyText: '一起参加周末校园活动。\n活动详情请留意学校通知。',
    announcementDate: '2026-10-20',
    popupEnabled: true,
    highlight: false,
  },
  audienceKind: 'all',
  selectedRegions: [],
  regions: [],
  search: '',
  moreRegions: false,
  slots: [
    { slot: 0, configured: true, changed: false },
    { slot: 1, configured: false, changed: false },
  ],
  upload: { status: 'idle', message: '', progress: 0 },
  image: { status: 'idle', message: '', src: '' },
};
const command = {
  ...ready,
  loaded: false,
  frozen: false,
  modal: null,
  reason: '',
  durationIndex: -1,
  publisherRestriction: false,
  targetProfileId: '',
  action: 'all',
  recoveryOperation: '',
  recoveryTarget: '',
};
const statusLabels = {
  all: '全部',
  open: '待接单',
  accepted: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  deleted: '已删除',
};
const actionLabels = {
  publish: '发布跑腿',
  accept: '接取跑腿',
  all: '发布及接取跑腿',
};
const actionOptions = Object.entries(actionLabels).map(([value, label]) => ({
  value,
  label,
}));
const order = {
  id,
  title: '示例订单 · 图书馆取书',
  displayState: 'accepted',
  state: 'accepted',
  reward: '8.00',
  publicText: '请从东校区图书馆取书，送到教学楼门口。',
  expectedTimeText: '今天 18:00 前',
  publisher: { status: 'available', displayName: '示例发布者', profileId: id },
  accepter: {
    status: 'available',
    displayName: '示例接单者',
    profileId: request,
  },
  relation: 'none',
  sourceRegion: {
    id: region,
    status: 'available',
    active: true,
    label: '示例东校区',
  },
  targetRegion: {
    id: region,
    status: 'available',
    active: true,
    label: '示例东校区',
  },
  createdAt: at,
  acceptedAt: at,
  completedAt: null,
  cancelledAt: null,
  deletedAt: null,
  deletionReason: null,
};
const errandReady = {
  ...ready,
  access: 'fixed',
  regionId: region,
  regionLabel: '示例东校区',
  regionInput: region,
  keywordDraft: '',
  keyword: '',
  filter: 'all',
  statusLabels,
  statusOptions: Object.entries(statusLabels).map(([value, label]) => ({
    value,
    label,
  })),
  items: [order],
  total: { status: 'known', value: 1 },
  legacyNumericUnavailable: false,
  numericSearch: false,
  continuation: 'end',
  pageNumber: 1,
  canPrevious: false,
  canNext: false,
  adminCommand: command,
  actionLabels,
  actionOptions,
  durationLabels: ['1小时', '6小时', '永久限制'],
};
const restriction = {
  restrictionId: id,
  subject: { status: 'available', displayName: '示例同学', profileId: request },
  action: 'accept',
  state: 'active',
  origin: 'local',
  reason: '示例处理：未按约定完成订单',
  startsAt: at,
  endsAt: '2026-10-21T10:00:00.000Z',
  recordedAt: at,
  terminal: null,
  operator: { status: 'available', displayName: '示例管理员' },
  source: { kind: 'global' },
};
const restrictionReady = {
  ...ready,
  access: 'global',
  mode: 'list',
  items: [restriction],
  restriction: null,
  events: [],
  recordedTotal: { status: 'known', value: 1 },
  historyCoverage: 'unknown_before_boundary',
  profileDraft: '',
  actionFilter: '',
  stateFilter: 'all',
  actionLabels,
  actionOptions,
  stateLabels: {
    active: '生效中',
    expired: '已到期',
    released: '已解除',
    superseded: '已替代',
  },
  stateOptions: [
    { value: 'all', label: '全部' },
    { value: 'active', label: '生效中' },
    { value: 'expired', label: '已到期' },
  ],
  eventLabels: { issued: '签发限制', manually_released: '手动解除' },
  durationLabels: ['1小时', '6小时', '永久限制'],
  continuation: 'end',
  pageNumber: 1,
  canPrevious: false,
  canNext: false,
  adminCommand: command,
};
const fixtures = [];
const add = (id, page, title, patch, expectedText) =>
  fixtures.push({
    id,
    page,
    title: `${title} · 虚构界面`,
    patch,
    expectedText,
  });
add(
  'school-admin-ready',
  'school-admin-management',
  '管理地区选择',
  adminReady,
  ['示例同学', '示例东校区', '改派或确认管理地区', '撤销学校管理权限'],
);
add(
  'school-admin-expired',
  'school-admin-management',
  '原分配过期',
  {
    ...adminReady,
    management: {
      ...admin,
      currentAssignment: { ...admin.currentAssignment, status: 'expired' },
    },
  },
  ['原分配已经过期', '改派会明确取代这条分配'],
);
add(
  'school-admin-protected',
  'school-admin-management',
  '受保护目标',
  {
    ...adminReady,
    management: {
      ...admin,
      eligibility: { status: 'protected', regions: [] },
      actions: { appoint: false, reassign: false, revoke: false },
    },
  },
  ['受保护的全局管理身份', '不能从此页面降级'],
);
add(
  'school-admin-confirm',
  'school-admin-management',
  '改派确认',
  { ...adminReady, confirming: 'reassign' },
  [
    '确认改派',
    '新地区：示例东校区',
    '不会自动佩戴',
    '不发送通知',
    '确认此操作',
  ],
);
add(
  'school-admin-recovery',
  'school-admin-management',
  '原请求恢复',
  { ...pending, pendingAction: 'revoke' },
  [
    '原学校管理员管理请求待确认',
    '失去当前管理权限后仍可',
    '查询原请求回执',
    '取消原请求',
  ],
);
add(
  'school-admin-cancel',
  'school-admin-management',
  '取消原请求',
  { ...pending, pendingAction: 'revoke', confirming: 'cancel' },
  ['不会回滚任命、改派或撤权', '确认取消原请求'],
);
add(
  'school-identity-ready',
  'school-identity-management',
  '学校归属更正',
  identityReady,
  [
    '当前认证学校：示例大学',
    '当前校内 UID：000123',
    '示例理工大学',
    '预览并确认学校更正',
  ],
);
add(
  'school-identity-confirm',
  'school-identity-management',
  '学校更正确认',
  { ...identityReady, confirming: 'correct_school' },
  [
    '号码永久保留在历史中',
    '目标学校分配新 UID',
    '现有认证有效期不会延长',
    '确认提交此操作',
  ],
);
add(
  'school-identity-uid',
  'school-identity-management',
  '补发 UID 确认',
  {
    ...identityReady,
    confirming: 'complete_uid',
    management: {
      ...identity,
      actions: { correctSchool: false, completeUid: true },
      current: { school, schoolUid: { status: 'unassigned' } },
      destination: null,
    },
  },
  ['校内 UID 尚未分配', '已有有效号码不会重复分配', '补发当前学校的 UID'],
);
add(
  'school-identity-recovery',
  'school-identity-management',
  '学校原请求恢复',
  { ...pending, pendingAction: 'correct_school' },
  [
    '原学校更正请求待确认',
    '停止等待、返回或关闭页面都不会取消',
    '查询并重试原请求',
  ],
);
add(
  'school-identity-cancel',
  'school-identity-management',
  '取消学校更正',
  { ...pending, pendingAction: 'correct_school', confirming: 'cancel' },
  ['不回滚更正或 UID', '确认取消原请求'],
);
add(
  'school-services-ready',
  'school-configuration',
  '学校服务配置',
  configReady,
  [
    '示例东校区',
    '学校交流群 · 已配置',
    '管理员联系 · 已停用',
    '保存并发布这一项',
  ],
);
add(
  'school-services-qr',
  'school-configuration',
  '二维码管理',
  { ...configReady, uiPanel: 'qr' },
  ['保留当前二维码', '选择并上传新二维码', '恢复原二维码上传', '清除二维码'],
);
add(
  'school-services-recovery',
  'school-configuration',
  '学校配置恢复',
  {
    ...configReady,
    management: 'none',
    loaded: false,
    form: null,
    entries: [],
    pending: true,
  },
  ['恢复原保存请求', '关闭页面不会自动取消服务端保存', '查询并重试原请求'],
);
add('school-policy-ready', 'school-posting-policy', '发布策略', policyReady, [
  '当前生效',
  '主题：生活、问答',
  '允许未认证用户回复',
  '保存并发布此学校策略',
]);
add(
  'school-policy-expired',
  'school-posting-policy',
  '发布策略已过期',
  {
    ...policyReady,
    sourceLabel: '已过期',
    sourceState: 'expired',
    editable: false,
    blocker: '示例：当前策略已过期，请重新核验后更新。',
    expiryLabel: '已过期',
  },
  ['来源状态：已过期', '当前策略已过期', '当前有效期：已过期'],
);
add(
  'school-policy-source',
  'school-posting-policy',
  '策略版本详情',
  { ...policyReady, uiPanel: 'source' },
  ['版本 4', '生效时间（UTC）', at],
);
add(
  'school-policy-recovery',
  'school-posting-policy',
  '策略保存恢复',
  {
    ...policyReady,
    management: 'none',
    loaded: false,
    form: null,
    pending: true,
    pendingRequestId: request,
    pendingRegionId: region,
    pendingSummary: '示例原策略 · 仅允许问答主题',
  },
  ['示例原策略', request, '原始内容、版本和请求标识', '查询并同键重试原请求'],
);
add(
  'school-uid-selected',
  'school-uid-lookup',
  '校内 UID 查询',
  {
    ...ready,
    canLookup: true,
    campuses: [campus],
    campusPage: 1,
    campusTotal: 1,
    schoolCode: 'SYNTHETIC',
    schoolName: '示例大学',
    uid: '000123',
    campusQuery: '示例',
    result: null,
  },
  [
    '1 · 选择准确学校',
    '已选学校：示例大学',
    '2 · 输入当前 UID',
    '查询此学校与 UID',
  ],
);
add(
  'school-uid-found',
  'school-uid-lookup',
  '已核验公开主页',
  {
    ...ready,
    canLookup: true,
    campuses: [],
    campusPage: 1,
    campusTotal: 0,
    schoolCode: 'SYNTHETIC',
    schoolName: '示例大学',
    uid: '000123',
    result: { status: 'found', target },
  },
  ['示例同学', '打开当前公开主页'],
);
add(
  'school-uid-unavailable',
  'school-uid-lookup',
  '当前不可查询',
  {
    ...ready,
    canLookup: true,
    campuses: [],
    campusPage: 1,
    campusTotal: 0,
    schoolCode: 'SYNTHETIC',
    schoolName: '示例大学',
    uid: '000123',
    result: { status: 'unavailable' },
  },
  [
    '此学校与 UID 当前不可查询',
    '历史号码、不可查看的主页及未知状态均不会显示身份',
  ],
);
add(
  'school-official-ready',
  'official-account-operations',
  '公众号配置',
  officialReady,
  ['开发合成模式', '无真实公众号连接', '示例校园号', '单独保存配置'],
);
add(
  'school-official-disabled',
  'official-account-operations',
  '公众号能力不可用',
  {
    ...officialReady,
    capabilities: { canManage: false, canPreview: false, canTest: false },
    config: { ...officialReady.config, readiness: 'unavailable' },
    error: '示例：当前合成服务不可用',
  },
  ['不会自动发布', '当前合成服务不可用'],
);
add(
  'school-official-confirm',
  'official-account-operations',
  '合成草稿确认',
  {
    ...officialReady,
    preview: {
      kind: 'test',
      accountLabel: '示例校园号',
      selectionAt: at,
      eligibleCount: 1,
      article: {
        title: '示例校园 · 今日精选',
        items: [
          {
            locator: 'synthetic-post',
            excerpt: '示例内容：一起分享校园里的美好时刻。',
          },
        ],
      },
      expiresAt: '2026-10-20T10:10:00.000Z',
      actions: { createDraft: true },
    },
  },
  ['示例校园 · 今日精选', '预览有效期至', '确认创建合成测试草稿（未发布）'],
);
add(
  'school-official-recovery',
  'official-account-operations',
  '公众号原请求恢复',
  {
    ...officialReady,
    config: null,
    pending: true,
    requestId: request,
    status: {
      nextAction: 'resume_same_key',
      acceptedMaterialCount: 0,
      withdrawal: 'local_withdrawn_remote_unverified',
    },
  },
  [request, '查询并重试同一原请求', '以当前登录恢复原请求'],
);
add(
  'school-announcement-list',
  'announcement-manage',
  '公告记录',
  {
    ...ready,
    management: 'fixed',
    regionName: '示例东校区',
    pending: false,
    items: [
      {
        id,
        content: { title: '示例公告 · 周末校园活动', versionLabel: '秋季活动' },
        state: 'active',
      },
      {
        id: request,
        content: { title: '示例公告 · 服务时间调整', versionLabel: '十月更新' },
        state: 'draft',
      },
    ],
    more: false,
  },
  ['示例公告 · 周末校园活动', '已启用', '私有上传准备', '编辑 / 停用启用'],
);
add(
  'school-announcement-empty',
  'announcement-manage',
  '公告记录为空',
  {
    ...ready,
    management: 'fixed',
    regionName: '示例东校区',
    items: [],
    pending: false,
    more: false,
  },
  ['还没有公告', '新建公告'],
);
add(
  'school-announcement-edit',
  'announcement-edit',
  '编辑公告',
  announceReady,
  ['修改这条公告', '自动覆盖辖区全部实体校区', '正文（每行保留）', '发布公告'],
);
add(
  'school-announcement-images',
  'announcement-edit',
  '公告图片',
  { ...announceReady, uiPanel: 'images' },
  [
    '图片 1 · 已配置',
    '图片 2 · 无',
    '查看当前图片',
    '只有发布后才对相应浏览者可见',
  ],
);
add(
  'school-announcement-audience',
  'announcement-edit',
  '公告范围',
  {
    ...announceReady,
    management: 'global',
    audienceKind: 'regions',
    selectedRegions: [region],
    regions: [{ id: region, name: '示例东校区' }],
    uiPanel: 'audience',
  },
  ['所选地区全部校区', region, '全体浏览者', '示例东校区'],
);
add(
  'school-announcement-recovery',
  'announcement-edit',
  '公告原请求恢复',
  {
    ...announceReady,
    management: 'none',
    loaded: false,
    pending: true,
    pendingId: request,
    pendingImages: [{ announcementId: id, slot: 0, revision: 3 }],
  },
  ['未获当前发布权限', '查询原回执', '取消原图片上传', '查询原图片'],
);
add('school-errand-list', 'errand-admin', '订单管理列表', errandReady, [
  '示例订单 · 图书馆取书',
  '报酬 8.00 元',
  '期望时间：今天 18:00 前',
  '管理删除订单',
]);
add(
  'school-errand-details',
  'errand-admin',
  '订单历史详情',
  { ...errandReady, uiPanel: `order:${id}` },
  ['示例发布者', '示例接单者', '订单编号：', '来源地区：示例东校区'],
);
add(
  'school-errand-confirm',
  'errand-admin',
  '管理删除确认',
  {
    ...errandReady,
    adminCommand: {
      ...command,
      modal: {
        operation: 'admin_delete',
        orderId: id,
        restrictionId: '',
        title: order.title,
        participantLabel: '示例发布者',
        regionId: region,
        targetProfileId: id,
        action: 'all',
      },
      reason: '示例原因：重复发布',
      publisherRestriction: false,
    },
  },
  [
    '确认管理删除',
    '删除后订单将不再公开显示',
    '可选，默认不选',
    '确认仅删除订单',
  ],
);
add(
  'school-errand-recovery',
  'errand-admin',
  '订单管理恢复',
  {
    ...errandReady,
    access: 'denied',
    loaded: false,
    items: [],
    adminCommand: {
      ...command,
      frozen: true,
      recoveryOperation: '管理删除',
      recoveryTarget: '示例订单 · 图书馆取书',
      status: '示例：结果尚未确认',
    },
  },
  [
    '原管理删除请求待确认',
    '保留原编号、目标和完整内容',
    '重新核验并重试完全相同的请求',
  ],
);
add(
  'school-restrictions-list',
  'errand-restrictions',
  '全局限制记录',
  restrictionReady,
  [
    '示例同学 · 接取跑腿',
    '生效中',
    '没有记录不能解释为从未受限',
    '仅解除此项限制',
  ],
);
add(
  'school-restrictions-details',
  'errand-restrictions',
  '限制来源',
  { ...restrictionReady, uiPanel: `restriction:${id}` },
  ['限制编号：', '操作人：示例管理员', '来源：全局签发'],
);
add(
  'school-restrictions-expired',
  'errand-restrictions',
  '限制已到期',
  {
    ...restrictionReady,
    mode: 'history',
    restriction: { ...restriction, state: 'expired' },
    items: [],
    events: [
      {
        eventId: request,
        kind: 'issued',
        effectiveAt: at,
        recordedAt: at,
        reason: restriction.reason,
        operator: restriction.operator,
      },
    ],
  },
  ['此项接取跑腿限制', '签发限制', '到期由时间推导，不代表管理员执行了解除'],
);
add(
  'school-restrictions-confirm',
  'errand-restrictions',
  '解除限制确认',
  {
    ...restrictionReady,
    adminCommand: {
      ...command,
      modal: {
        operation: 'release',
        orderId: '',
        restrictionId: id,
        title: '示例同学的接单限制',
        participantLabel: '示例同学',
        regionId: null,
        targetProfileId: request,
        action: 'accept',
      },
      reason: '示例复核：解除这一项限制',
    },
  },
  ['确认解除此项限制', '可能仍有其他发布、接单或全部功能限制', '关闭确认'],
);
add(
  'school-restrictions-recovery',
  'errand-restrictions',
  '限制原请求恢复',
  {
    ...restrictionReady,
    access: 'denied',
    loaded: false,
    items: [],
    adminCommand: {
      ...command,
      frozen: true,
      recoveryOperation: '解除限制',
      recoveryTarget: '示例同学的接单限制',
      status: '示例：结果尚未确认',
    },
  },
  [
    '原解除限制请求待确认',
    '暂未查到回执也不能换编号重发',
    '重新核验并查询原回执',
  ],
);
for (const [page, patch] of [
  [
    'school-admin-management',
    { ...ready, canManage: false, capabilityKnown: true, management: null },
  ],
  [
    'school-identity-management',
    { ...ready, canManage: false, capabilityKnown: true, management: null },
  ],
  [
    'school-configuration',
    {
      ...configReady,
      loaded: false,
      management: 'none',
      form: null,
      entries: [],
    },
  ],
  [
    'school-posting-policy',
    { ...policyReady, loaded: false, management: 'none', form: null },
  ],
  ['school-uid-lookup', { ...ready, canLookup: false, result: null }],
  [
    'official-account-operations',
    { ...officialReady, config: null, capabilities: null },
  ],
  [
    'announcement-edit',
    {
      ...announceReady,
      loaded: false,
      management: 'none',
      id: '',
      state: 'new',
    },
  ],
  [
    'announcement-manage',
    { ...ready, loaded: false, management: 'none', items: [], more: false },
  ],
  [
    'errand-admin',
    { ...errandReady, loaded: false, access: 'denied', items: [] },
  ],
  [
    'errand-restrictions',
    { ...restrictionReady, loaded: false, access: 'denied', items: [] },
  ],
])
  add(
    `school-denied-${page}`,
    page,
    '当前权限不可用',
    { ...patch, error: '示例：当前没有此项管理权限，请重新核验。' },
    ['当前没有此项管理权限'],
  );
export default fixtures;
