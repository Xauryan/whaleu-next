/** Fictional layout-only cases. No real accounts, contacts, evidence, requests, or providers. */
const ready = {
  hasSession: true,
  configured: true,
  loaded: true,
  busy: false,
  error: '',
  status: '',
  frozen: false,
};
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-20T08:00:00.000Z';
const punishment = {
  punishmentId: id,
  kind: 'interaction_mute',
  revision: '1',
  reason: '示例记录：重复发布无关内容',
  startsAt: at,
  endsAt: '2026-10-21T08:00:00.000Z',
  recordedAt: at,
  state: 'active',
  terminal: null,
  canAppeal: true,
  openAppealId: null,
};
const appeal = {
  appealId: otherId,
  punishment,
  text: '示例申诉：希望复核相关内容的上下文。',
  submittedAt: at,
  state: 'pending',
  decision: null,
};
const pendingCommand = {
  clientRequestId: requestId,
  action: 'submit_appeal',
  punishment: { punishmentId: id, kind: 'interaction_mute', revision: '1' },
  text: appeal.text,
};
const report = {
  ...ready,
  operation: 'report',
  confirmation: null,
  receiptStatus: '',
  status: '原请求恢复已就绪',
};
const juryVote = { ...report, operation: 'vote' };
const progress = {
  ...ready,
  progress: {
    kind: 'post',
    id,
    reportCount: 5,
    effectiveWeight: 5,
    hasReported: false,
    isSelf: false,
    reportCapability: {
      status: 'deny',
      code: 'REPORTING_CLOSED',
      evaluatedAt: at,
    },
    jury: {
      juryId: otherId,
      state: 'pending',
      createdAt: at,
      deadline: '2026-10-21T08:00:00.000Z',
      keepVotes: 0,
      removeVotes: 0,
      ownVote: null,
      voteCapability: { status: 'allow', code: null, evaluatedAt: at },
    },
  },
  canReport: false,
  canVote: true,
  showTallies: false,
  voteReason: '',
  reportReason: '',
};
const pending = {
  ...ready,
  loaded: false,
  frozen: true,
  pendingAction: 'submit_appeal',
  pendingPhase: 'submit',
  pendingRequestId: requestId,
  pendingCommand,
  error: '示例：连接中断，结果尚不能确认',
};
export default [
  {
    id: 'support-feedback-feed',
    page: 'feedback',
    title: '公开意见 · 虚构示例',
    patch: {
      ...ready,
      space: { id: otherId, kind: 'global', name: '意见建议' },
      posts: [
        {
          id,
          author: { kind: 'anonymous', displayName: '示例分身' },
          viewer: { isSelf: false },
          feedback: { authorSchool: '示例大学' },
          text: '希望课表支持按周切换，查找下一周的安排更方便。',
          publishedAt: at,
          likeCount: 12,
          discussionCount: 4,
          images: [],
        },
      ],
    },
    expectedText: ['全站公开', '发布意见建议', '示例分身', '查看讨论'],
  },
  {
    id: 'support-feedback-error',
    page: 'feedback',
    title: '意见加载失败 · 虚构示例',
    patch: {
      ...ready,
      loaded: false,
      error: '示例：暂时无法读取意见列表，请重试',
      space: null,
      posts: [],
    },
    expectedText: ['暂时无法读取意见列表', '全站公开'],
  },
  {
    id: 'support-feedback-empty',
    page: 'feedback',
    title: '意见空列表 · 虚构示例',
    patch: { ...ready, posts: [], space: { id: otherId } },
    expectedText: ['还没有意见建议', '发布意见建议'],
  },
  {
    id: 'support-contacts-ready',
    page: 'feedback-contacts',
    title: '主动查看联系信息 · 虚构示例',
    patch: { ...ready, contacts: { ...ready, enabled: true, contacts: null } },
    expectedText: ['发布者的联系方式', '不代表已认证', '查看联系方式'],
  },
  {
    id: 'support-contacts-revealed',
    page: 'feedback-contacts',
    title: '联系方式 · 虚构示例',
    patch: {
      ...ready,
      contacts: {
        ...ready,
        enabled: true,
        status: '发布者自愿公开的联系方式，不代表已认证',
        contacts: { wechat: 'fictional_contact', qq: '', phone: '' },
      },
    },
    expectedText: ['fictional_contact', '复制', '重新核验联系方式'],
  },
  {
    id: 'support-contacts-error',
    page: 'feedback-contacts',
    title: '联系权限变化 · 虚构示例',
    patch: {
      ...ready,
      contacts: {
        ...ready,
        enabled: false,
        contacts: null,
        error: '示例：当前不可查看此帖的联系方式',
      },
    },
    expectedText: ['当前不可查看此帖的联系方式', '刷新帖子权限'],
  },
  {
    id: 'support-report-jury',
    page: 'report-progress',
    title: '陪审进行中 · 虚构示例',
    patch: { hasTarget: true, report, juryVote, reportProgress: progress },
    expectedText: [
      '5',
      '人举报已受理',
      '保留主题',
      '删除主题',
      '作者和所有举报人不能投票',
    ],
  },
  {
    id: 'support-report-error',
    page: 'report-progress',
    title: '进度未知 · 虚构示例',
    patch: {
      hasTarget: true,
      report,
      juryVote,
      reportProgress: {
        ...progress,
        loaded: false,
        progress: null,
        canVote: false,
        error: '示例：原内容当前不可查看',
      },
    },
    expectedText: [
      '进度暂不能确认',
      '不代表没有举报或陪审',
      '原内容当前不可查看',
    ],
  },
  {
    id: 'support-report-recovery',
    page: 'report-progress',
    title: '原举报恢复 · 虚构示例',
    patch: {
      hasTarget: false,
      report: { ...report, frozen: true, status: '原举报结果待确认' },
      juryVote,
    },
    expectedText: [
      '举报结果待确认',
      '查询原举报回执',
      '重试完全相同的原举报',
      '仅查询当前账号自己的原回执',
    ],
  },
  {
    id: 'support-report-confirmation',
    page: 'report-progress',
    title: '举报确认 · 虚构示例',
    patch: {
      hasTarget: false,
      report: {
        ...report,
        confirmation: { operation: 'report', target: { kind: 'reply', id } },
      },
      juryVote,
    },
    expectedText: ['举报此回复？', '确认后无法修改或撤回', '确认举报', '取消'],
  },
  {
    id: 'support-jury-confirmation',
    page: 'report-progress',
    title: '陪审确认 · 虚构示例',
    patch: {
      hasTarget: true,
      report,
      juryVote: {
        ...juryVote,
        confirmation: {
          operation: 'vote',
          postId: id,
          juryId: otherId,
          vote: 'remove',
        },
      },
      reportProgress: progress,
    },
    expectedText: ['确认删除帖子主题？', '不能修改或撤回', '确认删除'],
  },
  {
    id: 'support-account-clear',
    page: 'account-status',
    title: '无生效处罚 · 虚构示例',
    patch: {
      ...ready,
      accountStatus: {
        effective: 'clear',
        coverage: 'complete',
        checkedAt: at,
        current: [],
      },
    },
    expectedText: [
      '暂无生效处罚',
      '当前无生效的禁言或封号',
      '查看我的处罚历史',
    ],
  },
  {
    id: 'support-account-restricted',
    page: 'account-status',
    title: '账号禁言 · 虚构示例',
    patch: {
      ...ready,
      accountStatus: {
        effective: 'interaction_mute',
        coverage: 'complete',
        checkedAt: at,
        current: [punishment],
      },
    },
    expectedText: [
      '互动暂时受限',
      '示例记录：重复发布无关内容',
      '对此项处罚申诉',
      '解除一项不会解除另一项',
    ],
  },
  {
    id: 'support-account-unavailable',
    page: 'account-status',
    title: '部分安全信息未知 · 虚构示例',
    patch: {
      ...ready,
      accountStatus: {
        effective: 'unavailable',
        coverage: 'unavailable',
        checkedAt: at,
        current: [],
      },
      error: '示例：部分安全信息暂不可用',
    },
    expectedText: ['状态暂不能确认', '不代表已恢复权限', '重新核验当前状态'],
  },
  {
    id: 'support-account-recovery',
    page: 'account-status',
    title: '账号原请求恢复 · 虚构示例',
    patch: pending,
    expectedText: [
      '原请求待确认',
      '查询不到回执不代表失败',
      '查询原请求回执',
      '取消原请求',
    ],
  },
  {
    id: 'support-appeal-form',
    page: 'safety-appeal',
    title: '私人申诉填写 · 虚构示例',
    patch: { ...ready, selectedPunishment: punishment, text: appeal.text },
    expectedText: [
      '仅你和当前有权的超级管理员可见',
      '不会发布到公开反馈',
      '申诉说明',
      '继续，核对申诉',
    ],
  },
  {
    id: 'support-appeal-detail',
    page: 'safety-appeal',
    title: '私人申诉进度 · 虚构示例',
    patch: { ...ready, selectedAppeal: appeal, appeals: [appeal] },
    expectedText: [
      '申诉待处理',
      '已提交申诉',
      '示例申诉：希望复核',
      '查看详情与结果',
    ],
  },
  {
    id: 'support-appeal-confirmation',
    page: 'safety-appeal',
    title: '私人申诉确认 · 虚构示例',
    patch: {
      ...ready,
      selectedPunishment: punishment,
      text: appeal.text,
      confirming: 'submit_appeal',
    },
    expectedText: [
      '确认提交私人申诉？',
      '原请求结果未确认前',
      '确认提交',
      '返回修改',
    ],
  },
  {
    id: 'support-appeal-result',
    page: 'safety-appeal',
    title: '私人申诉结果 · 虚构示例',
    patch: {
      ...ready,
      selectedAppeal: {
        ...appeal,
        state: 'decided',
        decision: {
          outcome: 'upheld',
          reason: '示例结果：复核后维持原处罚。',
          recordedAt: at,
        },
      },
    },
    expectedText: ['申诉已处理', '维持原处罚', '示例结果：复核后维持原处罚'],
  },
  {
    id: 'support-appeal-recovery',
    page: 'safety-appeal',
    title: '私人申诉恢复 · 虚构示例',
    patch: pending,
    expectedText: [
      '原请求待确认',
      '示例申诉：希望复核',
      '查询并重试原请求',
      '结果尚不能确认',
    ],
  },
  {
    id: 'support-appeal-cancel',
    page: 'safety-appeal',
    title: '原请求取消确认 · 虚构示例',
    patch: { ...pending, pendingPhase: 'cancel', confirming: 'cancel' },
    expectedText: [
      '取消待确认',
      '取消未完成的原请求？',
      '不会回滚',
      '确认取消原请求',
    ],
  },
  {
    id: 'support-appeal-empty',
    page: 'safety-appeal',
    title: '私人申诉空列表 · 虚构示例',
    patch: ready,
    expectedText: ['暂无私人申诉', '从账号状态选择具体处罚'],
  },
  {
    id: 'support-build-status',
    page: 'status',
    title: '开发状态 · 静态说明',
    patch: {},
    expectedText: [
      '鲸语校园',
      '开发预览',
      '此构建未连接生产服务',
      '校园公告',
      '查看我的认证状态',
    ],
  },
];
