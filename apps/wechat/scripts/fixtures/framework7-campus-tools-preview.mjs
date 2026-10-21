// Synthetic source-preview states only, not WeChat-device or live-campus proof.
// No provider, map, location, clipboard, remote URL, media download or permission
// is invoked. Reuse existing fictional fixtures, never runtime defaults.
import tools from './campus-tools-preview.mjs';
const sample = (id) =>
  structuredClone(tools.find((item) => item.id === id).patch);
const map = sample('campus-tools-map-loaded');
const shuttle = sample('campus-tools-shuttle-loaded');
const research = sample('campus-tools-research-loaded');
const webview = sample('campus-tools-webview-unavailable');
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-campus-tools-${id}`,
  page,
  title: `Framework7 iOS 原生校园工具 · ${title}`,
  patch,
  expectedText,
});
const image = {
  expanded: true,
  selected: 0,
  total: 2,
  src: '',
  viewId: '',
  alt: '合成资料预览',
  status: 'loading',
  message: '正在读取当前图片',
};
export default [
  ...tools
    .filter((item) => item.page !== 'campus-tools')
    .map((item) =>
      fixture(
        item.id.replace('campus-tools-', ''),
        item.page,
        item.title,
        item.patch,
        item.expectedText,
      ),
    ),
  fixture(
    'map-locating',
    'campus-tools-map',
    '本次定位进行中',
    { ...map, locateEnabled: true, locating: true, status: '正在请求本次定位' },
    ['正在请求本次定位', '定位到我', '回到校区'],
  ),
  fixture(
    'map-denied',
    'campus-tools-map',
    '拒绝定位仍可浏览',
    {
      ...map,
      locateEnabled: true,
      status: '未获得定位权限，仍可浏览地图；可自愿重试',
    },
    ['未获得定位权限', '示例图书馆'],
  ),
  fixture(
    'map-empty',
    'campus-tools-map',
    '未提供校园地点',
    { ...map, entry: { ...map.entry, markers: [] }, markers: [] },
    ['暂无地点信息', '0 个'],
  ),
  fixture(
    'shuttle-collapsed',
    'campus-tools-shuttle',
    '资料分组全部收起',
    { ...shuttle, expandedGroups: {} },
    ['示例校区 · 工作日', '2 张资料', '暂无图片'],
  ),
  fixture(
    'shuttle-empty-group',
    'campus-tools-shuttle',
    '空资料分组',
    { ...shuttle, expandedGroups: { 'qa-holiday': true } },
    ['本组暂无图片'],
  ),
  fixture(
    'shuttle-empty',
    'campus-tools-shuttle',
    '没有校车资料',
    { ...shuttle, entry: { ...shuttle.entry, groups: [] } },
    ['暂无校车资料'],
  ),
  fixture(
    'shuttle-image-loading',
    'campus-tools-shuttle',
    '资料读取中无伪造媒体',
    { ...shuttle, image },
    ['正在读取当前图片', '1 / 2', '上一张', '下一张'],
  ),
  fixture(
    'shuttle-image-last',
    'campus-tools-shuttle',
    '最后一张不可再向后',
    {
      ...shuttle,
      image: {
        ...image,
        selected: 1,
        status: 'unavailable',
        message: '图片暂不可用，请重新核对并重试',
      },
    },
    ['2 / 2', '重试当前图片'],
  ),
  fixture(
    'research-copy-busy',
    'campus-tools-research',
    '核对当前链接',
    { ...research, busy: true, status: '正在核对当前外部链接' },
    ['正在核对当前外部链接', '复制资源链接'],
  ),
  fixture(
    'research-copy-retry',
    'campus-tools-research',
    '复制失败保留重试',
    { ...research, error: '复制失败，请重试' },
    ['复制失败，请重试', '复制资源链接'],
  ),
  fixture(
    'research-no-link-image',
    'campus-tools-research',
    '只有文字说明',
    { ...research, entry: { ...research.entry, image: null, link: null } },
    ['学术资源导航', '适用说明'],
  ),
  fixture(
    'research-image-retry',
    'campus-tools-research',
    '资源图片重试',
    {
      ...research,
      image: {
        ...image,
        total: 1,
        status: 'unavailable',
        message: '图片显示失败，请重试',
      },
    },
    ['1 / 1', '图片显示失败，请重试', '重试当前图片'],
  ),
  fixture(
    'webview-loading',
    'campus-tools-webview',
    '可信嵌入核验尚未完成',
    { ...webview, state: 'enabled', busy: true, status: '正在读取当前工具' },
    ['正在连接', '正在读取当前工具'],
  ),
  fixture(
    'webview-error',
    'campus-tools-webview',
    '可信工具加载失败',
    {
      state: 'unavailable',
      status: '校园工具暂不可用，请刷新当前资料',
      error: '外部工具加载失败，请刷新后重试',
    },
    ['暂时无法打开', '外部工具加载失败'],
  ),
  fixture(
    'webview-disabled',
    'campus-tools-webview',
    '停用工具不加载',
    { state: 'disabled', status: '此工具已停用' },
    ['此工具已停用'],
  ),
  fixture(
    'webview-withdrawn',
    'campus-tools-webview',
    '撤回工具不加载',
    { state: 'withdrawn', status: '此工具已撤回' },
    ['此工具已撤回'],
  ),
  ...['map', 'shuttle', 'research', 'webview'].map((kind) =>
    fixture(
      `${kind}-recovery`,
      `campus-tools-${kind}`,
      '登录恢复不展示旧工具',
      {
        authRecovery: true,
        error: '登录状态未能恢复。请重新登录，或明确选择以访客继续。',
      },
      ['重新登录', '以访客继续'],
    ),
  ),
];
