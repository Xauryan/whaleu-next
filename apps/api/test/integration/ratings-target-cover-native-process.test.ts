import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import { z } from 'zod';
import {
  ratingScopedIntentSchema,
  ratingScopedReceiptSchema,
} from '../../src/ratings/scoped/contracts.js';
import {
  syntheticRatingTargetCoverFixture,
  coverHttpOk,
} from '../support/media/ratings-target-runtime-fixture.js';
import {
  ratingTargetCoverIntentSchema,
  ratingTargetCoverReceiptSchema,
  type RatingTargetCoverIntent,
} from '../../src/ratings/scoped/target-cover-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';

const nativeCalls = z.array(
  z.strictObject({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path: z.string(),
  }),
);
const nativeMessageSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('review-needed'),
    intent: ratingScopedIntentSchema,
  }),
  z.strictObject({
    event: z.literal('interactions-complete'),
    receipts: z.array(ratingScopedReceiptSchema).length(6),
    calls: nativeCalls,
    rootId: z.uuid(),
    replyId: z.uuid(),
  }),
  z.strictObject({
    event: z.literal('server-committed'),
    receipt: ratingTargetCoverReceiptSchema,
    calls: nativeCalls,
  }),
  z.strictObject({ event: z.literal('journal-frozen'), calls: nativeCalls }),
  z.strictObject({ event: z.literal('foreign-isolated'), calls: nativeCalls }),
  z.strictObject({
    event: z.literal('recovered'),
    receipt: ratingTargetCoverReceiptSchema,
    calls: nativeCalls,
    remaining: z.null(),
  }),
  z.strictObject({ event: z.literal('failure'), message: z.string() }),
]);
type NativeEvent = Exclude<
  z.infer<typeof nativeMessageSchema>,
  { event: 'failure' }
>;
function event(
  child: ChildProcess,
  expected: NativeEvent['event'],
): Promise<NativeEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exit);
    };
    const message = (value: unknown) => {
      const parsed = nativeMessageSchema.safeParse(value);
      if (!parsed.success) {
        cleanup();
        reject(new Error('Invalid native IPC message'));
        return;
      }
      const item = parsed.data;
      if (item.event === 'failure') {
        cleanup();
        reject(new Error(item.message));
      } else if (item.event === expected) {
        cleanup();
        resolve(item);
      }
    };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`Native child exited before ${expected}: ${code}/${signal}`),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, 30000);
    timer.unref();
    child.on('message', message);
    child.once('exit', exit);
  });
}
const exitOf = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
  );

/** SOURCE ONLY until the exclusive PG lease is granted. Server remains live;
 * client SIGKILL is not evidence of server/provider writer quiescence. */
