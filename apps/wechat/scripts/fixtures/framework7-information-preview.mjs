// Synthetic source previews only. Not a WeChat-device, database or provider gate.
// Private media stays a controlled image state; no network asset is requested.
import information from './information-preview.mjs';
const pages = [
  'organizations',
  'organization-editor',
  'announcements',
  'announcement-detail',
];
const sample = (id) =>
  structuredClone(information.find((item) => item.id === id).patch);
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-information-${id}`,
  page,
  title: `Framework7 iOS 原生组织与公告 · ${title}`,
  patch,
  expectedText,
});
const organizations = sample('information-organizations-loaded');
const editor = sample('information-organization-editor');
const members = sample('information-organization-members');
const recovery = sample('information-organization-recovery');
const announcements = sample('information-announcements-loaded');
const article = sample('information-announcement-article');
article.detail.media.items[0].slot = 'gallery0';
export default [
  ...information
    .filter((item) => pages.includes(item.page))
    .map((item) => {
      const patch = structuredClone(item.patch);
      if (patch.detail?.media?.items)
        patch.detail.media.items.forEach((image) => {
          image.slot = 'gallery0';
        });
      return fixture(
        item.id.replace('information-', ''),
        item.page,
        item.title,
        patch,
        item.expectedText,
      );
    }),
  fixture(
    'organizations-empty',
    'organizations',
    '空组织列表',
    { ...organizations, items: [] },
    ['还没有组织或申请', '浏览校园目录'],
  ),
  fixture(
    'organizations-busy',
    'organizations',
    '组织核验中',
    {
      ...organizations,
      loaded: false,
      busy: true,
      items: [],
      status: '正在读取组织',
    },
    ['正在读取组织', '申请新组织'],
  ),
  fixture(
    'organizations-more',
    'organizations',
    '组织分页',
    { ...organizations, more: true },
    ['加载更多', '山野徒步社'],
  ),
  fixture(
    'organizations-fixed-review',
    'organizations',
    '固定学校审核范围',
    {
      ...organizations,
      mode: 'review',
      management: 'fixed',
      regionName: '青屿大学',
    },
    ['待我审核', '青屿大学'],
  ),
  fixture(
    'editor-qq',
    'organization-editor',
    'QQ群申请输入',
    {
      ...sample('information-organization-new'),
      form: { ...editor.form, platform: 'qq', qqGroupNumber: '123456789' },
    },
    ['QQ群号', '保存申请草稿'],
  ),
  fixture(
    'editor-review',
    'organization-editor',
    '审核权限与原版本',
    {
      ...editor,
      detail: {
        ...editor.detail,
        permissions: { ...editor.detail.permissions, review: true },
      },
      showInfo: true,
    },
    ['审核申请', '批准并授予申请人唯一所有权', '内容版本 3 · 权限版本 2'],
  ),
  fixture(
    'editor-readonly',
    'organization-editor',
    '不可编辑的当前资料',
    {
      ...editor,
      detail: {
        ...editor.detail,
        permissions: {
          edit: false,
          submit: false,
          review: false,
          manageMembers: false,
          transferOwner: false,
        },
      },
    },
    ['名称', '介绍', '我的组织与申请'],
  ),
  fixture(
    'editor-recovery-busy',
    'organization-editor',
    '原请求查询中',
    { ...recovery, busy: true },
    ['查询原操作结果', '取消原请求', '有图片上传等待确认'],
  ),
  fixture(
    'editor-upload-busy',
    'organization-editor',
    '图片审核中',
    {
      ...members,
      upload: { status: 'working', message: '正在审核原图片', progress: 45 },
    },
    ['正在审核原图片', '选择并审核图片'],
  ),
  fixture(
    'editor-transfer-authority',
    'organization-editor',
    '所有权转让须核对目标',
    members,
    ['转让后，旧所有者降为管理员', '转让所有权给此成员'],
  ),
  fixture(
    'announcements-empty',
    'announcements',
    '已核验的空公告列表',
    { ...announcements, items: [], canNext: false },
    ['当前范围暂无公告', '公告来源与浏览范围'],
  ),
  fixture(
    'announcements-busy',
    'announcements',
    '公告读取可停止',
    {
      ...announcements,
      loaded: false,
      busy: true,
      items: [],
      status: '正在读取当前公告',
    },
    ['正在读取当前公告', '停止读取'],
  ),
  fixture(
    'announcements-previous',
    'announcements',
    '前页重新读取',
    { ...announcements, pageNumber: 2, canPrevious: true },
    ['上一页', '下一页'],
  ),
  fixture(
    'announcements-guest',
    'announcements',
    '访客公开浏览',
    { ...announcements, hasSession: false },
    ['新发布', '历史公告', '图书馆夜读空间延长开放'],
  ),
  fixture(
    'article-unavailable',
    'announcement-detail',
    '图片能力不可用不误报为空',
    {
      ...article,
      detail: {
        ...article.detail,
        media: { status: 'unavailable', items: null },
      },
    },
    ['公告图片暂不可用', '给想多读一会儿的你'],
  ),
  fixture(
    'article-known-empty',
    'announcement-detail',
    '无图片的完整公告',
    {
      ...article,
      detail: {
        ...article.detail,
        media: { status: 'known_empty', items: [] },
      },
    },
    ['图书馆夜读空间延长开放', '给想多读一会儿的你'],
  ),
  fixture(
    'article-busy',
    'announcement-detail',
    '详情读取中',
    {
      ...article,
      loaded: false,
      busy: true,
      detail: null,
      status: '正在读取当前公告',
    },
    ['正在读取当前公告', '停止读取'],
  ),
];
