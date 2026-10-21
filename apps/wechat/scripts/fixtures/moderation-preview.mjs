/** Fictional static layout states only. No real actors, evidence, requests, or services. */
const ready = {
  hasSession: true,
  configured: true,
  loaded: true,
  busy: false,
  error: '',
  status: '',
  frozen: false,
  receiptStatus: '',
  detailsExpanded: false,
};
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-20T09:30:00.000Z';
const post = { kind: 'post', id };
const reply = { kind: 'comment', id };
const management = {
  target: post,
  targetVersion: 'a'.repeat(64),
  canRemove: true,
  version: 3,
  viewSpaceId: other,
};
const pending = {
  ...ready,
  frozen: true,
  pendingTarget: post,
  pendingRequestId: request,
  pendingPhase: 'submit',
  management: null,
  error: '示例：连接中断，原请求结果尚未确认',
};
const punishment = {
  punishmentId: id,
  kind: 'interaction_mute',
  revision: '1',
  reason: '示例记录：连续发布与讨论无关的内容',
  startsAt: at,
  endsAt: '2026-10-21T09:30:00.000Z',
  recordedAt: at,
  state: 'active',
  terminal: null,
  canAppeal: false,
  openAppealId: null,
};
const appeal = {
  appealId: other,
  punishment,
  text: '示例申诉：希望结合前后回复重新核对这次处理。',
  submittedAt: at,
  state: 'pending',
  decision: null,
};
const application = {
  id,
  revision: 2,
  state: 'pending',
  campusId: other,
  campusName: '示例大学 · 东校区',
  institutionName: '示例大学',
  regionId: other,
  profileId: null,
  submittedAt: at,
  reason: null,
  evidenceRevision: 1,
  evidenceAvailable: true,
  evidenceExpiresAt: '2026-10-21T09:30:00.000Z',
};
const review = {
  ...ready,
  management: 'fixed',
  regionId: other,
  regionName: '示例城区',
  application,
  items: [application],
  stateLabel: '等待校方审核',
  page: 1,
  hasNext: false,
  message: '',
  pending: false,
  confirmation: '',
  evidenceMessage: '',
  evidenceSrc: '',
  reason: '',
};
const fixtures = [];
const add = (id, page, title, patch, expectedText) =>
  fixtures.push({ id, page, title, patch, expectedText });
