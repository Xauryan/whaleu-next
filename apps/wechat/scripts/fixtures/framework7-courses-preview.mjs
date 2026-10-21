// Fictional source-only inputs. No provider/account data or business actions.
const id = '11111111-1111-4111-8111-111111111111';
const commentId = '77777777-7777-4777-8777-777777777777';
const ready = {
  loaded: true,
  hasSession: true,
  configured: true,
  busy: false,
  frozen: false,
  status: '',
  error: '',
  receiptStatus: '',
};
const scores = { gradeScore: 0.5, abilityScore: 4.5, overallScore: 1.5 };
const course = {
  id,
  revision: 'fictional-course-revision',
  name: '设计与日常生活',
  campusLabel: '示例校区',
  sourceCampusKey: 'fictional-campus',
  department: 12,
  category: '通识选修',
  nature: '选修',
  code: 'DEMO-101',
  summary: {
    kind: 'known',
    count: 18,
    gradeScore: 4.5,
    abilityScore: 4.2,
    overallScore: 4.6,
  },
};
const detail = {
  course,
  catalogRevision: 'fictional-catalog-revision',
  myScore: { kind: 'not_submitted' },
};
const body = '  观察日常设计的小练习\n保留原文与换行 😀  ';
const comment = {
  id: commentId,
  body,
  likes: 8,
  createdAt: '2026-10-11T12:00:00.000Z',
};
const catalog = {
  ...ready,
  items: [course],
  departmentLabels: ['全部院系', '院系 12'],
  departmentIndex: 0,
};
const detailReady = { ...ready, detail, canScore: true, canSubmit: false };
const comments = {
  ...ready,
  courseId: id,
  items: [comment],
  timeLabels: { [commentId]: '12:40' },
  sort: 'likes',
};
const scoreRecovery = {
  ...ready,
  loaded: false,
  frozen: true,
  recoveryCourseId: id,
  recoveryScores: scores,
  status: '请先核验原请求',
};
const commentRecovery = {
  ...ready,
  loaded: false,
  frozen: true,
  recoveryCourseId: id,
  recoveryOperation: 'course.comment.publish.v1',
  recoveryBody: body,
  status: '请先核验原请求',
};
const fixture = (suffix, page, title, patch, expectedText) => ({
  id: `framework7-courses-${suffix}`,
  page,
  title: `Framework7 iOS 原生课程 · ${title}`,
  patch,
  expectedText,
});
export default [
  fixture('catalog', 'course-ratings', '课程目录', catalog, [
    '设计与日常生活',
    '18 人评分',
    '综合评分',
  ]),
  fixture(
    'catalog-empty',
    'course-ratings',
    '空目录',
    { ...catalog, items: [] },
    ['没有找到课程，试试其他关键词'],
  ),
  fixture(
    'catalog-more',
    'course-ratings',
    '目录操作',
    { ...catalog, uiPanel: 'more' },
    ['查询上次回复操作', '每门课仅可评分一次'],
  ),
  fixture(
    'catalog-filters',
    'course-ratings',
    '类别筛选',
    { ...catalog, uiPanel: 'filters', categoryDraft: '通识选修' },
    ['院系和类别可选其一'],
  ),
  fixture(
    'catalog-applied',
    'course-ratings',
    '已应用筛选',
    {
      ...catalog,
      appliedFilter: '院系 12 · 最新',
      sortDraft: 'time',
      canNext: true,
    },
    ['院系 12 · 最新', '加载下一页'],
  ),
  fixture(
    'catalog-unknown',
    'course-ratings',
    '评分未知',
    { ...catalog, items: [{ ...course, summary: { kind: 'unavailable' } }] },
    ['评分数据暂不可用'],
  ),
  fixture('catalog-recovery', 'course-ratings', '原评分恢复', scoreRecovery, [
    '上次评分结果待确认',
    '原课程编号',
    '重试原请求',
  ]),
  fixture(
    'catalog-busy',
    'course-ratings',
    '加载中',
    { ...catalog, loaded: false, busy: true, status: '正在加载课程' },
    ['正在加载课程', '停止等待'],
  ),
  fixture(
    'catalog-guest',
    'course-ratings',
    '访客',
    { loaded: false, hasSession: false },
    ['登录后继续'],
  ),
  fixture(
    'catalog-error',
    'course-ratings',
    '来源不可用',
    {
      loaded: false,
      hasSession: true,
      error: '课程目录来源尚未确认，不代表目录为空',
    },
    ['课程目录来源尚未确认，不代表目录为空'],
  ),
  fixture(
    'catalog-phone',
    'course-ratings',
    '手机号权限',
    {
      loaded: false,
      hasSession: true,
      error: '请先完成手机号验证，再重新加载课程评分',
    },
    ['验证手机号'],
  ),
  fixture('detail', 'course-rating-detail', '课程详情', detailReady, [
    '设计与日常生活',
    '还没有为这门课评分',
    '每门课仅一次',
  ]),
  fixture(
    'detail-info',
    'course-rating-detail',
    '目录信息',
    { ...detailReady, uiPanel: 'info' },
    [
      '来源校区：fictional-campus',
      '目录版本：fictional-catalog-revision',
      '不代表评分权限',
    ],
  ),
  fixture(
    'detail-score',
    'course-rating-detail',
    '三个独立维度',
    { ...detailReady, uiPanel: 'score', ...scores, canSubmit: true },
    ['三个维度分别评分', '核对评分', '得分 · 0.5'],
  ),
  fixture(
    'detail-confirm',
    'course-rating-detail',
    '最终评分确认',
    { ...detailReady, ...scores, canSubmit: true, confirming: true },
    ['确认首次评分', '确认提交', '返回调整'],
  ),
  fixture(
    'detail-recorded',
    'course-rating-detail',
    '已评分只读',
    {
      ...detailReady,
      canScore: false,
      detail: { ...detail, myScore: { kind: 'recorded', ...scores } },
    },
    ['已提交，首次评分不能修改或删除'],
  ),
  fixture(
    'detail-unavailable',
    'course-rating-detail',
    '历史未知',
    {
      ...detailReady,
      canScore: false,
      detail: { ...detail, myScore: { kind: 'unavailable' } },
    },
    ['暂未确认你的历史评分，请稍后重试'],
  ),
  fixture(
    'detail-aggregate-unknown',
    'course-rating-detail',
    '均分未知',
    {
      ...detailReady,
      canScore: false,
      detail: {
        ...detail,
        course: { ...course, summary: { kind: 'unavailable' } },
      },
      blocker: '评分历史尚未确认',
    },
    ['评分数据暂不可用', '评分历史尚未确认'],
  ),
  fixture(
    'detail-recovery',
    'course-rating-detail',
    '评分恢复',
    scoreRecovery,
    ['上次评分结果待确认', '确认结果前不能重新评分'],
  ),
  fixture(
    'detail-pending-current',
    'course-rating-detail',
    '当前课程待确认',
    { ...detailReady, ...scoreRecovery, loaded: true, canScore: false },
    ['上次评分结果待确认，请先查询'],
  ),
  fixture(
    'detail-busy',
    'course-rating-detail',
    '等待服务',
    { ...detailReady, busy: true, status: '正在核验课程' },
    ['正在核验课程', '停止等待'],
  ),
  fixture('comments', 'course-comments', '匿名课程回复', comments, [
    '观察日常设计的小练习',
    '赞 8',
    '写回复',
  ]),
  fixture(
    'comments-info',
    'course-comments',
    '回复边界',
    { ...comments, uiPanel: 'info' },
    ['回复不展示作者身份', '每条回复只能赞一次，不能取消'],
  ),
  fixture(
    'comments-empty',
    'course-comments',
    '暂无回复',
    { ...comments, items: [] },
    ['还没有课程回复'],
  ),
  fixture(
    'comments-next',
    'course-comments',
    '分页',
    { ...comments, canNext: true, sort: 'time' },
    ['加载下一页'],
  ),
  fixture(
    'comments-compose',
    'course-comments',
    '保留原文',
    {
      ...comments,
      uiPanel: 'compose',
      body,
      bodyBytes: new TextEncoder().encode(body).length,
      canPublish: true,
    },
    ['按原文提交', '核对回复'],
  ),
  fixture(
    'comments-publish',
    'course-comments',
    '发表确认',
    { ...comments, body, confirming: 'publish' },
    ['确认发表', '观察日常设计的小练习', '结果未确认前不能替换原文或重复提交'],
  ),
  fixture(
    'comments-like',
    'course-comments',
    '不可撤销点赞',
    { ...comments, selectedComment: comment, confirming: 'like' },
    ['赞这条回复', '点赞后不能取消', '确认点赞'],
  ),
  fixture(
    'comments-recovery-publish',
    'course-comments',
    '发表恢复',
    commentRecovery,
    ['上次操作结果待确认', '观察日常设计的小练习', '查询能否取消'],
  ),
  fixture(
    'comments-recovery-like',
    'course-comments',
    '点赞恢复',
    {
      ...commentRecovery,
      recoveryOperation: 'course.comment.like.v1',
      recoveryBody: '',
      recoveryCommentId: commentId,
    },
    ['原点赞回复', '查询原回执'],
  ),
  fixture(
    'comments-cancel',
    'course-comments',
    '取消单独确认',
    { ...commentRecovery, confirming: 'cancel', receiptMissing: true },
    ['取消上次操作', '不会撤销', '确认请求取消', '暂未查到结果，不代表已取消'],
  ),
  fixture(
    'comments-restart',
    'course-comments',
    '分页版本变化',
    { ...comments, restartRequired: true },
    ['列表已更新，请刷新后继续'],
  ),
  fixture(
    'comments-guest',
    'course-comments',
    '访客',
    { hasSession: false, loaded: false },
    ['登录后查看回复'],
  ),
  fixture(
    'comments-busy',
    'course-comments',
    '停止等待',
    { ...comments, busy: true, status: '正在加载回复' },
    ['正在加载回复', '停止等待'],
  ),
];
