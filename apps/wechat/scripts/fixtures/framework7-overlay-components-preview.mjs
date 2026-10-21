/**
 * Fictional, source-only presentation cases. The catalog renders each case in
 * light and dark from actual native Component/WXML/WXSS source.
 * No account, provider, persistence, domain action, keyboard or device proof.
 * "Loading" and "error" are explicit owner-provided sample properties only.
 */
const sheet = (id, title, disabled) => ({
  id,
  title,
  markup: `<wu-f7-sheet open="{{true}}" session-id="${id}" title="虚构校园资料" disabled="{{disabled}}"><view slot="header">仅用于组件评审</view><view>这是一段虚构的面板正文，不连接真实服务。</view><view slot="footer">示例页脚 · 不执行操作</view></wu-f7-sheet>`,
  scope: { disabled },
  expected: ['虚构校园资料', '仅用于组件评审', '虚构的面板正文', '示例页脚'],
});
const actions = (id, title, disabled = false, loading = false) => ({
  id,
  title,
  markup: `<wu-f7-actions open="{{true}}" session-id="${id}" title="虚构操作列表" actions="{{actions}}" disabled="{{disabled}}" loading="{{loading}}" cancel-label="返回示例" />`,
  scope: {
    disabled,
    loading,
    actions: [
      { id: 'inspect', label: '查看虚构资料', strong: true },
      { id: 'remove', label: '移除虚构条目', destructive: true },
      { id: 'unavailable', label: '示例操作不可用', disabled: true },
    ],
  },
  expected: [
    '虚构操作列表',
    '查看虚构资料',
    '移除虚构条目',
    '示例操作不可用',
    '返回示例',
    ...(loading ? ['处理中…'] : []),
  ],
});
const dialog = (id, title, mode, patch = {}) => ({
  id,
  title,
  markup: `<wu-f7-dialog open="{{true}}" session-id="${id}" mode="{{mode}}" title="虚构对话框示例" message="仅供布局评审，不执行提交或清除。" confirm-label="确认示例" cancel-label="返回示例" confirm-id="preview-confirm" destructive="{{destructive}}" value="{{value}}" input-label="虚构显示名称" placeholder="请输入示例文字" error-text="{{errorText}}" disabled="{{disabled}}" loading="{{loading}}" focus="{{focus}}" keyboard-height="{{keyboardHeight}}" />`,
  scope: {
    mode,
    destructive: false,
    value: '示例同学',
    errorText: '',
    disabled: false,
    loading: false,
    focus: false,
    keyboardHeight: 0,
    ...patch,
  },
  expected: [
    '虚构对话框示例',
    '不执行提交或清除',
    '确认示例',
    ...(mode !== 'alert' ? ['返回示例'] : []),
    ...(mode === 'prompt' ? ['虚构显示名称'] : []),
    ...(patch.errorText ? [patch.errorText] : []),
  ],
});

export default [
  sheet('overlay-sheet', 'Sheet · 虚构内容与具名插槽', false),
  sheet('overlay-sheet-disabled', 'Sheet · 禁用示例', true),
  actions('overlay-actions', 'Actions · 普通 / 强调 / 危险 / 禁用'),
  actions('overlay-actions-disabled', 'Actions · 全部禁用示例', true),
  actions('overlay-actions-loading', 'Actions · 处理中示例', false, true),
  dialog('overlay-dialog-alert', 'Dialog · Alert 提示示例', 'alert'),
  dialog('overlay-dialog-confirm', 'Dialog · Confirm 确认示例', 'confirm', {
    destructive: true,
  }),
  dialog('overlay-dialog-prompt', 'Dialog · Prompt 输入示例', 'prompt'),
  dialog('overlay-dialog-error', 'Dialog · 输入错误示例', 'prompt', {
    errorText: '示例校验错误，请检查名称格式',
  }),
  dialog('overlay-dialog-disabled', 'Dialog · 输入与按钮禁用示例', 'prompt', {
    disabled: true,
  }),
  dialog('overlay-dialog-loading', 'Dialog · 确认处理中示例', 'confirm', {
    loading: true,
  }),
  dialog(
    'overlay-dialog-keyboard',
    'Dialog · 240px 键盘偏移示例，非真机键盘',
    'prompt',
    { keyboardHeight: 240, focus: true },
  ),
];
