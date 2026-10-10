import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import { z } from 'zod';
import {
  syntheticRatingDiscussionFixture,
  writeSyntheticDiscussionApproval,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import {
  ratingsDiscussionBatchHash,
  ratingsDiscussionBatchIdentitySchema,
} from '../../src/media/contracts-ratings-discussion.js';
import {
  ratingDiscussionMediaReceiptSchema,
  ratingDiscussionMediaCommandHash,
} from '../../src/ratings/scoped/discussion-media-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';

const callsSchema = z.array(
  z.strictObject({ method: z.string(), path: z.string() }),
);
const messageSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('durable'),
    stage: z.string(),
    calls: callsSchema.optional(),
  }),
  z.strictObject({
    event: z.literal('recovered'),
    stage: z.string(),
    retainedKeys: z.number().int().nonnegative().optional(),
    calls: callsSchema.optional(),
  }),
  z.strictObject({ event: z.literal('error'), message: z.string() }),
]);
function event(child: ChildProcess, expected: 'durable' | 'recovered') {
  return new Promise<
    Exclude<z.infer<typeof messageSchema>, { event: 'error' }>
  >((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exit);
    };
    const message = (raw: unknown) => {
      const parsed = messageSchema.safeParse(raw);
      if (!parsed.success) {
        cleanup();
        reject(Error('Invalid native process IPC'));
        return;
      }
      const value = parsed.data;
      if (value.event === 'error') {
        cleanup();
        reject(Error(value.message));
      } else if (value.event === expected) {
        cleanup();
        resolve(value);
      }
    };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        Error(`Native process exited before ${expected}: ${code}/${signal}`),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Native process timeout: ${expected}`));
    }, 60000);
    timer.unref();
    child.on('message', message);
    child.once('exit', exit);
  });
}
const exitOf = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        resolve({ code: child.exitCode, signal: child.signalCode });
      else child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );

/** Real AppModule, original Ratings ScopedCommands and Media7 SQL/processing.
 * No HTTP response stub is used. Only the HTTPS logical-origin transport maps
 * to this disposable loopback server. Source only until heavy lease execution. */
test(
  'real owner root9/reply3 and unknown opaque requests survive native SIGKILL with original two-key receipts',
  { timeout: 600000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#526c87' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const directory = await mkdtemp(
        join(tmpdir(), 'whaleu-ratings-discussion-real-native-'),
      ),
      children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
      await rm(directory, { recursive: true, force: true });
    });
    const server = await f.app.getUrl(),
      origin = 'https://ratings-discussion-owner-process.invalid';
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    type Upload = Awaited<ReturnType<typeof f.ready>>;
    const launch = () => {
      const child = fork(
        fileURLToPath(
          new URL(
            '../../../wechat/test/support/native-rating-discussion-process.mjs',
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
      assert.equal(child.exitCode, null, 'checkpoint must not exit normally');
      assert.equal(child.signalCode, null, 'checkpoint must await parent kill');
      const exited = exitOf(child);
      assert.equal(child.kill('SIGKILL'), true, 'SIGKILL must be delivered');
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    };
    const initial = (
      actor: Actor,
      identity: ReturnType<typeof ratingsDiscussionBatchIdentitySchema.parse>,
    ) => ({
      version: 12,
      phase: 'batch',
      accountId: actor.accountId,
      identity,
      identityHash: ratingsDiscussionBatchHash(actor.accountId, identity),
      batchId: null,
      members: [],
      orderedMemberIds: [],
      sealedPlanDigest: null,
    });
    const nativeFixture = async (actor: Actor, upload: Upload) => {
      const stored = (
        await f.pool.query<{
          member_id: string;
          source_slot: number;
          input: {
            declaration: { mime: string; bytes: number; sha256: string };
          };
          request_hash: string;
        }>(
          `SELECT m.member_id,m.source_slot,m.input,i.request_hash FROM whaleu_media.ratings_discussion_members m JOIN whaleu_media.upload_intents i ON i.id=m.intent_id WHERE m.batch_id=$1`,
          [upload.batch.batchId],
        )
      ).rows;
      const first = initial(actor, upload.identity),
        plan = upload.batch.sealedPlan!;
      const members = plan.orderedMembers.map((image) => {
        const member = stored.find((m) => m.member_id === image.memberId)!,
          status = upload.batch.members.find(
            (m) => m.memberId === image.memberId,
          )!;
        return {
          memberId: image.memberId,
          clientRequestId: status.requestId,
          sourceSlot: member.source_slot,
          requestHash: member.request_hash,
          declaration: member.input.declaration,
          state: 'ready',
          assetId: image.assetId,
          manifestDigest: image.manifestDigest,
        };
      });
      return {
        actor: actor.accountId,
        intent: upload.intent,
        initial: first,
        sealed: {
          ...first,
          batchId: upload.batch.batchId,
          members,
          orderedMemberIds: plan.orderedMembers.map((image) => image.memberId),
          sealedPlanDigest: upload.batch.sealedPlanDigest,
        },
        batch: upload.batch,
      };
    };
    const persist = async (
      stage: string,
      path: string,
      actor: Actor,
      fixture: unknown,
      commit = false,
    ) => {
      const child = launch(),
        durable = event(child, 'durable');
      child.send({
        mode: commit ? 'commit-and-stop' : 'write',
        stage,
        path,
        server,
        origin,
        credentials: actor,
        fixture,
      });
      const response = await durable;
      const raw = await readFile(path, 'utf8');
      assert.equal(raw.includes(actor.accessToken), false);
      assert.equal(raw.includes(actor.refreshToken), false);
      assert.doesNotMatch(raw, /"(?:filePath|localSrc|grantId|uploadToken)"/);
      return { child, response, raw };
    };
    const recover = async (
      stage: string,
      path: string,
      actor: Actor,
      fixture: unknown,
    ) => {
      const child = launch(),
        recovered = event(child, 'recovered'),
        exited = exitOf(child);
      child.send({
        mode: 'recover',
        stage,
        path,
        server,
        origin,
        credentials: actor,
        fixture,
      });
      const response = await recovered;
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {});
      const calls = response.calls;
      assert.ok(calls?.length, 'runner must report real gateway requests');
      assert.equal(
        calls.some((call) => /\/(?:contexts|prepare|commit)$/.test(call.path)),
        false,
        'cold recovery does not recreate scope or resubmit publication',
      );
      return calls;
    };
    const durableReceipt = async (actor: Actor, requestId: string) => {
      const row = (
        await f.pool.query<{ receipt: unknown }>(
          'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, requestId],
        )
      ).rows[0];
      assert.ok(row);
      return ratingDiscussionMediaReceiptSchema.parse(row.receipt);
    };
    await t.test(
      'idle journal checkpoint stays alive without HTTP handles until parent SIGKILL',
      async () => {
        const child = launch(),
          durable = event(child, 'durable');
        child.send({
          mode: 'write',
          stage: 'batch-persisted',
          path: join(directory, 'idle-checkpoint.json'),
          server,
        });
        const checkpoint = await durable;
        assert.deepEqual(checkpoint.calls, []);
        // Yield beyond IPC delivery with no HTTP activity to accidentally keep
        // this writer alive. A received durable message alone is insufficient.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        await kill(child);
      },
    );
    let root: { id: string; revision: string } | undefined,
      rootUpload: Upload | undefined,
      rootActor: Actor | undefined;
    for (const count of [9, 3] as const)
      await t.test(
        count === 9
          ? 'root9 commits from native gateway before response journal persistence'
          : 'reply3 commits from native gateway with the real root ancestry',
        async () => {
          if (count === 3)
            assert.ok(root, 'reply case requires the real committed root');
          const actor = count === 9 ? f.creator : await f.actor(),
            draft = await f.draft(actor, count === 3 ? root : undefined),
            upload = await f.ready(
              actor,
              draft,
              Array.from({ length: count }, () => bytes),
            );
          const prepared = await f.prepare(actor, upload.intent);
          await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
          const fixture = await nativeFixture(actor, upload),
            path = join(directory, `committed-${count}.json`),
            lost = await persist(
              'applied-before-receipt',
              path,
              actor,
              fixture,
              true,
            );
          const receipt = await durableReceipt(
            actor,
            upload.intent.payload.clientRequestId,
          );
          assert.equal(receipt.outcome, 'applied');
          assert.equal(
            receipt.intentHash,
            ratingDiscussionMediaCommandHash(upload.intent),
          );
          assert.equal(
            lost.raw.includes('"receipt":null'),
            true,
            'commit response was not recorded by the native process',
          );
          const subject =
            receipt.outcome === 'applied'
              ? receipt.operation === 'create_comment_scoped'
                ? receipt.result.subjectId
                : receipt.result.replyId
              : assert.fail('expected applied');
          const state = (
            await f.pool.query<{
              bindings: number;
              reviews: number;
              transitions: number;
            }>(
              `SELECT
      (SELECT count(*)::int FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_id=$1 AND detached_at IS NULL) bindings,
      (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=$1) reviews,
      ((SELECT count(*)::int FROM whaleu_ratings.comment_transitions WHERE comment_id=$1)+(SELECT count(*)::int FROM whaleu_ratings.reply_transitions WHERE reply_id=$1)) transitions`,
              [subject],
            )
          ).rows[0]!;
          assert.deepEqual(state, {
            bindings: count,
            reviews: 1,
            transitions: 1,
          });
          await kill(lost.child);
          const renewed = await f.freshSession(actor),
            calls = await recover(
              'applied-before-receipt',
              path,
              renewed,
              fixture,
            );
          assert.equal(
            calls[0]?.path,
            `/v4/ratings/discussion/receipts/${upload.intent.payload.clientRequestId}`,
          );
          assert.ok(
            calls.some(
              (call) =>
                call.path ===
                `/v3/media/ratings-discussion/batch-requests/${upload.identity.batchRequestId}`,
            ),
          );
          assert.deepEqual(
            await durableReceipt(actor, upload.intent.payload.clientRequestId),
            receipt,
          );
          if (
            count === 9 &&
            receipt.outcome === 'applied' &&
            receipt.operation === 'create_comment_scoped'
          ) {
            root = {
              id: receipt.result.subjectId,
              revision: receipt.result.revision,
            };
            rootUpload = upload;
            rootActor = renewed;
          }
        },
      );
    await t.test(
      'server-applied receipt cannot clear the journal before native completion, but a fresh stopped process can settle',
      async () => {
        assert.ok(rootUpload && rootActor);
        const fixture = await nativeFixture(rootActor, rootUpload),
          path = join(directory, 'native-completion.json'),
          pending = await persist(
            'native-completion-pending',
            path,
            rootActor,
            fixture,
          );
        assert.equal(Object.keys(JSON.parse(pending.raw)).length, 2);
        assert.equal(pending.raw.includes('"outcome":"applied"'), true);
        await kill(pending.child);
        await recover('native-completion-pending', path, rootActor, fixture);
      },
    );
    await t.test(
      'unknown batch survives kill and closes using the original actor absence fence without a context',
      async () => {
        const actor = await f.actor(),
          intent = await f.draft(actor),
          p = intent.payload,
          identity = ratingsDiscussionBatchIdentitySchema.parse({
            protocol: 'ratings-discussion-media-v1',
            batchRequestId: randomUUID(),
            commandRequestId: p.clientRequestId,
            draftRevision: p.draftRevision,
            categoryId: p.categoryId,
            expectedCategoryRevision: p.expectedCategoryRevision,
            context: intent.context,
            target: {
              kind: 'root',
              targetId: p.targetId,
              expectedTargetRevision: p.expectedTargetRevision,
              expectedDefinitionRevision: p.expectedDefinitionRevision,
              expectedContentVersion: p.expectedContentVersion,
            },
          });
        const first = initial(actor, identity),
          fixture = {
            actor: actor.accountId,
            intent,
            initial: first,
            sealed: first,
          },
          path = join(directory, 'batch-unknown.json'),
          pending = await persist('batch-persisted', path, actor, fixture);
        await kill(pending.child);
        const calls = await recover(
          'batch-persisted',
          path,
          await f.freshSession(actor),
          fixture,
        );
        assert.equal(
          calls[0]?.path,
          `/v4/ratings/discussion/receipts/${p.clientRequestId}`,
        );
        assert.ok(
          calls.some(
            (call) =>
              call.path ===
              `/v3/media/ratings-discussion/batch-requests/${identity.batchRequestId}/cancel`,
          ),
        );
        const fence = (
          await f.pool.query<{ state: string; identity_hash: string }>(
            'SELECT state,identity_hash FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=$1 AND batch_request_id=$2',
            [actor.accountId, identity.batchRequestId],
          )
        ).rows[0]!;
        assert.deepEqual(fence, {
          state: 'cancelled_before_prepare',
          identity_hash: first.identityHash,
        });
        const late = await f
          .auth(
            request(f.http).post('/v3/media/ratings-discussion/batches'),
            actor,
          )
          .send(identity);
        assert.notEqual(late.status, 200);
        assert.equal(
          (
            await f.pool.query(
              'SELECT id FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND batch_request_id=$2',
              [actor.accountId, identity.batchRequestId],
            )
          ).rowCount,
          0,
        );
      },
    );
    for (const stage of [
      'prepare-unknown',
      'seal-persisted',
      'opaque-account-switch',
    ] as const)
      await t.test(
        `real original-actor ${stage} recovery cancels without fabricating publication`,
        async () => {
          const actor = await f.actor(),
            upload = await f.ready(actor, await f.draft(actor), [bytes]),
            fixture = await nativeFixture(actor, upload),
            path = join(directory, `${stage}.json`);
          let prepared: Awaited<ReturnType<typeof f.prepare>> | undefined;
          if (stage === 'opaque-account-switch') {
            prepared = await f.prepare(actor, upload.intent);
            await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
          }
          const pending = await persist(stage, path, actor, fixture);
          if (stage === 'opaque-account-switch')
            assert.doesNotMatch(
              pending.raw,
              /"(?:body|context|token|images|declaration|manifestDigest)"/,
            );
          await kill(pending.child);
          const calls = await recover(
            stage,
            path,
            await f.freshSession(actor),
            fixture,
          );
          assert.equal(
            calls[0]?.path,
            `/v4/ratings/discussion/receipts/${upload.intent.payload.clientRequestId}`,
          );
          const state = (
            await f.pool.query<{ state: string }>(
              'SELECT state FROM whaleu_media.ratings_discussion_batches WHERE id=$1',
              [upload.batch.batchId],
            )
          ).rows[0]!.state;
          assert.equal(state, 'cancelled');
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                [upload.intent.payload.images.map((image) => image.assetId)],
              )
            ).rowCount,
            0,
          );
          if (stage === 'opaque-account-switch') {
            assert.ok(
              calls.some(
                (call) =>
                  call.path ===
                  `/v4/ratings/discussion/requests/${upload.intent.payload.clientRequestId}/cancel`,
              ),
            );
            const receipt = await durableReceipt(
              actor,
              upload.intent.payload.clientRequestId,
            );
            assert.equal(receipt.outcome, 'closed');
            const late = await f.commit(
              actor,
              upload.intent,
              prepared!.prepared.contextRevision,
            );
            discussionHttpOk(late);
            assert.deepEqual(late.body, receipt);
          }
        },
      );
  },
);
