import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  windowDiscussionMediaFixture,
  reviewWindowDiscussionV2,
} from '../support/window-discussion-media-fixture.js';
import { reviewWindowDiscussion } from '../support/window-discussion-fixture.js';
import type {
  WindowRootPublish,
  WindowReplyPublish,
} from '../../src/ratings/windows/discussion/contracts.js';
import type {
  WindowRootPublishV2,
  WindowReplyPublishV2,
} from '../../src/ratings/windows/discussion/contracts-v2.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
const credentials = (a: SessionCredentials): SessionCredentials => ({
  accountId: a.accountId,
  sessionId: a.sessionId,
  accessToken: a.accessToken,
  refreshToken: a.refreshToken,
  expiresAt: a.expiresAt,
  refreshExpiresAt: a.refreshExpiresAt,
});
test(
  'default emitted W3 v2 App/Page/WXML uploads ordered images, recovers v1 and v2 across three cold processes, galleries and notices through real HTTP/PG',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 26, height: 16, channels: 3, background: '#8a5f32' },
    })
      .png()
      .toBuffer();
    const imageInfo = await sharp(bytes).metadata();
    assert.equal(imageInfo.format, 'png');
    assert.ok(imageInfo.width && imageInfo.height);
    const f = await windowDiscussionMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      window = f.add({ name: 'Synthetic Native Window Images' });
    await f.accept([window]);
    await f.acceptDiscussion([window.id]);
    const checkpoints: string[] = [];
    async function run(
      mode: 'legacy' | 'publish' | 'recover',
      extra: Record<string, unknown> = {},
    ) {
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/window-discussion-images-native-worker.mjs',
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
      child.stdout?.on('data', (v) => (logs += String(v)));
      child.stderr?.on('data', (v) => (logs += String(v)));
      t.after(() => {
        if (!child.killed) child.kill();
      });
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        let done: Record<string, unknown> | undefined;
        child.on('message', (raw: unknown) => {
          void (async () => {
            const m = raw as Record<string, unknown>;
            if (m['event'] === 'failure')
              throw Error(String(m['message']) + '\n' + logs);
            if (m['event'] === 'checkpoint') {
              const name = String(m['name']);
              checkpoints.push(mode + ':' + name);
              if (name === 'process-images') {
                for (const kind of ['seal', 'process', 'review'] as const)
                  assert.equal(await f.worker.runOne(kind), true);
              } else if (name === 'review')
                await reviewWindowDiscussionV2(
                  f.pool,
                  String(m['actorId']),
                  String(m['windowId']),
                  m['command'] as WindowRootPublishV2 | WindowReplyPublishV2,
                  typeof m['rootId'] === 'string' ? m['rootId'] : null,
                );
              else if (name === 'review-v1')
                await reviewWindowDiscussion(
                  f.pool,
                  String(m['actorId']),
                  String(m['windowId']),
                  m['command'] as WindowRootPublish | WindowReplyPublish,
                  typeof m['rootId'] === 'string' ? m['rootId'] : null,
                );
              else if (name === 'verify-root' || name === 'verify-legacy') {
                const rows = await f.pool.query<{
                  publication_version: number;
                  image_set: unknown[];
                  id: string;
                }>(
                  'SELECT id,publication_version,image_set FROM whaleu_ratings.window_discussion_comments WHERE actor_id=$1 AND request_id=$2',
                  [actor.accountId, m['requestId']],
                );
                assert.equal(rows.rowCount, 1);
                const row = rows.rows[0]!;
                assert.equal(
                  row.publication_version,
                  name === 'verify-root' ? 2 : 1,
                );
                assert.equal(
                  row.image_set.length,
                  name === 'verify-root' ? 3 : 0,
                );
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT count(*)::int n FROM whaleu_media.window_discussion_appearances WHERE comment_id=$1',
                      [row.id],
                    )
                  ).rows[0]!.n,
                  row.image_set.length,
                );
              } else if (name === 'verify-cancel') {
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT 1 FROM whaleu_ratings.window_discussion_media_cancels WHERE actor_id=$1 AND request_id=$2',
                      [actor.accountId, m['requestId']],
                    )
                  ).rowCount,
                  1,
                );
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT 1 FROM whaleu_ratings.window_discussion_comments WHERE actor_id=$1 AND request_id=$2',
                      [actor.accountId, m['requestId']],
                    )
                  ).rowCount,
                  0,
                );
                for (const key of m['uploadKeys'] as {
                  requestId: string;
                  requestHash: string;
                }[]) {
                  const row = (
                    await f.pool.query<{ request_hash: string; state: string }>(
                      'SELECT request_hash,state FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
                      [actor.accountId, key.requestId],
                    )
                  ).rows[0];
                  assert.ok(row);
                  assert.equal(row.request_hash, key.requestHash);
                  assert.ok(
                    ['terminal', 'cancelled_before_prepare'].includes(
                      row.state,
                    ),
                  );
                }
              } else throw Error('Unknown checkpoint ' + name);
              child.send({ event: 'continue', name });
            } else if (m['event'] === 'done') {
              assert.equal(done, undefined, 'One terminal worker result');
              done = m;
              // The worker owns orderly native cleanup and IPC shutdown.
              // Accept its result only after a clean subprocess exit.
            }
          })().catch((error) => {
            reject(error);
            child.kill();
          });
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (done && code === 0) resolve(done);
          else
            reject(
              Error(
                `Window image ${mode} process exited ${code} without clean completion: ${logs}`,
              ),
            );
        });
        child.send({
          mode,
          port: f.port,
          actor: credentials(actor),
          other: credentials(other),
          windowId: window.id,
          png: bytes.toString('base64'),
          imageInfo: {
            width: imageInfo.width,
            height: imageInfo.height,
            type: imageInfo.format,
          },
          ...extra,
        });
      });
    }
    const legacy = await run('legacy');
    assert.ok(Array.isArray(legacy['legacyJournal']));
    const published = await run('publish', {
      legacyJournal: legacy['legacyJournal'],
      legacyRequestId: legacy['legacyRequestId'],
    });
    assert.equal(published['uploads'], 3);
    assert.ok(Array.isArray(published['journal']));
    const recovered = await run('recover', {
      journal: published['journal'],
      requestId: published['requestId'],
    });
    assert.ok(Number(recovered['reads']) >= 3);
    assert.ok(checkpoints.includes('publish:verify-legacy'));
    assert.ok(checkpoints.includes('recover:verify-cancel'));
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.window_discussion_comments',
        )
      ).rows[0]!.n,
      3,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_media.window_discussion_appearances',
        )
      ).rows[0]!.n,
      4,
    );
  },
);
