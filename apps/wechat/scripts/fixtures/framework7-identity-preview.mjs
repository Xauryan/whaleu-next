// Synthetic source-preview states only. They do not authorize, sign in, call a
// provider, persist identity data, or establish Tencent native-device evidence.
// getPhoneNumber remains a real WeChat button. School native authorization stays
// unavailable in every fixture, exactly as the shipping unavailable port does.
import auth from './auth-preview.mjs';
const pages = [
  'login',
  'phone-binding',
  'campus',
  'identity-campus',
  'verification',
  'institutional-verification',
];
const sample = (id) =>
  structuredClone(auth.find((item) => item.id === id).patch);
const fixture = (id, page, title, patch, expectedText) => ({
  id,
  page,
  title,
  patch,
  expectedText,
});
const campus = sample('auth-campus');
const identity = sample('auth-identity-campus');
const verification = sample('auth-verification');
const school = sample('auth-school-unavailable');
export default [
  ...auth.filter((item) => pages.includes(item.page)),
  fixture(
    'login-denied',
    'login',
    '登录被拒 · 不构造会话',
    {
      configured: true,
      hasLocalSession: false,
      verified: false,
      signingIn: false,
      busy: false,
      status: '未登录',
      error: '当前账号不可登录，请联系支持人员',
    },
    ['当前账号不可登录', '使用微信登录', '不会请求手机号或完成学生认证'],
  ),
  fixture(
    'login-busy',
    'login',
    '登录进行中 · 可取消',
    {
      configured: true,
      hasLocalSession: false,
      verified: false,
      signingIn: true,
      busy: true,
      status: '正在通过微信登录',
    },
    ['正在通过微信登录', '取消登录', '先逛逛校园'],
  ),
  fixture(
    'login-error',
    'login',
    '会话未确认 · 请求失败',
    {
      configured: true,
      hasLocalSession: true,
      verified: false,
      busy: false,
      status: '会话尚未验证',
      error: '网络连接失败；如刷新会话时中断，请重新登录',
      requestId: 'qa-login-request',
    },
    ['会话尚未验证', '网络连接失败', '验证当前登录'],
  ),
  fixture(
    'phone-native-consent',
    'phone-binding',
    '原生手机号授权按钮 · 非授权结果',
    {
      configured: true,
      hasSession: true,
      busy: false,
      phase: 'reserved',
      requestId: 'qa-phone-request',
      message: '已准备原请求，请主动选择是否授予本次微信手机号授权。',
    },
    ['同意微信手机号授权并验证', '目前尚未完成真机验收', '不以此确认学生身份'],
  ),
  fixture(
    'phone-denied',
    'phone-binding',
    '用户拒绝 · 没有验证结果',
    {
      configured: true,
      hasSession: true,
      busy: false,
      phase: 'reserved',
      requestId: 'qa-phone-request',
      message: '未授予微信手机号授权；不会发送授权码。',
    },
    ['未授予微信手机号授权', '不会发送授权码', '关闭原请求'],
  ),
  fixture(
    'phone-processing',
    'phone-binding',
    '处理进行中 · 不重放授权码',
    {
      configured: true,
      hasSession: true,
      busy: false,
      phase: 'processing',
      requestId: 'qa-phone-request',
      message: '授权正在处理，当前结果尚未确认。',
    },
    ['正在确认授权', '处理中不能重新授权', '结果未知时也不会重发授权码'],
  ),
  fixture(
    'phone-unavailable',
    'phone-binding',
    '未配置 · 禁止准备授权',
    {
      configured: false,
      hasSession: false,
      busy: false,
      phase: 'idle',
      message: '手机号授权暂不可用，请先配置 API 并登录。',
    },
    ['手机号授权暂不可用', '前往登录', '服务需单独启用'],
  ),
  fixture(
    'phone-error',
    'phone-binding',
    '恢复失败 · 保留原请求',
    {
      configured: true,
      hasSession: true,
      busy: false,
      phase: 'unknown',
      requestId: 'qa-phone-request',
      message: '网络连接失败，原授权结果尚未确认。',
    },
    ['原授权结果尚未确认', '查询原请求结果', '原请求：qa-phone-request'],
  ),
  fixture(
    'campus-dirty',
    'campus',
    '浏览校园 · 未提交筛选',
    {
      ...campus,
      q: '  示例校区  ',
      district: '  示例地区  ',
      searchDirty: true,
    },
    ['搜索条件已修改，请重新搜索', '仅更新浏览校园', '当前浏览校园'],
  ),
  fixture(
    'campus-denied',
    'campus',
    '浏览校园 · 不可用选择',
    {
      ...campus,
      candidateId: '',
      candidateName: '',
      items: campus.items.map((item) => ({ ...item, isActive: false })),
    },
    ['暂不可选择', '不会改变学生认证或身份校区', '搜索校园'],
  ),
  fixture(
    'campus-unavailable',
    'campus',
    '浏览校园 · 未登录',
    {
      ...campus,
      hasSession: false,
      configured: false,
      loaded: false,
      items: [],
      candidateId: '',
      selectedName: '尚未选择校园',
      status: '请先登录，再加载校园目录',
    },
    ['尚未选择校园', '请先登录', '前往登录'],
  ),
  fixture(
    'campus-error',
    'campus',
    '浏览校园 · 冲突锁定',
    {
      ...campus,
      needsReload: true,
      error: '校园设置已在其他位置更新，请重新加载',
    },
    ['校园设置已在其他位置更新', '重新加载', '确认切换'],
  ),
  fixture(
    'identity-denied',
    'identity-campus',
    '身份校区 · 服务端拒绝选择',
    {
      ...identity,
      selectedId: '',
      eligibilityMessage:
        '当前不能选择身份校区，请先确认有效学生归属与手机号验证。',
      state: { ...identity.state, canSelect: false },
    },
    ['当前不能选择身份校区', '仅影响之后发布', '可选校区'],
  ),
  fixture(
    'identity-unavailable',
    'identity-campus',
    '身份校区 · 状态未知',
    {
      ...identity,
      selectedId: '',
      eligibilityMessage: '可选校区尚未确认，不能据此判断当前身份。',
      state: {
        selectedCampus: null,
        canSelect: false,
        options: { status: 'unavailable', items: [] },
      },
    },
    ['可选校区尚未确认', '不能据此判断当前身份', '不改浏览校园'],
  ),
  fixture(
    'identity-error',
    'identity-campus',
    '身份校区 · 原请求未确认',
    {
      ...sample('auth-identity-recovery'),
      error: '查询暂时失败，请保留原请求后重试。',
    },
    ['查询暂时失败', '未查到结果也不代表未完成', '重试相同的原请求'],
  ),
  fixture(
    'verification-unavailable',
    'verification',
    '认证事实 · 未知并非未验证',
    {
      ...verification,
      rows: verification.rows.map((row) => ({
        ...row,
        value: '状态未知或暂不可用',
        detail: '尚无可信的当前记录，或暂时无法确认；这不等于未验证',
      })),
      schoolUidView: {
        loaded: true,
        error: '',
        schoolUid: { status: 'unavailable' },
      },
    },
    ['尚无可信的当前记录', '这不等于未验证', '校内 UID 暂不可用'],
  ),
  fixture(
    'verification-expired',
    'verification',
    '失效事实 · 保留撤销及过期限定',
    {
      ...verification,
      rows: [
        {
          key: 'affiliation',
          label: '学生归属认证',
          value: '已撤销',
          detail: '原验证已被撤销，不代表当前仍有效',
        },
        {
          key: 'studentNumber',
          label: '学号验证',
          value: '已过期',
          detail: '原验证已过有效期，不代表当前仍有效',
        },
        ...verification.rows.slice(2),
      ],
    },
    ['已撤销', '已过期', '不代表当前仍有效'],
  ),
  fixture(
    'verification-denied',
    'verification',
    '查询被拒 · 清除旧状态',
    {
      ...verification,
      hasSession: false,
      loaded: false,
      rows: [],
      status: '认证状态未能确认',
      error: '请先登录，再查询自己的认证状态',
      schoolUidView: { loaded: false, error: '' },
    },
    ['认证状态未能确认', '前往登录', '仅查询本人'],
  ),
  fixture(
    'verification-error',
    'verification',
    '查询失败 · 不伪造空事实',
    {
      ...verification,
      loaded: false,
      rows: [],
      status: '认证状态未能确认',
      error: '网络连接失败，请稍后重新查询',
      schoolUidView: { loaded: false, error: '网络连接失败' },
    },
    ['认证状态未能确认', '校内 UID 查询未完成', '查询认证状态'],
  ),
  fixture(
    'school-denied',
    'institutional-verification',
    '学校资格被拒 · 原生入口仍不可用',
    {
      ...school,
      error: '当前账号没有此操作权限',
      capability: null,
    },
    ['当前账号没有此操作权限', '学校授权暂未开放', '当前不能进行真实学校登录'],
  ),
  fixture(
    'school-error',
    'institutional-verification',
    '学校原请求恢复失败 · 不重新授权',
    {
      ...sample('auth-school-recovery'),
      error: '原请求查询失败，请保留原编号后重试。',
      verificationView: {
        loaded: false,
        rows: [],
        error: '当前认证状态未能确认',
      },
      schoolUidView: { loaded: false, error: '校内 UID 未能确认' },
    },
    ['原请求查询失败', '不会重新调用学校授权', '当前认证状态未能确认'],
  ),
].map((item) => ({
  ...item,
  id: `framework7-identity-${item.id}`,
  title: `Framework7 iOS 原生身份表单 · ${item.title}`,
}));
