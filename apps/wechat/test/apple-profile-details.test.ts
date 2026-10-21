import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import type { WhaleuApp } from '../src/app';
import { Cancellation } from '../src/platform/contracts';
import type { WxApi } from '../src/platform/wechat';
import {
  MeIdentityController,
  type MeIdentityView,
} from '../src/pages/me/identity-controller';
import {
  ProfileDetailsController,
  type ProfileDetailsView,
} from '../src/profile/details-controller';
import {
  decodeOwnProfileDetails,
  decodePublicProfileDetails,
  profileDetailDefaults,
  validateProfileDetailsPatch,
  type OwnProfileDetails,
  type ProfileDetailsPatch,
} from '../src/profile/details-contract';
import {
  HttpProfileDetailsGateway,
  type ProfileDetailsGateway,
} from '../src/profile/details-gateway';
import type { ProfileShare } from '../src/pages/me/profile-actions';
import type { OwnSchoolUidView } from '../src/school-uid/controller';
import { setup, otherId } from './community-helpers';
import { discoverySetup, profileId, publicProfile } from './discovery-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { ownProfile } from './profile-helpers';

const owned = (patch: Partial<OwnProfileDetails> = {}): OwnProfileDetails => ({
  accountId: wireCredentials().accountId,
  revision: 0,
  ...profileDetailDefaults(),
  ...patch,
});
function harness() {
  const s = setup();
  const sent: ProfileDetailsPatch[] = [];
  let current = owned();
  const gateway: ProfileDetailsGateway = {
    own: async () => current,
    update: async (patch) => {
      sent.push(patch);
      const { expectedRevision, ...values } = patch;
      current = owned({ ...values, revision: expectedRevision + 1 });
      return current;
    },
    public: async () => ({
      status: 'available',
      profileId,
      region: null,
      gender: null,
      age: null,
    }),
  };
  let view: ProfileDetailsView;
  const controller = new ProfileDetailsController(
    s.runtime,
    gateway,
    (value) => {
      view = value;
    },
  );
  return {
    ...s,
    sent,
    gateway,
    controller,
    view: () => view!,
    current: () => current,
  };
}

test('optional profile details are strict, nullable and private by default, never accepting birthdays or inferred fields', () => {
  assert.deepEqual(profileDetailDefaults(), {
    region: null,
    gender: null,
    age: null,
    showRegion: false,
    showGender: false,
    showAge: false,
  });
  assert.equal(
    decodeOwnProfileDetails(owned({ revision: 2147483647 })).revision,
    2147483647,
  );
  for (const patch of [
    { age: '20' },
    { age: -1 },
    { age: 121 },
    { age: 20.5 },
    { gender: 'guess' },
    { gender: 'other' },
    { region: ' invalid ' },
    { showAge: 'true' },
    { birthDate: '2000-01-01' },
    { latitude: 32 },
  ])
    assert.throws(() => decodeOwnProfileDetails({ ...owned(), ...patch }));
  assert.throws(() =>
    validateProfileDetailsPatch({
      expectedRevision: 2147483647,
      ...profileDetailDefaults(),
    }),
  );
  assert.throws(() =>
    decodePublicProfileDetails({
      status: 'available',
      profileId,
      region: null,
      gender: null,
      age: null,
      accountId: wireCredentials().accountId,
    }),
  );
  assert.throws(() =>
    decodePublicProfileDetails({
      status: 'available',
      profileId,
      region: null,
      gender: null,
      age: null,
      showAge: true,
    }),
  );
  assert.deepEqual(
    decodePublicProfileDetails({ status: 'unavailable', profileId }),
    { status: 'unavailable', profileId },
  );
});

