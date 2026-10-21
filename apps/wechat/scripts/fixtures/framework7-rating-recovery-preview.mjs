// Fictional local-only snapshots. Never provider/account data or live commands.
import management from './rating-management-preview.mjs';
import ratings from './ratings-preview.mjs';
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-rating-recovery-${id}`,
  page,
  title: `Framework7 iOS 原生评分恢复 · ${title}`,
  patch,
  expectedText,
});
const sample = (id) =>
  structuredClone(management.find((item) => item.id === id).patch);
const random = structuredClone(
  ratings.find((item) => item.page === 'rating-random').patch,
);
export default [
  ...management.map((item) =>
    fixture(item.id, item.page, item.title, item.patch, item.expectedText),
  ),
  fixture('random-result', 'rating-random', '完整候选随机结果', random, [
    '这次选中了',
    '湖畔自习室',
    '再选一个',
  ]),
  fixture(
    'random-empty',
    'rating-random',
    '无符合筛选对象',
    { ...random, result: { item: null, candidateCount: 0 } },
    ['没有符合条件的对象', '最低均分'],
  ),
  fixture(
    'random-info',
    'rating-random',
    '重复抽选与统计边界',
    { ...random, uiPanel: 'info' },
    ['可能再次选中同一个对象', '统计无法确认时不会进行抽取'],
  ),
  fixture(
    'random-campus-picker',
    'rating-random',
    '独立校园选择',
    {
      ...random,
      pickerOpen: true,
      campusQuery: '鲸语大学',
      campuses: [
        {
          id: 'fictional-campus',
          fullName: '鲸语大学主校区',
          institutionName: '鲸语大学',
          district: '示例地区',
          isActive: true,
          institutionId: 'fictional-school',
        },
      ],
    },
    ['选择学校与校区', '鲸语大学主校区', '选择此校区所属学校', '关闭选择'],
  ),
  fixture(
    'random-guest',
    'rating-random',
    '访客',
    { ...random, hasSession: false, result: null },
    ['登录后继续', '重选条件'],
  ),
  fixture(
    'random-busy',
    'rating-random',
    '停止等待不伪造结果',
    { ...random, busy: true, status: '正在核验完整候选范围', result: null },
    ['正在核验完整候选范围', '停止等待'],
  ),
  fixture(
    'category-lifecycle',
    'rating-category-editor',
    '生命周期选择保持独立',
    {
      ...sample('category-editor-normal'),
      operation: 'set_category_lifecycle_scoped',
      operationLabel: '生命周期变更',
      lifecycleAction: 'disable',
      lifecycleActions: [
        { value: 'disable', label: '停用分类', allowed: true },
        { value: 'archive', label: '归档分类', allowed: false },
      ],
    },
    ['归档后恢复到停用', '已选：停用分类', '归档分类'],
  ),
  fixture(
    'category-preview-expired',
    'rating-category-editor',
    '完整预览到期',
    {
      ...sample('category-editor-confirm'),
      error: '预览已过期，须重新核验完整范围和版本',
    },
    ['预览已过期', '确认绑定完整预览摘要'],
  ),
  fixture(
    'media-gallery',
    'rating-discussion-media',
    '已验证本地图片与释放',
    {
      ...sample('rating-media-normal'),
      gallery: { open: true, localSrc: '', index: 0, count: 3 },
    },
    ['图片正在核验或暂不可用', '1 / 3', '关闭并释放图片'],
  ),
  ...['window', 'major'].map((family) =>
    fixture(
      `${family}-own-unavailable`,
      `${family}-discussion-recovery`,
      '自己的点赞无法确认',
      {
        ...sample(`${family}-recovery-normal`),
        own: { kind: 'unavailable' },
        canUnlike: false,
      },
      ['历史暂不能确认，不能当作未点赞', '自己的点赞查询与撤回'],
    ),
  ),
  ...['window', 'major'].map((family) =>
    fixture(
      `${family}-image-cancel`,
      `${family}-discussion-recovery`,
      '图片原请求取消确认',
      {
        ...sample(`${family}-recovery-normal`),
        imageEnabled: true,
        imagePending: true,
        imageRecoverable: true,
        imageCancelConfirm: true,
        imageRequestId: 'fictional-original',
        imageStatus: '图片结果尚未确认',
      },
      [
        '确认取消此原请求及其图片上传',
        '已发表的请求以原回执为准',
        '确认取消原请求',
      ],
    ),
  ),
];
