import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Deliberately use emitted Page/controller/Toggle bytes, never a replacement
// Toggle model or business controller. Only the platform/storage shell is fake.
const requireNative = createRequire(__filename);
const { createActivityPublicationToggleBridge } = requireNative(
  '../../api/test/support/activity-publication-native-toggle.mjs',
);
const { createNativePressBridge } = requireNative(
  './native-press-emitted-harness.mjs',
);
const baseline = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(__dirname, '../dist'),
);
interface Owner {
  data: Record<string, unknown> & {
    form: { showOrganizerQr: boolean };
    uiPanels: { options: boolean };
  };
  controller?: { snapshot(): { form: { showOrganizerQr: boolean } } };
  setData(patch: Record<string, unknown>, callback?: () => void): unknown;
  onLoad(query: Record<string, string>): void;
  onShow(): unknown;
  onHide(): void;
  onUnload(): void;
  onQr(event: unknown): void;
}
const globals = globalThis as unknown as {
  Page?: (page: Owner) => void;
  getApp?: () => unknown;
  wx?: unknown;
  Component?: unknown;
};
const wait = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(
  edit?: (source: string) => string,
  config?: (value: { usingComponents: Record<string, string> }) => void,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'activity-qr-toggle-'));
  const dist = path.join(dir, 'dist');
  cpSync(baseline, dist, { recursive: true });
  const pageFile = path.join(dist, 'pages/activity-publish/activity-publish');
  if (edit)
    writeFileSync(
      `${pageFile}.wxml`,
      edit(readFileSync(`${pageFile}.wxml`, 'utf8')),
    );
  if (config) {
    const value = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
    config(value);
    writeFileSync(`${pageFile}.json`, JSON.stringify(value));
  }
  return {
    dir,
    dist,
    pageFile,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
async function mounted(
  f = {
    dist: baseline,
    pageFile: path.join(baseline, 'pages/activity-publish/activity-publish'),
    close() {},
  },
  options: { cleanupInsideShow?: boolean; deferredShow?: Promise<void> } = {},
) {
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let page: Owner | undefined;
  globals.Page = (value) => {
    assert.equal(page, undefined);
    page = value;
  };
  const { SessionStore } = requireNative(path.join(f.dist, 'auth/session.js'));
  const sessions = new SessionStore();
  globals.getApp = () => ({
    identity: {
      sessions,
      api: {
        request() {
          assert.fail('This pure adapter test must not request HTTP');
        },
      },
    },
    community: {
      newRequestId() {
        assert.fail('Toggle intent must not publish');
      },
    },
  });
  globals.wx = {
    getStorageSync() {
      return undefined;
    },
    setStorageSync() {
      assert.fail('No persisted publication');
    },
    removeStorageSync() {},
  };
  const target = requireNative.resolve(`${f.pageFile}.js`);
  delete requireNative.cache[target];
  requireNative(target);
  assert.ok(page, 'Actual emitted activity publisher registers Page');
  const owner = page;
  const platformWrites: Record<string, unknown>[] = [];
  let callback: (() => void) | undefined;
  owner.setData = function (patch, done) {
    platformWrites.push(structuredClone(patch));
    Object.assign(this.data, patch);
    done?.();
    callback?.();
  };
  const originalShow = owner.onShow;
  owner.onShow = function () {
    if (options.cleanupInsideShow) this.onHide();
    originalShow.call(this);
    return options.deferredShow;
  };
  const bridge = createActivityPublicationToggleBridge({
    page: owner,
    dist: f.dist,
    pageFile: f.pageFile,
  });
  owner.onLoad({});
  owner.onShow();
  await wait();
  assert.ok(owner.controller, 'Real emitted controller exists');
  assert.equal(owner.data.form.showOrganizerQr, false);
  // Opening options uses the existing real emitted F7 Button bridge.
  const press = createNativePressBridge({
    page: owner,
    dist: f.dist,
    pageFile: f.pageFile,
  });
  function open() {
    if (owner.data.uiPanels.options) return;
    const control = press.capture('onTogglePanel', { field: 'options' });
    try {
      assert.equal(control.press(), true);
    } finally {
      control.detach();
    }
  }
  return {
    page: owner,
    bridge,
    sessions,
    platformWrites,
    open,
    onPlatformWrite(fn: () => void) {
      callback = fn;
    },
    close() {
      callback = undefined;
      owner.onUnload();
      for (const key of ['Page', 'getApp', 'wx'] as const) {
        if (previous[key] === undefined) delete globals[key];
        else (globals as Record<string, unknown>)[key] = previous[key];
      }
      f.close();
    },
  };
}
const change = { detail: { value: true } };
const mutateHost = (attribute: string) => (source: string) =>
  source.replace('<wu-f7-toggle ', `<wu-f7-toggle ${attribute} `);
const mutateParent = (attribute: string) => (source: string) =>
  source.replace(
    '<view class="activity-setting-row">',
    `<view class="activity-setting-row" ${attribute}>`,
  );

test('actual emitted switch -> Toggle -> isolated onQr -> real controller, one shot and synchronous owner reconciliation', async () => {
  const h = await mounted();
  try {
    assert.throws(() => h.bridge.capture(), /must render/);
    h.open();
    const control = h.bridge.capture();
    assert.equal(control.instance.data.mounted, true);
    assert.equal(control.instance.properties.checked, false);
    const emit = control.instance.triggerEvent;
    control.instance.triggerEvent = function (...args: unknown[]) {
      assert.equal(
        this.data.nativeChecked,
        false,
        'Real model reconciles to the owner BEFORE emission',
      );
      return emit.apply(this, args);
    };
    const observed: boolean[] = [];
    h.onPlatformWrite(() => {
      observed.push(control.instance.data.nativeChecked);
    });
    assert.equal(control.change(change), true);
    assert.equal(h.page.data.form.showOrganizerQr, true);
    assert.equal(h.page.controller?.snapshot().form.showOrganizerQr, true);
    assert.equal(control.instance.properties.checked, true);
    assert.equal(control.instance.data.nativeChecked, true);
    assert.ok(
      observed.includes(true),
      'Owner checked observer runs synchronously before platform callback returns',
    );
    assert.equal(
      control.instance.data.mounted,
      false,
      'Accepted capture is single use',
    );
    assert.equal(control.change(change), false);
    assert.deepEqual(h.bridge.emissions, [
      {
        type: 'change',
        detail: { value: true },
        currentTarget: { dataset: {} },
        target: { dataset: {} },
        options: { bubbles: false, composed: false },
        tag: 'wu-f7-toggle',
      },
    ]);
  } finally {
    h.close();
  }
});

test('actual model reconciles before emission and same/malformed native detail cannot change owner', async () => {
  const h = await mounted();
  try {
    h.open();
    for (const nativeEvent of [
      undefined,
      {},
      { detail: null },
      { detail: {} },
      { detail: { value: false } },
      { detail: { value: 'true' } },
      { detail: { value: 1 } },
    ]) {
      const control = h.bridge.capture();
      control.instance.data.nativeChecked = true; // Simulate the native switch's transient state only.
      assert.equal(control.change(nativeEvent), false);
      assert.equal(
        control.instance.data.nativeChecked,
        false,
        'Actual model reverts to owner even for rejected native detail',
      );
      assert.equal(h.page.data.form.showOrganizerQr, false);
    }
    assert.equal(h.bridge.emissions.length, 0);
  } finally {
    h.close();
  }
});

test('typed complete host dataset comes from actual rendered markup, not the caller', async () => {
  const f = fixture(
    mutateHost(
      'data-field="qr" data-draft-revision="{{revision}}" data-is-new="{{!id}}" data-payload="{{form.types}}" data-copy="A &amp; B"',
    ),
  );
  const h = await mounted(f);
  try {
    h.open();
    const control = h.bridge.capture();
    assert.equal(
      control.change({
        ...change,
        currentTarget: { dataset: { field: 'forged' } },
      }),
      true,
    );
    const expected = {
      field: 'qr',
      draftRevision: 0,
      isNew: true,
      payload: [],
      copy: 'A & B',
    };
    assert.deepEqual(h.bridge.emissions[0].currentTarget.dataset, expected);
    assert.deepEqual(h.bridge.emissions[0].target.dataset, expected);
  } finally {
    h.close();
  }
});

for (const [label, edit] of [
  [
    'host disabled',
    (source: string) =>
      source.replace(
        'bind:change="onQr" disabled="{{busy || pending}}"',
        'bind:change="onQr" disabled="{{true}}"',
      ),
  ],
  ['host readOnly', mutateHost('read-only="{{true}}"')],
  ['host loading', mutateHost('loading="{{true}}"')],
  ['unknown host loading', mutateHost('loading="unknown"')],
  ['parent disabled', mutateParent('disabled="{{true}}"')],
  ['parent readOnly', mutateParent('read-only="{{true}}"')],
  ['parent loading', mutateParent('loading="{{true}}"')],
  ['hidden host', mutateHost('hidden="{{true}}"')],
  ['hidden parent', mutateParent('hidden="{{true}}"')],
  ['CSS hidden parent', mutateParent('style="display: none !important;"')],
] as const) {
  test(`${label} fails closed without Page delivery`, async () => {
    const h = await mounted(fixture(edit));
    try {
      h.open();
      const control = h.bridge.capture();
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          control.instance.properties,
          'loading',
        ),
        false,
        'No invented Toggle loading property',
      );
      assert.equal(control.change(change), false);
      assert.equal(h.page.data.form.showOrganizerQr, false);
      assert.equal(h.bridge.emissions.length, 0);
    } finally {
      h.close();
    }
  });
}

