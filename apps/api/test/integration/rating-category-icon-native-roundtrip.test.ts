/** Real AppModule → original Category5 owner → Media8 → PostgreSQL.
 * The separate process runs production native controller/runtime/adapter code.
 * Only native platform APIs, registered synthetic media and exact persisted
 * Review envelopes are supplied by the fixture. No mocked HTTP outcomes. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  categoryIconUploadScopeRequestHash,
  ratingCategoryIconIntentSchema,
  ratingCategoryIconReceiptSchema,
  ratingCategoryIconUploadScopeSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';

const callsSchema = z.array(
  z.strictObject({ method: z.string(), path: z.string() }),
);
const outputSchema = z.object({
  event: z.string(),
  calls: callsSchema.optional(),
  intent: ratingCategoryIconIntentSchema.optional(),
  receipt: ratingCategoryIconReceiptSchema.optional(),
  receipts: z.array(ratingCategoryIconReceiptSchema).optional(),
  scopeInputs: z.array(ratingCategoryIconUploadScopeSchema).optional(),
  original: z.unknown().optional(),
  pending: z.unknown().optional(),
  opaque: z.unknown().optional(),
  issuedIds: z.number().optional(),
  pickerCalls: z.number().optional(),
  uploadCalls: z.number().optional(),
  resident: z.number().optional(),
  removed: z.number().optional(),
  message: z.string().optional(),
  rpcId: z.number().optional(),
  kind: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;
function event(child: ChildProcess, expected: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exited);
    };
    const message = (raw: unknown) => {
      const parsed = outputSchema.safeParse(raw);
      if (!parsed.success) {
        cleanup();
        reject(Error('Invalid native Category IPC: ' + parsed.error.message));
        return;
      }
      const value = parsed.data;
      if (value.event === 'failure') {
        cleanup();
        reject(Error(value.message));
      } else if (value.event === expected) {
        cleanup();
        resolve(value);
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        Error(
          `Native Category child exited before ${expected}: ${code}/${signal}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Native Category checkpoint timeout: ${expected}`));
    }, 60000);
    timer.unref();
    child.on('message', message);
    child.once('exit', exited);
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

test(
  'real Category native editor and SIGKILL journal13 recover original PG receipts without replaying Review, binding or release',
  { timeout: 600000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#305e81' },
    })
      .png()
      .toBuffer();
    const cancelledPng = await sharp({
      create: { width: 35, height: 27, channels: 3, background: '#81305e' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture(
      [png, cancelledPng].map((bytes) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    const directory = await mkdtemp(
      join(tmpdir(), 'whaleu-category-real-native-'),
    );
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await Promise.all(children.map(exitOf));
      await f.close();
      await rm(directory, { recursive: true, force: true });
    });
    type Actor = typeof f.admin;
    const server = await f.app.getUrl(),
      foreign = await f.actor();
    let actor = f.admin;
    const freshSession = async (owner: Actor): Promise<Actor> => {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0]!;
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: identity.provider,
          appId: identity.app_id,
          subject: identity.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      assert.notEqual(session.sessionId, owner.sessionId);
      return { ...owner, ...session, accessToken, refreshToken };
    };
    let processedUploads = 0,
      approvedCommands = 0;
    const launch = (owner: Actor) => {
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/category-icon-native-worker.mjs',
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
      child.on('message', (raw: unknown) => {
        const parsed = outputSchema.safeParse(raw);
        if (!parsed.success || parsed.data.event !== 'rpc') return;
        const value = parsed.data;
        void (async () => {
          try {
            if (value.kind === 'process') {
              assert.ok(f.worker);
              for (const stage of ['seal', 'process', 'review'] as const)
                assert.equal(
                  await f.worker.runOne(stage),
                  true,
                  `${stage}: one registered actual uploaded PNG`,
                );
              processedUploads++;
            } else {
              assert.equal(value.kind, 'review');
              const intent = ratingCategoryIconIntentSchema.parse(value.intent);
              await f.stored(intent, owner); // Requires exact native HTTP-persisted preparation.
              await f.approveText(intent, owner);
              await f.approveIcons(intent, owner);
              approvedCommands++;
            }
            child.send({ event: 'rpc-result', rpcId: value.rpcId });
          } catch (error) {
            child.send({
              event: 'rpc-result',
              rpcId: value.rpcId,
              error: String(error),
            });
          }
        })();
      });
      return child;
    };
    const run = async (
      input: Record<string, unknown>,
      expected = 'completed',
      owner = actor,
    ) => {
      const child = launch(owner),
        answer = event(child, expected),
        exited = exitOf(child);
      child.send({
        server,
        credentials: owner,
        png: png.toString('base64'),
        ...input,
      });
      const result = await answer;
      if (
        expected === 'completed' ||
        expected === 'recovered' ||
        expected === 'foreign-isolated'
      )
        assert.deepEqual(await exited, { code: 0, signal: null });
      return { child, result };
    };
    const kill = async (child: ChildProcess) => {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      const exited = exitOf(child);
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    };
    const route = (categoryId?: string) => ({
      scope: 'campus',
      campusId: f.campusA,
      ...(categoryId ? { categoryId } : {}),
    });
    const durable = async (requestId: string) => {
      const rows = (
        await f.pool.query<{ receipt: unknown }>(
          'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, requestId],
        )
      ).rows;
      assert.equal(rows.length, 1);
      return ratingCategoryIconReceiptSchema.parse(rows[0]!.receipt);
    };
    const current = async (categoryId: string) =>
      (
        await f.pool.query<{
          kind: string;
          appearance_id: string | null;
          value: { kind: string };
          definition_id: string;
        }>(
          `SELECT d.kind,d.appearance_id,d.value,h.definition_id FROM whaleu_ratings.category_icon_definition_heads h JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id WHERE d.category_id=$1 ORDER BY d.kind`,
          [categoryId],
        )
      ).rows;
    const state = async () => ({
      artifacts: await f.artifacts(),
      reviews: (
        await f.pool.query(
          `SELECT (SELECT count(*)::int FROM whaleu_community.rating_approval_decisions) decisions,(SELECT count(*)::int FROM whaleu_ratings.category_icon_review_bindings) bindings`,
        )
      ).rows[0],
    });
    const assertPrivateJournal = (raw: string) => {
      assert.ok(raw.includes('v13.'));
      assert.equal(raw.includes(actor.accessToken), false);
      assert.equal(raw.includes(actor.refreshToken), false);
      assert.doesNotMatch(raw, /"(?:filePath|localSrc|uploadToken|grantId)"/);
    };
    const assertRecovery = (output: Output, requestId: string) => {
      assert.equal(
        output.calls?.[0]?.path,
        `/v5/ratings/requests/${requestId}`,
      );
      assert.equal(output.issuedIds, 0);
      assert.equal(output.uploadCalls, 0);
      assert.equal(output.pickerCalls, 0);
      assert.equal(
        output.calls?.some((call) =>
          /\/(?:entry-context|contexts|prepare|commit|grant|uploads\/)/.test(
            call.path,
          ),
        ),
        false,
      );
      assert.ok(
        output.calls?.every(
          (call) =>
            call.path === `/v5/ratings/requests/${requestId}` ||
            [
              '/v5/ratings/category-management/upload-scopes/recover',
              '/v5/ratings/category-management/upload-scopes/cancel',
              '/v5/ratings/category-management/cancel-by-hash',
            ].includes(call.path),
        ),
        'Recovery may only look up the original receipt and settle its exact original obligations',
      );
    };
    const edit = async (
      label: string,
      operation: RatingCategoryIconIntent['operation'],
      selection: string,
      categoryId?: string,
    ) => {
      const { result } = await run({
        mode: 'edit',
        path: join(directory, label + '.json'),
        route: route(categoryId),
        operation,
        selection,
        name: `Native ${label}`,
      });
      const intent = ratingCategoryIconIntentSchema.parse(result.intent),
        receipt = result.receipts?.at(-1);
      assert.ok(receipt);
      assert.equal(receipt.outcome, 'applied');
      assert.deepEqual(await durable(intent.payload.clientRequestId), receipt);
      assert.equal(result.uploadCalls, selection === 'replace' ? 1 : 0);
      assert.equal(result.resident, 0);
      assert.equal(result.removed, selection === 'replace' ? 1 : 0);
      assert.ok(
        result.calls?.some(
          (call) => call.path === '/v5/ratings/category-management/prepare',
        ),
      );
      assert.ok(
        result.calls?.some(
          (call) => call.path === '/v5/ratings/category-management/commit',
        ),
      );
      return { result, receipt, intent };
    };
    let categoryId = '',
      baseAppearance = '';
    await t.test(
      'actual native create, base replace and source keep traverse original owners and Media8',
      async () => {
        const created = await edit(
          'create',
          'create_categories_scoped',
          'replace',
        );
        assert.notEqual(created.receipt.outcome, 'closed');
        categoryId = created.receipt.result.categoryIds[0]!;
        const initial = (await current(categoryId)).find(
          (row) => row.kind === 'base',
        )!;
        assert.equal(initial.value.kind, 'image');
        assert.ok(initial.appearance_id);
        const media = (
          await f.pool.query(
            `SELECT i.protocol_version,a.resource_kind,a.slot FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_ratings.category_icon_appearances p ON p.asset_id=a.id WHERE p.id=$1`,
            [initial.appearance_id],
          )
        ).rows[0];
        assert.deepEqual(media, {
          protocol_version: 8,
          resource_kind: 'category_icon',
          slot: 'icon',
        });
        await edit(
          'replace-base',
          'edit_category_base_scoped',
          'replace',
          categoryId,
        );
        const replaced = (await current(categoryId)).find(
          (row) => row.kind === 'base',
        )!;
        assert.notEqual(replaced.appearance_id, initial.appearance_id);
        baseAppearance = replaced.appearance_id!;
        const bindings = (
          await f.pool.query('SELECT * FROM whaleu_media.bindings ORDER BY id')
        ).rows;
        await edit(
          'keep-source',
          'edit_category_base_scoped',
          'keep',
          categoryId,
        );
        const kept = (await current(categoryId)).find(
          (row) => row.kind === 'base',
        )!;
        assert.equal(kept.appearance_id, baseAppearance);
        assert.notEqual(kept.definition_id, replaced.definition_id);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_media.bindings ORDER BY id',
            )
          ).rows,
          bindings,
        );
      },
    );
    await t.test(
      'native override null, inherit and image are distinct; applied response loss survives SIGKILL and A→B→A',
      async () => {
        await edit(
          'override-null',
          'set_category_override_scoped',
          'set-empty',
          categoryId,
        );
        assert.equal(
          (await current(categoryId)).find((row) => row.kind === 'override')!
            .value.kind,
          'absent',
        );
        await edit(
          'override-inherit',
          'set_category_override_scoped',
          'inherit',
          categoryId,
        );
        assert.equal(
          (await current(categoryId)).find((row) => row.kind === 'override')!
            .value.kind,
          'inherit',
        );
        const path = join(directory, 'applied-response-lost.json');
        const lost = await run(
          {
            mode: 'edit',
            stage: 'applied-response-lost',
            path,
            route: route(categoryId),
            operation: 'set_category_override_scoped',
            selection: 'replace',
            name: 'Native override image',
            foreign,
          },
          'server-committed',
        );
        const intent = ratingCategoryIconIntentSchema.parse(lost.result.intent),
          receipt = ratingCategoryIconReceiptSchema.parse(lost.result.receipt);
        assert.equal(receipt.outcome, 'applied');
        assert.deepEqual(
          await durable(intent.payload.clientRequestId),
          receipt,
        );
        const roots = await current(categoryId);
        assert.equal(
          roots.find((row) => row.kind === 'base')!.appearance_id,
          baseAppearance,
        );
        assert.notEqual(
          roots.find((row) => row.kind === 'override')!.appearance_id,
          baseAppearance,
        );
        assert.equal(
          roots.find((row) => row.kind === 'override')!.value.kind,
          'image',
        );
        const raw = await readFile(path, 'utf8');
        assertPrivateJournal(raw);
        assert.ok(raw.includes(intent.payload.clientRequestId));
        assert.ok(raw.includes('"receipt":null'));
        assert.doesNotMatch(
          raw,
          /"(?:name|description|context|token|declaration|mediaSnapshot|intent)"/,
        );
        const originalKeys = Object.keys(JSON.parse(raw));
        assert.equal(originalKeys.length, 2);
        const scope = lost.result.scopeInputs![0]!;
        assert.ok(raw.includes(scope.clientRequestId));
        await kill(lost.child);
        const before = await state(),
          counts = { processedUploads, approvedCommands };
        const isolated = await run(
          { mode: 'foreign', path },
          'foreign-isolated',
          foreign,
        );
        assert.deepEqual(isolated.result.calls, []);
        assert.equal(await readFile(path, 'utf8'), raw);
        actor = await freshSession(actor);
        const recovered = await run({ mode: 'recover', path }, 'recovered');
        assertRecovery(recovered.result, intent.payload.clientRequestId);
        assert.ok(
          recovered.result.calls?.some(
            (call) =>
              call.path ===
              '/v5/ratings/category-management/upload-scopes/recover',
          ),
        );
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {});
        assert.deepEqual({ processedUploads, approvedCommands }, counts);
        assert.deepEqual(
          await state(),
          before,
          'Receipt recovery cannot repeat Review, media binding, release, retirement, or request creation',
        );
        const stored = await f.stored(intent, actor),
          replay = await f.commit(intent, stored.context_revision, actor);
        categoryIconHttpOk(replay);
        assert.deepEqual(replay.body, receipt);
        assert.deepEqual(await state(), before);
      },
    );
    await t.test(
      'unknown native upload scope keeps original actor obligation and cancels before any late owner preparation',
      async () => {
        const path = join(directory, 'unknown-scope.json');
        const unknown = await run(
          {
            mode: 'edit',
            stage: 'unknown-scope',
            path,
            route: route(categoryId),
            operation: 'edit_category_base_scoped',
            selection: 'replace',
            name: 'Unknown scope retained',
          },
          'checkpoint',
        );
        const scope = unknown.result.scopeInputs![0]!,
          requestId = scope.payload.clientRequestId;
        const raw = await readFile(path, 'utf8');
        assertPrivateJournal(raw);
        assert.ok(raw.includes(scope.clientRequestId));
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.category_icon_upload_scopes WHERE actor_id=$1 AND client_request_id=$2',
              [actor.accountId, scope.clientRequestId],
            )
          ).rowCount,
          0,
        );
        await kill(unknown.child);
        actor = await freshSession(actor);
        const before = z
            .object({ ownerEpoch: z.number() })
            .passthrough()
            .parse(await f.artifacts()),
          recovered = await run({ mode: 'recover', path }, 'recovered');
        assertRecovery(recovered.result, requestId);
        assert.ok(
          recovered.result.calls?.some(
            (call) =>
              call.path ===
              '/v5/ratings/category-management/upload-scopes/cancel',
          ),
        );
        const fence = (
          await f.pool.query<{ request_hash: string }>(
            'SELECT request_hash FROM whaleu_ratings.category_icon_upload_scope_fences WHERE actor_id=$1 AND client_request_id=$2',
            [actor.accountId, scope.clientRequestId],
          )
        ).rows[0];
        assert.ok(fence);
        assert.equal(
          fence.request_hash,
          categoryIconUploadScopeRequestHash(scope),
        );
        const late = await f.post('upload-scopes', scope, actor);
        assert.notEqual(late.status, 200);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.category_icon_upload_scopes WHERE actor_id=$1 AND client_request_id=$2',
              [actor.accountId, scope.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const after = z
          .object({ ownerEpoch: z.number() })
          .passthrough()
          .parse(await f.artifacts());
        assert.ok(
          after.ownerEpoch > before.ownerEpoch,
          'The exact cancellation fence is a real owner writer',
        );
        assert.deepEqual(
          { ...after, ownerEpoch: before.ownerEpoch },
          before,
          'Unknown cancellation creates only an absence fence, never an owner publication',
        );
      },
    );
    await t.test(
      'opaque prepared native command cancels by original hash after A→B→A without rebinding or fake deletion',
      async () => {
        const path = join(directory, 'opaque-prepared.json');
        const pending = await run(
          {
            mode: 'edit',
            stage: 'opaque-prepared',
            png: cancelledPng.toString('base64'),
            path,
            route: route(categoryId),
            operation: 'edit_category_base_scoped',
            selection: 'replace',
            name: 'Opaque original draft',
            foreign,
          },
          'checkpoint',
        );
        const intent = ratingCategoryIconIntentSchema.parse(
            pending.result.intent,
          ),
          scope = pending.result.scopeInputs![0]!;
        const raw = await readFile(path, 'utf8');
        assertPrivateJournal(raw);
        assert.ok(raw.includes(intent.payload.clientRequestId));
        assert.ok(raw.includes(scope.clientRequestId));
        assert.doesNotMatch(
          raw,
          /"(?:name|description|context|token|declaration|mediaSnapshot|intent)"/,
        );
        await kill(pending.child);
        const roots = await current(categoryId),
          bindingRows = (
            await f.pool.query(
              'SELECT * FROM whaleu_media.bindings ORDER BY id',
            )
          ).rows;
        const isolated = await run(
          { mode: 'foreign', path },
          'foreign-isolated',
          foreign,
        );
        assert.deepEqual(isolated.result.calls, []);
        assert.equal(await readFile(path, 'utf8'), raw);
        actor = await freshSession(actor);
        const recovered = await run(
          { mode: 'recover', path, expectCleanupPending: true },
          'recovered',
        );
        assertRecovery(recovered.result, intent.payload.clientRequestId);
        assert.ok(
          recovered.result.calls?.some(
            (call) =>
              call.path === '/v5/ratings/category-management/cancel-by-hash',
          ),
        );
        assert.ok(
          recovered.result.calls?.some(
            (call) =>
              call.path ===
              '/v5/ratings/category-management/upload-scopes/cancel',
          ),
        );
        const receipt = await durable(intent.payload.clientRequestId);
        assert.equal(receipt.outcome, 'closed');
        assert.deepEqual(await current(categoryId), roots);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_media.bindings ORDER BY id',
            )
          ).rows,
          bindingRows,
        );
        const prepared = await f.stored(intent, actor),
          late = await f.commit(intent, prepared.context_revision, actor);
        categoryIconHttpOk(late);
        assert.deepEqual(late.body, receipt);
        const status = await f.post(
          'upload-scopes/recover',
          {
            clientRequestId: scope.clientRequestId,
            requestHash: (
              await f.pool.query<{ scope_request_hash: string }>(
                'SELECT scope_request_hash FROM whaleu_ratings.category_icon_upload_scopes WHERE actor_id=$1 AND client_request_id=$2',
                [actor.accountId, scope.clientRequestId],
              )
            ).rows[0]!.scope_request_hash,
          },
          actor,
        );
        categoryIconHttpOk(status);
        assert.equal(status.body.state, 'cancelled');
        assert.ok(f.storage);
        // Respect the original two-minute cleanup quiet period; do not rewrite
        // not_before, relax worker deadlines or pretend queued means deleted.
        const quietUntil = (
          await f.pool.query<{ at: Date }>(
            `SELECT max(not_before) at FROM whaleu_media.cleanup_obligations WHERE state='pending'`,
          )
        ).rows[0]!.at.getTime();
        const quietWait = Math.max(0, quietUntil - Date.now() + 100);
        assert.ok(quietWait <= 121000, 'Original bounded cleanup quiet period');
        await delay(quietWait);
        const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
        let exhausted = false;
        for (let n = 0; n < 100; n++) {
          const result = await cleanup.runOne();
          if (result === 'idle') {
            exhausted = true;
            break;
          }
          assert.ok(['deleted', 'retained'].includes(result), result);
        }
        assert.equal(
          exhausted,
          true,
          'Bounded cleanup drains the real worker queue',
        );
        const afterCleanup = await f.post(
          'upload-scopes/recover',
          {
            clientRequestId: scope.clientRequestId,
            requestHash: categoryIconUploadScopeRequestHash(scope),
          },
          actor,
        );
        categoryIconHttpOk(afterCleanup);
        assert.equal(afterCleanup.body.recovery.status.cleanup, 'confirmed');
        actor = await freshSession(actor);
        const settled = await run({ mode: 'recover', path }, 'recovered');
        assertRecovery(settled.result, intent.payload.clientRequestId);
        assert.deepEqual(
          JSON.parse(await readFile(path, 'utf8')),
          {},
          'Only confirmed server cleanup clears original opaque obligations',
        );
        assert.equal(
          processedUploads,
          4,
          'Four uploads before multi-node create',
        );
      },
    );
    await t.test(
      'native multi-node create uploads each single slot then publishes exactly one original release',
      async () => {
        const before = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.scoped_releases',
          )
        ).rows[0]!.n;
        const created = await run({
          mode: 'edit',
          path: join(directory, 'multi-node.json'),
          route: route(),
          operation: 'create_categories_scoped',
          selection: 'replace',
          nodeCount: 2,
          name: 'Native atomic tree',
        });
        const receipt = created.result.receipts!.at(-1)!;
        assert.equal(receipt.outcome, 'applied');
        if (receipt.outcome !== 'applied') assert.fail();
        assert.equal(receipt.result.categoryIds.length, 2);
        assert.equal(created.result.uploadCalls, 2);
        assert.equal(created.result.removed, 2);
        assert.equal(created.result.resident, 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_releases',
            )
          ).rows[0]!.n,
          before + 1,
        );
        assert.equal(
          new Set(
            created.result.scopeInputs!.map((scope) => scope.draftRevision),
          ).size,
          1,
        );
        assert.equal(
          new Set(
            created.result.scopeInputs!.map((scope) => scope.clientRequestId),
          ).size,
          2,
        );
        const projected = (
          await f.pool.query(
            'SELECT count(*)::int n,count(DISTINCT appearance_id)::int appearances FROM whaleu_ratings.category_icon_projections WHERE release_id=$1 AND category_id=ANY($2::uuid[])',
            [receipt.result.releaseId, receipt.result.categoryIds],
          )
        ).rows[0]!;
        assert.deepEqual(projected, { n: 2, appearances: 2 });
        assert.equal(processedUploads, 6);
      },
    );
  },
);