add(
  'moderation-post-ready',
  'admin-post-removal',
  '主题管理 · 虚构界面',
  { ...ready, target: post, management },
  ['按当前浏览范围核验', '本次核验可删除', '继续核对删除'],
);
add(
  'moderation-post-confirm',
  'admin-post-removal',
  '主题删除确认 · 虚构界面',
  { ...ready, target: post, management, confirming: 'remove' },
  [
    '确认删除此主题？',
    '全部回复将不可访问',
    '删除会影响所有地区',
    '删除主题并通知作者',
  ],
);
add(
  'moderation-post-recovery',
  'admin-post-removal',
  '删除结果未知 · 虚构界面',
  pending,
  [
    '原管理员删帖请求待确认',
    '查询不到回执不代表',
    '查询原删帖回执',
    '取消原删帖请求',
  ],
);
add(
  'moderation-post-cancel',
  'admin-post-removal',
  '取消原删除请求 · 虚构界面',
  { ...pending, confirming: 'cancel' },
  ['不会恢复帖子', '确认取消原请求'],
);
add(
  'moderation-reply-ready',
  'admin-discussion-removal',
  '回复管理 · 虚构界面',
  { ...ready, target: reply, management: { ...management, target: reply } },
  ['按当前浏览范围核验', '当前根回复', '继续核对删除'],
);
add(
  'moderation-reply-confirm',
  'admin-discussion-removal',
  '根回复删除确认 · 虚构界面',
  {
    ...ready,
    target: reply,
    management: { ...management, target: reply },
    confirming: 'remove',
  },
  ['该根回复及其全部回复将不可访问', '其他根回复', '确认删除根回复'],
);
add(
  'moderation-reply-recovery',
  'admin-discussion-removal',
  '回复原请求恢复 · 虚构界面',
  { ...pending, pendingTarget: reply },
  [
    '原管理员回复删除请求待确认',
    '停止等待不会取消服务器处理',
    '查询原删除回执',
  ],
);
for (const [page, capability, action, title] of [
  ['profile-moderation', 'canReset', 'reset', '昵称'],
  ['profile-avatar-moderation', 'canClearCustomAvatar', 'clear', '头像'],
]) {
  const profile = {
    target: post,
    displayName: '示例公开昵称',
    revision: 4,
    [capability]: true,
  };
  add(
    `moderation-${title === '昵称' ? 'nickname' : 'avatar'}-ready`,
    page,
    `${title}管理 · 虚构界面`,
    { ...ready, target: post, management: profile },
    [
      '示例公开昵称',
      '资料版本 4',
      `继续核对${title}${title === '昵称' ? '重置' : '清除'}`,
    ],
  );
  add(
    `moderation-${title === '昵称' ? 'nickname' : 'avatar'}-confirm`,
    page,
    `${title}确认 · 虚构界面`,
    { ...ready, target: post, management: profile, confirming: action },
    ['分身保持不变', '私有系统通知', '需要重新确认'],
  );
  add(
    `moderation-${title === '昵称' ? 'nickname' : 'avatar'}-unavailable`,
    page,
    `${title}只读 · 虚构界面`,
    {
      ...ready,
      target: post,
      management: {
        target: post,
        [capability]: false,
        availability: 'unavailable',
        blocker: 'related_sync_unsupported',
      },
    },
    ['当前只能查看', '当前不可执行管理操作'],
  );
  add(
    `moderation-${title === '昵称' ? 'nickname' : 'avatar'}-recovery`,
    page,
    `${title}恢复 · 虚构界面`,
    pending,
    [`原${title}管理请求待确认`, '请保留本机数据', `查询原${title}管理回执`],
  );
}
add(
  'moderation-punishment-list',
  'safety-punishment-management',
  '处罚管理列表 · 虚构界面',
  { ...ready, mode: 'punishment-management', punishments: [punishment] },
  ['仅限当前超级管理员', '示例记录', '查看并核验', '不能新建任意账号处罚'],
);
add(
  'moderation-punishment-detail',
  'safety-punishment-management',
  '处罚核验 · 虚构界面',
  {
    ...ready,
    mode: 'punishment-management',
    selectedPunishment: punishment,
    canRelease: true,
    reason: '示例处理：复核后解除此项处罚',
  },
  ['解除理由', '核对并解除此项处罚', '查看该处罚所属账号的处罚历史'],
);
add(
  'moderation-punishment-readonly',
  'safety-punishment-management',
  '处罚只读 · 虚构界面',
  {
    ...ready,
    mode: 'punishment-management',
    selectedPunishment: punishment,
    canRelease: false,
  },
  ['当前记录只读', '不能解除'],
);
add(
  'moderation-punishment-confirm',
  'safety-punishment-management',
  '解除处罚确认 · 虚构界面',
  {
    ...ready,
    mode: 'punishment-management',
    selectedPunishment: punishment,
    canRelease: true,
    confirming: 'release',
    reason: '示例处理：复核后解除此项处罚',
  },
  ['确认解除这项处罚', '如禁言仍有效，互动仍受限', '确认并提交'],
);
add(
  'moderation-appeal-list',
  'safety-appeal-management',
  '私人申诉队列 · 虚构界面',
  { ...ready, mode: 'appeal-management', appeals: [appeal] },
  ['仅限当前超级管理员', '禁言申诉', '待处理', '查看申诉'],
);
add(
  'moderation-appeal-detail',
  'safety-appeal-management',
  '私人申诉处理 · 虚构界面',
  {
    ...ready,
    mode: 'appeal-management',
    selectedAppeal: appeal,
    canDecide: true,
    reason: '',
  },
  ['申诉说明', '示例申诉', '处理理由', '解除申诉绑定的处罚'],
);
add(
  'moderation-appeal-confirm',
  'safety-appeal-management',
  '申诉决定确认 · 虚构界面',
  {
    ...ready,
    mode: 'appeal-management',
    selectedAppeal: appeal,
    canDecide: true,
    reason: '示例理由：复核后维持原处罚',
    decision: 'upheld',
    confirming: 'decide_appeal',
  },
  ['确认处理这条申诉', '维持原处罚', '原请求结果未确认前不会生成新请求'],
);
add(
  'moderation-appeal-result',
  'safety-appeal-management',
  '已处理申诉 · 虚构界面',
  {
    ...ready,
    mode: 'appeal-management',
    selectedAppeal: {
      ...appeal,
      state: 'decided',
      decision: {
        outcome: 'upheld',
        reason: '示例结果：复核后维持原处罚',
        recordedAt: at,
      },
    },
    canDecide: false,
  },
  ['申诉已处理', '示例结果', '当前申诉只读'],
);
for (const [page, mode] of [
  ['safety-appeal-management', 'appeal-management'],
  ['safety-punishment-management', 'punishment-management'],
]) {
  const recovery = {
    ...pending,
    mode,
    pendingAction: 'release',
    pendingCommand: {
      clientRequestId: request,
      action: 'release',
      punishment: { punishmentId: id, kind: 'interaction_mute', revision: '1' },
      reason: '示例原请求理由',
      expectedStateVersion: 'fictional-version',
    },
  };
  add(
    `moderation-${mode}-recovery`,
    page,
    '管理原请求恢复 · 虚构界面',
    recovery,
    [
      '原请求待确认',
      '原处理理由',
      '失去管理权限仍可恢复本账号原请求',
      '查询并重试原请求',
    ],
  );
  add(
    `moderation-${mode}-cancel`,
    page,
    '管理原请求取消 · 虚构界面',
    { ...recovery, confirming: 'cancel' },
    ['不会回滚', '确认取消原请求'],
  );
}
add(
  'moderation-student-queue',
  'student-verification-review',
  '学校认证审核 · 虚构界面',
  review,
  [
    '示例城区',
    '示例大学',
    '材料有效期',
    '私密查看申请材料',
    '不能审核自己的申请',
  ],
);
add(
  'moderation-student-expired',
  'student-verification-review',
  '材料过期 · 虚构界面',
  {
    ...review,
    application: { ...application, state: 'expired', evidenceAvailable: false },
    stateLabel: '材料已过期，请重新申请',
  },
  ['材料已过期', '当前材料不可读取'],
);
add(
  'moderation-student-confirm',
  'student-verification-review',
  '学校认证确认 · 虚构界面',
  { ...review, confirmation: 'approved' },
  ['确认审核决定', '不会发行学号', '当前权限与申请版本'],
);
add(
  'moderation-student-recovery',
  'student-verification-review',
  '学校审核结果未知 · 虚构界面',
  {
    ...review,
    pending: true,
    application: null,
    items: [],
    error: '示例：审核请求结果尚未确认',
  },
  ['原审核结果待确认', '不会撤销已完成的决定', '查询原审核请求'],
);
add(
  'moderation-student-denied',
  'student-verification-review',
  '无学校审核权限 · 虚构界面',
  {
    ...review,
    management: 'none',
    application: null,
    items: [],
    regionId: '',
    regionName: '',
  },
  ['当前没有审核权限', '不能读取申请材料或提交审核决定'],
);
add(
  'moderation-feedback-list',
  'feedback-notices',
  '公开反馈提醒 · 虚构界面',
  {
    ...ready,
    unreadCount: 1,
    items: [
      { noticeId: id, createdAt: at, readAt: null, available: true },
      { noticeId: other, createdAt: at, readAt: at, available: false },
    ],
  },
  ['未读 1 条', '收到一条公开反馈', '标记此条已读', '反馈当前不可查看'],
);
add(
  'moderation-feedback-empty',
  'feedback-notices',
  '反馈提醒为空 · 虚构界面',
  { ...ready, unreadCount: 0, items: [] },
  ['暂无反馈通知', '新的公开反馈提醒'],
);
add(
  'moderation-feedback-policy',
  'feedback-notices',
  '反馈提醒说明 · 虚构界面',
  { ...ready, unreadCount: 0, items: [], detailsExpanded: true },
  ['不包含作者身份或原文快照', '不会自动标记已读', '尚未接入微信订阅消息'],
);
add(
  'moderation-post-punishment',
  'admin-post-removal',
  '删除及附加处罚 · 虚构界面',
  {
    ...ready,
    target: post,
    management: {
      target: post,
      targetVersion: 'a'.repeat(64),
      canRemove: true,
      punishmentOptions: {
        interaction_mute: {
          revision: '1',
          current: { punishmentId: id, endsAt: null },
        },
        access_suspension: { revision: '0', current: null },
      },
    },
    confirming: 'remove',
    punishmentKind: 'interaction_mute',
    punishmentUnit: 'days',
    punishmentValue: '7',
    punishmentReason: '示例原因：重复发布无关内容',
  },
  [
    '当前禁言：永久',
    '处罚只针对该内容的原作者',
    '同类永久处罚须先由超级管理员解除',
  ],
);
for (const [page, mode] of [
  ['safety-appeal-management', 'appeal-management'],
  ['safety-punishment-management', 'punishment-management'],
])
  add(
    `moderation-${mode}-empty`,
    page,
    '管理列表为空 · 虚构界面',
    { ...ready, mode },
    ['当前列表暂无记录', '不代表其他账号没有处罚或申诉'],
  );
export default fixtures;