test('owner details edit sends one explicit revisioned save and never automatically opts private values into public display', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().region, null);
  assert.equal(s.view().regionInput, '');
  s.controller.setRegion('  上海  ');
  s.controller.setAge('21');
  s.controller.setGender('female');
  await s.controller.save();
  assert.deepEqual(s.sent[0], {
    expectedRevision: 0,
    region: '上海',
    age: 21,
    gender: 'female',
    showRegion: false,
    showGender: false,
    showAge: false,
  });
  assert.equal(s.view().dirty, false);
  s.controller.setVisibility('showRegion', true);
  s.controller.setVisibility('showAge', true);
  await s.controller.save();
  assert.equal(s.sent[1]!.expectedRevision, 1);
  assert.equal(s.sent[1]!.showRegion, true);
  assert.equal(s.sent[1]!.showAge, true);
  assert.equal(s.sent[1]!.showGender, false);
  s.controller.setAge('');
  await s.controller.save();
  assert.equal(s.sent[2]!.age, null);
  assert.equal(s.sent[2]!.showAge, false);
  s.controller.dispose();
});

test('details validation, uncertain writes and conflicts do not blindly retry or overwrite', async () => {
  const s = harness();
  await s.controller.load();
  s.controller.setAge('200');
  await s.controller.save();
  assert.match(s.view().validationError, /0–120/);
  assert.equal(s.sent.length, 0);
  s.controller.setAge('22');
  const pending = deferred<OwnProfileDetails>();
  let writes = 0;
  s.gateway.update = async () => {
    writes++;
    return pending.promise;
  };
  const saving = s.controller.save();
  await flush();
  await s.controller.save();
  assert.equal(writes, 1);
  pending.reject(new ClientError('network', 'Lost response'));
  await saving;
  assert.equal(s.view().needsReload, true);
  await s.controller.save();
  assert.equal(writes, 1);
  await s.controller.load();
  assert.equal(s.view().needsReload, false);
  s.controller.setAge('23');
  s.gateway.update = async () => {
    throw new ClientError('business', 'Conflict', {
      serverCode: 'PROFILE_DETAILS_REVISION_CONFLICT',
      httpStatus: 409,
    });
  };
  await s.controller.save();
  assert.equal(s.view().needsReload, true);
  s.controller.dispose();
});

test('details discard other-owner data, private drafts and late reads across login/hide boundaries', async () => {
  const mismatch = harness();
  mismatch.gateway.own = async () =>
    owned({ accountId: otherId, region: 'must not show' });
  await mismatch.controller.load();
  assert.equal(mismatch.view().loaded, false);
  assert.equal(mismatch.view().region, null);
  mismatch.controller.dispose();
  for (const boundary of ['account', 'hide'] as const) {
    const s = harness();
    await s.controller.load();
    s.controller.setRegion('private unsaved');
    if (boundary === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('next'),
        accountId: otherId,
      });
    else s.runtime.privateViews!.clear();
    assert.equal(s.view().regionInput, '');
    assert.equal(s.view().dirty, false);
    s.controller.dispose();
  }
  const s = harness();
  const pending = deferred<OwnProfileDetails>();
  s.gateway.own = async () => pending.promise;
  const read = s.controller.load();
  await flush();
  s.controller.dispose();
  pending.resolve(owned({ region: 'late private data' }));
  await read;
  assert.equal(s.view().region, null);
});

test('details gateway uses exact independent owner routes and rejects foreign public selector responses', async () => {
  const s = setup();
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  const gateway = new HttpProfileDetailsGateway(api);
  transport.reply(owned());
  await gateway.own(new Cancellation());
  assert.match(transport.requests[0]!.url, /\/v1\/me\/profile-details$/);
  const patch = { expectedRevision: 0, ...profileDetailDefaults() };
  transport.reply(owned({ revision: 1 }));
  await gateway.update(patch, new Cancellation());
  assert.equal(transport.requests[1]!.method, 'PATCH');
  assert.deepEqual(transport.requests[1]!.body, patch);
  transport.reply({
    status: 'unavailable',
    profileId: wireCredentials().accountId,
  });
  await assert.rejects(gateway.public(profileId, new Cancellation()));
});

