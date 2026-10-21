// Repository-owned synthetic visual fixtures. Never runtime defaults or live activity data.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
const coverFixture =
  'data:image/png;base64,' +
  (
    await sharp(fileURLToPath(new URL('./profile-cover.svg', import.meta.url)))
      .png()
      .toBuffer()
  ).toString('base64');
const id = (number) =>
  `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const panels = {
  preferences: false,
  information: false,
  gallery: false,
  options: false,
};
const content = {
  title: '把校园的秋天装进相机里',
  description:
    '带上相机或手机，沿着湖边慢慢走，一起记录光影与树叶。\n\n从取景、构图到分享照片，摄影社的同学会陪你完成一次轻松的校园摄影漫步。不需要摄影基础，欢迎每一个喜欢观察生活的人。\n\n请自备饮水，穿适合步行的鞋。遇雨时活动安排由主办方说明。',
  types: ['offline'],
  activityTime: '10 月 24 日（周六）14:00—16:30',
  activityLocation: '图书馆南门集合 · 校园湖畔',
  endAt: '2026-10-24T16:30:00+08:00',
  showOrganizerQr: true,
};
const activity = {
  source: 'native',
  id: id(1),
  regionId: id(90),
  revision: 2,
  organization: { source: 'managed', organizationId: id(20) },
  organizerLabel: '学生摄影社',
  content,
  mediaBindings: { cover: id(30), gallery0: id(31) },
  createdAt: '2026-10-20T08:30:00+08:00',
  organizerQr: {
    status: 'available',
    organizationId: id(20),
    applicationRevision: 3,
    slot: 'mainQr',
    bindingId: id(40),
  },
};
const provider = {
  id: id(2),
  revision: id(3),
  title: '周五晚上的露天电影',
  organizerLabel: '校园电影协会',
  reward: { status: 'known', value: false },
  online: { status: 'known', value: 'offline' },
  createdAt: { status: 'known', value: '2026-10-16T10:00:00+08:00' },
  cover: { status: 'unavailable' },
  organizerAvatar: { status: 'absent' },
};
const providerDetail = {
  ...provider,
  regionId: id(90),
  bodyText:
    '在草坪上看一部温暖的电影。请带上坐垫，提前十分钟到场。\n\n影片结束后，欢迎留下来聊聊你最喜欢的片段。',
  activityTime: '10 月 23 日（周五）19:00',
  activityLocation: '学生活动中心前草坪',
  gallery: { status: 'known_empty', items: [] },
  organizerQr: { status: 'absent' },
};
const organizer = {
  source: 'managed',
  organizationId: id(20),
  revision: 3,
  name: '学生摄影社',
  kind: 'org',
  role: 'organization_owner',
};
const base = {
  configured: true,
  hasSession: true,
  loaded: true,
  busy: false,
  error: '',
  status: '',
  uiPanels: panels,
};
const draft = {
  source: 'native',
  id: id(1),
  regionId: id(90),
  organization: activity.organization,
  organizationRevision: 3,
  revision: 2,
  state: 'draft',
  content,
  mediaBindings: activity.mediaBindings,
};
const slots = [
  {
    slot: 'cover',
    label: '活动封面（必填）',
    configured: true,
    changed: false,
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    slot: `gallery${i}`,
    label: `详情图 ${i + 1}`,
    configured: i === 0,
    changed: false,
  })),
];
const compose = {
  ...base,
  organizers: [organizer],
  selected: organizer,
  form: content,
  titleCount: Array.from(content.title).length,
  descriptionCount: Array.from(content.description).length,
  typeSelected: { online: false, offline: true, reward: false },
  endAtInput: content.endAt,
  slots,
};
export default [
  {
    id: 'activities-native-list',
    page: 'activity-native',
    title: '校园活动',
    patch: {
      ...base,
      items: [
        activity,
        {
          ...activity,
          id: id(4),
          organizerLabel: '校园读书会',
          content: {
            ...content,
            title: '带一本喜欢的书来见面',
            activityTime: '10 月 25 日（周日）15:00—17:00',
            activityLocation: '图书馆二楼交流区',
            types: ['offline'],
          },
        },
        {
          ...activity,
          id: id(5),
          organizerLabel: '校园创作社',
          content: {
            ...content,
            title: '给校园写一封秋日来信',
            activityTime: '10 月 20 日—10 月 31 日',
            activityLocation: '线上征集',
            types: ['online', 'reward'],
          },
        },
      ],
      more: true,
    },
    expectedText: [
      '把校园的秋天装进相机里',
      '带一本喜欢的书来见面',
      '线上征集',
    ],
  },
  {
    id: 'activities-mine',
    page: 'activity-native',
    title: '我的活动',
    patch: { ...base, mine: true, items: [activity] },
    expectedText: ['我的发布', '学生摄影社', '按最初发布账号展示'],
  },
  {
    id: 'activities-provider-list',
    page: 'activity-list',
    title: '已核验活动目录',
    patch: {
      ...base,
      window: 'entry',
      selection: { kind: 'historical', maximum: 10 },
      selectionMessage: '当前展示历史活动。',
      pageNumber: 1,
      items: [
        provider,
        {
          ...provider,
          id: id(6),
          title: '校园音乐分享会',
          organizerLabel: '学生音乐社',
          reward: { status: 'unavailable', value: null },
          online: { status: 'known', value: 'online' },
        },
      ],
    },
    expectedText: ['活动目录', '周五晚上的露天电影', '校园音乐分享会'],
  },
  {
    id: 'activities-provider-detail',
    page: 'activity-detail',
    title: '目录活动详情',
    patch: {
      ...base,
      detail: providerDetail,
      publishedAtLabel: '2026年10月16日 10:00（UTC+08:00）',
    },
    expectedText: ['周五晚上的露天电影', '学生活动中心前草坪', '影片结束后'],
  },
  {
    id: 'activities-provider-recovery',
    page: 'activity-list',
    title: '浏览记录与偏好恢复',
    patch: {
      ...base,
      items: [],
      pageNumber: 1,
      uiPanels: { ...panels, preferences: true },
      visit: {
        pending: true,
        busy: false,
        status: '浏览记录尚未同步',
        error: '',
      },
      preference: {
        loaded: true,
        busy: false,
        checked: true,
        dirty: true,
        needsReload: false,
        status: '',
        error: '',
      },
    },
    expectedText: [
      '浏览记录待同步',
      '重试同步',
      '目前仅保存偏好，暂不发送提醒',
      '保存偏好',
    ],
  },
  {
    id: 'activities-native-detail',
    page: 'activity-native-detail',
    title: '活动内容与图片',
    patch: {
      ...base,
      activity,
      slots: slots.filter((slot) => slot.configured),
      selectedSlot: 'cover',
      image: { status: 'ready', src: coverFixture, message: '' },
      publishedAtLabel: '2026年10月20日 08:30（UTC+08:00）',
      endAtLabel: '2026年10月24日 16:30（UTC+08:00）',
    },
    expectedText: [
      '把校园的秋天装进相机里',
      '图书馆南门集合',
      '查看主办方二维码',
    ],
  },
  {
    id: 'activities-native-unavailable',
    page: 'activity-native-detail',
    title: '媒体与二维码不可用',
    patch: {
      ...base,
      activity: { ...activity, organizerQr: { status: 'unavailable' } },
      slots: slots.filter((slot) => slot.configured),
      image: {
        status: 'unavailable',
        src: '',
        message: '图片暂不可用，请稍后重试',
      },
    },
    expectedText: [
      '把校园的秋天装进相机里',
      '图片暂不可用',
      '主办方二维码已更新',
    ],
  },
  {
    id: 'activities-native-load-error',
    page: 'activity-native-detail',
    title: '活动加载失败',
    patch: {
      ...base,
      loaded: false,
      activity: null,
      error: '活动详情当前不可用',
    },
    expectedText: ['活动详情当前不可用', '重新加载'],
  },
  {
    id: 'activities-publish-compose',
    page: 'activity-publish',
    title: '活动编辑',
    patch: compose,
    expectedText: ['学生摄影社', '活动形式', '下一步，添加图片'],
  },
  {
    id: 'activities-publish-draft',
    page: 'activity-publish',
    title: '封面与保存',
    patch: { ...compose, id: id(1), draft, dirty: true },
    expectedText: ['活动图片', '封面', '先保存修改，再提交审核', '保存草稿'],
  },
  {
    id: 'activities-publish-gallery',
    page: 'activity-publish',
    title: '详情图与原上传恢复',
    patch: {
      ...compose,
      id: id(1),
      draft,
      dirty: true,
      uiPanels: { ...panels, gallery: true, options: true },
      pendingImages: [{ activityId: id(1), revision: 2, slot: 'gallery1' }],
    },
    expectedText: [
      '详情图 9',
      '公开主办方二维码',
      '图片上传待确认',
      '取消这张图片',
      '放弃未发布草稿',
    ],
  },
  {
    id: 'activities-publish-recovery',
    page: 'activity-publish',
    title: '提交结果待确认',
    patch: {
      ...compose,
      id: id(1),
      draft,
      pending: true,
      pendingId: id(50),
      review: 'pending',
    },
    expectedText: [
      '这次提交还在确认中',
      '查看结果并继续',
      '重试原提交',
      '取消原提交',
    ],
  },
  {
    id: 'activities-publish-success',
    page: 'activity-publish',
    title: '活动发布成功',
    patch: { ...compose, id: id(1), draft: { ...draft, state: 'published' } },
    expectedText: ['活动已发布', '把校园的秋天装进相机里', '查看已发布活动'],
  },
];
