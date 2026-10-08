import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePublicExperienceDisplay,
  PUBLIC_EXPERIENCE_COLOR_STYLES,
} from '../src/experience/public-display';
import { experienceColorStyle } from '../src/experience/colors';
import {
  decodeAuthor,
  decodeComment,
  decodePost,
} from '../src/community/contract';
import { decodeReply } from '../src/community/discussion-contract';
import { decodeFormation } from '../src/community/formation-contract';
import { decodeCommunityUpdate } from '../src/community/updates-contract';
import {
  decodeLikedItem,
  decodePublicProfile,
} from '../src/profile/discovery-contract';
import { authorProfilePath } from '../src/profile/author-navigation';
import {
  initialPublicProfileView,
  PublicProfileController,
} from '../src/pages/public-profile/controller';
import {
  anonymous,
  comment,
  commentId,
  formation,
  post,
  publicExperienceDisplay,
  reply,
  requestId,
} from './community-helpers';
import {
  discoverySetup,
  likedItem,
  namedAuthor,
  namedPost,
  profileId,
  profileList,
  publicProfile,
} from './discovery-helpers';
import { update, unavailable } from './updates-helpers';
import { deferred } from './helpers';
import { wireCredentials } from './identity-helpers';

const selected = () =>
  publicExperienceDisplay({
    title: { status: 'known', value: { key: 'level_29', name: '一代宗师' } },
    color: { status: 'known', value: 25 },
  });
const author = () => ({ ...namedAuthor(), experienceDisplay: selected() });

test('public display independently preserves selected title, retained color, unknown level and known level one', () => {
  const values = [
    publicExperienceDisplay(),
    selected(),
    publicExperienceDisplay({ level: { status: 'known', value: 1 } }),
    publicExperienceDisplay({
      title: { status: 'known', value: null },
      color: { status: 'known', value: null },
      level: { status: 'known', value: 1 },
    }),
    publicExperienceDisplay({
      title: { status: 'known', value: null },
      color: { status: 'known', value: 0 },
    }),
    { ...selected(), level: { status: 'known', value: 1 } },
    { ...selected(), color: { status: 'unavailable', value: null } },
  ];
  for (const value of values) {
    const decoded = decodePublicExperienceDisplay(value);
    assert.deepEqual(decoded, value);
    assert.notEqual(decoded, value);
    assert.ok(Object.isFrozen(decoded));
    for (const dimension of Object.values(decoded))
      assert.ok(Object.isFrozen(dimension));
    if (decoded.title.value) assert.ok(Object.isFrozen(decoded.title.value));
  }
  assert.notDeepEqual(values[3], values[4]);
});

