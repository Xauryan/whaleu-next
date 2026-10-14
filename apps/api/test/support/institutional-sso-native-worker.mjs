/** Actual emitted App/Page/WXML → real AppModule HTTP. Only native school handoff is synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function until(check, label, page) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${page?.data.error || page?.data.message || 'timeout'}`,
    );
    await delay(10);
  }
}
async function mint(accountId, context) {
  let listener, timer;
  const response = new Promise((resolve, reject) => {
    listener = (message) => {
      if (
        message?.event !== 'minted' ||
        message.requestId !== context.requestId
      )
        return;
      clearTimeout(timer);
      process.removeListener('message', listener);
      if (
        typeof message.authorizationResponse !== 'string' ||
        !message.authorizationResponse.length
      )
        reject(Error('Invalid synthetic minted response'));
      else resolve(message.authorizationResponse);
    };
    process.on('message', listener);
    timer = setTimeout(() => {
      process.removeListener('message', listener);
      reject(Error('Synthetic mint response timed out'));
    }, 25000);
  });
  await send({
    event: 'mint',
    accountId,
    requestId: context.requestId,
    requestHash: context.requestHash,
  });
  return response;
}
process.once('message', async (input) => {
  let app;
  const pages = new Set(),
    checkpoints = [],
    commands = [],
    secrets = [...(input.privacyMarkers ?? [])];
  const transport = new NativeExperienceTransport(input.port),
    platform = platformStorage();
  let handoffs = 0,
    authorizations = 0;
  try {
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      login: (options) =>
        queueMicrotask(() =>
          options.success({
            code: input.loginCode ?? 'synthetic-institutional-native-owner',
          }),
        ),
      request: (options) => {
        const path = new URL(options.url).pathname;
        if (
          options.method === 'POST' &&
          path.startsWith('/v1/me/institutional-sso/requests')
        ) {
          const account =
            app.identity.sessions.snapshot().credentials.accountId;
          const pending = app.institutionalSso.journal.load(account);
          assert.ok(
            pending,
            'Durable original journal exists before every institutional POST',
          );
          if (path.endsWith('/complete') && options.data.mode === 'authorize') {
            authorizations++;
            assert.equal(pending.phase, 'submit_pending');
            assert.equal(options.data.requestHash, pending.requestHash);
            assert.deepEqual(Object.keys(options.data).sort(), [
              'authorizationResponse',
              'mode',
              'requestHash',
            ]);
          } else if (path.endsWith('/complete')) {
            assert.equal(options.data.mode, 'recover');
            assert.equal(pending.phase, 'recover_started');
          } else if (path.endsWith('/close'))
            assert.equal(pending.phase, 'cancel');
          else {
            assert.equal(pending.phase, 'prepare_unstarted');
            assert.deepEqual(options.data, pending.command);
          }
          // Log only operation correlation. Never retain the request body or response bytes.
          commands.push({
            path,
            requestId: pending.command.requestId,
            phase: pending.phase,
            mode: options.data.mode ?? null,
          });
        }
        void transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            (result) =>
              options.success({
                statusCode: result.status,
                header: result.headers,
                data: result.body,
              }),
            () =>
              options.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      navigateTo: (options) => options.success?.(),
      navigateBack: (options) => options.fail({}),
      reLaunch: (options) => options.success?.(),
      showModal: (options) => options.success({ confirm: true, cancel: false }),
    };
    function boot() {
      emitted('config').clientConfiguration = Object.freeze({
        apiOrigin: nativeOrigin,
        providerLoginEnabled: true,
      });
      globalThis.wx = wx;
      globalThis.App = (value) => {
        app = value;
      };
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
    }
    function injectSyntheticPort() {
      assert.equal(
        app.institutionalSso.port.available,
        false,
        'Each fresh shipping App starts unavailable',
      );
      app.institutionalSso = {
        ...app.institutionalSso,
        port: {
          available: true,
          async authorize(context) {
            handoffs++;
            const account =
              app.identity.sessions.snapshot().credentials.accountId;
            const pending = app.institutionalSso.journal.load(account);
            assert.equal(pending.phase, 'authorize_pending');
            assert.equal(context.requestId, pending.command.requestId);
            assert.equal(context.requestHash, pending.requestHash);
            assert.deepEqual(context.context, {
              campusId: pending.command.campusId,
              capabilityVersion: pending.command.capabilityVersion,
              consent: pending.command.consent,
            });
            const authorizationResponse = await mint(account, context);
            secrets.push(authorizationResponse);
            return { state: 'authorized', authorizationResponse };
          },
        },
      };
    }
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
    const clean = () => {
      const serialized = JSON.stringify({
        storage: [...platform.storage.values],
        pages: [...pages].flatMap((h) => [h.page.data, ...h.page.patches]),
        network: transport.exchanges,
        commands,
      });
      for (const secret of secrets)
        assert.ok(
          !serialized.includes(secret),
          'Opaque/private synthetic value leaked to render/storage/network log',
        );
    };
    boot();
    const login = mount('login');
    login.tap('onLogin');
    await until(
      () => !login.page.data.busy,
      'native identity login',
      login.page,
    );
    assert.equal(login.page.data.verified, true, login.page.data.error);
    const accountId = app.identity.sessions.snapshot().credentials.accountId;
    close(login);
    checkpoints.push('native-login');
    const campus = mount('campus');
    await until(
      () => campus.page.data.loaded,
      'real campus catalog',
      campus.page,
    );
    campus.tap('onChoose', { id: input.home.campusId });
    campus.tap('onSave');
    await until(
      () => !campus.page.data.saving,
      'native browsing campus selection',
      campus.page,
    );
    close(campus);
    checkpoints.push('native-campus-selection');
    const unavailable = mount('institutional-verification', {
      campusId: input.home.campusId,
    });
    await until(
      () => !unavailable.page.data.busy && !!unavailable.page.data.capability,
      'actual institutional capability',
      unavailable.page,
    );
    assert.equal(
      unavailable.page.data.capability.state,
      'eligible',
      unavailable.page.data.error,
    );
    assert.equal(unavailable.page.data.nativeAvailable, false);
    unavailable.page.onPrepare();
    unavailable.page.onAuthorize();
    assert.equal(commands.length, 0);
    assert.equal(handoffs, 0);
    clean();
    close(unavailable);
    checkpoints.push('shipping-native-unavailable');
    injectSyntheticPort();
    let page = mount('institutional-verification', {
      campusId: input.home.campusId,
    });
    await until(
      () =>
        !page.page.data.busy && page.page.data.capability?.state === 'eligible',
      'eligible synthetic institutional capability',
      page.page,
    );
    page.event('bindchange', 'onConsent', { value: ['consent'] });
    page.tap('onPrepare');
    page.page.onPrepare();
    await until(
      () => !page.page.data.busy && page.page.data.state === 'prepared',
      'durable real institutional prepare',
      page.page,
    );
    const requestId = page.page.data.requestId;
    assert.equal(
      app.institutionalSso.journal.load(accountId).phase,
      'prepared_unstarted',
    );
    checkpoints.push('durable-prepare');
    transport.dropSuccess = {
      path: `/v1/me/institutional-sso/requests/${requestId}/complete`,
      method: 'POST',
    };
    page.tap('onAuthorize');
    page.page.onAuthorize();
    await until(
      () => !page.page.data.busy,
      'lost real complete response',
      page.page,
    );
    assert.equal(handoffs, 1);
    assert.equal(authorizations, 1);
    assert.equal(page.page.data.frozen, true);
    assert.equal(
      app.institutionalSso.journal.load(accountId).phase,
      'submit_pending',
    );
    assert.notEqual(page.page.data.state, 'completed');
    clean();
    close(page);
    app.onHide();
    checkpoints.push('lost-post-commit-response');
    boot();
    injectSyntheticPort();
    assert.equal(
      app.identity.sessions.snapshot().credentials.accountId,
      accountId,
    );
    page = mount('institutional-verification', {
      campusId: input.home.campusId,
    });
    await until(
      () => !page.page.data.busy && page.page.data.state === 'completed',
      'cold exact original completion recovery',
      page.page,
    );
    await until(
      () =>
        page.page.data.verificationView.loaded &&
        page.page.data.schoolUidView.loaded,
      'independent current Verification and UID',
      page.page,
    );
    assert.equal(page.page.data.requestId, requestId);
    assert.equal(page.page.data.frozen, false);
    assert.equal(handoffs, 1);
    assert.equal(authorizations, 1);
    const facts = input.expectedFacts ?? ['affiliation', 'student_number'];
    assert.equal(
      page.page.data.verificationView.rows.find(
        (row) => row.key === 'affiliation',
      ).value,
      facts.includes('affiliation') ? '已验证' : '未验证',
    );
    assert.equal(
      page.page.data.verificationView.rows.find(
        (row) => row.key === 'studentNumber',
      ).value,
      facts.includes('student_number') ? '已验证' : '未验证',
    );
    assert.equal(
      page.page.data.verificationView.rows.find((row) => row.key === 'phone')
        .value,
      input.expectedPhoneLabel ?? '未验证',
    );
    assert.equal(
      page.page.data.schoolUidView.schoolUid.status,
      input.expectedUidStatus ?? 'assigned',
    );
    assert.equal(app.institutionalSso.journal.load(accountId), null);
    clean();
    checkpoints.push('cold-original-recovery', 'independent-current-summaries');
    // A second deliberate operation proves prepared + started journal is never a new handoff.
    page.tap('onReload');
    await until(
      () =>
        !page.page.data.busy && page.page.data.capability?.state === 'eligible',
      'deliberate next operation capability',
      page.page,
    );
    page.event('bindchange', 'onConsent', { value: ['consent'] });
    page.tap('onPrepare');
    await until(
      () => !page.page.data.busy && page.page.data.state === 'prepared',
      'second distinct prepared request',
      page.page,
    );
    const cancelledRequestId = page.page.data.requestId;
    assert.notEqual(cancelledRequestId, requestId);
    app.institutionalSso.journal.advance(
      app.institutionalSso.journal.load(accountId),
      'authorize_pending',
    );
    clean();
    close(page);
    app.onHide();
    boot();
    injectSyntheticPort();
    page = mount('institutional-verification', {
      campusId: input.home.campusId,
    });
    await until(
      () => !page.page.data.busy && page.page.data.state === 'prepared',
      'cold started/prepared recovery',
      page.page,
    );
    assert.equal(page.page.data.canAuthorize, false);
    page.page.onAuthorize();
    await delay(20);
    assert.equal(handoffs, 1);
    assert.equal(authorizations, 1);
    assert.equal(page.page.data.requestId, cancelledRequestId);
    checkpoints.push('started-prepared-no-rehandoff');
    page.tap('onClose');
    await until(
      () => !page.page.data.busy && page.page.data.state === 'cancelled',
      'original-key close after cold uncertainty',
      page.page,
    );
    assert.equal(app.institutionalSso.journal.load(accountId), null);
    checkpoints.push('durable-original-close');
    clean();
    for (const path of ['/v1/me/verification', '/v1/me/school-uid'])
      assert.ok(
        transport.exchanges.filter(
          (exchange) =>
            exchange.path === path &&
            exchange.method === 'GET' &&
            exchange.status === 200,
        ).length >= 2,
      );
    close(page);
    await send({
      event: 'done',
      accountId,
      requestId,
      cancelledRequestId,
      checkpoints,
      handoffs,
      authorizations,
      requests: transport.exchanges.length,
    });
  } catch (error) {
    // All assertions and errors above intentionally avoid private values in their messages.
    await send({
      event: 'failure',
      message:
        error instanceof Error
          ? error.stack
          : 'Native institutional journey failed',
    });
  } finally {
    for (const page of pages) {
      page.page.onHide?.();
      page.page.onUnload?.();
    }
    app?.onHide?.();
    app?.identity?.dispose?.();
    process.disconnect?.();
  }
});
