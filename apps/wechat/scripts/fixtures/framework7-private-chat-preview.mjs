// Fictional native-source states only. No real users, media paths, receipt or provider claims.
import legacy from './private-chat-preview.mjs';
const base = Object.fromEntries(legacy.map((fixture) => [fixture.id, fixture]));
const list = base['private-chat-list'].patch;
const chat = base['private-chat-loaded'].patch;
const recovery = base['private-chat-recovery'].patch;
const item = chat.uiMessages[1];
const make = (suffix, page, patch, title, expectedText) => ({
  id: `framework7-private-chat-${suffix}`,
  page: `private-message-${page}`,
  title: `${title} · 虚构原生示例`,
  patch,
  expectedText,
});
export default [
  make('list', 'list', list, '私信列表', ['我的私信', '拾青', '分身会话']),
  make(
    'list-menu',
    'list',
    { ...list, uiMenu: true, coverage: 'local' },
    '私信列表选项',
    ['刷新私信', '请求恢复', '仅显示已核验的本地历史'],
  ),
  make(
    'list-hide',
    'list',
    { ...list, confirmHide: list.items[0].id },
    '隐藏会话确认',
    ['隐藏此会话？', '历史不会删除', '确认隐藏'],
  ),
  make(
    'list-empty',
    'list',
    { ...list, items: [], uiItems: [], unread: 0 },
    '空私信列表',
    ['还没有私信', '新的聊天会出现在这里'],
  ),
  make(
    'list-pending',
    'list',
    { ...list, pending: true, error: '网络中断，请先确认原请求' },
    '列表待确认',
    ['有一条请求尚未确认', '网络中断'],
  ),
  make('detail', 'detail', chat, '原生聊天', ['拾青', '在一楼入口见', '09:39']),
  make(
    'detail-keyboard',
    'detail',
    { ...chat, text: '这段草稿尚未发送', uiKeyboardHeight: 248 },
    '原生键盘与未发送草稿',
    ['拾青', '收到，到时见'],
  ),
  make(
    'detail-menu',
    'detail',
    { ...chat, uiMessageMenu: item.id },
    '消息原生长按菜单',
    ['复制', '撤回', '收起'],
  ),
  make(
    'detail-media',
    'detail',
    { ...chat, uiPanel: 'media' },
    '图片来源选择',
    ['发送图片', '单张 JPEG / PNG，最多 5 MiB', '从相册发送图片', '取消'],
  ),
  make(
    'detail-conversation',
    'detail',
    { ...chat, uiPanel: 'conversation' },
    '会话原生选项',
    [
      '会话选项',
      '查看公开主页',
      '查看来源帖子',
      '离开页面会清除草稿和临时图片',
    ],
  ),
  make(
    'detail-confirm',
    'detail',
    {
      ...chat,
      confirm: {
        kind: 'block',
        description: '屏蔽后将不能继续在此会话发送消息。',
      },
    },
    '屏蔽确认',
    ['确认屏蔽？', '屏蔽后将不能继续', '取消'],
  ),
  make(
    'detail-uncertain',
    'detail',
    base['private-chat-uncertain'].patch,
    '发送结果待确认',
    ['发送结果尚未确认', '原请求尚未确认'],
  ),
  make(
    'detail-first-contact',
    'detail',
    {
      ...chat,
      canSend: false,
      sendReason: '对方回复前仅可发送一条消息；撤回和隐藏不会恢复额度',
    },
    '首条消息限制',
    ['对方回复前仅可发送一条消息', '拾青'],
  ),
  make(
    'detail-open',
    'detail',
    {
      ...chat,
      conversation: null,
      messages: [],
      uiMessages: [],
      needsOpen: true,
      openingMode: 'anonymous',
    },
    '分身身份确认',
    ['此帖子内的分身身份', '创建后不可切换', '确认身份并打开会话'],
  ),
  make(
    'detail-recalled',
    'detail',
    {
      ...chat,
      uiMessages: [
        { ...item, state: 'recalled', text: null, canRecall: false },
      ],
      messages: [{ ...item, state: 'recalled', text: null, canRecall: false }],
    },
    '已撤回消息',
    ['消息已撤回', '拾青'],
  ),
  make(
    'detail-image',
    'detail',
    {
      ...chat,
      uiMessages: [{ ...item, state: 'image', text: null }],
      messages: [{ ...item, state: 'image', text: null }],
      imagePath: '',
      imageMessageId: '',
    },
    '未加载私信图片',
    ['查看图片', '拾青'],
  ),
  make('recovery', 'recovery', recovery, '确认原请求', [
    '先查询原回执',
    '我到了，先在入口等你',
  ]),
  make(
    'recovery-details',
    'recovery',
    { ...recovery, uiDetails: true },
    '原请求详情',
    ['原请求编号', '重试使用原编号和原内容', '不会替换为新草稿'],
  ),
  make(
    'recovery-actions',
    'recovery',
    { ...recovery, uiActions: true },
    '原请求恢复方式',
    ['查询后按相同编号和原内容重试', '安全取消原请求', '返回'],
  ),
  make(
    'recovery-cancel',
    'recovery',
    { ...recovery, confirmCancel: true },
    '安全取消确认',
    ['阻止尚未执行的迟到请求', '不会撤销已发送消息', '保留原请求'],
  ),
  make(
    'recovery-scrubbed',
    'recovery',
    {
      ...recovery,
      pendingText: '',
      canRetry: false,
      uiDetails: true,
      status: '原文已在退出登录或切换账号时清除；只能查询回执或安全取消',
    },
    '账号变更后恢复',
    ['原文已在退出登录或切换账号时清除', '先查询原回执'],
  ),
  make(
    'recovery-edit',
    'recovery',
    {
      ...recovery,
      pending: false,
      canRetry: false,
      editing: true,
      draftText: '重新编辑的合成草稿',
      outcome: '内容未通过审核，可修改后发起新请求',
    },
    '重新编辑新草稿',
    [
      '未发送的原文',
      '这是新草稿，发送时会重新审核',
      '发送新草稿',
      '离开页面会清除这份临时草稿',
    ],
  ),
  make(
    'recovery-settled',
    'recovery',
    {
      ...recovery,
      pending: false,
      canRetry: false,
      outcome: '原请求已安全取消，迟到请求不会再执行',
    },
    '原请求已终结',
    ['已取得处理结果', '原请求已安全取消'],
  ),
];
