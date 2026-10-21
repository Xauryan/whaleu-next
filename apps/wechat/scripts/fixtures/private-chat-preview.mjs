// Fictional source-preview fixtures. No user reference content or provider claims.
const conversation = {
  id: '55555555-5555-4555-8555-555555555555',
  self: {
    mode: 'named',
    displayName: '晴舟',
    profileId: '22222222-2222-4222-8222-222222222222',
  },
  peer: {
    mode: 'named',
    displayName: '拾青',
    profileId: '33333333-3333-4333-8333-333333333333',
  },
  source: {
    kind: 'post',
    postId: '44444444-4444-4444-8444-444444444444',
    available: true,
  },
  unreadCount: 2,
  hidden: false,
  sendAvailability: 'available',
  blockScope: 'named',
  blockedByYou: false,
};
const message = (suffix, sequence, sender, text, time, extra = {}) => ({
  id: `66666666-6666-4666-8666-66666666666${suffix}`,
  sequence: String(sequence),
  sender,
  state: 'text',
  text,
  createdAt: `2026-10-20T${time}:00Z`,
  canRecall: sender === 'self',
  ...extra,
});
const messages = [
  message('1', 1, 'peer', '你帖子里那本摄影书，还在吗？', '09:30'),
  message('2', 2, 'self', '在的，书页很新。周三可以带到图书馆。', '09:31'),
  message('3', 3, 'peer', '好呀，我下午三点有空。', '09:32'),
  message('4', 4, 'self', '那就三点，在一楼入口见。', '09:39'),
  message('5', 5, 'peer', '收到，到时见 🌿', '09:40'),
];
const uiMessages = messages.map((item, index) => ({
  ...item,
  timeLabel: item.createdAt.slice(11, 16),
  showTime: index === 0 || index === 3,
}));
const secondConversation = {
  ...conversation,
  id: '77777777-7777-4777-8777-777777777777',
  self: { mode: 'anonymous', displayName: '分身 07', profileId: null },
  peer: { mode: 'anonymous', displayName: '分身 12', profileId: null },
  unreadCount: 0,
  blockScope: 'conversation',
};
const items = [
  {
    id: conversation.id,
    conversation,
    latest: messages[4],
    updatedAt: messages[4].createdAt,
  },
  {
    id: secondConversation.id,
    conversation: secondConversation,
    latest: message('6', 1, 'peer', '谢谢分享，我也想去试试。', '08:20'),
    updatedAt: '2026-10-20T08:20:00Z',
  },
];
const loaded = {
  hasSession: true,
  busy: false,
  loaded: true,
  error: '',
  status: '',
  pending: false,
  coverage: 'complete',
};
const chat = {
  ...loaded,
  conversation,
  messages,
  uiMessages,
  canSend: true,
  text: '',
  canMore: true,
  uiPanel: '',
  uiMessageMenu: '',
  uiKeyboardHeight: 0,
  sendReason: '对方回复前仅可发送一条消息；撤回和隐藏不会恢复额度',
};
export default [
  {
    id: 'private-chat-list',
    page: 'private-message-list',
    title: '私信列表 · 虚构示例',
    patch: {
      ...loaded,
      items,
      uiItems: items.map((item) => ({
        ...item,
        initial: [...item.conversation.peer.displayName][0],
        timeLabel: item.updatedAt.slice(11, 16),
      })),
      unread: 2,
    },
    expectedText: ['我的私信', '拾青', '收到，到时见', '分身会话'],
  },
  {
    id: 'private-chat-loaded',
    page: 'private-message-detail',
    title: '私信会话 · 虚构示例',
    patch: chat,
    expectedText: [
      '拾青',
      '你帖子里那本摄影书，还在吗',
      '在一楼入口见',
      '09:39',
    ],
  },
  {
    id: 'private-chat-uncertain',
    page: 'private-message-detail',
    title: '私信结果待确认 · 虚构示例',
    patch: {
      ...chat,
      pending: true,
      error: '网络连接中断，发送结果尚未确认',
      text: '我到了，先在入口等你。',
    },
    expectedText: ['发送结果尚未确认', '原请求尚未确认', '拾青'],
  },
  {
    id: 'private-chat-recovery',
    page: 'private-message-recovery',
    title: '私信请求恢复 · 虚构示例',
    patch: {
      ...loaded,
      pending: true,
      operation: 'send',
      requestId: '88888888-8888-4888-8888-888888888888',
      conversationId: conversation.id,
      pendingText: '我到了，先在入口等你。',
      canRetry: true,
      status: '下面是原请求；查询不代表重新发送。重试始终使用相同编号和原文。',
    },
    expectedText: [
      '确认原请求',
      '结果还未确认',
      '我到了，先在入口等你',
      '先查询原回执',
    ],
  },
];
