/** Actual emitted App/Page/WXML and production transports. Synthetic wx and local
 * immutable Media provider edges only; no business controller is replaced. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url)),
  emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const {
  NativeMediaUploadBridge,
} = require('../../../wechat/test/support/media-upload-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function until(check, label, page) {
  const end = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < end,
      `${label}: ${page?.data.error || page?.data.status || page?.data.nativeDetail?.error || JSON.stringify(page?.data.upload) || 'timed out'}`,
    );
    await delay(10);
  }
}
async function rpc(name, fields = {}) {
  const response = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await response, { event: 'continue', name });
}
const nodeText = (nodes) =>
  nodes
    .map((node) => (typeof node === 'string' ? node : nodeText(node.children)))
    .join('');
process.once('message', async (input) => {
  const pages = new Set();
  let app, bridge;
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    bridge = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'organizations',
    );
    const wx = {
      ...platform,
      ...bridge.wx,
      nextTick: queueMicrotask,
      request: (options) => {
        void transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            async (response) => {
              if (
                response.status === 200 &&
                new URL(options.url).pathname.endsWith('/finalize')
              )
                await rpc('process-images');
              options.success({
                statusCode: response.status,
                header: response.headers,
                data: response.body,
              });
            },
            () =>
              options.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      navigateTo: (options) => options.success?.(),
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (value) => {
      app = value;
    };
    globalThis.getApp = () => app;
    emitted('app');
    app.onLaunch();
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        input.actors[actor],
      );
    const mount = (name, route = {}) => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(route);
      h.page.onShow?.();
      return h;
    };
    const close = (h) => {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    };
    const ready = async (h) =>
      until(
        () => h.page.data.loaded && !h.page.data.busy,
        'page ready',
        h.page,
      );
    const inputField = (h, field, value) =>
      h.event('bindinput', 'onField', { value }, { field });
    const ensureMediaOpen = (h, slot) => {
      if (!h.page.data.publicRead && !h.page.data.showMedia)
        h.tap('onToggleMediaSection');
      if (!h.page.data.expandedMedia[slot]) h.tap('onToggleMedia', { slot });
    };
    const ensureMembersOpen = (h) => {
      if (!h.page.data.showMembers) h.tap('onToggleMembers');
    };
    login('owner');
    let editor = mount('organization-editor');
    await ready(editor);
    await until(
      () => editor.page.data.categories.length > 0,
      'categories',
      editor.page,
    );
    editor.tap('onCategory', { id: input.categoryId });
    editor.tap('onPlatform', { platform: 'qq' });
    inputField(editor, 'name', '原生组织');
    inputField(editor, 'introText', 'Page到PostgreSQL真实组织');
    inputField(editor, 'qqGroupNumber', '12345678');
    editor.tap('onSave');
    await until(
      () => !!editor.page.data.id && !editor.page.data.busy,
      'created real draft',
      editor.page,
    );
    const id = editor.page.data.id;
    assert.equal(editor.page.data.detail.state, 'draft');
    assert.equal(editor.page.data.detail.members.length, 0);
    for (const slot of ['avatar', 'mainQr']) {
      await bridge.select(Buffer.from(input.png, 'base64'), 'image/png', {
        width: 40,
        height: 40,
        type: 'png',
      });
      ensureMediaOpen(editor, slot);
      editor.tap('onPickImage', { slot });
      await until(
        () => editor.page.data.upload.status === 'ready',
        'reviewed native image',
        editor.page,
      );
      assert.equal(
        editor.page.data.slots.find((s) => s.slot === slot).change,
        'replace',
      );
    }
    transport.dropSuccess = {
      path: `/v1/organizations/${id}/content`,
      method: 'POST',
    };
    editor.tap('onSubmit');
    await until(
      () =>
        editor.page.data.pending &&
        !editor.page.data.busy &&
        !!editor.page.data.error,
      'lost committed submit response',
      editor.page,
    );
    assert.equal(editor.page.data.detail.state, 'draft');
    close(editor);
    editor = mount('organization-editor', { id });
    await ready(editor);
    assert.equal(editor.page.data.pending, true);
    assert.equal(editor.page.data.detail.state, 'pending');
    editor.tap('onRecover');
    await until(
      () => !editor.page.data.pending && !editor.page.data.busy,
      'original-key submit receipt',
      editor.page,
    );
    assert.equal(
      transport.exchanges.filter(
        (x) =>
          x.method === 'POST' && x.path === `/v1/organizations/${id}/content`,
      ).length,
      1,
      'Recovery must not repost committed command',
    );
    close(editor);
    login('reviewer');
    let list = mount('organizations');
    await until(
      () => list.page.data.management === 'fixed' && !list.page.data.busy,
      'school capabilities',
      list.page,
    );
    list.tap('onReviews');
    await until(
      () =>
        list.page.data.items.some((x) => x.id === id) && !list.page.data.busy,
      'real pending review queue',
      list.page,
    );
    const reviewLink = list
      .nodes()
      .find(
        (n) =>
          typeof n !== 'string' &&
          n.tag === 'navigator' &&
          String(n.attrs.url).includes(id),
      );
    assert.ok(reviewLink);
    close(list);
    editor = mount('organization-editor', { id });
    await ready(editor);
    assert.equal(editor.page.data.detail.permissions.review, true);
    editor.event('bindinput', 'onReason', { value: '请完善介绍' });
    editor.tap('onReject');
    await until(
      () =>
        editor.page.data.detail?.state === 'rejected' && !editor.page.data.busy,
      'school rejection',
      editor.page,
    );
    close(editor);
    login('owner');
    editor = mount('organization-editor', { id });
    await ready(editor);
    assert.match(editor.page.data.status, /请完善介绍/);
    inputField(editor, 'introText', '已按审核意见完善');
    editor.tap('onSubmit');
    await until(
      () =>
        editor.page.data.detail?.state === 'pending' && !editor.page.data.busy,
      'same bindings resubmitted',
      editor.page,
    );
    close(editor);
    login('reviewer');
    editor = mount('organization-editor', { id });
    await ready(editor);
    editor.tap('onApprove');
    await until(
      () =>
        editor.page.data.detail?.state === 'approved' && !editor.page.data.busy,
      'first school approval',
      editor.page,
    );
    assert.equal(
      editor.page.data.detail.members.filter(
        (m) => m.role === 'organization_owner',
      ).length,
      1,
    );
    const oldRevision = editor.page.data.revision;
    await bridge.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 40,
      height: 40,
      type: 'png',
    });
    ensureMediaOpen(editor, 'introImage0');
    editor.tap('onPickImage', { slot: 'introImage0' });
    await until(
      () => editor.page.data.upload.status === 'ready',
      'unused reviewed image',
      editor.page,
    );
    ensureMediaOpen(editor, 'introImage0');
    editor.tap('onKeepImage', { slot: 'introImage0' });
    editor.tap('onSave');
    await until(
      () =>
        editor.page.data.revision === oldRevision + 1 && !editor.page.data.busy,
      'approved edit remains visible',
      editor.page,
    );
    assert.equal(editor.page.data.detail.state, 'approved');
    assert.equal(editor.page.data.detail.mediaBindings.introImage0, null);
    await until(
      () =>
        editor.page.data.pendingImages.some(
          (p) =>
            p.slot === 'introImage0' && p.applicationRevision === oldRevision,
        ),
      'original revision upload recovery entry',
      editor.page,
    );
    editor.tap('onPendingImage', {
      slot: 'introImage0',
      revision: oldRevision,
      action: 'cancel',
    });
    await until(
      () =>
        !editor.page.data.pendingImages.some(
          (p) =>
            p.slot === 'introImage0' && p.applicationRevision === oldRevision,
        ),
      'cancel original unbound image after content advances',
      editor.page,
    );
    assert.equal(editor.page.data.detail.state, 'approved');
    assert.equal(editor.page.data.revision, oldRevision + 1);
    assert.ok(editor.page.data.detail.mediaBindings.avatar);
    assert.ok(editor.page.data.detail.mediaBindings.mainQr);
    close(editor);
    // Both source partitions use actual directory Pages and the same detail route.
    const directory = mount('directory-list', {
      kind: 'org',
      regionId: input.regionId,
      categoryId: input.categoryId,
    });
    await until(
      () =>
        directory.page.data.nativeDirectory?.items.some((x) => x.id === id) &&
        !directory.page.data.nativeDirectory.busy,
      'native approved directory partition',
      directory.page,
    );
    assert.ok(
      directory
        .nodes()
        .some(
          (n) =>
            typeof n !== 'string' &&
            n.attrs.class === 'f7-directory-section-toolbar' &&
            nodeText(n.children).includes('已核验目录'),
        ),
    );
    assert.ok(
      directory
        .nodes()
        .some(
          (n) =>
            typeof n !== 'string' &&
            n.attrs.class === 'f7-directory-section-toolbar' &&
            nodeText(n.children).includes('本平台组织'),
        ),
    );
    assert.ok(
      directory
        .nodes()
        .some(
          (n) =>
            typeof n !== 'string' &&
            n.attrs.class === 'f7-directory-section-toolbar' &&
            nodeText(n.children).includes('审核通过 · 独立目录'),
        ),
    );
    directory.tap('onNativeEntry', { id });
    close(directory);
    const publicPage = mount('directory-detail', {
      source: 'managed',
      kind: 'org',
      regionId: input.regionId,
      categoryId: input.categoryId,
      entryId: id,
    });
    await until(
      () =>
        !!publicPage.page.data.nativeDetail?.publicDetail &&
        !publicPage.page.data.nativeDetail.busy,
      'school reviewer approved public detail',
      publicPage.page,
    );
    assert.equal(
      publicPage.page.data.nativeDetail.publicDetail.management.available,
      true,
    );
    assert.ok(
      publicPage
        .nodes()
        .some(
          (n) =>
            typeof n !== 'string' &&
            n.tag === 'navigator' &&
            String(n.attrs.url).includes(
              `organization-editor/organization-editor?id=${id}`,
            ),
        ),
      'School reviewer can reach management again from approved public detail',
    );
    close(publicPage);
    editor = mount('organization-editor', { id });
    await ready(editor);
    ensureMembersOpen(editor);
    editor.event('bindinput', 'onLookupInput', { value: input.profileIds.one });
    editor.tap('onLookup');
    await until(
      () => !!editor.page.data.person && !editor.page.data.busy,
      'member lookup',
      editor.page,
    );
    editor.tap('onAddAdmin');
    await until(
      () =>
        editor.page.data.detail.members.length === 2 && !editor.page.data.busy,
      'add administrator',
      editor.page,
    );
    close(editor);
    login('one');
    editor = mount('organization-editor', { id });
    await ready(editor);
    assert.equal(editor.page.data.detail.role, 'organization_admin');
    assert.equal(editor.page.data.detail.permissions.transferOwner, false);
    ensureMembersOpen(editor);
    editor.event('bindinput', 'onLookupInput', { value: input.profileIds.two });
    editor.tap('onLookup');
    await until(
      () => !!editor.page.data.person && !editor.page.data.busy,
      'admin member lookup',
      editor.page,
    );
    editor.tap('onAddAdmin');
    await until(
      () =>
        editor.page.data.detail.members.length === 3 && !editor.page.data.busy,
      'admin adds admin',
      editor.page,
    );
    editor.tap('onRemoveAdmin', { id: input.profileIds.two });
    await until(
      () =>
        editor.page.data.detail.members.length === 2 && !editor.page.data.busy,
      'admin removes admin',
      editor.page,
    );
    close(editor);
    login('reviewer');
    editor = mount('organization-editor', { id });
    await ready(editor);
    ensureMembersOpen(editor);
    editor.event('bindinput', 'onLookupInput', { value: input.profileIds.two });
    editor.tap('onLookup');
    await until(
      () => !!editor.page.data.person && !editor.page.data.busy,
      'school transfer target',
      editor.page,
    );
    editor.tap('onTransfer');
    await until(
      () =>
        editor.page.data.detail.members.some(
          (m) =>
            m.role === 'organization_owner' &&
            m.profile?.profileId === input.profileIds.two,
        ) && !editor.page.data.busy,
      'atomic school transfer',
      editor.page,
    );
    assert.equal(
      editor.page.data.detail.members.filter(
        (m) => m.role === 'organization_owner',
      ).length,
      1,
    );
    assert.equal(
      editor.page.data.detail.members.find(
        (m) => m.profile?.profileId === input.profileIds.owner,
      )?.role,
      'organization_admin',
    );
    close(editor);
    login('owner');
    list = mount('organizations');
    await ready(list);
    assert.equal(
      list.page.data.items.find((i) => i.id === id)?.role,
      'organization_admin',
    );
    close(list);
    editor = mount('organization-editor', { id });
    await ready(editor);
    assert.equal(editor.page.data.detail.permissions.transferOwner, false);
    ensureMembersOpen(editor);
    editor.tap('onRemoveAdmin', { id: input.profileIds.owner });
    await until(
      () =>
        !editor.page.data.pending &&
        !editor.page.data.busy &&
        editor.page.data.detail === null,
      'self removal revokes management',
      editor.page,
    );
    close(editor);
    login('two');
    editor = mount('organization-editor', { id });
    await ready(editor);
    const hold = transport.holdNext(`/v1/organizations/${id}`);
    editor.tap('onRefresh');
    await hold.arrived;
    editor.page.onHide();
    hold.release();
    await delay(30);
    assert.equal(
      editor.page.data.detail,
      null,
      'hidden page never renders late privileged response',
    );
    close(editor);
    editor = mount('organization-editor', { id });
    await ready(editor);
    login('outsider');
    assert.equal(
      editor.page.data.detail,
      null,
      'account switch clears details synchronously',
    );
    close(editor);
    await rpc('verify-final', { organizationId: id });
    await send({
      event: 'done',
      organizationId: id,
      uploads: bridge.exchanges.length,
      requests: transport.exchanges.length,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message:
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error),
    });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    await bridge?.dispose();
    process.disconnect();
  }
});