test('all supported catalog titles and only finite local palette indices decode', () => {
  const names = [
    '萌新小白',
    '初来乍到',
    '崭露头角',
    '小有名气',
    '活跃分子',
    '社区新星',
    '人气达人',
    '校园红人',
    '意见领袖',
    '社区元老',
    '校园名人',
    '风云人物',
    '传奇人物',
    '校园之光',
    '一代宗师',
  ];
  for (const value of [
    { key: 'default_jingxiaoyu', name: '鲸小语' },
    ...names.map((name, index) => ({ key: `level_${index * 2 + 1}`, name })),
  ])
    assert.deepEqual(
      decodePublicExperienceDisplay(
        publicExperienceDisplay({
          title: { status: 'known', value },
        }),
      ).title.value,
      value,
    );
  assert.ok(Object.isFrozen(PUBLIC_EXPERIENCE_COLOR_STYLES));
  assert.equal(PUBLIC_EXPERIENCE_COLOR_STYLES.length, 26);
  for (let id = 0; id < 26; id++) {
    assert.equal(
      decodePublicExperienceDisplay(
        publicExperienceDisplay({
          color: { status: 'known', value: id },
        }),
      ).color.value,
      id,
    );
    assert.equal(PUBLIC_EXPERIENCE_COLOR_STYLES[id], experienceColorStyle(id));
    assert.match(PUBLIC_EXPERIENCE_COLOR_STYLES[id]!, /^background: /);
    assert.doesNotMatch(
      PUBLIC_EXPERIENCE_COLOR_STYLES[id]!,
      /url\(|expression|javascript/i,
    );
  }
  assert.equal(experienceColorStyle(null), '');
  assert.notEqual(PUBLIC_EXPERIENCE_COLOR_STYLES[0], '');
});

test('strict public display rejects legacy, corrupt states, invented titles and caller style', () => {
  const invalid = [null, {}, { ...selected(), colorId: 25 }];
  for (const field of ['title', 'color', 'level']) {
    for (const value of [
      null,
      {},
      { status: 'unavailable', value: 0 },
      { status: 'unknown', value: null },
      { status: 'known' },
      { status: 'known', value: null, availability: 'known' },
    ])
      invalid.push({ ...selected(), [field]: value });
  }
  for (const value of [
    -1,
    26,
    1.5,
    Infinity,
    NaN,
    '0',
    '#fff',
    'url(https://example.com)',
  ])
    invalid.push({ ...selected(), color: { status: 'known', value } });
  for (const value of [null, 0, 31, 1.5, Infinity, '1'])
    invalid.push({ ...selected(), level: { status: 'known', value } });
  for (const value of [
    { key: 'admin', name: '管理员' },
    { key: 'level_2', name: 'invented' },
    { key: 'level_29', name: '管理员' },
    { key: 'toString', name: 'x' },
    { key: 'level_29', name: '一代宗师', earnedAt: null },
    { key: 'level_29', name: '一代宗师', style: 'background:red' },
  ])
    invalid.push({ ...selected(), title: { status: 'known', value } });
  for (const value of invalid)
    assert.throws(() => decodePublicExperienceDisplay(value));
});

test('every nested public author decodes exact display and cannot carry private ownership metadata', () => {
  const named = author();
  const fixtures: { raw: unknown; decode: (raw: unknown) => unknown }[] = [
    { raw: named, decode: decodeAuthor },
    { raw: post({ author: named }), decode: decodePost },
    {
      raw: comment({
        author: named,
        replyPreview: { items: [reply({ author: named })], nextCursor: null },
        replyCount: 1,
      }),
      decode: decodeComment,
    },
    {
      raw: reply({
        author: named,
        target: {
          kind: 'comment',
          id: commentId,
          status: 'available',
          author: named,
        },
      }),
      decode: decodeReply,
    },
    {
      raw: formation({
        members: formation().members.map((member) => ({
          ...member,
          author: named,
        })),
      }),
      decode: decodeFormation,
    },
    {
      raw: { ...update(), preview: { ...update().preview, author: named } },
      decode: decodeCommunityUpdate,
    },
    {
      raw: likedItem({ preview: { ...likedItem().preview, author: named } }),
      decode: decodeLikedItem,
    },
    {
      raw: publicProfile({ experienceDisplay: selected() }),
      decode: decodePublicProfile,
    },
  ];
  const privateKeys = [
    'balance',
    'earnedAt',
    'recordedAt',
    'entitlements',
    'baseline',
    'coverage',
    'provenance',
    'revision',
    'requestId',
    'recordId',
    'settlementId',
    'sourceId',
    'ownerId',
    'accountId',
    'providerId',
    'signIn',
    'pending',
    'style',
    'colorUrl',
  ];
  for (const { raw, decode } of fixtures) {
    assert.deepEqual(decode(raw), raw);
    for (const key of privateKeys) {
      const encoded = JSON.stringify(raw);
      const contaminated = JSON.parse(
        encoded
          .split('"experienceDisplay":{')
          .join(`"experienceDisplay":{"${key}":null,`),
      );
      assert.throws(() => decode(contaminated), key);
    }
  }
});

test('anonymous and unavailable unions reject even null display and never gain legacy identity fields', () => {
  const anon = anonymous();
  assert.deepEqual(decodeAuthor(anon), anon);
  const missing = {
    kind: 'comment',
    id: commentId,
    status: 'unavailable' as const,
  };
  const fixtures: { raw: unknown; decode: (raw: unknown) => unknown }[] = [
    { raw: anon, decode: decodeAuthor },
    { raw: { status: 'unavailable', profileId }, decode: decodePublicProfile },
    {
      raw: {
        status: 'blocked_by_you',
        profileId,
        relationship: {
          relationshipId: requestId,
          blocked: true,
          revision: '1',
        },
      },
      decode: decodePublicProfile,
    },
    { raw: unavailable(), decode: decodeCommunityUpdate },
  ];
  for (const { raw, decode } of fixtures) {
    assert.deepEqual(decode(raw), raw);
    for (const value of [null, selected()])
      assert.throws(() =>
        decode({ ...(raw as object), experienceDisplay: value }),
      );
  }
  for (const value of [null, selected()]) {
    assert.throws(() =>
      decodeReply({
        ...reply(),
        target: { ...missing, experienceDisplay: value },
      }),
    );
    assert.throws(() =>
      decodePost({ ...post(), author: { ...anon, experienceDisplay: value } }),
    );
    assert.throws(() =>
      decodeCommunityUpdate({
        ...update(),
        preview: {
          ...update().preview,
          author: { ...anon, experienceDisplay: value },
        },
      }),
    );
  }
});

test('canonical named navigation accepts raw display without view decoration or legacy compatibility', () => {
  const named = decodeAuthor(author());
  const before = JSON.stringify(named);
  assert.equal(
    authorProfilePath(named),
    `/pages/public-profile/public-profile?profileId=${profileId}`,
  );
  assert.equal(JSON.stringify(named), before);
  const legacy = { ...author() } as Record<string, unknown>;
  delete legacy.experienceDisplay;
  for (const raw of [
    legacy,
    { ...named, colorStyle: PUBLIC_EXPERIENCE_COLOR_STYLES[25] },
    { ...named, experienceDisplay: null },
  ]) {
    assert.throws(() => decodeAuthor(raw));
    assert.equal(authorProfilePath(raw as never), null);
  }
  const decoded = decodePublicProfile(
    publicProfile({ experienceDisplay: selected() }),
  );
  assert.ok(decoded.status === 'available');
  assert.equal(decoded.totalInteractions, null);
  assert.equal(decoded.totalInteractionsStatus, 'unavailable');
  for (const field of ['title', 'level', 'displayAvailability'])
    assert.throws(() => decodePublicProfile({ ...decoded, [field]: null }));
});

test('profile public cosmetics refresh from current canonical state and clear with every lifecycle boundary', async () => {
  for (const boundary of [
    'logout',
    'account',
    'same-login',
    'app-hide',
    'page-hide',
    'dispose',
  ] as const) {
    const s = discoverySetup();
    let view = initialPublicProfileView();
    const controller = new PublicProfileController(
      s.runtime,
      profileId,
      (next) => {
        view = next;
      },
    );
    s.behavior.profile = async () =>
      publicProfile({ experienceDisplay: selected() });
    s.behavior.list = async () =>
      profileList({ items: [post({ author: author() })] });
    await controller.load();
    assert.equal(JSON.stringify(view).includes('一代宗师'), true);
    const delayed = deferred<ReturnType<typeof publicProfile>>();
    s.behavior.profile = async () => delayed.promise;
    const pending = controller.load();
    assert.equal(JSON.stringify(view).includes('一代宗师'), false);
    if (boundary === 'logout') s.sessions.logout();
    else if (boundary === 'account' || boundary === 'same-login')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(boundary === 'account' ? { accountId: requestId } : {}),
      });
    else if (boundary === 'app-hide') s.runtime.privateViews!.clear();
    else if (boundary === 'page-hide') controller.dispose();
    else controller.dispose();
    delayed.resolve(publicProfile({ experienceDisplay: selected() }));
    await pending;
    assert.equal(JSON.stringify(view).includes('一代宗师'), false, boundary);
    assert.equal(view.profile, null);
    assert.deepEqual(view.items, []);
    controller.dispose();
  }
  const s = discoverySetup();
  let view = initialPublicProfileView();
  const controller = new PublicProfileController(
    s.runtime,
    profileId,
    (next) => {
      view = next;
    },
  );
  s.behavior.profile = async () =>
    publicProfile({ experienceDisplay: selected() });
  await controller.load();
  s.behavior.profile = async () =>
    publicProfile({
      experienceDisplay: publicExperienceDisplay({
        title: { status: 'known', value: null },
        color: { status: 'known', value: 0 },
      }),
    });
  s.behavior.list = async () => profileList({ items: [namedPost()] });
  await controller.load();
  assert.ok(view.profile?.status === 'available');
  assert.equal(view.profile.experienceDisplay.title.value, null);
  assert.equal(view.profile.experienceDisplay.color.value, 0);
  assert.equal(JSON.stringify(view).includes('一代宗师'), false);
  assert.equal(s.storage.data.size, 0);
  controller.dispose();
});
