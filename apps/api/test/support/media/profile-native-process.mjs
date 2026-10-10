/** Separate native process using the real strict Profile gateway and durable
 * actor-scoped journal. IPC credentials never enter the persisted file. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../../wechat/src/auth/session.ts');
const { ApiClient } = require('../../../../wechat/src/api/client.ts');
const {
  Cancellation,
} = require('../../../../wechat/src/platform/contracts.ts');
const {
  HttpAvatarGateway,
} = require('../../../../wechat/src/profile/avatar-gateway.ts');
const {
  AvatarPrincipalOwner,
} = require('../../../../wechat/src/profile/avatar-principal.ts');
const {
  ProfileAvatarUpload,
} = require('../../../../wechat/src/profile/avatar-upload.ts');
const {
  MediaLocalFiles,
} = require('../../../../wechat/src/media/local-files.ts');
const { systemClock } = require('../../../../wechat/src/platform/clock.ts');
const {
  PendingAvatarStore,
} = require('../../../../wechat/src/profile/avatar-pending.ts');
const origin = 'https://profile-native-process.invalid';
const send = (message, exit = false) =>
  new Promise((resolve) =>
    process.send(message, () => {
      resolve();
      if (exit) process.exit(0);
    }),
  );
process.once('message', async (message) => {
  try {
    assert.equal(message.command, 'start');
    const {
      credentials,
      journalPath,
      port,
      mode,
      prepare,
      selection,
      originalActor,
      sourcePath,
      readyStatus,
    } = message;
    const read = () => {
      try {
        return JSON.parse(readFileSync(journalPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw error;
      }
    };
    const write = (value) =>
      writeFileSync(journalPath, JSON.stringify(value), {
        mode: 0o600,
        flush: true,
      });
    const storage = {
      get(key) {
        return read()[key];
      },
      set(key, value) {
        const old = read();
        old[key] = value;
        write(old);
      },
      remove(key) {
        const old = read();
        delete old[key];
        write(old);
      },
    };
    const sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), credentials);
    const ticket = sessions.snapshot();
    const session = {
      current() {
        sessions.assertCurrent(ticket);
        return sessions.snapshot();
      },
    };
    const pending = new PendingAvatarStore(storage, origin);
    if (mode === 'foreign-actor') {
      assert.notEqual(credentials.accountId, originalActor);
      assert.equal(pending.load(credentials.accountId), null);
      await send({ event: 'foreign-isolated' }, true);
      return;
    }
    const transport = {
      async send(input) {
        const url = new URL(input.url);
        assert.equal(url.origin, origin);
        assert.match(url.pathname, /^\/v1\/(me\/profile|profiles\/)/);
        const abort = new AbortController(),
          unsubscribe = input.cancellation?.subscribe(() => abort.abort());
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}${url.pathname}${url.search}`,
            {
              method: input.method,
              headers: input.headers,
              ...(input.body === undefined
                ? {}
                : { body: JSON.stringify(input.body) }),
              redirect: 'error',
              signal: abort.signal,
            },
          );
          const body = await response.json();
          const withhold =
            response.status === 200 &&
            input.method === 'POST' &&
            ((mode === 'prepare-and-stop' &&
              url.pathname === '/v1/me/profile/avatar-edits') ||
              (mode === 'command-and-stop' &&
                url.pathname === '/v1/me/profile/avatar-commands') ||
              (mode === 'grant-and-stop' && url.pathname.endsWith('/grant')) ||
              (mode === 'finalize-and-stop' &&
                url.pathname.endsWith('/finalize')));
          if (withhold) {
            await send({
              event:
                mode === 'prepare-and-stop'
                  ? 'prepare-committed'
                  : mode === 'grant-and-stop'
                    ? 'grant-committed'
                    : mode === 'finalize-and-stop'
                      ? 'finalize-committed'
                      : 'command-committed',
              result: body,
            });
            return await new Promise(() => {}); // Supervisor observes real SIGKILL before restart.
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body,
          };
        } finally {
          unsubscribe?.();
        }
      },
    };
    const gateway = new HttpAvatarGateway(
      new ApiClient(origin, transport, sessions, {
        async refresh() {
          throw new Error('Fresh IPC session should not refresh');
        },
      }),
    );
    if (mode === 'prepare-and-stop') {
      pending.freezeEdit(credentials.accountId, prepare);
      await gateway.prepare(prepare, session, new Cancellation());
      throw new Error('Response should have remained uncertain');
    }
    if (mode === 'command-and-stop' || mode === 'command-freeze-and-stop') {
      if (selection.source.kind === 'custom') {
        const original = pending.freezeEdit(credentials.accountId, prepare);
        pending.observe(original, readyStatus);
      }
      pending.freezeCommand(credentials.accountId, selection);
      if (mode === 'command-freeze-and-stop') {
        await send({ event: 'command-frozen' });
        await new Promise(() => {});
      }
      await gateway.command(selection, session, new Cancellation());
      throw new Error('Response should have remained uncertain');
    }
    if (
      ['grant-and-stop', 'upload-and-stop', 'finalize-and-stop'].includes(mode)
    ) {
      let saved = pending.freezeEdit(credentials.accountId, prepare);
      const prepared = await gateway.prepare(
        prepare,
        session,
        new Cancellation(),
      );
      saved = pending.observe(saved, prepared);
      const grant = await gateway.grant(
        prepared.editId,
        session,
        new Cancellation(),
      );
      const nativePath = 'wxfile://tmp/profile-process-avatar.png';
      const files = {
        async stat(path) {
          assert.equal(path, nativePath);
          return statSync(sourcePath).size;
        },
        async image(path) {
          assert.equal(path, nativePath);
          const sharp = require('sharp');
          const info = await sharp(readFileSync(sourcePath)).metadata();
          return { type: info.format, width: info.width, height: info.height };
        },
        async digest(path, expected, current) {
          assert.equal(path, nativePath);
          current();
          const bytes = readFileSync(sourcePath);
          assert.equal(bytes.length, expected);
          return createHash('sha256').update(bytes).digest('hex');
        },
        async unlink(path) {
          assert.equal(path, nativePath);
          unlinkSync(sourcePath);
        },
        async readError() {
          throw new Error('Not a download fixture');
        },
      };
      const wx = {
        chooseMedia(options) {
          assert.equal(options.count, 1);
          assert.deepEqual(options.mediaType, ['image']);
          assert.deepEqual(options.sizeType, ['original']);
          options.success({
            tempFiles: [
              {
                tempFilePath: nativePath,
                size: statSync(sourcePath).size,
                fileType: 'image',
              },
            ],
          });
          options.complete();
        },
        uploadFile(options) {
          const abort = new AbortController();
          (async () => {
            try {
              const url = new URL(options.url);
              assert.equal(url.origin, origin);
              assert.match(url.pathname, /^\/v1\/me\/profile\/avatar-edits\//);
              assert.equal(options.filePath, nativePath);
              const form = new FormData();
              form.append(
                'file',
                new Blob([readFileSync(sourcePath)], {
                  type: prepare.declaration.mime,
                }),
                'ignored-native-filename',
              );
              const response = await fetch(
                `http://127.0.0.1:${port}${url.pathname}`,
                {
                  method: 'POST',
                  headers: options.header,
                  body: form,
                  redirect: 'error',
                  signal: abort.signal,
                },
              );
              const data = await response.text();
              if (mode === 'upload-and-stop' && response.status === 200) {
                await send({
                  event: 'upload-committed',
                  result: JSON.parse(data),
                });
                await new Promise(() => {});
              }
              options.success({ statusCode: response.status, data });
            } catch (error) {
              options.fail(error);
            } finally {
              options.complete();
            }
          })();
          return {
            abort() {
              abort.abort();
            },
          };
        },
      };
      const registry = new MediaLocalFiles(files),
        transfer = new ProfileAvatarUpload(
          origin,
          wx,
          files,
          registry,
          sessions,
          systemClock,
        ),
        cancel = new Cancellation();
      const file = await transfer.pick(session, cancel);
      saved = pending.phase(saved, 'upload_uncertain');
      await transfer.upload(
        transfer.register(grant, session),
        file,
        () => {},
        session,
        cancel,
      );
      pending.phase(saved, 'processing');
      await gateway.finalize(prepared.editId, session, new Cancellation());
      throw new Error('Expected withheld finalize response');
    }
    const record = pending.load(credentials.accountId);
    assert.ok(record);
    if (mode === 'recover-edit') {
      assert.ok(record.edit);
      const result = await gateway.recoverEdit(
        record.edit.prepare.clientRequestId,
        session,
        new Cancellation(),
      );
      assert.equal(result.state, 'recorded');
      const observed = pending.observe(record, result.status);
      assert.equal(
        observed.edit.prepare.clientRequestId,
        record.edit.prepare.clientRequestId,
      );
      await send({ event: 'edit-recovered', result, record: observed }, true);
      return;
    }
    if (mode === 'cancel-edit') {
      assert.ok(record.edit);
      const result = await gateway.cancelEdit(
        record.edit.prepare.clientRequestId,
        record.edit.requestHash,
        session,
        new Cancellation(),
      );
      if (result.state === 'cancelled_before_prepare')
        pending.settlePrePrepare(record, result);
      else {
        assert.equal(result.state, 'recorded');
        pending.settleEdit(record, result.status);
      }
      await send({ event: 'edit-cancelled', result }, true);
      return;
    }
    assert.equal(mode, 'recover-command');
    assert.ok(record.command);
    const result = await gateway.recoverCommand(
      record.command.input.clientRequestId,
      session,
      new Cancellation(),
    );
    if (result.state === 'committed')
      pending.settleCommand(record, result.receipt);
    else {
      assert.equal(result.state, 'cancelled');
      pending.settleCancelledCommand(record, result);
    }
    // Receipt settlement is followed by independent current authorization. No
    // historical receipt is used as an image descriptor or bytes entitlement.
    const principals = new AvatarPrincipalOwner(sessions),
      principalTicket = principals.snapshot();
    const principal = {
      current() {
        principals.assertCurrent(principalTicket);
        return principals.snapshot();
      },
    };
    const current = await gateway.current(null, principal, new Cancellation());
    await send({ event: 'command-recovered', result, current }, true);
  } catch (error) {
    process.send(
      {
        event: 'failure',
        name: error?.name ?? 'Error',
        message: error?.message ?? 'Profile native child failed',
      },
      () => process.exit(1),
    );
  }
});
