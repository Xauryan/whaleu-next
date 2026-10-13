/** Emitted App/Page/WXML → production native decoder/gateway → normal HTTP
 * AppModule → disposable PostgreSQL. Synthetic platform/session/catalog facts
 * and explicit accepted Review decisions are the only external boundaries.
 * This is not physical-device or production-provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { z } from 'zod';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { HotFeedProcessing } from '../../src/community/hot-score/processing.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { relatedSyncRuntimeFixture } from '../support/related-sync-fixtures.js';
import {
  appendTopologyRevision,
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

const output = z.strictObject({
  event: z.enum(['checkpoint', 'done', 'failure']),
  name: z.string().optional(),
  checkpointId: z.number().int().positive().optional(),
  accountId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  operation: z
    .enum(['publish_post', 'publish_comment', 'publish_reply'])
    .optional(),
  postId: z.uuid().optional(),
  rootCommentId: z.uuid().optional(),
  replyId: z.uuid().optional(),
  pinId: z.uuid().optional(),
  httpCalls: z.number().int().nonnegative().optional(),
  commands: z.array(z.unknown()).optional(),
  cancelledRequestIds: z.array(z.uuid()).optional(),
  message: z.string().optional(),
});
type NativeOutput = z.infer<typeof output>;
const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});
const uuid = (value: unknown, label: string) => {
  assert.equal(typeof value, 'string', label);
  return z.uuid().parse(value);
};

test(
  'related sync emitted Page/WXML → HTTP AppModule/PG: settings, identity, exact Review recovery, shared discovery and scoped management',
  { timeout: 300000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture({
      HOT_FEED_PROCESSING: 'manual_only',
      HOT_SCORE_COMPUTATION: 'manual_only',
      SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
      LIKE_COMPONENT_PROCESSING: 'manual_only',
      COMMENT_COMPONENT_PROCESSING: 'manual_only',
    });
    let child: ChildProcess | undefined = undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exited;
      }
      await f.close();
    });
    const adminA = await f.actor();
    // The native identity-campus page, not this fixture, makes A the publisher's
    // community identity. Verified phone/affiliation are accepted test facts.
    const publisher = await f.actor({ identity: false });
    const reader = await f.actor({ campusId: f.scope.related.campusId });
    const adminB = await f.actor({ campusId: f.scope.related.campusId });
    const queryText = 'related native golden text';
    const http = f.app.getHttpServer();
    const get = (path: string, actor: SessionCredentials = reader) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);

    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const [actor, region] of [
        [adminA, f.scope.home],
        [adminB, f.scope.related],
      ] as const)
        await tx.query(
          `INSERT INTO whaleu_authorization.role_grants
           (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
           VALUES($1,$2,'school_admin',$3,$2,'synthetic-related-native')`,
          [randomUUID(), actor.accountId, region.regionId],
        );
      // Explicit accepted empty pin history, never inferred from absent rows.
      for (const region of [f.scope.home, f.scope.related, f.scope.foreign]) {
        const scopeId = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_community.post_pin_scopes
           (id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until)
           VALUES($1,$2,'regional',$3,'synthetic-related-native-scope','accepted',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
          [scopeId, region.spaceId, region.regionId],
        );
        await tx.query(
          `INSERT INTO whaleu_community.post_pin_history
           (scope_id,coverage,source_reference,accepted_at,valid_until)
           VALUES($1,'accepted_empty','synthetic-related-native-history',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
          [scopeId],
        );
      }
    });
    // Browsing selection is independent of the publication identity selected by
    // the emitted Page. Use the ordinary Profile API for this fixture preference.
    for (const [actor, campusId] of [
      [adminA, f.scope.home.campusId],
      [publisher, f.scope.home.campusId],
      [reader, f.scope.related.campusId],
      [adminB, f.scope.related.campusId],
    ] as const) {
      const profile = await get('/v1/me/profile', actor);
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      const selected = await request(http)
        .put('/v1/me/campus')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ campusId, expectedRevision: profile.body.revision });
      assert.equal(selected.status, 200, JSON.stringify(selected.body));
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_campus.community_identity_selections WHERE account_id=$1',
          [publisher.accountId],
        )
      ).rowCount,
      0,
      'The native journey must perform identity selection itself',
    );

    const checkpoints: string[] = [];
    const approvedRequests: {
      accountId: string;
      requestId: string;
      operation: string;
    }[] = [];
    let postId = '',
      rootCommentId = '',
      replyId = '',
      pinId = '';
    let originalBinding: unknown;
    const materializeHot = async () => {
      // The real owner runtimes consume the bounded set of native sources. No
      // score, component certificate or hot source is forged by this test.
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await f.app
          .get(HotFeedProcessing)
          .processSelected([postId]);
        assert.equal(result.failed, 0, JSON.stringify(result));
        if (result.current === 1) {
          assert.equal(
            await f.app.get(HotScoreMaterializer).refresh(postId),
            'current',
          );
          return;
        }
      }
      assert.fail(
        'Native post components did not become current within their bounded source count',
      );
    };
    const expectOneCanonicalRoot = async () => {
      const root = await f.pool.query<{
        id: string;
        space_id: string;
        account_id: string;
      }>(
        'SELECT id,space_id,account_id FROM whaleu_community.posts WHERE text=$1',
        [queryText],
      );
      assert.deepEqual(root.rows, [
        {
          id: postId,
          space_id: f.scope.home.spaceId,
          account_id: publisher.accountId,
        },
      ]);
      const binding = await f.pool.query(
        'SELECT * FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
        [postId],
      );
      assert.equal(binding.rowCount, 1);
      assert.equal(binding.rows[0].original_space_id, f.scope.home.spaceId);
      if (originalBinding === undefined) originalBinding = binding.rows[0];
      else
        assert.deepEqual(
          binding.rows[0],
          originalBinding,
          'Topology/settings changes cannot rewrite immutable origin proof',
        );
    };
    const acceptReview = async (value: NativeOutput, operation: string) => {
      const accountId = uuid(value.accountId, 'Review actor');
      const requestId = uuid(value.requestId, 'Review request');
      assert.equal(
        accountId,
        operation === 'publish_post' ? publisher.accountId : reader.accountId,
      );
      assert.equal(value.operation ?? operation, operation);
      const queued = await f.pool.query<{
        operation: string;
        envelope: {
          version: number;
          scope: {
            sync: string;
            identityRegionId: string;
            identityCampusId: string;
            parentDistribution?: { postId: string };
          };
        };
      }>(
        'SELECT operation,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
        [accountId, requestId],
      );
      assert.equal(
        queued.rowCount,
        1,
        'Only a real queued exact-envelope Review may be approved',
      );
      const envelope = queued.rows[0]!.envelope;
      assert.equal(queued.rows[0]!.operation, operation);
      assert.equal(envelope.version, 4);
      assert.equal(
        envelope.scope.sync,
        operation === 'publish_post' ? 'related' : 'inherited_related',
      );
      assert.equal(
        envelope.scope.identityRegionId,
        operation === 'publish_post'
          ? f.scope.home.regionId
          : f.scope.related.regionId,
      );
      assert.equal(
        envelope.scope.identityCampusId,
        operation === 'publish_post'
          ? f.scope.home.campusId
          : f.scope.related.campusId,
      );
      if (operation !== 'publish_post')
        assert.equal(envelope.scope.parentDistribution?.postId, postId);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
            [accountId, requestId],
          )
        ).rowCount,
        0,
        'Pending Review must not fabricate a publication receipt',
      );
      await f.decide(accountId, requestId);
      approvedRequests.push({ accountId, requestId, operation });
    };
    const topology = structuredClone(f.scope.topology);
    const homeGroup = topology.regions.find(
      (r) => r.regionId === f.scope.home.regionId,
    )!.groupId;
    const foreignGroup = topology.regions.find(
      (r) => r.regionId === f.scope.foreign.regionId,
    )!.groupId;
    const changeGroup = (regionId: string, groupId: string) => {
      topology.regions = topology.regions.map((region) =>
        region.regionId === regionId ? { ...region, groupId } : region,
      );
    };
    const checkpoint = async (value: NativeOutput) => {
      assert.ok(value.name);
      assert.equal(value.checkpointId, checkpoints.length + 1);
      checkpoints.push(value.name);
      switch (value.name) {
        case 'approve-root': {
          const policy = await f.pool.query<{
            command: {
              version: number;
              policy: { relatedSyncEnabled: boolean };
            };
            receipt: { outcome: string };
          }>(
            'SELECT command,receipt FROM whaleu_community.region_policy_commands WHERE actor_id=$1',
            [adminA.accountId],
          );
          assert.equal(
            policy.rowCount,
            1,
            'Settings must be saved through the emitted Page and normal HTTP',
          );
          assert.equal(policy.rows[0]!.command.version, 2);
          assert.equal(policy.rows[0]!.command.policy.relatedSyncEnabled, true);
          assert.equal(policy.rows[0]!.receipt.outcome, 'saved');
          await acceptReview(value, 'publish_post');
          break;
        }
        case 'published':
          postId = uuid(value.postId, 'Canonical publication');
          assert.equal(value.requestId, approvedRequests[0]!.requestId);
          await expectOneCanonicalRoot();
          await materializeHot();
          break;
        case 'approve-child':
          assert.ok(
            value.operation === 'publish_comment' ||
              value.operation === 'publish_reply',
          );
          await acceptReview(value, value.operation);
          break;
        case 'pinned': {
          assert.equal(value.postId, postId);
          rootCommentId = uuid(value.rootCommentId, 'Canonical root comment');
          replyId = uuid(value.replyId, 'Canonical reply');
          pinId = uuid(value.pinId, 'B pin');
          const pin = await f.pool.query<{
            post_id: string;
            space_id: string;
            actor_id: string;
          }>(
            'SELECT p.post_id,s.space_id,p.actor_id FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_scopes s ON s.id=p.scope_id WHERE p.id=$1',
            [pinId],
          );
          assert.deepEqual(pin.rows, [
            {
              post_id: postId,
              space_id: f.scope.related.spaceId,
              actor_id: adminB.accountId,
            },
          ]);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1 AND post_id=$2 AND account_id=$3',
                [rootCommentId, postId, reader.accountId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.replies WHERE id=$1 AND root_comment_id=$2 AND post_id=$3 AND account_id=$4',
                [replyId, rootCommentId, postId, reader.accountId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
                [postId, reader.accountId],
              )
            ).rowCount,
            1,
          );
          await materializeHot();
          break;
        }
        case 'withdraw-b':
          await setRegionPolicy(f.pool, f.scope.home.regionId, {
            relatedSyncEnabled: false,
          });
          changeGroup(f.scope.related.regionId, foreignGroup);
          await appendTopologyRevision(f.pool, topology);
          await expectOneCanonicalRoot();
          break;
        case 'add-c':
          changeGroup(f.scope.foreign.regionId, homeGroup);
          await appendTopologyRevision(f.pool, topology);
          await expectOneCanonicalRoot();
          break;
        case 'restore-b':
          changeGroup(f.scope.related.regionId, homeGroup);
          await appendTopologyRevision(f.pool, topology);
          await expectOneCanonicalRoot();
          break;
        case 'removed':
          assert.equal(value.postId, postId);
          await expectOneCanonicalRoot();
          break;
        default:
          assert.fail(`Unexpected native checkpoint ${value.name}`);
      }
    };

    child = fork(
      fileURLToPath(
        new URL(
          '../../../wechat/scripts/related-sync-native-child.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    child.stdout?.resume();
    let logs = '';
    child.stderr?.on('data', (data: Buffer) => {
      logs = (logs + String(data)).slice(-12000);
    });
    const exited = new Promise<number | null>((resolve) =>
      child!.once('exit', resolve),
    );
    const done = await new Promise<NativeOutput>((resolve, reject) => {
      let finished = false;
      let processing = false;
      const fail = (error: unknown) => {
        if (!finished) {
          finished = true;
          reject(error);
        }
      };
      child!.on('message', (raw: unknown) => {
        if (finished) return;
        const parsed = output.safeParse(raw);
        if (!parsed.success) {
          fail(
            new Error(`Invalid related native IPC: ${parsed.error.message}`),
          );
          return;
        }
        const value = parsed.data;
        if (value.event === 'failure') {
          fail(new Error(`${value.message ?? 'Native child failed'}\n${logs}`));
          return;
        }
        if (value.event === 'done') {
          if (processing) {
            fail(new Error('Native completion overlapped a parent checkpoint'));
            return;
          }
          finished = true;
          resolve(value);
          return;
        }
        if (processing) {
          fail(new Error('Native checkpoints must be sequential'));
          return;
        }
        processing = true;
        void checkpoint(value).then(() => {
          processing = false;
          if (!finished)
            child!.send({
              event: 'continue',
              name: value.name,
              checkpointId: value.checkpointId,
            });
        }, fail);
      });
      child!.once('exit', (code) => {
        if (!finished)
          fail(
            new Error(
              `Native child exited before completion (${code})\n${logs}`,
            ),
          );
      });
      child!.once('error', fail);
      child!.send({
        port: f.port,
        actors: {
          adminA: credentials(adminA),
          publisher: credentials(publisher),
          reader: credentials(reader),
          adminB: credentials(adminB),
        },
        scope: f.scope,
        queryText,
      });
    });
    assert.equal(await exited, 0, logs);
    assert.equal(done.postId, postId);
    assert.equal(done.rootCommentId, rootCommentId);
    assert.equal(done.replyId, replyId);
    assert.equal(done.pinId, pinId);
    assert.ok(
      (done.httpCalls ?? 0) > 40,
      'The acceptance path must exercise real native HTTP',
    );
    assert.deepEqual(checkpoints, [
      'approve-root',
      'published',
      'approve-child',
      'approve-child',
      'pinned',
      'withdraw-b',
      'add-c',
      'restore-b',
      'removed',
    ]);
    assert.deepEqual(
      approvedRequests.map((row) => row.operation),
      ['publish_post', 'publish_comment', 'publish_reply'],
    );
    for (const [index, publication] of approvedRequests.entries()) {
      const receipt = await f.pool.query<{
        receipt: { outcome: string; resourceId: string };
      }>(
        'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
        [publication.accountId, publication.requestId],
      );
      assert.equal(receipt.rowCount, 1);
      assert.equal(receipt.rows[0]!.receipt.outcome, 'created');
      assert.equal(
        receipt.rows[0]!.receipt.resourceId,
        [postId, rootCommentId, replyId][index],
      );
    }
    // Pure related management has its own exact v3 command, never a punishment
    // field or an accidental original-region authority upgrade.
    const removals = await f.pool.query<{
      command: { version: number; viewSpaceId: string; punishment?: unknown };
      receipt: { outcome: string };
    }>(
      `SELECT command,receipt FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1
       UNION ALL SELECT command,receipt FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1`,
      [adminB.accountId],
    );
    assert.equal(removals.rowCount, 3);
    for (const row of removals.rows) {
      assert.equal(row.command.version, 3);
      assert.equal(row.command.viewSpaceId, f.scope.related.spaceId);
      assert.equal(Object.hasOwn(row.command, 'punishment'), false);
      assert.equal(row.receipt.outcome, 'applied');
    }
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_safety.account_punishments'))
        .rowCount,
      0,
    );
    const pins = await f.pool.query<{
      command: { version: number; spaceId: string };
    }>('SELECT command FROM whaleu_community.post_pin_commands');
    assert.ok(pins.rows.length > 0);
    for (const row of pins.rows) {
      assert.equal(row.command.version, 2);
      assert.equal(row.command.spaceId, f.scope.related.spaceId);
    }
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=$1 AND reason='deleted'",
          [pinId],
        )
      ).rowCount,
      1,
    );
    for (const spaceId of [
      f.scope.home.spaceId,
      f.scope.related.spaceId,
      f.scope.foreign.spaceId,
    ]) {
      const detail = await get(`/v1/community/posts/${postId}`).query({
        viewSpaceId: spaceId,
      });
      assert.equal(detail.status, 404, JSON.stringify(detail.body));
    }
    await expectOneCanonicalRoot();
    t.diagnostic(
      `Emitted native related-sync journey used ${done.httpCalls} real loopback HTTP calls, three exact Review publications, one canonical graph, one destination pin and three pure scoped removals.`,
    );
  },
);
