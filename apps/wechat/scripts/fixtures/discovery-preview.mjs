// Fictional layout data only. No runtime defaults, real users or campus evidence.
const base = {
  configured: true,
  hasSession: true,
  loaded: true,
  busy: false,
  status: '',
  error: '',
};
const unknownExperience = {
  title: { status: 'unavailable', value: null },
  color: { status: 'unavailable', value: null },
  level: { status: 'unavailable', value: null },
};
const named = {
  kind: 'named',
  displayName: '示例同学',
  experienceDisplay: unknownExperience,
};
const anonymous = { kind: 'anonymous', displayName: '蓝色小鲸' };
const campus = { id: 'qa-campus', name: '示例校园', kind: 'regional' };
const post = (id, text, extra = {}) => ({
  id,
  text,
  author: named,
  space: campus,
  category: 'discussion',
  component: { kind: 'none' },
  images: [],
  viewer: { isSelf: false, isSaved: false, canSave: true },
  likeCount: 12,
  commentCount: 4,
  replyCount: 2,
  discussionCount: 6,
  saveCount: 3,
  publishedAt: '2026-10-20T04:00:00.000Z',
  publishedAtLabel: '2026年10月20日',
  ...extra,
});
const hotPosts = [
  post(
    'qa-reading',
    '秋天最舒服的自习位置，原来就在图书馆靠窗的这一排。\n午后的光刚刚好，带本书坐一会儿。',
  ),
  post('qa-running', '周末想沿着校园的小路慢跑，有一起出发的朋友吗？', {
    author: anonymous,
    component: {
      kind: 'formation',
      formation: {
        theme: '一起慢跑，顺便认识新朋友',
        memberCount: 3,
        capacity: 6,
        status: 'open',
      },
    },
  }),
];
const searchPatch = {
  ...base,
  scopeLoaded: true,
  selectedScope: 'all',
  inputDraft: '自习',
  submittedQuery: '自习',
  mode: 'keyword',
  searchType: 'all',
  effectiveTypes: ['post', 'comment', 'reply'],
  category: 'all',
  regional: campus,
  pageNumber: 1,
  continuation: 'more',
  canNext: true,
  hits: [
    {
      key: 'qa-hit-one',
      kind: 'post',
      contentId: 'qa-reading',
      postId: 'qa-reading',
      author: named,
      space: campus,
      category: 'discussion',
      createdAtLabel: '2026年10月20日',
      snippet: {
        truncatedBefore: false,
        truncatedAfter: false,
        segments: [
          { text: '安静的', matched: false },
          { text: '自习', matched: true },
          { text: '角落，在图书馆二层靠窗的位置。', matched: false },
        ],
      },
    },
    {
      key: 'qa-hit-two',
      kind: 'comment',
      contentId: 'qa-comment',
      postId: 'qa-another',
      author: anonymous,
      space: campus,
      category: 'research',
      createdAtLabel: '2026年10月19日',
      postSummary: '想找一个能专心读书的地方',
      snippet: {
        truncatedBefore: false,
        truncatedAfter: true,
        segments: [
          { text: '下午可以去北侧', matched: false },
          { text: '自习', matched: true },
          { text: '室，人会少一些。', matched: false },
        ],
      },
    },
  ],
};
const directoryEntry = (id, name, intro, extra = {}) => ({
  id,
  name,
  introPreview: intro,
  kind: 'school',
  platform: 'qq',
  categoryId: 'qa-category',
  badge: { status: 'known', value: null },
  avatar: { status: 'absent', value: null },
  ...extra,
});
const directoryDetail = {
  ...directoryEntry(
    'qa-photo',
    '示例校园摄影交流',
    '从日常光影开始，记录属于你的校园。',
  ),
  introText:
    '从日常光影开始，记录属于你的校园。\n\n这里交流拍摄心得，也分享散步时遇见的小小惊喜。新手也欢迎加入。',
  introImages: { status: 'known', items: [] },
  mainQr: { status: 'absent', value: null },
  managerWechatImage: { status: 'absent', value: null },
  linkedOfficialAccountQr: { status: 'absent', value: null },
  qqGroupNumber: { status: 'known', value: '123456789' },
  createdAtLabel: '2026年9月1日',
  updatedAtLabel: '2026年10月20日',
};
export default [
  {
    id: 'discovery-search-results',
    page: 'community-search',
    title: '搜索结果 · 合成内容',
    patch: searchPatch,
    expectedText: [
      '安静的',
      '图书馆二层靠窗的位置。',
      '想找一个能专心读书的地方',
      '主题内搜索',
    ],
  },
  {
    id: 'discovery-search-filters',
    page: 'community-search',
    title: '搜索筛选 · 合成内容',
    patch: {
      ...searchPatch,
      showFilters: true,
      fromDay: '2026-10-01',
      from: '2026-10-01T00:00:00.000Z',
      category: 'trading',
    },
    expectedText: ['搜索方式', '社区范围', '全部交易', 'UTC 日期', '清除日期'],
  },
  {
    id: 'discovery-search-pending',
    page: 'community-search',
    title: '尚未查完 · 不能判为空',
    patch: { ...searchPatch, hits: [], continuation: 'scan_pending' },
    expectedText: ['搜索尚未完成', '继续查找', '不代表没有匹配项'],
  },
  {
    id: 'discovery-hot-loaded',
    page: 'community-hot',
    title: '热榜 · 合成内容',
    patch: {
      ...base,
      space: campus,
      selectedSpaceId: campus.id,
      posts: hotPosts,
      range: 'week',
      continuation: 'more',
      canNext: true,
    },
    expectedText: [
      '图书馆靠窗的这一排',
      '一起慢跑，顺便认识新朋友',
      '蓝色小鲸',
      '3 / 6 人',
    ],
  },
  {
    id: 'discovery-saved-loaded',
    page: 'community-saved',
    title: '收藏 · 合成内容',
    patch: {
      ...base,
      visibleSavedCount: 2,
      canLoadMore: true,
      items: hotPosts.map((item, index) => ({
        saveEpochId: `qa-save-${index}`,
        savedAtLabel: '2026年10月20日',
        post: item,
      })),
    },
    expectedText: [
      '2 条可查看',
      '图书馆靠窗的这一排',
      '取消收藏',
      '收藏的更新',
    ],
  },
  {
    id: 'discovery-saved-recovery',
    page: 'community-saved',
    title: '收藏结果恢复',
    patch: {
      ...base,
      savedMutation: {
        frozen: true,
        busy: false,
        actionLabel: '取消收藏',
        status: '结果待确认',
        receiptStatus: '',
        error: '',
        recoveryPostId: 'qa-reading',
      },
      items: [],
    },
    expectedText: ['结果待确认', '查询原请求回执', '重试完全相同的原请求'],
  },
  {
    id: 'discovery-liked-loaded',
    page: 'community-liked',
    title: '点赞 · 合成内容',
    patch: {
      ...base,
      pageNumber: 1,
      visibleLikedCount: 2,
      continuation: 'end',
      items: [
        {
          likeId: 'qa-like-post',
          kind: 'post',
          postId: 'qa-reading',
          likedAtLabel: '2026年10月20日',
          preview: {
            author: named,
            text: '校园落叶的颜色，已经悄悄变了。',
            images: [],
            isSelf: false,
          },
        },
        {
          likeId: 'qa-like-reply',
          kind: 'reply',
          postId: 'qa-reading',
          rootCommentId: 'qa-root',
          targetId: 'qa-reply',
          likedAtLabel: '2026年10月19日',
          preview: {
            author: anonymous,
            text: '傍晚的这条路也很好看，值得慢慢走一次。',
            images: [],
            isSelf: false,
          },
        },
      ],
    },
    expectedText: [
      '校园落叶的颜色',
      '值得慢慢走一次',
      '定位回复',
      '已到本次浏览末尾',
    ],
  },
  {
    id: 'discovery-liked-count-unavailable',
    page: 'community-liked',
    title: '点赞数量不可确认',
    patch: {
      ...base,
      visibleLikedCount: null,
      visibleLikedCountStatus: 'unavailable',
      continuation: 'scan_pending',
      canLoadMore: true,
      pageNumber: 1,
      items: [],
    },
    expectedText: ['准确总数暂不可用', '还有历史记录待核验', '继续查看'],
  },
  {
    id: 'discovery-mine-records',
    page: 'community-mine',
    title: '发布状态 · 无隐藏正文',
    patch: {
      ...base,
      publications: [
        {
          id: 'qa-own-one',
          status: 'published',
          publishedAtLabel: '2026年10月20日',
          ownerVisibility: { canChange: true, ownerHidden: false, version: 2 },
        },
        {
          id: 'qa-own-two',
          status: 'hidden',
          publishedAtLabel: '2026年10月18日',
          ownerVisibility: { canChange: true, ownerHidden: true, version: 3 },
        },
        {
          id: 'qa-own-three',
          status: 'deleted',
          publishedAtLabel: '2026年10月12日',
        },
      ],
    },
    expectedText: ['已发布', '已隐藏', '已删除', '取消隐藏', '正文不可查看'],
  },
  {
    id: 'discovery-mine-recovery',
    page: 'community-mine',
    title: '原互动恢复 · 合成状态',
    patch: {
      ...base,
      ballotRecoveryPostId: 'qa-vote',
      savedRecoveryPostId: 'qa-save',
      showTools: true,
      publications: [],
    },
    expectedText: [
      '有结果待确认',
      '收藏或更新设置',
      '投票',
      '查看待确认的主题与回复',
      '原管理请求恢复',
    ],
  },
  {
    id: 'discovery-directory-hub',
    page: 'directory-hub',
    title: '校园目录 · 合成分类',
    patch: {
      ...base,
      kind: 'school',
      pageNumber: 1,
      categories: [
        {
          id: 'qa-clubs',
          name: '兴趣同好',
          description: '把热爱分享给同频的朋友',
          accent: 'green',
        },
        {
          id: 'qa-study',
          name: '学习交流',
          description: '一起讨论，互相进步',
          accent: 'lilac',
        },
        {
          id: 'qa-sport',
          name: '运动搭子',
          description: '下一场，一起上场',
          accent: 'orange',
        },
        {
          id: 'qa-life',
          name: '校园生活',
          description: '认识校园的另一面',
          accent: 'cyan',
        },
      ],
    },
    expectedText: [
      '兴趣同好',
      '学习交流',
      '运动搭子',
      '校园生活',
      '我管理的组织',
    ],
  },
  {
    id: 'discovery-directory-list',
    page: 'directory-list',
    title: '群聊列表 · 两个来源',
    patch: {
      ...base,
      kind: 'school',
      categoryId: 'qa-category',
      pageNumber: 1,
      entries: [
        directoryEntry(
          'qa-photo',
          '示例校园摄影交流',
          '从日常光影开始，记录属于你的校园。',
        ),
        directoryEntry(
          'qa-read',
          '示例阅读分享',
          '读到喜欢的段落，来这里聊一聊。',
          { platform: 'wechat' },
        ),
      ],
      nativeDirectory: {
        loaded: true,
        busy: false,
        error: '',
        more: true,
        items: [
          {
            id: 'qa-native',
            data: {
              name: '示例徒步社',
              introText: '用周末的脚步，探索校园周围的风景。',
              platform: 'qq',
            },
          },
        ],
      },
    },
    expectedText: [
      '示例校园摄影交流',
      '示例阅读分享',
      '示例徒步社',
      '本平台组织',
      '下一批本平台组织',
    ],
  },
  {
    id: 'discovery-directory-detail-qq',
    page: 'directory-detail',
    title: '群聊详情 · 合成号码',
    patch: { ...base, managed: false, canCopy: true, detail: directoryDetail },
    expectedText: [
      '示例校园摄影交流',
      '新手也欢迎加入',
      '123456789',
      '复制群号',
    ],
  },
  {
    id: 'discovery-directory-detail-wechat',
    page: 'directory-detail',
    title: '微信群详情 · 没有假二维码',
    patch: {
      ...base,
      managed: false,
      detail: {
        ...directoryDetail,
        name: '示例阅读分享',
        platform: 'wechat',
        qqGroupNumber: { status: 'not_applicable', value: null },
        mainQr: { status: 'unavailable', value: null },
      },
    },
    expectedText: [
      '示例阅读分享',
      '加入微信群',
      '入群二维码暂不可用',
      '管理员微信二维码未提供',
    ],
  },
  {
    id: 'discovery-directory-detail-managed',
    page: 'directory-detail',
    title: '组织详情 · 授权图片入口',
    patch: {
      ...base,
      managed: true,
      nativeDetail: {
        busy: false,
        error: '',
        id: 'qa-native',
        publicDetail: {
          data: {
            name: '示例徒步社',
            platform: 'wechat',
            introText: '用周末的脚步，探索校园周围的风景。',
          },
          management: { available: true },
        },
        slots: [{ slot: 'main_qr', label: '入群二维码' }],
      },
      nativeImage: {
        src: '',
        message: '图片暂时无法显示，请重试。',
        status: 'unavailable',
      },
    },
    expectedText: [
      '示例徒步社',
      '管理此组织',
      '查看已审核图片',
      '图片暂时无法显示',
    ],
  },
];