test('actual disabled and readOnly model methods reject even direct late component callback', async () => {
  for (const field of ['disabled', 'readOnly']) {
    const h = await mounted();
    try {
      h.open();
      const control = h.bridge.capture();
      control.instance.properties[field] = true;
      control.instance.data.nativeChecked = true;
      control.definition.methods.onChange.call(control.instance, change);
      assert.equal(control.instance.data.nativeChecked, false);
      assert.equal(h.bridge.emissions.length, 0);
      assert.equal(h.page.data.form.showOrganizerQr, false);
      control.detach();
    } finally {
      h.close();
    }
  }
});

test('unknown default-false boolean and missing emitted switch binding fail closed', async () => {
  const h = await mounted(fixture(mutateHost('read-only="unknown"')));
  try {
    h.open();
    assert.throws(() => h.bridge.capture(), /Unknown boolean/);
  } finally {
    h.close();
  }
  const f = fixture();
  const file = path.join(f.dist, 'components/f7-toggle/f7-toggle.wxml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'catchchange="onChange"',
      'bindtap="onConsumeTap"',
    ),
  );
  const missing = await mounted(f);
  try {
    missing.open();
    assert.throws(() => missing.bridge.capture(), /native switch catchchange/);
  } finally {
    missing.close();
  }
});

