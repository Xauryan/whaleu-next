import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  campusToolsFixture,
  syntheticMapEntry,
  syntheticToolsCatalog,
} from '../support/campus-tools-fixture.js';
import type { ToolCatalog } from '../../src/campus-tools/contracts.js';

test(
  'emitted campus tools App/Page/WXML -> HTTP/AppModule/PG: guest map, ordered owner images, copy, disabled embed, replacement and lifecycle',
  { timeout: 180000 },
  async (t) => {
    let configuredWeb: { catalogId: string; entryId: string } | null = null;
    const f = await campusToolsFixture({
      webview: {
        allows: (catalog, entryId) =>
          configuredWeb !== null &&
          configuredWeb.catalogId === catalog.id &&
          configuredWeb.entryId === entryId,
      },
    });
    t.after(() => f.close());
    const images = [await f.image(), await f.image(), await f.image()];
    const base = (ordinal: number, sourceId: string) => ({
      id: randomUUID(),
      revision: randomUUID(),
      ordinal,
      sourceId,
      state: 'enabled' as const,
      title: `Synthetic ${sourceId}`,
    });
    const entries: ToolCatalog['entries'] = [
      syntheticMapEntry(),
      {
        ...base(1, 'shuttle'),
        kind: 'shuttle',
        groups: [
          { id: 'shuttle', title: 'Synthetic shuttle', slots: [images[0]!] },
          { id: 'bus', title: 'Synthetic bus', slots: [images[1]!] },
        ],
      },
      {
        ...base(2, 'research'),
        kind: 'research',
        description: 'Synthetic research resource',
        compatibility: null,
        image: images[2]!,
        link: { action: 'copy', url: 'https://tools.example.com/resource' },
      },
      {
        ...base(3, 'web'),
        kind: 'web-link',
        link: {
          action: 'webview',
          url: 'https://tools.example.com/controlled',
        },
      },
    ];
    const catalog = syntheticToolsCatalog(f.scope.home.campusId, {
      entries,
      linkPolicy: {
        id: randomUUID(),
        version: 1,
        rules: [
          {
            action: 'copy',
            host: 'tools.example.com',
            path: '/resource',
            query: [],
          },
          {
            action: 'webview',
            host: 'tools.example.com',
            path: '/controlled',
            query: [],
          },
        ],
      },
    });
    configuredWeb = { catalogId: catalog.id, entryId: entries[3]!.id };
    await f.admit(catalog);
    const actor = await f.actor(),
      expiredActor = await f.actor();
    const child = fork(
      fileURLToPath(
        new URL(
          '../../../wechat/test/campus-tools-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (value) => {
      logs += String(value);
    });
    child.stderr?.on('data', (value) => {
      logs += String(value);
    });
    t.after(() => {
      if (!child.killed) child.kill();
    });
    await new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          assert.ok(raw && typeof raw === 'object' && 'event' in raw);
          const message = raw as Record<string, unknown>;
          if (message['event'] === 'failure')
            throw new Error(String(message['message']) + '\n' + logs);
          if (message['event'] === 'checkpoint') {
            const name = String(message['name']);
            if (name === 'replace-catalog')
              await f.admit(
                syntheticToolsCatalog(f.scope.home.campusId, {
                  expectedHead: catalog.id,
                }),
              );
            else if (name === 'revoke-session')
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [actor.sessionId],
              );
            else if (name === 'expire-refresh') {
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '2 seconds',refresh_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                [expiredActor.sessionId],
              );
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '2 seconds' WHERE session_id=$1",
                [expiredActor.sessionId],
              );
            } else throw new Error('Unexpected native checkpoint');
            child.send({ event: 'continue', name });
          } else if (message['event'] === 'done') {
            assert.ok(Number(message['downloads']) >= 3);
            assert.ok(Number(message['requests']) >= 12);
            assert.ok(f.processCalls() >= 3);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done)
          reject(
            new Error(`Native campus tools worker exited ${code}\n${logs}`),
          );
      });
      child.send({
        port: f.port,
        campusId: catalog.campusId,
        otherCampusId: f.scope.foreign.campusId,
        catalogId: catalog.id,
        policyId: catalog.linkPolicy.id,
        entries,
        actor,
        expiredActor,
      });
    });
  },
);