test('Me public identity share authority is independent of private tabs and revoked on logout, reload and hide', async () => {
  const s = discoverySetup();
  s.behavior.profile = async () => publicProfile({ isOwn: true });
  let view: MeIdentityView;
  const controller = new MeIdentityController(s.runtime, (value) => {
    view = value;
  });
  await controller.load();
  assert.equal(view!.profile?.profileId, profileId);
  const ticket = controller.shareTicket();
  assert.ok(ticket);
  const pending = deferred<ReturnType<typeof publicProfile>>();
  s.behavior.profile = async () => pending.promise;
  const read = controller.load();
  assert.equal(controller.shareTicket(), null);
  await flush();
  s.sessions.logout();
  pending.resolve(publicProfile({ isOwn: true }));
  await read;
  assert.equal(controller.shareTicket(), null);
  assert.equal(view!.profile, null);
  controller.dispose();
});

test('Me reads real formatted school UID and own details, shares only public profile route, and exposes upper-right native controls', async () => {
  const template = readFileSync(
    path.join(__dirname, '../src/pages/me/me.wxml'),
    'utf8',
  );
  assert.match(template, /schoolUidView\.schoolUid\.formattedUid/);
  assert.match(template, /UID：/);
  assert.doesNotMatch(template, /校内 UID/);
  assert.match(template, /profile-toolbar-actions/);
  assert.match(template, /name="scan"/);
  assert.match(template, /open-type="share"/);
  const header = template.slice(0, template.indexOf('class="profile-content"'));
  assert.doesNotMatch(header, /仅自己/);
  assert.match(header, /details\.showGender &amp;&amp; details\.gender/);
  assert.match(header, /details\.showRegion &amp;&amp; details\.region/);
  assert.match(header, /details\.showAge &amp;&amp; details\.age !== null/);
  const editor = readFileSync(
    path.join(__dirname, '../src/pages/profile/profile.wxml'),
    'utf8',
  );
  assert.match(editor, /保存展示信息与公开设置/);
  assert.match(editor, /默认仅自己可见/);
  assert.match(editor, /onDetailsVisibility/);
  type MePage = {
    data: {
      schoolUidView: OwnSchoolUidView;
      details: ProfileDetailsView;
      publicIdentity: MeIdentityView;
    };
    onShow(): void;
    onUnload(): void;
    onShareAppMessage(): ProfileShare;
    setData(patch: Record<string, unknown>): void;
  };
  const native = globalThis as typeof globalThis & { wx: WxApi };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: native.wx,
  };
  const s = discoverySetup();
  s.behavior.profile = async () => publicProfile({ isOwn: true });
  const runtime = {
    ...s.runtime,
    schoolUid: {
      own: async () => ({
        status: 'assigned' as const,
        school: { code: '10001', name: '真实接口学校' },
        uid: '42',
        formattedUid: '000042',
      }),
      capabilities: async () => {
        throw new Error('Not called');
      },
      lookup: async () => ({ status: 'unavailable' as const }),
    },
  };
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  globalThis.getApp = (() =>
    ({
      identity: { sessions: s.sessions, api },
      community: runtime,
    }) as unknown as WhaleuApp) as typeof getApp;
  native.wx = {} as WxApi;
  let definition: MePage | undefined;
  globalThis.Page = ((value: object) => {
    definition = value as MePage;
  }) as typeof Page;
  let page: MePage | undefined;
  try {
    await import('../src/pages/me/me.js');
    assert.ok(definition);
    page = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    transport.reply(ownProfile());
    transport.reply({ items: [], nextCursor: null, continuation: 'end' });
    transport.reply(owned({ region: '杭州', gender: 'female', age: 21 }));
    page.onShow();
    await flush();
    await flush();
    assert.deepEqual(page.data.schoolUidView.schoolUid, {
      status: 'assigned',
      school: { code: '10001', name: '真实接口学校' },
      uid: '42',
      formattedUid: '000042',
    });
    assert.equal(page.data.details.region, '杭州');
    assert.equal(page.data.details.showRegion, false);
    const shared = page.onShareAppMessage();
    assert.equal(
      shared.path,
      `/pages/public-profile/public-profile?profileId=${profileId}`,
    );
    assert.equal(shared.imageUrl, '/assets/share/profile.png');
    assert.doesNotMatch(JSON.stringify(shared), /杭州|female|000042/);
    s.sessions.logout();
    assert.equal(page.data.schoolUidView.schoolUid, null);
    assert.equal(page.data.details.region, null);
    assert.equal(
      page.onShareAppMessage().path,
      '/pages/community-feed/community-feed',
    );
  } finally {
    page?.onUnload();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    native.wx = previous.wx;
  }
});

