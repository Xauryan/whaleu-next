// Fictional source-only presentation samples. Never shipped or sent to a provider.
// The parent preview runner renders every state as a light/dark pair. Native
// scroll locking, animation acknowledgement and interaction are tested separately.
const normal = {
  configured: true,
  hasSession: true,
  loaded: true,
  busy: false,
  status: '仅展示当前仍可查看的帖子',
  error: '',
  items: [
    {
      postId: '96000000-0000-4000-8000-000000000002',
      summary: '图书馆靠窗的座位，刚好能看到银杏慢慢变黄。',
      viewedAt: '2026/10/20 16:30:00',
    },
    {
      postId: '96000000-0000-4000-8000-000000000004',
      summary: '校园里适合散步的小路，你最喜欢哪一条？',
      viewedAt: '2026/10/19 19:12:00',
    },
  ],
  page: 1,
  canMore: true,
  canPrevious: false,
  confirmClear: false,
  historyOverlayLocked: false,
  historyPageStyle: '',
  clearDialogOpen: false,
  clearDialogSessionId: '',
  clearDialogAttempt: 0,
  clearDialogLoading: false,
  clearDialogError: '',
};
const confirm = {
  ...normal,
  confirmClear: true,
  historyOverlayLocked: true,
  historyPageStyle: 'overflow: hidden;',
  clearDialogOpen: true,
  clearDialogSessionId: 'synthetic-history-confirm',
};
const failure = '本机存储清理失败，记录已停止显示；请重试清空。';
export default [
  {
    id: 'framework7-overlays-history-normal',
    page: 'browsing-history',
    title: '原生 Dialog · 本机浏览记录',
    patch: normal,
    expectedText: ['本机 · 最近 30 天', '银杏慢慢变黄', '下一页'],
  },
  {
    id: 'framework7-overlays-history-confirm',
    page: 'browsing-history',
    title: '原生 Dialog · 清空确认',
    patch: confirm,
    expectedText: [
      '清空本机浏览记录？',
      '不会删除帖子，也不会影响收藏。',
      '取消',
      '清空记录',
    ],
  },
  {
    id: 'framework7-overlays-history-error',
    page: 'browsing-history',
    title: '原生 Dialog · 本机清理失败后明确重试',
    patch: {
      ...confirm,
      items: [],
      loaded: false,
      canMore: false,
      status: '清理未完成',
      error: failure,
      clearDialogSessionId: 'synthetic-history-error',
      clearDialogAttempt: 1,
      clearDialogError: failure,
    },
    expectedText: ['清空本机浏览记录？', failure, '重试清空', '取消'],
  },
].map((fixture) => ({ ...fixture, themes: ['light', 'dark'] }));
