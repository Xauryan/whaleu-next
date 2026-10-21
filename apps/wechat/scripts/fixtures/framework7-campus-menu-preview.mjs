// Fictional source fixtures only. These do not configure a real campus/provider.
const campus = { busy: false, state: 'ready', error: '', status: '' };
const sample = (id, title, patch, expectedText) => ({
  id: `framework7-campus-menu-${id}`,
  page: 'campus-hub',
  title,
  patch: { campusLabel: '示例大学 · 主校区', campus, ...patch },
  expectedText,
});
export default [
  sample('ready', '校园工具与真实导航', {}, [
    '校园地图',
    '课程评价',
    '校园跑腿',
    '我的课表',
    '暂未接入',
  ]),
  sample('loading', '读取当前校园', { campus: { ...campus, busy: true } }, [
    '正在读取校园工具',
    '科研资源',
  ]),
  sample('auth', '登录状态恢复', { authRecovery: true }, [
    '登录状态需要重新确认',
    '前往确认',
  ]),
  sample(
    'error',
    '可恢复的工具错误',
    { campus: { ...campus, error: '校园目录暂时无法读取。' } },
    ['校园目录暂时无法读取', '重试'],
  ),
  sample(
    'navigation-error',
    '原生导航失败',
    { navigationError: '暂时无法打开，请稍后重试。' },
    ['暂时无法打开', '重试'],
  ),
  {
    id: 'framework7-campus-menu-services',
    page: 'account-menu',
    title: '二级服务菜单',
    patch: {},
    expectedText: ['我的全部发布', '登录与会话', '校园工具'],
  },
];
