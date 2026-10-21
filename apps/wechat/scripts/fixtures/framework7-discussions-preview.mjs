/** Fictional source-only UI states. Never imported by native runtime.
 * No real account, media download, provider or Tencent device is exercised. */
import majors from './majors-preview.mjs';
import windows from './window-discussion-preview.mjs';
const clone = (value) => structuredClone(value);
function consistent(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(consistent);
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, consistent(child)]),
  );
  if (
    result.kind === 'known' &&
    'rootCount' in result &&
    result.hotComment === null
  )
    result.rootCount = 0;
  return result;
}
const fixture = (id, page, title, patch, expectedText) => ({
  id: `framework7-discussions-${id}`,
  page,
  title: `Framework7 原生讨论 · ${title}`,
  patch: consistent(clone(patch)),
  expectedText,
});
const source = (id) =>
  consistent(
    clone([...majors, ...windows].find((item) => item.id === id).patch),
  );
const routes = [
  'major-directory',
  'major-detail',
  'major-discussion',
  'major-discussion-thread',
  'window-discussion',
  'window-discussion-thread',
];
const sample = Object.fromEntries(
  routes.map((page) => [page, source(`${page}-populated`)]),
);
const initial = [...majors, ...windows].filter((item) =>
  routes.includes(item.page),
);
const discussions = routes.filter((page) => page.includes('discussion'));
const owner = (page) => (page.startsWith('major') ? 'major' : 'window');
const root = (page) => sample[page].root ?? sample[page].items[0];
const base = (page) => ({
  ...sample[page],
  body: '保留这段原文，等待明确确认。',
  bodyBytes: 48,
  canPublish: true,
  imageCount: 0,
  imageEnabled: true,
});
export default [
  ...initial.map((item) =>
    fixture(
      'baseline-' + item.id,
      item.page,
      item.title,
      item.patch,
      item.expectedText,
    ),
  ),
  fixture(
    'major-search',
    'major-directory',
    '明确搜索与院系筛选',
    {
      ...sample['major-directory'],
      searchDraft: '设计',
      departmentIndex: 1,
      appliedFilter: '设计学院 · 设计',
      canNext: true,
    },
    ['设计', '更多专业'],
  ),
  fixture(
    'major-empty',
    'major-directory',
    '已确认目录为空',
    { ...sample['major-directory'], items: [], totalCount: 0 },
    ['0 个专业', '没有找到相关专业'],
  ),
  fixture(
    'major-summary-unknown',
    'major-detail',
    '摘要未知不视为零',
    {
      ...sample['major-detail'],
      detail: {
        ...sample['major-detail'].detail,
        item: {
          ...sample['major-detail'].detail.item,
          summary: { kind: 'unavailable' },
        },
      },
      relatedLoaded: true,
      relatedItems: [],
    },
    ['讨论摘要暂不可用', '暂时没有相关专业'],
  ),
  fixture(
    'major-detail-options',
    'major-detail',
    '事实说明与恢复入口',
    { ...sample['major-detail'], uiPanel: 'options' },
    ['未提供培养方案、学位或就业说明', '请求与点赞记录'],
  ),
  ...routes.flatMap((page) => [
    fixture(
      `${page}-guest`,
      page,
      '未登录',
      { hasSession: false, loaded: false },
      ['登录后继续'],
    ),
    fixture(
      `${page}-loading-error`,
      page,
      '等待与错误',
      {
        hasSession: true,
        loaded: false,
        busy: true,
        status: '正在读取合成示例',
        error: '合成网络错误，请稍后核验',
      },
      ['正在读取合成示例', '合成网络错误', '停止等待'],
    ),
  ]),
  ...discussions.flatMap((page) => {
    const family = owner(page),
      item = root(page),
      thread = page.endsWith('thread');
    const recovery = {
      ...base(page),
      loaded: false,
      items: [],
      root: null,
      frozen: true,
      recoveryPhase: 'submit',
      recoveryOperation: `${family}.discussion.${thread ? 'reply' : 'root'}.v1`,
      recoveryMajorId: item.majorId ?? '',
      recoveryWindowId: item.windowId ?? '',
      recoveryCommentId: thread ? item.id : '',
      receiptStatus: '原请求结果待确认',
    };
    const images = {
      imageEnabled: true,
      imagePending: true,
      imageRecoverable: true,
      imageFrozen: true,
      imageRequestId: '77777777-7777-4777-8777-777777777777',
      imageStatus: '图片与发表原请求结果待确认',
    };
    return [
      fixture(
        `${page}-tools`,
        page,
        '工具与恢复入口',
        { ...base(page), uiPanel: family === 'major' ? 'options' : 'tools' },
        [family === 'major' ? '请求与点赞记录' : '操作记录与恢复'],
      ),
      fixture(
        `${page}-empty`,
        page,
        '已确认没有当前讨论',
        { ...base(page), items: [], totalCount: 0 },
        [thread ? '还没有回复' : '还没有主题'],
      ),
      fixture(
        `${page}-next`,
        page,
        '有后续页',
        { ...base(page), canNext: true },
        [family === 'major' ? (thread ? '更多回复' : '更多主题') : '下一页'],
      ),
      fixture(
        `${page}-compose`,
        page,
        '原生多行编辑与图片入口',
        { ...base(page), uiPanel: 'compose' },
        [
          '相册',
          '拍照',
          family === 'major' ? '下一步' : thread ? '核对回复' : '核对主题',
        ],
      ),
      fixture(
        `${page}-publish-review`,
        page,
        '原文与有序图片复核',
        { ...base(page), confirming: 'publish', imageCount: 2 },
        [
          '保留这段原文',
          family === 'major' ? '确认发表原文' : '确认发表',
          '返回修改',
        ],
      ),
      fixture(
        `${page}-like-review`,
        page,
        '当前点赞版本复核',
        { ...base(page), confirming: 'like', selectedComment: item },
        ['只修改自己的点赞', '确认这次点赞'],
      ),
      fixture(`${page}-recovery`, page, '原请求未知不得替换', recovery, [
        '原请求结果待确认',
        '查询原回执',
      ]),
      fixture(
        `${page}-cancel-review`,
        page,
        '取消前先核验原回执',
        { ...recovery, confirming: 'cancel' },
        ['确认服务端取消', '若已完成'],
      ),
      fixture(
        `${page}-cancel-unknown`,
        page,
        '取消意图持久保存',
        { ...recovery, recoveryPhase: 'cancel' },
        [
          '已确认取消，等待服务端结果',
          family === 'major' ? '先查回执，再重试原取消' : '重试原取消',
        ],
      ),
      fixture(
        `${page}-image-recovery`,
        page,
        '图片恢复不依赖公开列表',
        {
          ...base(page),
          loaded: false,
          items: [],
          root: null,
          ...images,
          imageCancelConfirm: true,
        },
        ['查询原图片讨论回执', '确认取消原请求'],
      ),
      fixture(
        `${page}-review-image-recovery`,
        page,
        '确认层内部唯一图片恢复入口',
        { ...base(page), confirming: 'publish', ...images },
        ['查询原图片讨论回执', '原请求'],
      ),
      fixture(
        `${page}-gallery`,
        page,
        '受控图片授权等待',
        {
          ...base(page),
          galleryOpen: true,
          gallerySrc: '',
          galleryStatus: '正在核验原图片访问权限',
          galleryIndex: 0,
          galleryCount: 2,
        },
        ['正在核验原图片访问权限', '上一张', '下一张'],
      ),
    ];
  }),
  fixture(
    'major-delete-review',
    'major-discussion',
    '能力核验后的删除复核',
    {
      ...base('major-discussion'),
      confirming: 'delete',
      deleteTarget: {
        majorId: root('major-discussion').majorId,
        commentId: root('major-discussion').id,
        rootId: null,
      },
    },
    ['删除主题后其回复也将不可查看', '此操作不提供恢复入口', '确认删除'],
  ),
  fixture(
    'major-delete-image-recovery',
    'major-discussion-thread',
    '删除确认与原图片恢复并存',
    {
      ...base('major-discussion-thread'),
      confirming: 'delete',
      deleteTarget: {
        majorId: root('major-discussion-thread').majorId,
        commentId: root('major-discussion-thread').id,
        rootId: null,
      },
      imageEnabled: true,
      imagePending: true,
      imageRecoverable: true,
      imageCancelConfirm: true,
      imageRequestId: '77777777-7777-4777-8777-777777777777',
      imageStatus: '保留原图片恢复编号',
    },
    ['确认删除', '查询原图片讨论回执', '确认取消原请求'],
  ),
];