for (const registered of [false, true])
  test(`unknown ${registered ? 'registered' : 'unregistered'} component ancestor is not presentation`, async () => {
    const h = await mounted(
      fixture(
        (source) =>
          source
            .replace(
              '<view class="activity-setting-row">',
              '<unknown-parent><view class="activity-setting-row">',
            )
            .replace(
              'aria-label="公开主办方二维码"/></view>',
              'aria-label="公开主办方二维码"/></view></unknown-parent>',
            ),
        registered
          ? (config) => {
              config.usingComponents['unknown-parent'] =
                '../../components/f7-block/f7-block';
            }
          : undefined,
      ),
    );
    try {
      h.open();
      assert.equal(h.bridge.capture().change(change), false);
      assert.equal(h.bridge.emissions.length, 0);
    } finally {
      h.close();
    }
  });

test('wrong Toggle and presentation registration, non-Component JSON, and cross-artifact files reject', async () => {
  const owner = { onQr() {}, setData() {} };
  for (const target of [
    '../../components/f7-input/f7-input',
    '/components/unknown/f7-toggle',
    `${baseline}/components/f7-toggle/f7-toggle`,
  ]) {
    const f = fixture(undefined, (config) => {
      config.usingComponents['wu-f7-toggle'] = target;
    });
    try {
      assert.throws(
        () => createActivityPublicationToggleBridge({ page: owner, ...f }),
        /Wrong emitted/,
      );
    } finally {
      f.close();
    }
  }
  const json = fixture();
  writeFileSync(
    path.join(json.dist, 'components/f7-toggle/f7-toggle.json'),
    '{"component":false}',
  );
  try {
    assert.throws(
      () => createActivityPublicationToggleBridge({ page: owner, ...json }),
      /must be a Component/,
    );
  } finally {
    json.close();
  }
  const cross = fixture();
  try {
    assert.throws(
      () =>
        createActivityPublicationToggleBridge({
          page: owner,
          dist: cross.dist,
          pageFile: path.join(
            baseline,
            'pages/activity-publish/activity-publish',
          ),
        }),
      /selected activity-publish/,
    );
    const file = path.join(cross.dist, 'components/f7-toggle/f7-toggle.js');
    rmSync(file);
    symlinkSync(path.join(baseline, 'components/f7-toggle/f7-toggle.js'), file);
    assert.throws(
      () => createActivityPublicationToggleBridge({ page: owner, ...cross }),
      /redirect to another artifact/,
    );
  } finally {
    cross.close();
  }
  const wrongParent = await mounted(
    fixture(
      (source) =>
        source
          .replace(
            '<view class="activity-setting-row">',
            '<wu-f7-list><view class="activity-setting-row">',
          )
          .replace(
            'aria-label="公开主办方二维码"/></view>',
            'aria-label="公开主办方二维码"/></view></wu-f7-list>',
          ),
      (config) => {
        config.usingComponents['wu-f7-list'] =
          '../../components/f7-button/f7-button';
      },
    ),
  );
  try {
    wrongParent.open();
    assert.throws(
      () => wrongParent.bridge.capture().change(change),
      /Wrong emitted wu-f7-list/,
    );
  } finally {
    wrongParent.close();
  }
});