test('native existing profile editor persists optional fields only after explicit save and public switches', async () => {
  type Editor = {
    data: { details: ProfileDetailsView };
    onShow(): void;
    onUnload(): void;
    onDetailsRegion(event: { detail: { value: string } }): void;
    onDetailsAge(event: { detail: { value: string } }): void;
    onDetailsGender(event: { detail: { value: string } }): void;
    onDetailsVisibility(event: {
      currentTarget: { dataset: { key: string } };
      detail: { value: boolean };
    }): void;
    onSaveDetails(): void;
    setData(patch: Record<string, unknown>): void;
  };
  const native = globalThis as typeof globalThis & { wx: WxApi };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: native.wx,
  };
  const s = setup();
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  globalThis.getApp = (() =>
    ({
      identity: { sessions: s.sessions, api },
      community: s.runtime,
    }) as unknown as WhaleuApp) as typeof getApp;
  native.wx = {} as WxApi;
  let definition: Editor | undefined;
  globalThis.Page = ((value: object) => {
    definition = value as Editor;
  }) as typeof Page;
  let page: Editor | undefined;
  try {
    await import('../src/pages/profile/profile.js');
    assert.ok(definition);
    page = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    transport.reply(owned());
    transport.reply(ownProfile());
    page.onShow();
    await flush();
    await flush();
    assert.equal(page.data.details.loaded, true);
    page.onDetailsRegion({ detail: { value: '成都' } });
    page.onDetailsAge({ detail: { value: '20' } });
    page.onDetailsGender({ detail: { value: '1' } });
    page.onDetailsVisibility({
      currentTarget: { dataset: { key: 'showRegion' } },
      detail: { value: true },
    });
    assert.equal(
      transport.requests.filter((request) => request.method === 'PATCH').length,
      0,
    );
    transport.reply(
      owned({
        revision: 1,
        region: '成都',
        age: 20,
        gender: 'female',
        showRegion: true,
      }),
    );
    page.onSaveDetails();
    await flush();
    await flush();
    const writes = transport.requests.filter(
      (request) => request.method === 'PATCH',
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.body, {
      expectedRevision: 0,
      region: '成都',
      gender: 'female',
      age: 20,
      showRegion: true,
      showGender: false,
      showAge: false,
    });
    assert.equal(page.data.details.dirty, false);
    page.onDetailsRegion({ detail: { value: '未保存地区' } });
    page.onUnload();
    assert.equal(page.data.details.regionInput, '');
    assert.equal(page.data.details.age, null);
  } finally {
    page?.onUnload();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    native.wx = previous.wx;
  }
});

test('gender supports only male female or private unset and never publishes a selection implicitly', async () => {
  const s = harness();
  await s.controller.load();
  s.controller.setGender('other');
  assert.equal(s.view().gender, null);
  assert.equal(s.view().dirty, false);
  s.controller.setGender('male');
  assert.equal(s.view().gender, 'male');
  assert.equal(s.view().showGender, false);
  s.controller.setVisibility('showGender', true);
  s.controller.setGender('');
  assert.equal(s.view().gender, null);
  assert.equal(s.view().showGender, false);
  s.controller.dispose();
});
