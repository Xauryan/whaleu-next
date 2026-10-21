// Synthetic source-preview states only, not WeChat-device or live-data proof.
// Reuse the existing fictional discovery rows. Unknown counts stay unknown;
// no provider, image download, authorization or business action is executed.
import discovery from './discovery-preview.mjs';
const sample = (id) =>
  structuredClone(discovery.find((item) => item.id === id).patch);
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-collections-${id}`,
  page,
  title: `Framework7 iOS 原生收藏与热门 · ${title}`,
  patch,
  expectedText,
});
const hot = sample('discovery-hot-loaded');
const saved = sample('discovery-saved-loaded');
const liked = sample('discovery-liked-loaded');
const mine = sample('discovery-mine-records');
const recovery = sample('discovery-saved-recovery');
const guest = {
  configured: true,
  hasSession: false,
  loaded: false,
  busy: false,
  items: [],
  publications: [],
  tradingPosts: [],
  posts: [],
  error: '',
  status: '登录后查看自己的记录',
};
const savedMutation = {
  frozen: false,
  busy: false,
  status: '',
  receiptStatus: '',
  actionLabel: '',
  error: '',
  recoveryPostId: '',
};
export default [
  ...discovery
    .filter((item) =>
      [
        'community-hot',
        'community-saved',
        'community-liked',
        'community-mine',
      ].includes(item.page),
    )
    .map((item) =>
      fixture(
        item.id.replace('discovery-', ''),
        item.page,
        item.title,
        item.patch,
        item.expectedText,
      ),
    ),
  fixture(
    'hot-scan-pending',
    'community-hot',
    '扫描未完成不是空列表',
    { ...hot, posts: [], continuation: 'scan_pending', canNext: true },
    ['本批尚未查完', '继续查看'],
  ),
  fixture(
    'hot-guest',
    'community-hot',
    '访客预览不冒充登录',
    {
      ...hot,
      hasSession: false,
      continuation: 'login_required',
      canNext: false,
    },
    ['登录查看', '继续查看需要登录及手机号验证'],
  ),
  fixture(
    'hot-phone-required',
    'community-hot',
    '手机号门槛',
    { ...hot, continuation: 'phone_verification_required', canNext: false },
    ['继续查看需要手机号验证', '前往手机号授权验证'],
  ),
  fixture(
    'hot-coverage-unavailable',
    'community-hot',
    '覆盖范围未知',
    { ...hot, relatedCampusDistribution: 'unavailable' },
    ['关联学校展示范围暂不可确认', '不能据此判断关联学校没有帖子'],
  ),
  fixture(
    'hot-busy',
    'community-hot',
    '刷新中可停止',
    { ...hot, busy: true, posts: [], status: '正在核验当前热门内容' },
    ['正在核验当前热门内容', '停止加载'],
  ),
  fixture(
    'hot-error',
    'community-hot',
    '失败后保留范围',
    { ...hot, posts: [], loaded: false, error: '读取失败，请刷新重试' },
    ['读取失败，请刷新重试', '示例校园'],
  ),
  fixture(
    'hot-notes',
    'community-hot',
    '热度范围说明',
    { ...hot, showInfo: true },
    ['不含急出和已完成的交易', '尚未覆盖历史导入内容'],
  ),
  fixture(
    'saved-empty',
    'community-saved',
    '已核验的空收藏',
    { ...saved, items: [], visibleSavedCount: 0, canLoadMore: false },
    ['0 条可查看', '暂无当前可查看的收藏'],
  ),
  fixture(
    'saved-guest',
    'community-saved',
    '私有收藏登录边界',
    { ...guest, savedMutation },
    ['登录后查看收藏', '收藏的更新'],
  ),
  fixture(
    'saved-busy',
    'community-saved',
    '收藏加载中',
    {
      ...saved,
      loaded: false,
      items: [],
      busy: true,
      status: '正在读取当前收藏',
    },
    ['正在读取当前收藏', '停止加载'],
  ),
  fixture(
    'saved-recovery-busy',
    'community-saved',
    '原请求查询中',
    { ...recovery, savedMutation: { ...recovery.savedMutation, busy: true } },
    ['查询原请求回执', '停止等待（不撤销请求）'],
  ),
  fixture(
    'saved-recovery-error',
    'community-saved',
    '回执不可确认',
    {
      ...recovery,
      savedMutation: {
        ...recovery.savedMutation,
        error: '原请求结果仍未确认，请保留本机数据',
      },
    },
    ['原请求结果仍未确认', '重试完全相同的原请求'],
  ),
  fixture(
    'saved-notes',
    'community-saved',
    '更新能力说明',
    { ...saved, showInfo: true },
    ['包含急出交易', '不代表订阅同意或设备授权'],
  ),
  fixture(
    'liked-empty',
    'community-liked',
    '只有核验完成才显示为空',
    {
      ...liked,
      items: [],
      visibleLikedCount: 0,
      visibleLikedCountStatus: 'known',
      continuation: 'end',
    },
    ['0 条可查看', '当前没有可查看的点赞'],
  ),
  fixture(
    'liked-guest',
    'community-liked',
    '私有点赞登录边界',
    { ...guest, visibleLikedCount: null },
    ['登录后查看点赞', '点赞说明'],
  ),
  fixture(
    'liked-busy',
    'community-liked',
    '点赞核验中',
    {
      ...liked,
      loaded: false,
      items: [],
      busy: true,
      visibleLikedCount: null,
      status: '正在核验当前点赞记录',
    },
    ['正在核验当前点赞记录', '停止加载'],
  ),
  fixture(
    'liked-cursor-error',
    'community-liked',
    '失效游标不显示旧内容',
    {
      ...liked,
      loaded: false,
      items: [],
      visibleLikedCount: null,
      continuation: null,
      canLoadMore: false,
      canPrevious: false,
      pageNumber: 0,
      error: '浏览位置已失效，请刷新重新查看',
    },
    ['浏览位置已失效', '点赞说明'],
  ),
  fixture(
    'liked-previous',
    'community-liked',
    '前后翻页重新核验',
    { ...liked, pageNumber: 2, canPrevious: true, showInfo: true },
    ['上一页', '每次翻页重新核验'],
  ),
  fixture(
    'mine-empty',
    'community-mine',
    '仅状态记录为空',
    { ...mine, publications: [], tradingPosts: [], canLoadMore: false },
    ['还没有发布记录', '主题记录'],
  ),
  fixture('mine-guest', 'community-mine', '发布记录登录边界', guest, [
    '登录后查看发布',
    '主题记录',
  ]),
  fixture(
    'mine-busy',
    'community-mine',
    '发布记录加载中',
    {
      ...mine,
      loaded: false,
      busy: true,
      publications: [],
      tradingPosts: [],
      status: '正在读取发布状态',
    },
    ['正在读取发布状态', '停止加载'],
  ),
  fixture(
    'mine-all-recovery',
    'community-mine',
    '独立恢复入口',
    {
      ...mine,
      savedRecoveryPostId: 'qa-post',
      formationRecoveryPostId: 'qa-post',
      ballotRecoveryPostId: 'qa-post',
      discussionRecoveryPostId: 'qa-post',
      discussionRecoveryRootCommentId: 'qa-root',
      tradingRecoveryPostId: 'qa-post',
    },
    ['有结果待确认', '收藏或更新设置', '回复点赞或置顶'],
  ),
  fixture(
    'mine-hide-confirm',
    'community-mine',
    '隐藏前保留后果说明',
    {
      ...mine,
      ownerVisibility: {
        confirming: 'change',
        desired: true,
        busy: false,
        frozen: false,
      },
    },
    ['隐藏后其他人不可查看', '确认隐藏'],
  ),
  fixture(
    'mine-owner-recovery',
    'community-mine',
    '作者可见性结果未知',
    {
      ...mine,
      ownerVisibility: {
        frozen: true,
        busy: false,
        pendingPostId: 'qa-post',
        pendingOwnerHidden: true,
        pendingPhase: 'submit',
      },
    },
    ['原请求待确认', '查询不到回执不代表原请求不会完成'],
  ),
  fixture(
    'mine-tools',
    'community-mine',
    '管理入口与最小披露',
    { ...mine, showTools: true },
    ['不包含隐藏或已删除内容的正文、图片与身份', '原管理请求恢复'],
  ),
];
