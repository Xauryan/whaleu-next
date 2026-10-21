// Fictional source-preview states only. No runtime defaults, real accounts,
// network images, provider calls, device screenshots or saved preferences.
import discovery from './discovery-preview.mjs';
import information from './information-preview.mjs';
const search = discovery.find(
  (item) => item.id === 'discovery-search-results',
).patch;
const qq = discovery.find(
  (item) => item.id === 'discovery-directory-detail-qq',
).patch;
const preferences = [
  ['showOfficialAccountTip', '公众号提示', true, ''],
  ['showHotTopic', '每日热榜', true, ''],
  ['showGroupNotice', '校园群提示', true, ''],
  ['showTradingGroupNotice', '交易群提示', true, ''],
  ['showErrandGroupNotice', '跑腿群提示', false, ''],
  ['defaultAnonymousEnabled', '默认分身发布', false, ''],
  ['defaultCommentAnonymousEnabled', '回复默认使用分身', false, ''],
  ['defaultCommentNonAnonymousEnabled', '回复默认不使用分身', true, ''],
  [
    'defaultAllowAnonymousDm',
    '默认允许分身私信',
    false,
    '作为后续发布功能的默认偏好',
  ],
  [
    'hideProfilePosts',
    '隐藏个人主页帖子',
    true,
    '对其他人隐藏主页帖子、交易与对应数量；不会删除内容',
  ],
  ['activitySubscribed', '活动提醒', true, '保存活动提醒偏好，消息投递待接入'],
].map(([key, label, checked, hint]) => ({ key, label, checked, hint }));
const settings = {
  hasSession: true,
  configured: true,
  loaded: true,
  loading: false,
  saving: false,
  needsReload: false,
  preferencesDirty: false,
  preferences,
  error: '',
  validationError: '',
  status: '',
};
const fixture = (id, page, title, patch, expectedText) => ({
  id,
  page,
  title,
  patch,
  expectedText,
});
export default [
  ...discovery
    .filter((item) =>
      ['community-search', 'directory-detail'].includes(item.page),
    )
    .map((item) =>
      item.patch.managed
        ? {
            ...item,
            patch: {
              ...item.patch,
              nativeDetail: {
                ...item.patch.nativeDetail,
                slots: [{ slot: 'mainQr', label: '入群二维码' }],
              },
            },
          }
        : item,
    ),
  ...information.filter((item) => item.page === 'school-services'),
  fixture(
    'search-unsubmitted',
    'community-search',
    '未提交输入 · 保留已提交结果',
    {
      ...search,
      inputDraft: '中文输入中',
      relatedCampusDistribution: 'unavailable',
    },
    ['输入尚未提交', '当前结果与筛选仍使用「自习」', '仅展示已核验内容'],
  ),
  fixture(
    'search-guest',
    'community-search',
    '访客 · 主题结果与登录边界',
    {
      ...search,
      hasSession: false,
      effectiveTypes: ['post'],
      continuation: 'login_required',
    },
    ['登录后可搜索回复', '本次仅搜索帖子', '继续查找需要登录及手机号验证'],
  ),
  fixture(
    'search-phone',
    'community-search',
    '手机号验证 · 非结果终点',
    { ...search, hits: [], continuation: 'phone_verification_required' },
    ['继续查找需要手机号验证', '完成后请重新搜索'],
  ),
  fixture(
    'search-busy',
    'community-search',
    '查询进行中 · 显式取消',
    {
      ...search,
      busy: true,
      loaded: false,
      hits: [],
      status: '正在搜索已核验内容',
    },
    ['正在搜索已核验内容', '停止搜索'],
  ),
  fixture(
    'search-error',
    'community-search',
    '查询失败 · 不伪造空结果',
    {
      ...search,
      error: '搜索暂时无法完成，请重试',
      hits: [],
      continuation: 'idle',
      canNext: false,
    },
    ['搜索暂时无法完成，请重试', '搜索说明'],
  ),
  fixture('settings-ready', 'settings', '设置 · 服务端已确认值', settings, [
    '公众号提示',
    '隐藏个人主页帖子',
    '消息投递待接入',
  ]),
  fixture(
    'settings-dirty',
    'settings',
    '设置 · 未保存修改',
    { ...settings, preferencesDirty: true },
    ['保存设置', '取消修改'],
  ),
  fixture(
    'settings-saving',
    'settings',
    '设置 · 保存中禁止重入',
    {
      ...settings,
      preferencesDirty: true,
      saving: true,
      status: '正在保存设置',
    },
    ['正在保存设置', '保存设置', '停止等待'],
  ),
  fixture(
    'settings-conflict',
    'settings',
    '设置 · 冲突锁定与重载',
    {
      ...settings,
      preferencesDirty: true,
      needsReload: true,
      error: '设置已在其他位置更新，请重新加载',
      status: '重新加载前不能继续保存',
    },
    ['设置已在其他位置更新', '重新加载前不能继续保存', '重新加载'],
  ),
  fixture(
    'settings-guest',
    'settings',
    '设置 · 未登录不构造偏好',
    { ...settings, hasSession: false, loaded: false, preferences: [] },
    ['登录后设置', '重新加载'],
  ),
  fixture(
    'directory-copy-busy',
    'directory-detail',
    '已核验目录 · 复制进行中',
    { ...qq, copyBusy: true, showInfo: true },
    ['复制群号', '浏览校园不改变访问范围', '创建于'],
  ),
  fixture(
    'directory-provenance',
    'directory-detail',
    '公众号 · 不混淆推广与所有权',
    {
      ...qq,
      canCopy: false,
      showInfo: true,
      detail: {
        ...qq.detail,
        platform: 'official',
        badge: { status: 'known', value: 'official' },
        mainQr: { status: 'unavailable', value: null },
      },
    },
    ['官方推广', '关注二维码暂不可用', '不代表已证明机构所有权'],
  ),
].map((item) => ({
  ...item,
  id: `framework7-forms-${item.id}`,
  title: `Framework7 iOS 原生表单 · ${item.title}`,
}));
