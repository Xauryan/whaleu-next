import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import {
  syntheticProfileRuntimeFixture,
  seedSyntheticAvatarCatalog,
  profileCommandEnvelope,
  approveProfileAvatar,
  selectProfileAvatar,
  readyProfileAvatar,
  profileOk,
} from '../support/media/profile-runtime-fixture.js';
import type {
  ProfileActor,
  ProfileFixture,
} from '../support/media/profile-runtime-fixture.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { avatarCommandHash } from '../../src/profile/avatar/contracts.js';
import { profileMediaStatusSchema } from '../../src/media/contracts-profile.js';
import { sha256 } from '../../src/media/processing/protocol.js';

function event(
  child: ChildProcess,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for Profile native child ${expected}`),
      );
    }, 20000);
    timer.unref();
    const message = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('event' in value))
        return;
      if (value.event === 'failure') {
        cleanup();
        reject(new Error(JSON.stringify(value)));
      } else if (value.event === expected) {
        cleanup();
        resolve(value as Record<string, unknown>);
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Profile native child exited before ${expected}: ${code}/${signal}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exited);
    };
    child.on('message', message);
    child.once('exit', exited);
  });
}
const exitOf = (
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
async function freshSession(f: ProfileFixture, actor: ProfileActor) {
  const provider = (
    await f.pool.query<{ app_id: string; subject: string }>(
      'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
      [actor.accountId],
    )
  ).rows[0]!;
  const accessToken = mintToken('access'),
    refreshToken = mintToken('refresh');
  const session = await f.app
    .get(IdentityRepository)
    .createSession(
      { provider: 'wechat', appId: provider.app_id, subject: provider.subject },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
  assert.notEqual(session.sessionId, actor.sessionId);
  return { ...session, accessToken, refreshToken };
}
test(
  'actual native Profile SIGKILL preserves uncertain keys, isolates actors and recovers historical command before current avatar',
  { timeout: 240000 },
  async () => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#314c7c' },
      })
        .png()
        .toBuffer();
    const f = await syntheticProfileRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const directory = await mkdtemp(
        join(tmpdir(), 'whaleu-profile-native-process-'),
      ),
      children: ChildProcess[] = [];
    const launch = () => {
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/media/profile-native-process.mjs',
            import.meta.url,
          ),
        ),
        [],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      child.stderr?.resume();
      children.push(child);
      return child;
    };
    const run = async (
      mode: string,
      credentials: unknown,
      journalPath: string,
      expected: string,
      extra: Record<string, unknown> = {},
    ) => {
      const child = launch(),
        result = event(child, expected),
        exit = exitOf(child);
      child.send({
        command: 'start',
        mode,
        credentials,
        journalPath,
        port: f.port,
        ...extra,
      });
      const answer = await result;
      assert.deepEqual(await exit, { code: 0, signal: null });
      return answer;
    };
    try {
      const actor = await f.actor(),
        foreign = await f.actor(),
        journalPath = join(directory, 'prepare.json');
      const prepare = {
        protocol: 'profile-media-v1',
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        slot: 'avatar',
        declaration: {
          mime: 'image/png',
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      };
      const first = launch(),
        committed = event(first, 'prepare-committed');
      first.send({
        command: 'start',
        mode: 'prepare-and-stop',
        credentials: actor,
        journalPath,
        port: f.port,
        prepare,
      });
      const original = await committed,
        firstExit = exitOf(first);
      first.kill('SIGKILL');
      assert.deepEqual(await firstExit, { code: null, signal: 'SIGKILL' });
      const saved = await readFile(journalPath, 'utf8');
      for (const prohibited of [
        actor.accessToken,
        actor.refreshToken,
        'filePath',
        'grantId',
        directory,
      ])
        assert.equal(saved.includes(prohibited), false);
      const records = Object.values(JSON.parse(saved)) as {
        edit: { phase: string; editId: string | null; intentId: string | null };
      }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.edit.phase, 'prepare_uncertain');
      assert.equal(records[0]!.edit.editId, null);
      assert.equal(records[0]!.edit.intentId, null);
      await run('foreign-actor', foreign, journalPath, 'foreign-isolated', {
        originalActor: actor.accountId,
      });
      assert.equal(await readFile(journalPath, 'utf8'), saved);
      const replacementSession = await freshSession(f, actor),
        recovered = await run(
          'recover-edit',
          replacementSession,
          journalPath,
          'edit-recovered',
        );
      const observation = (
        recovered['result'] as { status: { intentId: string; editId: string } }
      ).status;
      assert.equal(
        observation.intentId,
        (original['result'] as { intentId: string }).intentId,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.upload_ingress'))
          .rowCount,
        0,
      );
      await run(
        'cancel-edit',
        replacementSession,
        journalPath,
        'edit-cancelled',
      );
      assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), {});
      // Every cut runs an actual separate native process and real HTTP. A lost
      // grant/upload/finalize response is recovered by the original request key;
      // the restarted process never needs the old local file or ephemeral grant.
      for (const cut of ['grant', 'upload', 'finalize'] as const) {
        const cutActor = await f.actor(),
          cutJournal = join(directory, `${cut}.json`),
          sourcePath = join(directory, `${cut}.png`);
        await writeFile(sourcePath, bytes);
        const cutPrepare = { ...prepare, clientRequestId: randomUUID() };
        const child = launch(),
          observed = event(child, `${cut}-committed`);
        child.send({
          command: 'start',
          mode: `${cut}-and-stop`,
          credentials: cutActor,
          journalPath: cutJournal,
          port: f.port,
          prepare: cutPrepare,
          sourcePath,
        });
        const originalCut = await observed,
          stopped = exitOf(child);
        child.kill('SIGKILL');
        assert.deepEqual(await stopped, { code: null, signal: 'SIGKILL' });
        const cutSaved = await readFile(cutJournal, 'utf8');
        for (const prohibited of [
          cutActor.accessToken,
          cutActor.refreshToken,
          'filePath',
          'grantId',
          sourcePath,
          'wxfile://',
        ])
          assert.equal(cutSaved.includes(prohibited), false);
        // Delete the bytes before restart to demonstrate recovery is metadata-only.
        await rm(sourcePath, { force: true });
        const cutSession = await freshSession(f, cutActor),
          recoveredCut = await run(
            'recover-edit',
            cutSession,
            cutJournal,
            'edit-recovered',
          );
        const status = profileMediaStatusSchema.parse(
          (recoveredCut['result'] as { status: unknown }).status,
        );
        assert.equal(status.requestId, cutPrepare.clientRequestId);
        assert.equal(
          status.status,
          cut === 'grant'
            ? 'prepared'
            : cut === 'upload'
              ? 'uploaded'
              : 'processing',
        );
        assert.equal(
          status.intentId,
          (originalCut['result'] as { intentId: string }).intentId,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1',
              [cutActor.accountId],
            )
          ).rowCount,
          1,
        );
        if (cut === 'grant') {
          const idleGrant = await f.pool.query<{ writer_state: string }>(
            'SELECT writer_state FROM whaleu_media.upload_ingress WHERE intent_id=$1',
            [status.intentId],
          );
          assert.equal(idleGrant.rowCount, 1);
          assert.equal(idleGrant.rows[0]!.writer_state, 'idle');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1',
                [status.intentId],
              )
            ).rowCount,
            0,
          );
          await run('cancel-edit', cutSession, cutJournal, 'edit-cancelled');
          assert.deepEqual(JSON.parse(await readFile(cutJournal, 'utf8')), {});
          continue;
        }
        // The observed upload is never replayed. Finalization is idempotent for
        // both uploaded and already-processing states, then shared workers seal.
        profileOk(
          await request(f.app.getHttpServer())
            .post(`/v1/me/profile/avatar-edits/${status.editId}/finalize`)
            .set('Authorization', `Bearer ${cutSession.accessToken}`)
            .send({}),
        );
        for (const stage of ['seal', 'process', 'review'] as const)
          assert.equal(await f.worker.runOne(stage), true);
        const readyResponse = await request(f.app.getHttpServer())
          .get(`/v1/me/profile/avatar-edits/${status.editId}`)
          .set('Authorization', `Bearer ${cutSession.accessToken}`);
        profileOk(readyResponse);
        const ready = profileMediaStatusSchema.parse(readyResponse.body);
        assert.equal(ready.status, 'ready_unbound');
        if (ready.status !== 'ready_unbound')
          throw new Error('Recovered Profile upload did not become ready');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.upload_ingress WHERE intent_id=$1',
              [status.intentId],
            )
          ).rowCount,
          1,
        );
        const selected = await selectProfileAvatar(f, cutActor, {
          protocol: 'profile-media-v1',
          clientRequestId: randomUUID(),
          expectedRevision: 0,
          source: {
            kind: 'custom',
            editId: ready.editId,
            assetId: ready.assetId,
          },
        });
        assert.equal(selected.current.revision, 1);
        // Cancellation observes immutable bound history and cannot detach it.
        const settled = await run(
          'cancel-edit',
          cutSession,
          cutJournal,
          'edit-cancelled',
        );
        assert.equal(
          (settled['result'] as { status: { status: string } }).status.status,
          'bound_history',
        );
        assert.deepEqual(JSON.parse(await readFile(cutJournal, 'utf8')), {});
      }
      const catalog = await seedSyntheticAvatarCatalog(
          f,
          bytes,
          'image/png',
          24,
          24,
        ),
        commandActor = await f.actor(),
        commandJournal = join(directory, 'command.json');
      const selection = {
        protocol: 'profile-media-v1' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        source: {
          kind: 'catalog' as const,
          catalogVersion: catalog.catalogVersion,
          itemId: catalog.itemId,
        },
      };
      await approveProfileAvatar(
        f.pool,
        await profileCommandEnvelope(f, commandActor, selection),
      );
      const second = launch(),
        commandCommitted = event(second, 'command-committed');
      second.send({
        command: 'start',
        mode: 'command-and-stop',
        credentials: commandActor,
        journalPath: commandJournal,
        port: f.port,
        selection,
      });
      const receipt = await commandCommitted,
        secondExit = exitOf(second);
      second.kill('SIGKILL');
      assert.deepEqual(await secondExit, { code: null, signal: 'SIGKILL' });
      const commandSaved = await readFile(commandJournal, 'utf8');
      for (const prohibited of [
        commandActor.accessToken,
        commandActor.refreshToken,
        'filePath',
        'grantId',
        directory,
      ])
        assert.equal(commandSaved.includes(prohibited), false);
      // Another authorized operation wins later. Recovering the old receipt must
      // not resurrect its selected catalog appearance or reuse its review grant.
      await selectProfileAvatar(f, commandActor, {
        protocol: 'profile-media-v1',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        source: { kind: 'clear' },
      });
      const resumed = await run(
        'recover-command',
        await freshSession(f, commandActor),
        commandJournal,
        'command-recovered',
      );
      assert.deepEqual(
        (resumed['result'] as { receipt: unknown }).receipt,
        receipt['result'],
      );
      assert.equal(
        (resumed['current'] as { revision: number; avatar: { state: string } })
          .revision,
        2,
      );
      assert.equal(
        (resumed['current'] as { avatar: { state: string } }).avatar.state,
        'none',
      );
      assert.deepEqual(JSON.parse(await readFile(commandJournal, 'utf8')), {});
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1',
            [commandActor.accountId],
          )
        ).rowCount,
        2,
      );
      const customActor = await f.actor(),
        customJournal = join(directory, 'custom-command.json'),
        customReady = await readyProfileAvatar(f, customActor, bytes);
      const customSelection = {
        protocol: 'profile-media-v1' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        source: {
          kind: 'custom' as const,
          editId: customReady.status.editId,
          assetId: customReady.status.assetId,
        },
      };
      await approveProfileAvatar(
        f.pool,
        await profileCommandEnvelope(f, customActor, customSelection),
      );
      const customChild = launch(),
        customCommitted = event(customChild, 'command-committed');
      customChild.send({
        command: 'start',
        mode: 'command-and-stop',
        credentials: customActor,
        journalPath: customJournal,
        port: f.port,
        prepare: customReady.input,
        readyStatus: customReady.status,
        selection: customSelection,
      });
      const customReceipt = await customCommitted,
        customExit = exitOf(customChild);
      customChild.kill('SIGKILL');
      assert.deepEqual(await customExit, { code: null, signal: 'SIGKILL' });
      const customSaved = await readFile(customJournal, 'utf8');
      for (const prohibited of [
        customActor.accessToken,
        customActor.refreshToken,
        'filePath',
        'grantId',
        directory,
      ])
        assert.equal(customSaved.includes(prohibited), false);
      const customRecord = Object.values(JSON.parse(customSaved)) as {
        edit: { assetId: string };
        command: { input: { clientRequestId: string } };
      }[];
      assert.equal(customRecord[0]!.edit.assetId, customReady.status.assetId);
      assert.equal(
        customRecord[0]!.command.input.clientRequestId,
        customSelection.clientRequestId,
      );
      await selectProfileAvatar(f, customActor, {
        protocol: 'profile-media-v1',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        source: { kind: 'clear' },
      });
      const customRecovered = await run(
        'recover-command',
        await freshSession(f, customActor),
        customJournal,
        'command-recovered',
      );
      assert.deepEqual(
        (customRecovered['result'] as { receipt: unknown }).receipt,
        customReceipt['result'],
      );
      assert.equal(
        (
          customRecovered['current'] as {
            revision: number;
            avatar: { state: string };
          }
        ).revision,
        2,
      );
      assert.equal(
        (customRecovered['current'] as { avatar: { state: string } }).avatar
          .state,
        'none',
      );
      assert.deepEqual(JSON.parse(await readFile(customJournal, 'utf8')), {});
      const customBinding = await f.pool.query<{ detached_at: Date | null }>(
        'SELECT detached_at FROM whaleu_media.bindings WHERE asset_id=$1',
        [customReady.status.assetId],
      );
      assert.equal(customBinding.rowCount, 1);
      assert.ok(customBinding.rows[0]!.detached_at);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$1',
            [customReady.status.editId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1',
            [customActor.accountId],
          )
        ).rowCount,
        2,
      );
      const fencedActor = await f.actor(),
        fencedJournal = join(directory, 'cancel-command.json'),
        fencedReady = await readyProfileAvatar(f, fencedActor, bytes);
      const fencedCommand = {
        protocol: 'profile-media-v1' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        source: {
          kind: 'custom' as const,
          editId: fencedReady.status.editId,
          assetId: fencedReady.status.assetId,
        },
      };
      const fencedChild = launch(),
        frozen = event(fencedChild, 'command-frozen');
      fencedChild.send({
        command: 'start',
        mode: 'command-freeze-and-stop',
        credentials: fencedActor,
        journalPath: fencedJournal,
        port: f.port,
        prepare: fencedReady.input,
        readyStatus: fencedReady.status,
        selection: fencedCommand,
      });
      await frozen;
      const fencedExit = exitOf(fencedChild);
      fencedChild.kill('SIGKILL');
      assert.deepEqual(await fencedExit, { code: null, signal: 'SIGKILL' });
      const cancelled = await request(f.app.getHttpServer())
        .post(
          `/v1/me/profile/avatar-command-requests/${fencedCommand.clientRequestId}/cancel`,
        )
        .set('Authorization', `Bearer ${fencedActor.accessToken}`)
        .send({
          protocol: 'profile-media-v1',
          requestHash: avatarCommandHash(fencedActor.accountId, fencedCommand),
        });
      profileOk(cancelled);
      assert.equal(cancelled.body.state, 'cancelled');
      const fencedSession = await freshSession(f, fencedActor),
        fencedRecovered = await run(
          'recover-command',
          fencedSession,
          fencedJournal,
          'command-recovered',
        );
      assert.deepEqual(fencedRecovered['result'], cancelled.body);
      assert.equal(
        (fencedRecovered['current'] as { revision: number }).revision,
        0,
      );
      const remaining = Object.values(
        JSON.parse(await readFile(fencedJournal, 'utf8')),
      ) as { edit: { assetId: string }; command: null }[];
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]!.command, null);
      assert.equal(
        remaining[0]!.edit.assetId,
        fencedReady.status.assetId,
        'command fence retains a custom edit until its own cancellation proof',
      );
      const late = await request(f.app.getHttpServer())
        .post('/v1/me/profile/avatar-commands')
        .set('Authorization', `Bearer ${fencedSession.accessToken}`)
        .send(fencedCommand);
      assert.equal(late.status, 409);
      await run('cancel-edit', fencedSession, fencedJournal, 'edit-cancelled');
      assert.deepEqual(JSON.parse(await readFile(fencedJournal, 'utf8')), {});
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
            [fencedReady.status.assetId],
          )
        ).rowCount,
        0,
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
