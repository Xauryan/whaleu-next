/** Fictional layout-only fixtures. No real profiles, photos, services or remote images. */
const windowId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const replyId = '33333333-3333-4333-8333-333333333333';
const author = {
  mode: 'named',
  profileId: '44444444-4444-4444-8444-444444444444',
  displayName: '示例小舟',
};
const topic = {
  id: rootId,
  windowId,
  rootId: null,
  replyToReplyId: null,
  author,
  addressedAuthor: null,
  body: '今天试了番茄牛肉面，汤底很清爽。想听听大家还推荐这里的什么菜？',
  createdAt: '2026-10-20T11:40:00.000Z',
  likes: 12,
  replyCount: 3,
  isLiked: false,
  myMembershipRevision: null,
};
const reply = {
  ...topic,
  id: replyId,
  rootId,
  author: {
    ...author,
    profileId: '55555555-5555-4555-8555-555555555555',
    displayName: '示例阿禾',
  },
  body: '我更喜欢菌菇饭，赶上刚出锅的时候很香。',
  createdAt: '2026-10-20T12:15:00.000Z',
  likes: 2,
  replyCount: 0,
};
const ready = {
  loaded: true,
  hasSession: true,
  configured: true,
  busy: false,
  frozen: false,
  status: '',
  error: '',
  receiptStatus: '',
  timeLabels: { [rootId]: '11:40', [replyId]: '12:15' },
  totalCount: 1,
  pageNumber: 1,
  canNext: false,
  uiPanel: '',
};
const roots = { ...ready, mode: 'roots', root: null, items: [topic] };
const thread = { ...ready, mode: 'thread', root: topic, items: [reply] };
export default [
  {
    id: 'window-discussion-populated',
    page: 'window-discussion',
    title: '窗口主题列表 · 虚构示例',
    patch: roots,
    expectedText: ['示例小舟', topic.body, '3 条回复', '发布主题'],
  },
  {
    id: 'window-discussion-thread-populated',
    page: 'window-discussion-thread',
    title: '主题与回复 · 虚构示例',
    patch: thread,
    expectedText: [topic.body, reply.body, '按时间排序', '回复主题'],
  },
  {
    id: 'window-discussion-empty',
    page: 'window-discussion',
    title: '窗口讨论空态 · 虚构示例',
    patch: { ...roots, items: [], totalCount: 0 },
    expectedText: ['还没有主题', '发布主题'],
  },
  {
    id: 'window-discussion-compose',
    page: 'window-discussion',
    title: '发布主题 · 虚构示例',
    patch: {
      ...roots,
      uiPanel: 'compose',
      body: '今天的汤面很合口味。',
      bodyBytes: 30,
      canPublish: true,
      imageEnabled: true,
      imageCount: 0,
    },
    expectedText: ['公开昵称', '核对主题', '相册', '拍照'],
  },
  {
    id: 'window-discussion-reply-compose',
    page: 'window-discussion-thread',
    title: '回复同学 · 虚构示例',
    patch: {
      ...thread,
      uiPanel: 'compose',
      replyTarget: reply,
      body: '记下了，下次去尝尝。',
      bodyBytes: 30,
      canPublish: true,
    },
    expectedText: ['回复 示例阿禾', '改为回复主题', '核对回复'],
  },
  {
    id: 'window-discussion-image-recovery',
    page: 'window-discussion',
    title: '图片请求恢复 · 虚构示例',
    patch: {
      ...roots,
      loaded: false,
      items: [],
      imageEnabled: true,
      imagePending: true,
      imageFrozen: true,
      imageRecoverable: true,
      imageRequestId: rootId,
      imageStatus: '原图片讨论请求待确认，请查询原回执。',
    },
    expectedText: [
      '图片与发布进度',
      '查询原图片讨论回执',
      '取消整组图片与发布',
    ],
  },
  {
    id: 'window-discussion-publish-confirmation',
    page: 'window-discussion',
    title: '公开发布确认 · 虚构示例',
    patch: {
      ...roots,
      uiPanel: 'compose',
      confirming: 'publish',
      body: '喜欢这家窗口的番茄汤面。',
      imageCount: 0,
    },
    expectedText: ['确认公开发布', '喜欢这家窗口的番茄汤面。', '返回修改'],
  },
];
