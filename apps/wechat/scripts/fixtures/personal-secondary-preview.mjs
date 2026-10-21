// Fictional, repository-owned layout samples. Never shipped or sent to a provider.
import sharp from 'sharp';
const cover =
  'data:image/png;base64,' +
  (
    await sharp(new URL('./profile-cover.svg', import.meta.url).pathname)
      .png()
      .toBuffer()
  ).toString('base64');
const id = (n) => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = {
  configured: true,
  hasSession: true,
  loaded: true,
  busy: false,
  status: '',
  error: '',
};
const display = {
  title: { status: 'known', value: { key: 'level_1', name: '萌新小白' } },
  color: { status: 'known', value: 0 },
  level: { status: 'known', value: 1 },
};
const unknown = {
  title: { status: 'unavailable', value: null },
  color: { status: 'unavailable', value: null },
  level: { status: 'unavailable', value: null },
};
const profile = {
  status: 'available',
  profileId: id(1),
  isOwn: false,
  displayName: '山禾',
  bio: '喜欢校园里的树，也喜欢傍晚散步。',
  avatar: null,
  affiliation: null,
  publicUid: null,
  schoolUidStatus: 'unavailable',
  experienceDisplay: display,
  totalInteractions: null,
  totalInteractionsStatus: 'unavailable',
  postsHidden: false,
  postCount: 2,
  postCountStatus: 'known',
  tradeCount: 0,
  tradeCountStatus: 'known',
};
const author = {
  kind: 'named',
  profileId: id(1),
  displayName: '山禾',
  avatar: null,
  experienceDisplay: display,
};
const post = {
  id: id(2),
  text: '图书馆靠窗的座位，刚好能看到银杏慢慢变黄。\n带本书来坐一会儿吧。',
  author,
  space: { id: id(3), kind: 'regional', name: '南湖校园' },
  category: 'discussion',
  images: [],
  trading: null,
  component: { kind: 'none' },
  publishedAt: '2026-10-20T08:30:00.000Z',
  likeCount: 8,
  commentCount: 2,
  replyCount: 1,
  discussionCount: 3,
  saveCount: 4,
  commentsPolicy: 'open',
  viewer: {
    isSelf: false,
    isLiked: false,
    isSaved: false,
    canDelete: false,
    canComment: true,
    canSave: true,
    canSetUpdatePreference: true,
  },
};
const follow = {
  ...base,
  profileId: id(1),
  following: false,
  frozen: false,
  recoveryProfileId: '',
  recoveryFollowing: null,
  receiptStatus: '',
};
const block = {
  ...base,
  frozen: false,
  confirmSource: null,
  activeRelationshipId: '',
  receiptStatus: '',
  current: null,
};
const publicPatch = {
  ...base,
  profile,
  items: [
    post,
    {
      ...post,
      id: id(4),
      text: '周末沿着湖边走了一圈，风很舒服。',
      publishedAt: '2026-10-18T09:00:00.000Z',
      likeCount: 3,
      commentCount: 1,
      replyCount: 0,
      discussionCount: 1,
      saveCount: 1,
    },
  ],
  total: 2,
  totalStatus: 'known',
  continuation: 'end',
  pageNumber: 1,
  follow,
  block,
  publicDetails: {
    ...base,
    details: {
      status: 'available',
      profileId: id(1),
      region: '浙江杭州',
      gender: 'female',
      age: 21,
    },
  },
  coverRead: { status: 'ready', localSrc: cover, message: '' },
};
const blocked = (n, name, kind = 'current') => ({
  relationshipId: id(n),
  revision: '1',
  blocked: true,
  blockedAt: '2026-10-18T09:00:00.000Z',
  display: { kind, displayName: name },
  canUnblock: true,
});
const blocks = {
  ...base,
  items: [
    blocked(11, '行舟'),
    blocked(12, '晚风', 'snapshot'),
    blocked(13, null, 'unavailable'),
  ],
  block,
};
const history = {
  ...base,
  items: [
    {
      postId: id(2),
      summary: '图书馆靠窗的座位，刚好能看到银杏慢慢变黄。',
      viewedAt: '2026/10/20 16:30:00',
    },
    {
      postId: id(4),
      summary: '校园里适合散步的小路，你最喜欢哪一条？',
      viewedAt: '2026/10/19 19:12:00',
    },
  ],
  page: 1,
  canMore: true,
  canPrevious: false,
  confirmClear: false,
};
const rules = [
  'publish',
  'comment',
  'like_save',
  'received_like_save',
  'received_comment',
].map((action, i) => ({
  action,
  amount: [10, 3, 1, 2, 3][i],
  dailyLimit: [1, 5, 10, 10, 5][i],
  rewardedCount: 0,
  refundCount: 0,
  remaining: [1, 5, 10, 10, 5][i],
  grossPositiveAwarded: '0',
}));
const summary = {
  ruleVersion: 'local-experience-v1',
  timezone: 'Asia/Shanghai',
  serverDay: '2026-10-20',
  baseline: 'known',
  coverage: { history: 'complete', entitlements: 'complete' },
  balance: '10',
  level: 1,
  progress: {
    currentThreshold: '0',
    nextThreshold: '15',
    pointsIntoLevel: '10',
    pointsToNextLevel: '5',
    percent: 66,
  },
  signIn: {
    signedIn: false,
    lastDay: null,
    streak: 0,
    nextStreak: 1,
    nextReward: 2,
  },
  tasks: rules,
  pending: { count: 0, reason: null },
  stateRevision: '1',
};
const titles = [
  {
    key: 'level_1',
    name: '萌新小白',
    kind: 'level',
    unlockLevel: 1,
    earnedAt: '2026-10-18T09:00:00.000Z',
    recordedAt: '2026-10-18T09:00:00.000Z',
  },
];
const experience = {
  ...base,
  summary,
  balanceLabel: '10',
  progressLabel: '再获得 5 经验，升至 Lv.2',
  signInLabel: '今日签到 +2 经验',
  appearance: {
    coverage: 'complete',
    titles,
    titleKey: 'level_1',
    colorId: 0,
    eligibleColorIds: Array.from({ length: 11 }, (_, index) => index),
    revision: '1',
  },
  titleKey: 'level_1',
  colorId: 0,
  titleGroups: [{ label: '等级头衔', titles }],
  previewTitle: '萌新小白',
  previewStyle: 'background: #CED5E9;',
  appearanceDirty: false,
  tasks: [
    {
      action: 'publish',
      label: '发布内容',
      reward: '每次 +10 经验',
      progress: '0 / 1',
    },
    {
      action: 'comment',
      label: '发表回复',
      reward: '每次 +3 经验',
      progress: '0 / 5',
    },
    {
      action: 'like_save',
      label: '点赞或收藏',
      reward: '每次 +1 经验',
      progress: '0 / 10',
    },
  ],
  colors: [
    {
      id: 0,
      name: '颜色 0',
      unlockLevel: 0,
      style: 'background: #CED5E9;',
      selectable: true,
      selected: true,
      retained: true,
    },
    {
      id: 1,
      name: '颜色 1',
      unlockLevel: 0,
      style: 'background: #e57373;',
      selectable: true,
      selected: false,
      retained: false,
    },
    {
      id: 2,
      name: '颜色 2',
      unlockLevel: 0,
      style: 'background: #98E9E3;',
      selectable: true,
      selected: false,
      retained: false,
    },
  ],
  records: [],
  recordsCoverage: '当前记录覆盖完整',
  levelTitleRules: [{ key: 'level_1', name: '萌新小白', unlockLevel: 1 }],
  experiencePanels: { appearance: false, records: false, redemption: false },
};
const ranking = {
  ...base,
  scope: 'global',
  population: 'known_participants',
  populationCompleteness: 'incomplete',
  selectionStatus: 'available_candidates_exhausted',
  items: [
    { profileId: id(1), displayName: '山禾', experienceDisplay: display },
    {
      profileId: id(20),
      displayName: '行舟',
      experienceDisplay: { ...display, level: { status: 'known', value: 3 } },
    },
    { profileId: id(21), displayName: '晚风', experienceDisplay: unknown },
  ],
};
export default [
  {
    id: 'personal-public-profile',
    page: 'public-profile',
    title: '公开主页 · 公开资料',
    patch: publicPatch,
    expectedText: ['山禾', '浙江杭州', '21岁', '银杏慢慢变黄', '私信'],
  },
  {
    id: 'personal-public-male',
    page: 'public-profile',
    title: '公开主页 · 男性胶囊与空列表',
    patch: {
      ...publicPatch,
      items: [],
      total: 0,
      publicDetails: {
        ...base,
        details: {
          status: 'available',
          profileId: id(1),
          region: null,
          gender: 'male',
          age: null,
        },
      },
    },
    expectedText: ['山禾', '还没有可展示的公开主题或交易'],
  },
  {
    id: 'personal-public-guest',
    page: 'public-profile',
    title: '公开主页 · 未登录',
    patch: { ...publicPatch, hasSession: false },
    expectedText: ['登录后关注', '登录后查看详情'],
  },
  {
    id: 'personal-public-hidden',
    page: 'public-profile',
    title: '公开主页 · 主人隐藏发布',
    patch: {
      ...publicPatch,
      profile: { ...profile, postsHidden: true, postCount: 0, tradeCount: 0 },
      items: [],
      total: null,
    },
    expectedText: ['对方已隐藏主页主题与交易', '私信'],
  },
  {
    id: 'personal-public-unavailable',
    page: 'public-profile',
    title: '公开主页 · 暂不可查看',
    patch: {
      ...base,
      profile: { status: 'unavailable', profileId: id(1) },
      error: '此主页当前不可查看',
    },
    expectedText: ['此主页当前不可查看'],
  },
  {
    id: 'personal-public-follow-recovery',
    page: 'public-profile',
    title: '公开主页 · 关注结果待确认',
    patch: {
      ...publicPatch,
      follow: {
        ...follow,
        following: null,
        frozen: true,
        recoveryProfileId: id(1),
        recoveryFollowing: true,
      },
    },
    expectedText: ['关注结果待确认', '重试原操作'],
  },
  {
    id: 'personal-blocks',
    page: 'community-blocks',
    title: '我的拉黑 · 列表',
    patch: blocks,
    expectedText: ['行舟', '晚风', '拉黑时的名称', '解除拉黑'],
  },
  {
    id: 'personal-blocks-empty',
    page: 'community-blocks',
    title: '我的拉黑 · 空列表',
    patch: { ...base, items: [] },
    expectedText: ['还没有拉黑任何人'],
  },
  {
    id: 'personal-blocks-recovery',
    page: 'community-blocks',
    title: '我的拉黑 · 结果待确认',
    patch: {
      ...blocks,
      block: {
        ...block,
        frozen: true,
        activeRelationshipId: id(11),
        error: '解除结果待确认，请查询原请求',
      },
    },
    expectedText: ['解除结果待确认', '查询原请求回执', '重试完全相同的原请求'],
  },
  {
    id: 'personal-history',
    page: 'browsing-history',
    title: '浏览记录 · 本机记录',
    patch: history,
    expectedText: ['本机 · 最近 30 天', '银杏慢慢变黄', '下一页'],
  },
  {
    id: 'personal-history-clear',
    page: 'browsing-history',
    title: '浏览记录 · 清空确认',
    patch: {
      ...history,
      confirmClear: true,
      historyOverlayLocked: true,
      historyPageStyle: 'overflow: hidden;',
      clearDialogOpen: true,
      clearDialogSessionId: 'synthetic-legacy-history-clear',
      clearDialogAttempt: 0,
      clearDialogLoading: false,
      clearDialogError: '',
    },
    expectedText: ['清空本机浏览记录？', '不会删除帖子', '取消'],
  },
  {
    id: 'personal-history-error',
    page: 'browsing-history',
    title: '浏览记录 · 读取失败不恢复旧摘要',
    patch: {
      ...base,
      loaded: false,
      items: [],
      error: '暂时无法读取浏览记录，请重试',
    },
    expectedText: ['暂时无法读取浏览记录'],
  },
  {
    id: 'personal-history-guest',
    page: 'browsing-history',
    title: '浏览记录 · 已退出登录',
    patch: { ...base, loaded: false, hasSession: false, items: [] },
    expectedText: ['登录后查看本机记录', '退出登录会清除'],
  },
  {
    id: 'personal-experience',
    page: 'experience',
    title: '经验与头衔 · 日常成长',
    patch: experience,
    expectedText: ['当前经验', '今日签到 +2 经验', '每日经验', '我的头衔'],
  },
  {
    id: 'personal-experience-appearance',
    page: 'experience',
    title: '经验与头衔 · 选择外观',
    patch: {
      ...experience,
      appearanceDirty: true,
      experiencePanels: { ...experience.experiencePanels, appearance: true },
    },
    expectedText: ['不显示头衔', '保存头衔与颜色', '头衔不代表管理权限'],
  },
  {
    id: 'personal-experience-recovery',
    page: 'experience',
    title: '经验与头衔 · 保留原签到与外观请求',
    patch: { ...experience, signInPending: true, appearancePending: true },
    expectedText: ['签到结果待确认', '重试原签到', '重试原保存'],
  },
  {
    id: 'personal-experience-redemption',
    page: 'experience',
    title: '经验与头衔 · 兑换结果待确认',
    patch: {
      ...experience,
      redemptionStatus: 'available',
      redemptionPending: true,
      redemptionCode: '',
    },
    expectedText: ['查询原兑换结果', '用原兑换码重试', '请勿更换兑换码'],
  },
  {
    id: 'personal-experience-unavailable',
    page: 'experience',
    title: '经验与头衔 · 兑换暂不可用',
    patch: {
      ...experience,
      experiencePanels: { ...experience.experiencePanels, redemption: true },
    },
    expectedText: ['兑换暂不可用', '已拥有的头衔仍可选择'],
  },
  {
    id: 'personal-experience-error',
    page: 'experience',
    title: '经验与头衔 · 加载失败',
    patch: { ...base, loaded: false, error: '暂时无法读取经验，请稍后刷新' },
    expectedText: ['暂时无法读取经验'],
  },
  {
    id: 'personal-ranking',
    page: 'experience-ranking',
    title: '校园成长 · 已知参与者',
    patch: ranking,
    expectedText: ['不代表全站或本校排名', '山禾', '行舟', '历史覆盖不完整'],
  },
  {
    id: 'personal-ranking-limited',
    page: 'experience-ranking',
    title: '校园成长 · 来源尚未查完',
    patch: { ...ranking, items: [], selectionStatus: 'scan_limited' },
    expectedText: ['暂未找到可展示的同学，仍有来源尚未查完'],
  },
  {
    id: 'personal-ranking-error',
    page: 'experience-ranking',
    title: '校园成长 · 加载失败',
    patch: { ...base, loaded: false, items: [], error: '暂时无法读取等级列表' },
    expectedText: ['暂时无法读取等级列表'],
  },
  {
    id: 'personal-wallet-unavailable',
    page: 'wallet',
    title: '钱包 · 服务暂未接入',
    patch: { loaded: false, error: '钱包服务暂未接入' },
    expectedText: ['钱包服务暂未接入'],
  },
];
