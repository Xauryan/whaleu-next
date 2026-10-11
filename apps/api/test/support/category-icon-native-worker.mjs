/** TEST ONLY native platform bridge to a real AppModule loopback server.
 * Controller, runtime, gateways, adapter, registry and journal are production.
 * Only native wx APIs, fixture media processing and exact Review are synthetic. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  RatingCategoryScopedController,
} = require('../../../wechat/src/ratings/category-scoped-controller.ts');
const {
  CategoryIconUpload,
} = require('../../../wechat/src/ratings/category-icon-upload.ts');
const { MediaLocalFiles } = require('../../../wechat/src/media/local-files.ts');
const origin = 'https://category-icon-real-native.invalid';
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
const keepAlive = () => {
  const timer = setInterval(() => undefined, 60000);
  process.once('disconnect', () => clearInterval(timer));
};
let rpcSequence = 0;
const rpc = async (kind, payload) => {
  const rpcId = ++rpcSequence;
  const answer = new Promise((resolve, reject) => {
    const receive = (message) => {
      if (message?.event !== 'rpc-result' || message.rpcId !== rpcId) return;
      process.removeListener('message', receive);
      if (message.error) reject(Error(message.error));
      else resolve();
    };
    process.on('message', receive);
  });
  await send({ event: 'rpc', rpcId, kind, ...payload });
  await answer;
};
process.once('message', async (input) => {
  try {
    const {
      mode,
      stage,
      server,
      path,
      credentials,
      foreign,
      route,
      operation,
      selection,
      name,
      png,
    } = input;
    const calls = [],
      receipts = [],
      resident = new Map(),
      removed = [],
      scopeInputs = [],
      processed = new Set();
    let issuedIds = 0,
      pickerCalls = 0,
      uploadCalls = 0,
      view,
      store,
      controller;
    const read = () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    };
    const write = (value) => {
      writeFileSync(path + '.next', JSON.stringify(value), {
        mode: 0o600,
        flush: true,
      });
      renameSync(path + '.next', path);
    };
    const storage = {
      getStorageSync: (key) => read()[key],
      setStorageSync: (key, value) => {
        const all = read();
        all[key] = value;
        write(all);
      },
      removeStorageSync: (key) => {
        const all = read();
        delete all[key];
        write(all);
      },
      getRandomValues: (options) => {
        assert.equal(mode, 'edit', 'Recovery cannot mint a request identity');
        issuedIds++;
        options.success({
          randomValues: Uint8Array.from(randomBytes(options.length)).buffer,
        });
      },
    };
    const sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), credentials);
    const clock = {
      now: () => Date.now(),
      schedule: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
    };
    const snapshot = () => ({
      calls,
      receipts,
      issuedIds,
      pickerCalls,
      uploadCalls,
      resident: resident.size,
      removed: removed.length,
      scopeInputs,
      pending: store.isOpaque(credentials.accountId)
        ? null
        : store.load(credentials.accountId),
    });
    const suspend = async (event, extra = {}) => {
      keepAlive();
      await send({ event, ...snapshot(), ...extra });
      return new Promise(() => {});
    };
    const transport = {
      send: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, origin);
        assert.match(url.pathname, /^\/v[235]\/(ratings|media)\//);
        if (
          stage === 'unknown-scope' &&
          url.pathname === '/v5/ratings/category-management/upload-scopes'
        ) {
          scopeInputs.push(request.body);
          return suspend('checkpoint'); // Durable member exists; owner has not received it.
        }
        calls.push({ method: request.method, path: url.pathname });
        const abort = new AbortController(),
          off = request.cancellation?.subscribe(() => abort.abort());
        try {
          const response = await fetch(server + url.pathname + url.search, {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined
              ? {}
              : { body: JSON.stringify(request.body) }),
            redirect: 'error',
            signal: abort.signal,
          });
          const body = await response.json();
          if (
            response.status === 200 &&
            url.pathname === '/v5/ratings/category-management/upload-scopes'
          )
            scopeInputs.push(request.body);
          if (
            response.status === 200 &&
            /\/v3\/media\/ratings-category-icon\/upload-scopes\/[^/]+\/finalize$/.test(
              url.pathname,
            ) &&
            !processed.has(url.pathname)
          ) {
            processed.add(url.pathname);
            await rpc('process', {});
          }
          if (
            response.status === 200 &&
            url.pathname === '/v5/ratings/category-management/prepare' &&
            !body.outcome
          )
            await rpc('review', { intent: request.body });
          if (
            response.status === 200 &&
            body.protocolVersion === 5 &&
            body.outcome
          )
            receipts.push(body);
          if (
            response.status === 200 &&
            stage === 'applied-response-lost' &&
            url.pathname === '/v5/ratings/category-management/commit'
          ) {
            const original = store.load(credentials.accountId);
            if (foreign) sessions.completeLogin(sessions.beginLogin(), foreign);
            keepAlive();
            await send({
              event: 'server-committed',
              calls,
              receipt: body,
              original,
              intent: original.command.intent,
              opaque: read(),
              scopeInputs,
              issuedIds,
              pickerCalls,
              uploadCalls,
              resident: resident.size,
              removed: removed.length,
            });
            return new Promise(() => {});
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body,
          };
        } finally {
          off?.();
        }
      },
    };
    const api = new ApiClient(origin, transport, sessions, {
      refresh: async () => {
        throw Error('Fresh fixture credentials must not refresh');
      },
    });
    const bytes = Buffer.from(png ?? '', 'base64');
    const files = {
      stat: async (path) => {
        assert.ok(resident.has(path));
        return resident.get(path).length;
      },
      image: async (path) => {
        assert.ok(resident.has(path));
        return { width: 32, height: 24, type: 'png' };
      },
      digest: async (path, size, current) => {
        current();
        const value = resident.get(path);
        assert.equal(value?.length, size);
        return createHash('sha256').update(value).digest('hex');
      },
      readError: async () => null,
      unlink: async (path) => {
        assert.equal(
          resident.delete(path),
          true,
          'Native temporary file is removed exactly once',
        );
        removed.push(path);
      },
    };
    const registry = new MediaLocalFiles(files);
    const wx = {
      ...storage,
      chooseMedia: (options) => {
        assert.equal(mode, 'edit');
        pickerCalls++;
        const filePath = `wxfile://tmp/category-icon-${pickerCalls}.png`;
        resident.set(filePath, bytes);
        options.success({
          tempFiles: [
            { tempFilePath: filePath, size: bytes.length, fileType: 'image' },
          ],
        });
        options.complete();
      },
      uploadFile: (options) => {
        assert.equal(mode, 'edit');
        uploadCalls++;
        const url = new URL(options.url),
          abort = new AbortController();
        assert.equal(url.origin, origin);
        assert.equal(options.name, 'file');
        calls.push({ method: 'POST', path: url.pathname });
        const body = new FormData();
        body.append(
          'file',
          new Blob([resident.get(options.filePath)], { type: 'image/png' }),
          'native-category-icon.png',
        );
        void fetch(server + url.pathname, {
          method: 'POST',
          headers: options.header,
          body,
          redirect: 'error',
          signal: abort.signal,
        })
          .then(async (response) =>
            options.success({
              statusCode: response.status,
              data: await response.text(),
            }),
          )
          .catch((error) => options.fail(error))
          .finally(() => options.complete());
        return {
          abort: () => abort.abort(),
          onProgressUpdate: () => undefined,
          offProgressUpdate: () => undefined,
        };
      },
    };
    const base = createCommunityRuntime({ sessions, api }, wx, origin, clock);
    const runtime = {
      ...base,
      ratingCategoryIconUpload: new CategoryIconUpload(
        origin,
        wx,
        files,
        registry,
        sessions,
        clock,
      ),
    };
    store = runtime.pendingRatingCategoryIcon;
    controller = new RatingCategoryScopedController(
      runtime,
      (value) => {
        view = value;
      },
      true,
      clock,
    );
    if (mode === 'foreign') {
      const before = read();
      await controller.recover();
      assert.deepEqual(calls, []);
      assert.deepEqual(read(), before);
      assert.deepEqual(store.load(credentials.accountId), {
        command: null,
        uploads: null,
      });
      controller.dispose();
      await send({ event: 'foreign-isolated', ...snapshot() });
      process.disconnect();
      return;
    }
    if (mode === 'recover') {
      await controller.load({
        deliberately: 'invalid route; original receipt comes first',
      });
      if (
        store.isOpaque(credentials.accountId) ||
        store.load(credentials.accountId).uploads ||
        store.load(credentials.accountId).command
      ) {
        controller.requestCancel();
        await controller.confirmCancel();
      }
      if (input.expectCleanupPending) {
        const retained = store.opaqueRecovery(credentials.accountId);
        assert.equal(retained.command.receipt.outcome, 'closed');
        assert.equal(retained.command.obligations.length, 1);
        assert.equal(retained.uploads.obligations.length, 1);
        assert.ok(view.error, 'Pending physical cleanup must remain explicit');
      } else assert.deepEqual(read(), {}, view.error);
      assert.equal(issuedIds, 0);
      assert.equal(uploadCalls, 0);
      assert.equal(pickerCalls, 0);
      controller.dispose();
      await send({ event: 'recovered', ...snapshot() });
      process.disconnect();
      return;
    }
    await controller.load(route);
    assert.equal(view.loaded, true, view.error);
    assert.equal(view.iconEnabled, true, view.error);
    controller.selectOperation(operation);
    if (operation === 'create_categories_scoped') {
      controller.setNodeText('n0', 'name', name);
      for (let i = 1; i < (input.nodeCount ?? 1); i++) {
        controller.addNode('n0');
        controller.setNodeText(`n${i}`, 'name', `${name} child ${i}`);
      }
    }
    if (operation === 'edit_category_base_scoped')
      controller.setText('name', name);
    const slots = [...view.iconSlots];
    assert.ok(slots.length);
    for (const slot of slots) controller.chooseIcon(slot.key, selection);
    await controller.prepare();
    assert.equal(view.iconFrozen, true, view.error);
    if (selection === 'replace') {
      for (const [index, slot] of slots.entries()) {
        await controller.uploadIcon(slot.key);
        assert.equal(
          store.load(credentials.accountId).uploads.members[index]?.state,
          'ready',
          view.error,
        );
        assert.equal(
          resident.size,
          0,
          'Actual native complete precedes temporary-file removal',
        );
      }
      await controller.preparePending();
    }
    assert.ok(view.preview, view.error);
    const original = store.load(credentials.accountId),
      intent = original.command.intent;
    if (stage === 'opaque-prepared') {
      assert.ok(foreign);
      sessions.completeLogin(sessions.beginLogin(), foreign);
      assert.equal(store.isOpaque(credentials.accountId), true);
      assert.deepEqual(store.load(foreign.accountId), {
        command: null,
        uploads: null,
      });
      keepAlive();
      await send({
        event: 'checkpoint',
        calls,
        intent,
        original,
        opaque: read(),
        scopeInputs,
        issuedIds,
        pickerCalls,
        uploadCalls,
        resident: resident.size,
        removed: removed.length,
      });
      return;
    }
    await controller.commit();
    assert.deepEqual(read(), {}, view.error);
    controller.dispose();
    await send({ event: 'completed', ...snapshot(), intent });
    process.disconnect();
  } catch (error) {
    await send({ event: 'failure', message: error.stack ?? String(error) });
    process.exitCode = 1;
    process.disconnect();
  }
});
