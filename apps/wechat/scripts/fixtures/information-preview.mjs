// Fictional visual QA data only. Never imported into runtime or sent to a service.
const ready = { loaded: true, busy: false, status: '', error: '' };
const organizationData = {
  kind: 'org',
  platform: 'wechat',
  categoryId: 'qa-outdoors',
  name: '山野徒步社',
  introText:
    '周末走出教室，一起看看山间的风景。\n每月安排轻徒步，也欢迎第一次走进户外的你。',
  qqGroupNumber: null,
};
const permissions = {
  edit: true,
  submit: false,
  review: false,
  manageMembers: true,
  transferOwner: true,
};
const editor = {
  ...ready,
  id: 'qa-hiking',
  regionId: 'qa-region',
  revision: 3,
  authorityVersion: 2,
  stateLabel: '已批准',
  roleLabel: '所有者',
  form: organizationData,
  detail: {
    id: 'qa-hiking',
    data: organizationData,
    permissions,
    members: [
      {
        grantId: 'qa-owner',
        role: 'organization_owner',
        profile: { profileId: 'qa-person', displayName: '林同学' },
      },
      {
        grantId: 'qa-admin',
        role: 'organization_admin',
        profile: { profileId: 'qa-helper', displayName: '苏同学' },
      },
    ],
  },
  slots: [
    { slot: 'avatar', label: '组织头像', configured: true, change: 'keep' },
    { slot: 'mainQr', label: '入群二维码', configured: true, change: 'keep' },
    {
      slot: 'managerContact',
      label: '管理员联系方式',
      configured: false,
      change: 'keep',
    },
    {
      slot: 'linkedOfficialQr',
      label: '关联公众号二维码',
      configured: false,
      change: 'keep',
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      slot: `introImage${index}`,
      label: `介绍图片 ${index + 1}`,
      configured: false,
      change: 'keep',
    })),
  ],
};
const announcement = {
  id: 'qa-library',
  revision: 'qa-revision',
  title: '图书馆夜读空间延长开放',
  versionLabel: '',
  announcementDate: '2026-10-20',
  createdAt: '2026-10-20T08:00:00Z',
  updatedAt: '2026-10-20T09:00:00Z',
  highlight: true,
  isLatest: true,
  popupEnabled: false,
  bodyText:
    '给想多读一会儿的你\n\n从本周起，图书馆一层夜读区开放至22:30。靠窗的长桌、独立阅读位与饮水区均可使用。\n\n闭馆前请带好随身物品，把座位留给下一位同学。让每一个安静的夜晚，都有书相伴。',
  media: {
    status: 'available',
    items: [
      {
        announcementId: 'qa-library',
        revision: 1,
        slot: 'image0',
        bindingId: 'qa-image',
      },
    ],
  },
};
const announcementBase = {
  ...ready,
  campusId: 'qa-campus',
  scopeLabel: '青屿大学 · 湖畔校区',
  hasSession: true,
  source: 'native',
};
const services = {
  ...ready,
  campusId: 'qa-campus',
  campusName: '青屿大学 · 湖畔校区',
  regionName: '青屿大学',
  entries: [
    {
      entryKey: 'treehole',
      label: '树洞交流群',
      revision: 1,
      state: 'configured',
      data: {
        kind: 'group',
        enabled: true,
        name: '湖畔校园交流群',
        description: '聊聊校园日常，分享新发现。加入前请阅读群公告。',
        qqGroupNumber: '123456789',
        joinUrl: '',
        maxGroupNumber: null,
      },
      qrcode: { status: 'configured' },
    },
    {
      entryKey: 'official_account',
      label: '学校公众号',
      revision: 1,
      state: 'configured',
      data: {
        kind: 'official_account',
        enabled: true,
        name: '青屿校园生活',
        description: '校园通知、活动和生活指南。',
      },
      qrcode: { status: 'configured' },
    },
    {
      entryKey: 'admin',
      label: '联系管理员',
      revision: 1,
      state: 'configured',
      data: { kind: 'admin', enabled: true, wechatId: 'qingyu_help' },
      qrcode: { status: 'none' },
    },
  ],
};
export default [
  {
    id: 'information-organizations-loaded',
    page: 'organizations',
    title: '我的组织',
    patch: {
      ...ready,
      management: 'none',
      items: [
        {
          id: 'qa-hiking',
          state: 'approved',
          role: 'organization_owner',
          data: organizationData,
        },
        {
          id: 'qa-film',
          state: 'pending',
          role: 'applicant',
          data: {
            ...organizationData,
            name: '周末电影放映室',
            introText: '每周选一部电影，看完再聊。',
          },
        },
        {
          id: 'qa-book',
          state: 'draft',
          role: 'applicant',
          data: {
            ...organizationData,
            kind: 'school',
            platform: 'qq',
            name: '图书交换小组',
            introText: '让书架上的故事，走到下一位读者手里。',
          },
        },
      ],
    },
    expectedText: ['山野徒步社', '周末电影放映室', '待审核', '浏览校园目录'],
  },
  {
    id: 'information-organizations-review',
    page: 'organizations',
    title: '待审组织',
    patch: {
      ...ready,
      mode: 'review',
      management: 'global',
      regionName: '青屿大学',
      campusQuery: '青屿',
      campuses: [{ id: 'qa-campus', fullName: '青屿大学 · 湖畔校区' }],
      items: [],
    },
    expectedText: ['待我审核', '青屿大学 · 湖畔校区', '暂时没有待审申请'],
  },
  {
    id: 'information-organizations-error',
    page: 'organizations',
    title: '组织读取恢复',
    patch: { error: '登录状态已变化，请重新打开组织页面', items: [] },
    expectedText: ['登录状态已变化', '申请新组织', '我的组织与申请'],
  },
  {
    id: 'information-organization-public',
    page: 'organization-editor',
    title: '组织公开详情',
    patch: {
      ...ready,
      publicRead: true,
      id: 'qa-hiking',
      publicDetail: {
        data: organizationData,
        management: { available: false },
      },
      slots: [
        {
          slot: 'mainQr',
          label: '入群二维码',
          configured: true,
          change: 'keep',
        },
      ],
    },
    expectedText: ['山野徒步社', '周末走出教室', '入群二维码'],
  },
  {
    id: 'information-organization-new',
    page: 'organization-editor',
    title: '组织申请',
    patch: {
      ...ready,
      form: { ...organizationData, name: '', introText: '' },
      categories: [
        { id: 'qa-outdoors', name: '户外运动' },
        { id: 'qa-arts', name: '文化艺术' },
        { id: 'qa-service', name: '志愿服务' },
      ],
      status: '先保存申请草稿，再上传必填图片并提交审核',
    },
    expectedText: ['校园群', '户外运动', '保存申请草稿'],
  },
  {
    id: 'information-organization-editor',
    page: 'organization-editor',
    title: '组织编辑',
    patch: editor,
    expectedText: ['编辑组织资料', '图片与二维码', '保存修改', '管理成员'],
  },
  {
    id: 'information-organization-members',
    page: 'organization-editor',
    title: '成员管理',
    patch: {
      ...editor,
      showMembers: true,
      showMedia: true,
      expandedMedia: { avatar: true },
      person: { profileId: 'qa-new-member', displayName: '周同学' },
    },
    expectedText: ['选择并审核图片', '林同学', '苏同学', '转让所有权给此成员'],
  },
  {
    id: 'information-organization-recovery',
    page: 'organization-editor',
    title: '原请求与图片恢复',
    patch: {
      ...editor,
      pending: true,
      error: '操作结果尚未确认，请保留原请求',
      pendingImages: [
        {
          key: 'avatar:2',
          slot: 'avatar',
          applicationRevision: 2,
          label: '组织头像',
        },
      ],
    },
    expectedText: [
      '有一笔操作等待确认',
      '查询原操作结果',
      '重试同一请求',
      '恢复原图片请求',
    ],
  },
  {
    id: 'information-announcements-loaded',
    page: 'announcements',
    title: '公告列表',
    patch: {
      ...announcementBase,
      pageNumber: 1,
      canNext: true,
      items: [
        announcement,
        {
          ...announcement,
          id: 'qa-books',
          title: '周末旧书交换，在草坪见',
          announcementDate: '2026-10-18',
          isLatest: false,
          highlight: false,
        },
        {
          ...announcement,
          id: 'qa-care',
          title: '校园服务反馈入口更新',
          announcementDate: null,
          isLatest: false,
          highlight: false,
        },
      ],
    },
    expectedText: [
      '图书馆夜读空间延长开放',
      '周末旧书交换',
      '日期未知',
      '下一页',
    ],
  },
  {
    id: 'information-announcements-history',
    page: 'announcements',
    title: '历史来源不可用',
    patch: {
      ...announcementBase,
      loaded: false,
      source: 'accepted',
      showInfo: true,
      status: '历史公告暂不可读取',
      error: '历史资料尚未接入，请稍后重试',
    },
    expectedText: [
      '历史资料尚未接入',
      '历史资料不可用',
      '查看公告不会记录弹窗确认',
    ],
  },
  {
    id: 'information-announcement-article',
    page: 'announcement-detail',
    title: '公告正文',
    patch: { ...announcementBase, detail: announcement },
    expectedText: [
      '图书馆夜读空间延长开放',
      '给想多读一会儿的你',
      '查看图片 1',
    ],
  },
  {
    id: 'information-announcement-image-retry',
    page: 'announcement-detail',
    title: '公告图片读取恢复',
    patch: {
      ...announcementBase,
      detail: announcement,
      image: {
        status: 'unavailable',
        src: '',
        message: '图片暂时无法显示，请重新查看',
      },
      showInfo: true,
    },
    expectedText: ['图片暂时无法显示', '公告信息', '查看公告不会记录弹窗确认'],
  },
  {
    id: 'information-announcement-error',
    page: 'announcement-detail',
    title: '公告访问失效',
    patch: {
      error: '公告已更新或当前不可见，请重新加载',
      restartRequired: true,
    },
    expectedText: ['公告已更新或当前不可见', '未选择浏览校区'],
  },
  {
    id: 'information-school-services',
    page: 'school-services',
    title: '学校服务',
    patch: services,
    expectedText: [
      '湖畔校园交流群',
      '123456789',
      '青屿校园生活',
      'qingyu_help',
    ],
  },
  {
    id: 'information-school-services-recovery',
    page: 'school-services',
    title: '学校服务读取恢复',
    patch: {
      ...services,
      entries: [
        services.entries[0],
        {
          entryKey: 'trading',
          label: '二手交易群',
          state: 'disabled',
          data: null,
          qrcode: { status: 'none' },
        },
        {
          entryKey: 'official_account',
          label: '学校公众号',
          state: 'unconfigured',
          data: null,
          qrcode: { status: 'none' },
        },
      ],
      qr: {
        status: 'unavailable',
        src: '',
        message: '二维码已更新，请刷新当前资料',
      },
      showInfo: true,
    },
    expectedText: [
      '当前服务已停用',
      '该校暂未配置',
      '二维码已更新',
      '关闭二维码预览',
      '学校服务管理',
    ],
  },
  {
    id: 'information-school-services-no-campus',
    page: 'school-services',
    title: '选择学校',
    patch: { needsCampus: true },
    expectedText: [
      '选择浏览校区',
      '先选一个校区',
      '校园群、公众号和管理员联系方式',
    ],
  },
];