test('removed parent, restored markup, any owner update, and real session reset permanently stale captures', async () => {
  const h = await mounted();
  try {
    h.open();
    const removed = h.bridge.capture();
    h.page.setData({ uiPanels: { ...h.page.data.uiPanels, options: false } });
    assert.throws(() => h.bridge.capture(), /must render/);
    h.open();
    assert.equal(
      removed.change(change),
      false,
      'Reappearing identical markup cannot revive a detached capture',
    );
    const changed = h.bridge.capture();
    h.page.setData({ status: 'Owner rendered again' });
    assert.equal(changed.change(change), false);
    const account = h.bridge.capture();
    h.sessions.beginLogin();
    assert.equal(
      account.change(change),
      false,
      'Real SessionStore epoch callback invalidates the old owner capture',
    );
    account.definition.methods.onChange.call(account.instance, change);
    assert.equal(h.bridge.emissions.length, 0);
    assert.equal(h.page.data.form.showOrganizerQr, false);
  } finally {
    h.close();
  }
});

test('hidden then restored parent cannot revive an existing capture', async () => {
  const h = await mounted(fixture(mutateParent('hidden="{{qrHidden}}"')));
  try {
    h.page.setData({ qrHidden: false });
    h.open();
    const control = h.bridge.capture();
    h.page.setData({ qrHidden: true });
    assert.equal(h.bridge.capture().change(change), false);
    h.page.setData({ qrHidden: false });
    assert.equal(control.change(change), false);
    assert.equal(h.bridge.emissions.length, 0);
  } finally {
    h.close();
  }
});

test('hide/show and unload use actual Page lifecycle and cannot revive late callbacks', async () => {
  const h = await mounted();
  try {
    h.open();
    const hidden = h.bridge.capture();
    h.page.onHide();
    assert.equal(hidden.instance.data.pageVisible, false);
    assert.equal(hidden.instance.data.mounted, false);
    h.page.onShow();
    await wait();
    h.open();
    assert.equal(hidden.change(change), false);
    hidden.definition.methods.onChange.call(hidden.instance, change);
    const unloaded = h.bridge.capture();
    h.page.onUnload();
    assert.equal(unloaded.change(change), false);
    h.page.onShow();
    await wait();
    h.open();
    assert.equal(
      h.bridge.capture().change(change),
      false,
      'An unloaded adapter must never attach again',
    );
    assert.equal(h.bridge.emissions.length, 0);
  } finally {
    h.close();
  }
});

test('synchronous onShow cleanup is not platform hide, asynchronous show completion never revives', async () => {
  const h = await mounted(undefined, { cleanupInsideShow: true });
  try {
    h.open();
    assert.equal(h.bridge.capture().change(change), true);
  } finally {
    h.close();
  }
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const late = await mounted(undefined, { deferredShow: pending });
  try {
    late.open();
    const control = late.bridge.capture();
    late.page.onHide();
    resolve();
    await wait();
    assert.equal(control.change(change), false);
    late.open();
    assert.equal(late.bridge.capture().change(change), false);
    assert.equal(late.bridge.emissions.length, 0);
  } finally {
    late.close();
  }
});

test('actual emitted non-isolated options cannot cross the bridge', async () => {
  const f = fixture();
  const file = path.join(f.dist, 'components/f7-toggle/f7-toggle.js');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'bubbles: false, composed: false',
      'bubbles: true, composed: false',
    ),
  );
  const h = await mounted(f);
  try {
    h.open();
    assert.throws(() => h.bridge.capture().change(change));
    assert.equal(h.bridge.emissions.length, 0);
    assert.equal(h.page.data.form.showOrganizerQr, false);
  } finally {
    h.close();
  }
});

// These temporary artifact mutations verify containment, not alternate models.
for (const [label, mutate] of [
  [
    'unknown switch ancestor',
    (source: string) =>
      source
        .replace('<switch ', '<unknown-parent><switch ')
        .replace(
          'catchchange="onChange" />',
          'catchchange="onChange" /></unknown-parent>',
        ),
  ],
  [
    'native switch disabled',
    (source: string) =>
      source.replace(
        'disabled="{{disabled || readOnly || !mounted || !pageVisible}}"',
        'disabled="true"',
      ),
  ],
  [
    'native switch permission control',
    (source: string) =>
      source.replace('<switch ', '<switch open-type="getPhoneNumber" '),
  ],
] as const) {
  test(`${label} in emitted Toggle WXML cannot deliver owner intent`, async () => {
    const f = fixture();
    const file = path.join(f.dist, 'components/f7-toggle/f7-toggle.wxml');
    writeFileSync(file, mutate(readFileSync(file, 'utf8')));
    const h = await mounted(f);
    try {
      h.open();
      assert.equal(h.bridge.capture().change(change), false);
      assert.equal(h.bridge.emissions.length, 0);
      assert.equal(h.page.data.form.showOrganizerQr, false);
    } finally {
      h.close();
    }
  });
}
