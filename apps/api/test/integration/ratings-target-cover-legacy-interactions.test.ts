import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { z } from 'zod';
import {
  syntheticRatingTargetCoverFixture,
  coverHttpOk,
} from '../support/media/ratings-target-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { RatingScopedRepository } from '../../src/ratings/scoped/repository.js';
import {
  ratingScopedIntentSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';

/** These remain protocol 2 operations. A current v6 target adds exact cover
 * authority, never a protocol relabel or a new journal format. Not executed. */
test(
  'v2 auxiliary reads and interactions require current exact cover scope, Review and Media, while original receipts recover',
  { timeout: 180000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 36, height: 28, channels: 3, background: '#576ab4' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const owner = f.creator,
      reader = await f.actor();
    const upload = await f.ready(owner, await f.draft(owner), png),
      created = await f.execute(owner, upload.input);
    const targetId = created.result.targetId,
      revision = created.result.revision;
    const common = { targetId, expectedTargetRevision: revision };
    const auxiliary = async (actor: typeof owner, path: string) => {
      const c = await f.scopedContext(actor, { kind: 'global' }, 'read');
      return f
        .auth(request(f.http).get(path), actor)
        .query({ contextId: c.id, contextToken: c.token });
    };
    const currentPath = `/v2/ratings/targets/${targetId}`;
    const ensureBlocked = (response: { status: number; body: unknown }) => {
      if (response.status === 200) {
        const body = z
          .object({
            outcome: z.string().optional(),
            status: z.string().optional(),
          })
          .parse(response.body);
        assert.ok(
          body.outcome === 'closed' || body.status === 'unavailable',
          JSON.stringify(response.body),
        );
      } else {
        const body = z
          .object({
            error: z.object({
              code: z.enum([
                'RATING_UNAVAILABLE',
                'RATING_SCOPE_UNAVAILABLE',
                'RATING_SCOPED_CONTEXT_CHANGED',
                'RATING_SCOPE_DENIED',
                'RATING_NOT_FOUND',
                'CONTENT_REVIEW_UNAVAILABLE',
                'MEDIA_UNAVAILABLE',
              ]),
            }),
          })
          .parse(response.body);
        assert.ok(body.error.code);
      }
    };
    const execute = async (input: RatingScopedIntent) => {
      const result = await f.executeCommand(reader, input);
      return { ...result, receipt: scopedSuccess(result.receipt) };
    };
    const safety = async (tx: PoolClient, state: 'allow' | 'unknown') => {
      const a = (
        await tx.query<{
          revision: string;
          manifest_digest: string;
          policy_revision: string;
        }>(
          `SELECT h.revision::text,a.manifest_digest,a.policy_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h`,
          [upload.status.assetId],
        )
      ).rows[0]!;
      const event = randomUUID(),
        next = String(BigInt(a.revision) + 1n);
      await tx.query(
        `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,$4,$5,$6,'synthetic-cover-v2',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [
          event,
          upload.status.assetId,
          next,
          state,
          a.manifest_digest,
          a.policy_revision,
        ],
      );
      await tx.query(
        'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
        [upload.status.assetId, next, event],
      );
    };
    let scored!: Awaited<ReturnType<typeof execute>>;
    let rootId = '',
      rootRevision = '',
      likeRevision = '',
      subscriptionRevision = '',
      replyId = '',
      replyRevision = '',
      replyLikeRevision = '';
    const auxiliaryPaths = () => [
      ...['my-score', 'score-summary', 'comments', 'subscription'].map(
        (suffix) => `${currentPath}/${suffix}`,
      ),
      `/v2/ratings/comments/${rootId}`,
      `/v2/ratings/comments/${rootId}/discussion`,
      `/v2/ratings/comments/${rootId}/replies`,
      `/v2/ratings/comments/${rootId}/like`,
      `/v2/ratings/replies/${replyId}`,
      `/v2/ratings/replies/${replyId}/position`,
      `/v2/ratings/replies/${replyId}/like`,
    ];
    await t.test(
      'same v2 score, text comment, like and subscription retain their old receipt shape',
      async () => {
        scored = await execute(
          await f.commandIntent(reader, 'set_score_scoped', {
            ...common,
            expectedRevision: null,
            score: 4,
          }),
        );
        assert.equal(scored.receipt.protocolVersion, 2);
        const comment = await f.executeCommand(
          owner,
          await f.commandIntent(owner, 'create_comment_scoped', {
            ...common,
            authorMode: 'named',
            body: 'Plain text under exact covered target',
            assetIds: [],
          }),
        );
        const commentReceipt = scopedSuccess(comment.receipt);
        rootId = String(commentReceipt.result['subjectId']);
        rootRevision = String(commentReceipt.result['revision']);
        const liked = await auxiliary(
          reader,
          `/v2/ratings/comments/${rootId}/like`,
        );
        coverHttpOk(liked);
        assert.equal(liked.body.status, 'known');
        const like = await execute(
          await f.commandIntent(reader, 'set_comment_like_scoped', {
            ...common,
            rootId,
            expectedRevision: rootRevision,
            expectedLikeRevision: liked.body.revision,
            liked: true,
          }),
        );
        likeRevision = String(like.receipt.result['revision']);
        const reply = await f.executeCommand(
          owner,
          await f.commandIntent(owner, 'create_reply_scoped', {
            ...common,
            rootId,
            expectedRootRevision: rootRevision,
            replyTo: null,
            authorMode: 'named',
            body: 'Plain reply under covered target',
            assetIds: [],
          }),
        );
        const replyReceipt = scopedSuccess(reply.receipt);
        replyId = String(replyReceipt.result['replyId']);
        replyRevision = String(replyReceipt.result['revision']);
        const replyState = await auxiliary(
          reader,
          `/v2/ratings/replies/${replyId}/like`,
        );
        coverHttpOk(replyState);
        assert.equal(replyState.body.status, 'known');
        const replyLiked = await execute(
          await f.commandIntent(reader, 'set_reply_like_scoped', {
            ...common,
            rootId,
            replyId,
            expectedRootRevision: rootRevision,
            expectedRevision: replyRevision,
            expectedLikeRevision: replyState.body.revision,
            liked: true,
          }),
        );
        replyLikeRevision = String(replyLiked.receipt.result['revision']);
        const subscription = await auxiliary(
          reader,
          `${currentPath}/subscription`,
        );
        coverHttpOk(subscription);
        assert.equal(subscription.body.status, 'known');
        const subscribed = await execute(
          await f.commandIntent(reader, 'set_target_subscription_scoped', {
            ...common,
            expectedSubscriptionRevision: subscription.body.revision,
            subscribed: true,
          }),
        );
        subscriptionRevision = String(subscribed.receipt.result['revision']);
        for (const path of auxiliaryPaths()) {
          const result = await auxiliary(reader, path);
          coverHttpOk(result);
          assert.doesNotMatch(
            JSON.stringify(result.body),
            /"(?:cover|manifest|contextToken|url)"/,
          );
        }
      },
    );
    await t.test(
      'explicit v3 subscription cards carry only the selected read context descriptor',
      async () => {
        const c = await f.context(reader, 'read');
        const result = await f
          .auth(
            request(f.http).get('/v3/ratings/target-cover/subscriptions'),
            reader,
          )
          .query({ contextId: c.id, contextToken: c.token });
        coverHttpOk(result);
        const card = result.body.items.find(
          (item: { id: string }) => item.id === targetId,
        );
        assert.ok(card?.cover);
        assert.equal(card.cover.targetId, targetId);
        assert.equal(card.cover.contextId, c.id);
        assert.equal(card.cover.contextToken, c.token);
        const descriptor = await f
          .auth(
            request(f.http).get(
              `/v3/ratings/target-cover/targets/${targetId}/appearances/${card.cover.appearanceId}`,
            ),
            reader,
          )
          .query({ contextId: c.id, contextToken: c.token });
        coverHttpOk(descriptor);
        assert.deepEqual(descriptor.body, card.cover);
        const old = await f.scopedContext(reader, { kind: 'global' }, 'read');
        ensureBlocked(
          await f
            .auth(
              request(f.http).get('/v3/ratings/target-cover/subscriptions'),
              reader,
            )
            .query({ contextId: old.id, contextToken: old.token }),
        );
        ensureBlocked(
          await f
            .auth(request(f.http).get('/v2/ratings/subscriptions'), reader)
            .query({ contextId: c.id, contextToken: c.token }),
        );
      },
    );
    const freshInteractions = async () => [
      await f.commandIntent(reader, 'set_score_scoped', {
        ...common,
        expectedRevision: scored.receipt.result['revision'],
        score: 5,
      }),
      await f.commandIntent(reader, 'set_comment_like_scoped', {
        ...common,
        rootId,
        expectedRevision: rootRevision,
        expectedLikeRevision: likeRevision,
        liked: false,
      }),
      await f.commandIntent(reader, 'set_target_subscription_scoped', {
        ...common,
        expectedSubscriptionRevision: subscriptionRevision,
        subscribed: false,
      }),
      await f.commandIntent(reader, 'set_reply_like_scoped', {
        ...common,
        rootId,
        replyId,
        expectedRootRevision: rootRevision,
        expectedRevision: replyRevision,
        expectedLikeRevision: replyLikeRevision,
        liked: false,
      }),
    ];
    const assertOriginalRecovery = async () => {
      // JSON object keys are unordered; PostgreSQL jsonb may reorder them.
      // Preserve the exact historical values and canonical bytes, not transport key order.
      const expected = canonicalJson(scored.response.body);
      const replay = await f.sendCommand(
        reader,
        scored.input,
        scored.prepared?.contextRevision,
      );
      coverHttpOk(replay);
      assert.equal(canonicalJson(replay.body), expected);
      const status = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${scored.input.payload.clientRequestId}`,
        ),
        reader,
      );
      coverHttpOk(status);
      assert.equal(canonicalJson(status.body), expected);
      assert.doesNotMatch(expected, /"(?:cover|manifest|contextToken|url)"/);
    };
    await t.test(
      'an unrelated current campus context cannot be substituted for the exact global target scope',
      async () => {
        const input = (await freshInteractions())[0]!;
        const wrong = await f.scopedContext(
          reader,
          { kind: 'campus', campusId: f.campusA },
          'interact',
        );
        const changed = ratingScopedIntentSchema.parse({
          ...input,
          context: scopedCommandContext(wrong),
        });
        ensureBlocked(await f.sendCommand(reader, changed));
        const read = await f.scopedContext(
          reader,
          { kind: 'campus', campusId: f.campusA },
          'read',
        );
        ensureBlocked(
          await f
            .auth(request(f.http).get(`${currentPath}/score-summary`), reader)
            .query({ contextId: read.id, contextToken: read.token }),
        );
      },
    );
    await t.test(
      'unknown Media blocks auxiliary reads and fresh writes but never reauthorizes an original receipt',
      async () => {
        const inputs = await freshInteractions();
        await withCommunityScopeWriter(f.pool, (tx) => safety(tx, 'unknown'));
        for (const path of auxiliaryPaths())
          ensureBlocked(await auxiliary(reader, path));
        for (const input of inputs)
          ensureBlocked(await f.sendCommand(reader, input));
        await assertOriginalRecovery();
        await withCommunityScopeWriter(f.pool, (tx) => safety(tx, 'allow'));
        coverHttpOk(await auxiliary(reader, `${currentPath}/score-summary`));
      },
    );
    await t.test(
      'allow to unknown to allow after the auxiliary target read is still a final-proof change',
      async () => {
        const repository = f.app.get(RatingScopedRepository),
          target = repository.target;
        const before = (
          await f.pool.query(
            'SELECT revision,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
            [upload.status.assetId],
          )
        ).rows[0];
        let reached = false;
        repository.target = async function (
          ...args: Parameters<typeof target>
        ) {
          const value = await target.apply(this, args);
          if (!reached) {
            reached = true;
            await safety(args[2], 'unknown');
            await safety(args[2], 'allow');
          }
          return value;
        };
        try {
          ensureBlocked(
            await auxiliary(reader, `${currentPath}/score-summary`),
          );
          assert.equal(reached, true);
        } finally {
          repository.target = target;
        }
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT revision,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
              [upload.status.assetId],
            )
          ).rows[0],
          before,
        );
      },
    );
    await t.test(
      'replacing the adopted capability source revokes that exact registration; old receipts and owner deletion remain recoverable',
      async () => {
        const inputs = await freshInteractions(),
          readContext = await f.scopedContext(
            reader,
            { kind: 'global' },
            'read',
          );
        const source = (
          await f.pool.query(
            `SELECT s.source_kind,s.source_key,s.scope_keys,s.payload FROM whaleu_ratings.target_cover_capability_sources c JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id JOIN whaleu_ratings.scoped_source_attestations s ON(s.id,s.revision)=(c.source_id,c.source_revision) WHERE v.logical_scope_key='global'`,
          )
        ).rows[0];
        assert.ok(source);
        // Replace the source AND publish/activate the complete affected domain
        // atomically through the existing fixture owner. The old cover registration
        // stays immutable and cannot authorize this new adopted version.
        await f.atomicChange((tx) => f.capability(source.payload, tx), {
          activate: true,
        });
        for (const input of inputs)
          ensureBlocked(await f.sendCommand(reader, input));
        // Reuse a previously issued context so a failed new issuance cannot mask a missing read gate.
        for (const path of auxiliaryPaths())
          ensureBlocked(
            await f.auth(request(f.http).get(path), reader).query({
              contextId: readContext.id,
              contextToken: readContext.token,
            }),
          );
        await assertOriginalRecovery();
        for (const [kind, id] of [
          ['replies', replyId],
          ['comments', rootId],
        ] as const) {
          const metadata = await f.auth(
            request(f.http).get(`/v1/ratings/${kind}/${id}/deletion-context`),
            owner,
          );
          coverHttpOk(metadata);
          assert.doesNotMatch(
            JSON.stringify(metadata.body),
            /"(?:body|name|description|cover|manifest|contextToken)"/,
          );
          const input = {
            clientRequestId: randomUUID(),
            regionId: metadata.body.regionId,
            targetId,
            expectedTargetRevision: metadata.body.targetRevision,
            expectedRevision: metadata.body.revision,
            ...(kind === 'replies'
              ? { rootId, expectedRootRevision: metadata.body.rootRevision }
              : {}),
          };
          const deletion = await f
            .auth(request(f.http).delete(`/v1/ratings/${kind}/${id}`), owner)
            .send(input);
          coverHttpOk(deletion);
          assert.equal(deletion.body.outcome, 'applied');
          const replay = await f
            .auth(request(f.http).delete(`/v1/ratings/${kind}/${id}`), owner)
            .send(input);
          coverHttpOk(replay);
          assert.deepEqual(replay.body, deletion.body);
        }
        const deleted = await f
          .auth(
            request(f.http).post(
              `/v1/ratings/management/owner-deletion/targets/${targetId}`,
            ),
            owner,
          )
          .send({
            clientRequestId: randomUUID(),
            expectedTargetRevision: revision,
          });
        coverHttpOk(deleted);
        await assertOriginalRecovery();
      },
    );
  },
);