test(
  'real Ratings owner COMMIT response loss survives native SIGKILL and journal11 receipt-first recovery',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 48, height: 36, channels: 3, background: '#295a7d' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    const directory = await mkdtemp(
        join(tmpdir(), 'whaleu-ratings-cover-http-process-'),
      ),
      children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
      await rm(directory, { recursive: true, force: true });
    });
    const port = Number(new URL(await f.app.getUrl()).port);
    let actor = f.creator;
    const launch = () => {
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/native-process/ratings-target-cover-http.mjs',
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
    const kill = async (child: ChildProcess) => {
      const exited = exitOf(child);
      child.kill('SIGKILL');
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    };
    const run = async (
      mode: string,
      journalPath: string,
      credentials: unknown = actor,
    ) => {
      const child = launch(),
        answer = event(
          child,
          mode === 'foreign' ? 'foreign-isolated' : 'recovered',
        ),
        exited = exitOf(child);
      child.send({ mode, journalPath, credentials, port });
      const result = await answer;
      assert.deepEqual(await exited, { code: 0, signal: null });
      return result;
    };
    const uploadedJournal = async (
      upload: Awaited<ReturnType<typeof f.ready>>,
    ) => ({
      version: 11,
      phase: 'upload',
      accountId: actor.accountId,
      scopeInput: (
        await f.pool.query(
          'SELECT input FROM whaleu_ratings.target_cover_upload_scopes WHERE id=$1',
          [upload.scope.scopeId],
        )
      ).rows[0]!.input,
      scope: upload.scope,
      status: upload.status,
    });
    let targetId = '';
    const head = async () =>
      (
        await f.pool.query(
          `SELECT h.content_version,h.definition_revision,d.envelope FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions d ON (d.target_id,d.content_version,d.definition_revision)=(h.target_id,h.content_version,h.definition_revision) WHERE h.target_id=$1`,
          [targetId],
        )
      ).rows[0];
    const active = async () =>
      (
        await f.pool.query(
          `SELECT p.id appearance_id,p.asset_id,b.id binding_id FROM whaleu_ratings.target_cover_appearances p JOIN whaleu_media.bindings b ON b.id=p.media_binding_id WHERE p.target_id=$1 AND b.detached_at IS NULL ORDER BY p.id`,
          [targetId],
        )
      ).rows;
    const lose = async (
      label: string,
      input: RatingTargetCoverIntent,
      upload?: Awaited<ReturnType<typeof f.ready>>,
    ) => {
      const prepared = await f.prepare(actor, input),
        journalPath = join(directory, `${label}.json`),
        child = launch(),
        committed = event(child, 'server-committed');
      child.send({
        mode: 'commit-and-stop',
        credentials: actor,
        journalPath,
        port,
        intent: input,
        ...(upload ? { upload: await uploadedJournal(upload) } : {}),
      });
      const result = await committed;
      assert.equal(result.event, 'server-committed');
      const receipt = ratingTargetCoverReceiptSchema.parse(result.receipt);
      assert.equal(receipt.outcome, 'applied');
      // Independent PG query proves commit, rather than trusting the child IPC alone.
      const durable = (
        await f.pool.query(
          'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(durable);
      assert.deepEqual(durable.receipt, receipt);
      await kill(child);
      const frozen = await readFile(journalPath, 'utf8');
      assert.ok(frozen.includes(input.payload.clientRequestId));
      assert.ok(frozen.includes('"version":11'));
      assert.equal(frozen.includes(actor.accessToken), false);
      assert.equal(frozen.includes(actor.refreshToken), false);
      assert.doesNotMatch(
        frozen,
        /"(?:filePath|localSrc|uploadToken|grantId)"/,
      );
      const foreign = await f.actor();
      const isolated = await run('foreign', journalPath, foreign);
      assert.equal(isolated.event, 'foreign-isolated');
      assert.deepEqual(isolated.calls, []);
      assert.equal(await readFile(journalPath, 'utf8'), frozen);
      // Even a late cancel has only the same original committed business outcome.
      const cancel = await f
        .auth(request(f.http).post('/v3/ratings/target-cover/cancel'), actor)
        .send(input);
      coverHttpOk(cancel);
      assert.deepEqual(cancel.body, receipt);
      const renewed = await f.freshSession(actor);
      actor = renewed;
      const recovered = await run('recover', journalPath, actor);
      assert.equal(recovered.event, 'recovered');
      assert.deepEqual(recovered.receipt, receipt);
      assert.equal(recovered.remaining, null);
      assert.equal(
        recovered.calls[0]?.path,
        `/v3/ratings/target-cover/receipts/${input.payload.clientRequestId}`,
      );
      assert.equal(
        recovered.calls.some((call: { path: string }) =>
          /\/(?:prepare|commit|contexts)$/.test(call.path),
        ),
        false,
      );
      if (upload)
        assert.ok(
          recovered.calls.some(
            (call: { path: string }) =>
              call.path ===
              `/v3/media/ratings-target/upload-requests/${upload.scope.prepare.clientRequestId}`,
          ),
        );
      const replay = await f.send(
        actor,
        input,
        prepared.prepared.contextRevision,
      );
      coverHttpOk(replay);
      assert.deepEqual(replay.body, receipt);
      return receipt;
    };
    await t.test(
      'create with real ready Media commits body+cover once before the native response is lost',
      async () => {
        const upload = await f.ready(actor, await f.draft(actor), png),
          receipt = await lose('create', upload.input, upload);
        targetId = String((receipt.result as { targetId: string }).targetId);
        assert.equal((await active()).length, 1);
        assert.equal(
          (await head()).envelope.cover.assetId,
          upload.status.assetId,
        );
      },
    );
    await t.test(
      'replace commits one new appearance and keeps the old binding detached across receipt recovery',
      async () => {
        const before = await head(),
          old = await active(),
          upload = await f.ready(actor, await f.draft(actor, targetId), png);
        await lose('replace', upload.input, upload);
        assert.equal(
          (await head()).content_version,
          before.content_version + 1,
        );
        assert.equal((await active()).length, 1);
        assert.notEqual(
          (await active())[0].appearance_id,
          old[0].appearance_id,
        );
        assert.ok(
          (
            await f.pool.query(
              'SELECT detached_at FROM whaleu_media.bindings WHERE id=$1',
              [old[0].binding_id],
            )
          ).rows[0].detached_at,
        );
      },
    );
    await t.test(
      'text keep and clear use the same response-loss recovery without rebinding or resurrecting the old cover',
      async () => {
        const before = await head(),
          bindings = await active(),
          draft = await f.draft(actor, targetId);
        await lose(
          'keep',
          ratingTargetCoverIntentSchema.parse({
            ...draft,
            payload: {
              ...draft.payload,
              name: 'Same immutable cover, new body',
            },
          }),
        );
        assert.deepEqual((await head()).envelope.cover, before.envelope.cover);
        assert.deepEqual(await active(), bindings);
        const clear = await f.draft(actor, targetId);
        await lose(
          'clear',
          ratingTargetCoverIntentSchema.parse({
            ...clear,
            payload: { ...clear.payload, cover: { action: 'clear' } },
          }),
        );
        assert.equal((await head()).envelope.cover, null);
        assert.deepEqual(await active(), []);
      },
    );
    for (const cancelFirst of [true, false])
      await t.test(
        cancelFirst
          ? 'cancel wins before a later commit and the old cover stays exact'
          : 'real concurrent cancel/commit has one original outcome and restart follows the winner',
        async () => {
          // Establish a visible old appearance so cancellation must retain something.
          const oldUpload = await f.ready(
            actor,
            await f.draft(actor, targetId),
            png,
          );
          await f.execute(actor, oldUpload.input);
          const before = await head(),
            old = await active(),
            upload = await f.ready(actor, await f.draft(actor, targetId), png),
            prepared = await f.prepare(actor, upload.input);
          const journalPath = join(
              directory,
              cancelFirst ? 'cancel-winner.json' : 'race-winner.json',
            ),
            child = launch(),
            frozen = event(child, 'journal-frozen');
          child.send({
            mode: 'freeze-and-stop',
            credentials: actor,
            journalPath,
            port,
            intent: upload.input,
            upload: await uploadedJournal(upload),
          });
          await frozen;
          await kill(child);
          const cancel = () =>
            f
              .auth(
                request(f.http).post('/v3/ratings/target-cover/cancel'),
                actor,
              )
              .send(upload.input);
          if (cancelFirst) {
            coverHttpOk(await cancel());
          } else {
            const outcomes = await Promise.all([
              cancel(),
              f.send(actor, upload.input, prepared.prepared.contextRevision),
            ]);
            assert.ok(
              outcomes.some((response) => response.status === 200),
              'One real contender must persist the original outcome',
            );
          }
          const recovered = await run('recover', journalPath);
          assert.equal(recovered.event, 'recovered');
          const receipt = ratingTargetCoverReceiptSchema.parse(
            recovered.receipt,
          );
          if (cancelFirst) assert.equal(receipt.outcome, 'closed');
          const cancelled = await cancel(),
            committed = await f.send(
              actor,
              upload.input,
              prepared.prepared.contextRevision,
            );
          coverHttpOk(cancelled);
          coverHttpOk(committed);
          assert.deepEqual(cancelled.body, receipt);
          assert.deepEqual(committed.body, receipt);
          if (receipt.outcome === 'closed') {
            assert.deepEqual(await head(), before);
            assert.deepEqual(await active(), old);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                  [upload.status.assetId],
                )
              ).rowCount,
              0,
            );
          } else {
            assert.equal(receipt.outcome, 'applied');
            assert.equal((await active()).length, 1);
            assert.equal(
              (await head()).envelope.cover.assetId,
              upload.status.assetId,
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, upload.input.payload.clientRequestId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
    await t.test(
      'actual native page controllers cross target3 and auxiliary2 owners for all six interactions and owner deletions',
      async () => {
        // This independent user journey must not inherit the prior crash/race actor's throttle usage.
        const interactionActor = await f.actor();
        const interactionUpload = await f.ready(
          interactionActor,
          await f.draft(interactionActor),
          png,
        );
        const interactionCreated = await f.execute(
          interactionActor,
          interactionUpload.input,
        );
        const interactionTargetId = interactionCreated.result.targetId;
        const child = launch(),
          done = event(child, 'interactions-complete'),
          exited = exitOf(child);
        const review = (raw: unknown) => {
          const parsed = nativeMessageSchema.safeParse(raw);
          if (!parsed.success || parsed.data.event !== 'review-needed') return;
          const input = parsed.data.intent;
          void (async () => {
            try {
              assert.ok(
                input.operation === 'create_comment_scoped' ||
                  input.operation === 'create_reply_scoped',
              );
              await f.prepareCommand(interactionActor, input);
              await f.approveCommand(interactionActor, input);
              child.send({
                event: 'review-ready',
                requestId: input.payload.clientRequestId,
              });
            } catch (error) {
              child.send({
                event: 'review-ready',
                requestId: input.payload.clientRequestId,
                error: String(error),
              });
            }
          })();
        };
        child.on('message', review);
        child.send({
          mode: 'interactions',
          credentials: interactionActor,
          journalPath: join(directory, 'interactions.json'),
          port,
          targetId: interactionTargetId,
        });
        const result = await done;
        assert.equal(result.event, 'interactions-complete');
        assert.deepEqual(await exited, { code: 0, signal: null });
        child.removeListener('message', review);
        assert.deepEqual(
          result.receipts.map((receipt) => receipt.operation),
          [
            'set_score_scoped',
            'create_comment_scoped',
            'create_reply_scoped',
            'set_comment_like_scoped',
            'set_reply_like_scoped',
            'set_target_subscription_scoped',
          ],
        );
        for (const receipt of result.receipts) {
          assert.equal(receipt.outcome, 'applied');
          const durable = (
            await f.pool.query(
              'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [interactionActor.accountId, receipt.requestId],
            )
          ).rows[0];
          assert.deepEqual(durable?.receipt, receipt);
        }
        assert.ok(
          result.calls.some(
            (call) =>
              call.path ===
              `/v3/ratings/target-cover/targets/${interactionTargetId}`,
          ),
        );
        assert.ok(
          result.calls.some(
            (call) =>
              call.path ===
                `/v2/ratings/targets/${interactionTargetId}/my-score` &&
              call.method === 'PUT',
          ),
        );
        for (const [kind, id] of [
          ['replies', result.replyId],
          ['comments', result.rootId],
        ] as const) {
          assert.ok(
            result.calls.some(
              (call) =>
                call.path === `/v1/ratings/${kind}/${id}/deletion-context`,
            ),
          );
          assert.ok(
            result.calls.some(
              (call) =>
                call.path === `/v1/ratings/${kind}/${id}` &&
                call.method === 'DELETE',
            ),
          );
          const deleted = (
            await f.pool.query(
              `SELECT deleted_at FROM whaleu_ratings.${kind} WHERE id=$1`,
              [id],
            )
          ).rows[0];
          assert.ok(deleted?.deleted_at);
        }
        const retained = (
          await f.pool.query(
            `SELECT p.asset_id FROM whaleu_ratings.target_cover_appearances p JOIN whaleu_media.bindings b ON b.id=p.media_binding_id WHERE p.target_id=$1 AND b.detached_at IS NULL`,
            [interactionTargetId],
          )
        ).rows;
        assert.deepEqual(
          retained,
          [{ asset_id: interactionUpload.status.assetId }],
          'Interactions and content deletion do not replace the target cover',
        );
      },
    );
  },
);
