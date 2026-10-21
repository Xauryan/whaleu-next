import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { MediaLocalFiles } from '../src/media/local-files';
import { createNativeProfileCoverEditor } from '../src/profile/cover-editor-runtime';
import { createNativeProfileCoverRuntime } from '../src/profile/cover-native-runtime';
import { CoverPrincipalOwner } from '../src/profile/cover-principal';
import { createProfileCoverReaders } from '../src/profile/cover-reader-runtime';
import { FakeClock, MemoryStorage } from './helpers';
import { coverIds, FakeCoverGateway } from './support/cover-fixtures';
import { ReadFiles } from './support/media-read-fixtures';

test('main shell static imports exclude cover editor implementation while the deep profile page includes it', () => {
  const source = path.join(__dirname, '../src');
  const dependencies = new Map<string, string[]>();
  const closure = (entries: string[]) => {
    const reachable = new Set<string>();
    const visit = (file: string) => {
      if (reachable.has(file)) return;
      reachable.add(file);
      let imports = dependencies.get(file);
      if (!imports) {
        const emitted = ts.transpileModule(
          readFileSync(path.join(source, file), 'utf8'),
          {
            compilerOptions: {
              target: ts.ScriptTarget.ES2020,
              module: ts.ModuleKind.CommonJS,
            },
          },
        ).outputText;
        imports = [...emitted.matchAll(/require\("(\.[^"]+)"\)/g)].map(
          (match) =>
            path.posix.normalize(
              path.posix.join(path.posix.dirname(file), match[1]! + '.ts'),
            ),
        );
        dependencies.set(file, imports);
      }
      imports.forEach(visit);
    };
    entries.forEach(visit);
    return reachable;
  };
  const main = closure([
    'app.ts',
    ...['community-feed', 'campus-hub', 'inbox', 'me', 'compose-entry'].map(
      (name) => `pages/${name}/${name}.ts`,
    ),
  ]);
  const deep = closure(['pages/profile/profile.ts']);
  for (const name of ['controller', 'pending', 'upload', 'editor-runtime']) {
    const file = `profile/cover-${name}.ts`;
    assert.equal(main.has(file), false, `${file} must not be eager main code`);
    assert.equal(deep.has(file), true, `${file} must remain statically loaded`);
  }
  assert.equal(main.has('profile/cover-runtime.ts'), false);
  assert.equal(main.has('profile/cover-reader-runtime.ts'), true);
  assert.equal(main.has('profile/cover-download.ts'), true);
});

test('deep editor factory reuses one upload/pending owner and exact shared principal, ledger and native files', () => {
  const sessions = new SessionStore();
  const auth = { refresh: async () => sessions.snapshot() };
  const api = new ApiClient(
    'https://api.example.test',
    {
      send: async () => {
        throw new Error('No request expected');
      },
    },
    sessions,
    auth,
  );
  const files = Object.assign(new ReadFiles(), {
    digest: async () => 'a'.repeat(64),
  });
  const registry = new MediaLocalFiles(files);
  const runtime = createNativeProfileCoverRuntime({
    api,
    auth,
    sessions,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    wx: {},
    files,
    registry,
    clock: new FakeClock(),
    newRequestId: async () => coverIds.request,
  });
  const first = createNativeProfileCoverEditor(runtime, () => undefined);
  const second = createNativeProfileCoverEditor(runtime, () => undefined);
  type Internals = {
    principals: unknown;
    gateway: unknown;
    pending: unknown;
    transfer: { registry: unknown; sessions: unknown };
  };
  const a = first as unknown as Internals;
  const b = second as unknown as Internals;
  assert.equal(a.principals, runtime.editorContext.principals);
  assert.equal(b.principals, a.principals);
  assert.equal(a.gateway, runtime.editorContext.gateway);
  assert.equal(a.pending, b.pending);
  assert.equal(a.transfer, b.transfer);
  assert.equal(a.transfer.registry, registry);
  assert.equal(a.transfer.sessions, sessions);
  assert.equal(runtime.editorContext.files, files);
  first.dispose();
  second.dispose();
});

test('main lifecycle registry revokes readers and deep editors, and removes disposed editors', async () => {
  const sessions = new SessionStore();
  const privateViews = new PrivateViewLifecycle();
  const released: string[] = [];
  let sequence = 0;
  const runtime = createProfileCoverReaders({
    principals: new CoverPrincipalOwner(sessions),
    gateway: new FakeCoverGateway(),
    clock: new FakeClock(),
    privateViews,
    download: {
      download: async () => ({ localId: `cover-${++sequence}` }),
      resolve: async (file) => `wxfile://tmp/${file.localId}.png`,
      release: async (file) => {
        released.push(file.localId);
      },
    },
  });
  const first = runtime.createReader(() => undefined);
  const second = runtime.createReader(() => undefined);
  const calls: string[] = [];
  const editor = runtime.registerEditor({
    hide: () => {
      calls.push('hide');
    },
    invalidate: () => {
      calls.push('invalidate');
    },
    dispose: () => {
      calls.push('dispose');
    },
  });
  runtime.registerEditor(editor); // Registering twice must not wrap twice.
  await first.load(coverIds.profile);
  await second.load(coverIds.profile);
  assert.equal(first.snapshot().localSrc, '');
  assert.ok(second.snapshot().localSrc);
  privateViews.clear(coverIds.actor);
  assert.equal(second.snapshot().localSrc, '');
  assert.deepEqual(calls, ['invalidate']);
  await first.load(coverIds.profile);
  runtime.hide();
  assert.equal(first.snapshot().localSrc, '');
  assert.deepEqual(calls, ['invalidate', 'hide']);
  editor.dispose();
  privateViews.clear();
  runtime.hide();
  assert.deepEqual(calls, ['invalidate', 'hide', 'dispose']);
  assert.equal(released.length, 3);
  first.dispose();
  second.dispose();
});

test('deep editor commit invalidates the shared reader window before its page callback', () => {
  const sessions = new SessionStore();
  const auth = { refresh: async () => sessions.snapshot() };
  const files = Object.assign(new ReadFiles(), {
    digest: async () => 'a'.repeat(64),
  });
  const runtime = createNativeProfileCoverRuntime({
    api: new ApiClient(
      'https://api.example.test',
      {
        send: async () => {
          throw new Error('No request expected');
        },
      },
      sessions,
      auth,
    ),
    auth,
    sessions,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    wx: {},
    files,
    registry: new MediaLocalFiles(files),
    clock: new FakeClock(),
    newRequestId: async () => coverIds.request,
  });
  const calls: string[] = [];
  runtime.invalidate = () => {
    calls.push('invalidate');
  };
  const editor = createNativeProfileCoverEditor(
    runtime,
    () => undefined,
    () => {
      calls.push('changed');
    },
  );
  (editor as unknown as { changed(): void }).changed();
  assert.deepEqual(calls, ['invalidate', 'changed']);
  editor.dispose();
});
