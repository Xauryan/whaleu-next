/** Fictional layout-only inputs. Never imported by native runtime or backend. */
const ready = {
  loaded: true,
  hasSession: true,
  configured: true,
  busy: false,
  timeLabels: {
    '33333333-3333-4333-8333-333333333333': '12:40',
    '44444444-4444-4444-8444-444444444444': '13:15',
  },
  frozen: false,
  status: '',
  error: '',
  receiptStatus: '',
};
const target = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '湖畔自习室',
  description: '靠近湖边的安静自习空间',
  kind: 'general',
  hasCover: false,
  allowedActions: {
    setScore: true,
    createComment: true,
    authorModes: ['named', 'anonymous'],
  },
};
const category = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '学习空间',
  description: '自习室、图书馆与校园里的安静角落',
  kind: 'general',
  level: 1,
  hasIcon: false,
};
const author = { mode: 'named', displayName: '小舟' };
const comment = {
  id: '33333333-3333-4333-8333-333333333333',
  author,
  body: '窗边的位置光线很好，下午来可以安静读完一本书。',
  createdAt: '今天 12:40',
  isMine: false,
  allowedActions: { delete: false },
};
const reply = {
  id: '44444444-4444-4444-8444-444444444444',
  author: { mode: 'anonymous', displayName: '蓝鲸分身' },
  body: '周末也开门吗？想找一个可以看书一下午的地方。',
  createdAt: '今天 13:15',
  isMine: false,
  replyTo: { kind: 'root' },
  allowedActions: { reply: true, delete: false },
};
const likes = {
  [comment.id]: { status: 'known', count: 12, liked: false },
  [reply.id]: { status: 'known', count: 2, liked: true },
};
const summary = {
  status: 'known',
  count: 24,
  average: 4.5,
  distribution: { 1: 0, 2: 1, 3: 2, 4: 5, 5: 16 },
};
const subscriptions = {
  [target.id]: { status: 'known', count: 18, subscribed: false },
};
const course = {
  id: '55555555-5555-4555-8555-555555555555',
  name: '设计与日常生活',
  campusLabel: '示例校区',
  sourceCampusKey: 'synthetic-campus',
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
const courseDetail = {
  course,
  catalogRevision: 'synthetic-revision',
  myScore: { kind: 'not_recorded' },
};
const itemComment = {
  id: comment.id,
  body: '课程里有很多观察日常设计的小练习，适合对设计感兴趣的同学。',
  likes: 8,
  createdAt: '今天 11:20',
};
const ratingPatch = {
  ...ready,
  detail: target,
  summary,
  comments: [comment],
  myScoreKnown: true,
  myScore: { score: 4 },
  likes,
  subscriptions,
};
const discussion = {
  root: comment,
  allowedActions: { createReply: true, authorModes: ['named', 'anonymous'] },
};
export default [
  {
    id: 'ratings-catalog-populated',
    page: 'rating-catalog',
    title: '评分目录',
    patch: {
      ...ready,
      categories: [
        category,
        {
          ...category,
          id: 'category-two',
          name: '校园生活',
          description: '运动、休闲和每天的小事',
        },
      ],
    },
    expectedText: ['校园评分', '学习空间', '校园生活'],
  },
  {
    id: 'ratings-targets-populated',
    page: 'rating-catalog',
    title: '分类内评分对象',
    patch: {
      ...ready,
      parentId: category.id,
      categories: [],
      targets: [target],
      subscriptions,
    },
    expectedText: ['湖畔自习室', '18 人码住', '评分对象'],
  },
  {
    id: 'ratings-detail-populated',
    page: 'rating-detail',
    title: '评分详情',
    patch: ratingPatch,
    expectedText: ['湖畔自习室', '4.5', comment.body, '写评价'],
  },
  {
    id: 'ratings-detail-score',
    page: 'rating-detail',
    title: '我的评分',
    patch: { ...ratingPatch, uiPanel: 'score' },
    expectedText: ['当前 4 分', '评分与文字评价分别提交', comment.body],
  },
  {
    id: 'ratings-detail-compose',
    page: 'rating-detail',
    title: '撰写评价',
    patch: {
      ...ratingPatch,
      composerOpen: true,
      authorMode: 'anonymous',
      text: '这里很适合安静阅读。',
      textLength: 10,
    },
    expectedText: ['发布评价', '分身', '仅支持文字'],
  },
  {
    id: 'ratings-thread-populated',
    page: 'rating-thread',
    title: '评价回复',
    patch: { ...ready, detail: target, discussion, replies: [reply], likes },
    expectedText: ['湖畔自习室', reply.body, '回复这条评价'],
  },
  {
    id: 'ratings-create-ready',
    page: 'rating-create',
    title: '添加评分对象',
    patch: {
      ...ready,
      ready: true,
      name: '林间步道',
      description: '连接图书馆和生活区的步行小径。',
    },
    expectedText: ['添加评分对象', '提交申请', '名称 100 字'],
  },
  {
    id: 'ratings-scoped-catalog',
    page: 'rating-scoped',
    title: '校园范围评分',
    patch: {
      ...ready,
      mode: 'catalog',
      scopeLabel: '示例校区',
      categories: [category],
      targets: [target],
      subscriptions,
    },
    expectedText: ['示例校区', '学习空间', '湖畔自习室'],
  },
  {
    id: 'ratings-scoped-detail',
    page: 'rating-scoped',
    title: '校园对象详情',
    patch: {
      ...ratingPatch,
      mode: 'detail',
      scopeLabel: '示例校区',
      myScore: { myScore: { score: 4 } },
    },
    expectedText: ['湖畔自习室', '24 人评分', comment.body, '写评价'],
  },
  {
    id: 'ratings-random-result',
    page: 'rating-random',
    title: '随机选择结果',
    patch: {
      ...ready,
      categoryId: category.id,
      result: { candidateCount: 16, item: { target, summary, regionId: null } },
    },
    expectedText: ['这次选中了', '湖畔自习室', '再选一个'],
  },
  {
    id: 'courses-catalog-populated',
    page: 'course-ratings',
    title: '课程目录',
    patch: {
      ...ready,
      items: [
        course,
        {
          ...course,
          id: 'course-two',
          name: '城市与建筑',
          code: 'DEMO-102',
          category: '艺术通识',
          summary: {
            kind: 'known',
            count: 0,
            gradeScore: null,
            abilityScore: null,
            overallScore: null,
          },
        },
      ],
      pageNumber: 1,
      appliedFilter: '全部课程',
    },
    expectedText: ['设计与日常生活', '18 人评分', '城市与建筑', '暂无评分'],
  },
  {
    id: 'courses-detail-populated',
    page: 'course-rating-detail',
    title: '课程详情',
    patch: { ...ready, detail: courseDetail, canScore: true },
    expectedText: ['设计与日常生活', '得分', '能力', '综合', '为课程评分'],
  },
  {
    id: 'courses-detail-score',
    page: 'course-rating-detail',
    title: '三维评分选择',
    patch: {
      ...ready,
      detail: courseDetail,
      canScore: true,
      canSubmit: true,
      uiPanel: 'score',
      gradeScore: 4.5,
      abilityScore: 4,
      overallScore: 4.5,
    },
    expectedText: ['核对评分', '得分 · 4.5', '提交后不能修改或删除'],
  },
  {
    id: 'courses-comments-populated',
    page: 'course-comments',
    title: '课程回复',
    patch: {
      ...ready,
      courseId: course.id,
      items: [itemComment],
      pageNumber: 1,
    },
    expectedText: [itemComment.body, '赞 8', '写回复'],
  },
  {
    id: 'courses-comments-compose',
    page: 'course-comments',
    title: '撰写课程回复',
    patch: {
      ...ready,
      courseId: course.id,
      items: [itemComment],
      pageNumber: 1,
      uiPanel: 'compose',
      body: '喜欢这门课的观察练习。',
      bodyBytes: 33,
      canPublish: true,
    },
    expectedText: ['核对回复', '33 / 8000 字节', itemComment.body],
  },
  {
    id: 'courses-comments-recovery',
    page: 'course-comments',
    title: '结果未确认时恢复',
    patch: {
      ...ready,
      loaded: false,
      frozen: true,
      recoveryCourseId: course.id,
      recoveryOperation: 'course.comment.publish.v1',
      recoveryBody: '我保存的原回复。',
      receiptMissing: true,
    },
    expectedText: ['上次操作结果待确认', '我保存的原回复。', '查询原回执'],
  },
];
