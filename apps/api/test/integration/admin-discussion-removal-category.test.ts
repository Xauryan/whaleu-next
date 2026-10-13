import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import {
  categoryPolicyDigest,
  categoryReviewDigest,
} from '../../src/community/category-reclassification/evidence.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import type { AdminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';

async function seedPolicy(
  f: AdminDiscussionRemovalFixture,
  options: { continuation?: boolean; media?: boolean; until?: Date } = {},
) {
  const issuerId = randomUUID(),
    policyId = randomUUID(),
    sourceKey = `synthetic:discussion-category:${randomUUID()}`;
  const definition = {
    version: 1,
    authorMode: 'named',
    content: 'text_only',
    component: 'none',
    distribution: 'regional',
    sync: 'none',
    anonymousDm: false,
    origin: 'native',
    crosswalk: { pets: 10, scenery: 12 },
    transitions: [
      { from: 'pets', to: 'scenery' },
      { from: 'scenery', to: 'pets' },
    ],
    continueDescendants: options.continuation ?? true,
    futureChildren: 'original_envelope_plus_reviewed_current_parent',
    descendantMedia: options.media ? 'retain_current_media_proof' : 'text_only',
  };
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      "INSERT INTO whaleu_community.post_category_issuers(id,source_ref,accepted_at,valid_until) VALUES($1,'synthetic:discussion-category',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')",
      [issuerId],
    );
    await tx.query(
      `INSERT INTO whaleu_community.post_category_policies(id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until)
      VALUES($1,$2,1,'synthetic:discussion-category',$3,$4,$5,$6,clock_timestamp()-interval '1 minute',coalesce($7::timestamptz,clock_timestamp()+interval '1 hour'))`,
      [
        policyId,
        sourceKey,
        f.scope.home.regionId,
        issuerId,
        definition,
        categoryPolicyDigest(definition),
        options.until ?? null,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_community.post_category_policy_heads(source_key,policy_id) VALUES($1,$2)',
      [sourceKey, policyId],
    );
  });
  return { policyId, issuerId };
}
type Policy = Awaited<ReturnType<typeof seedPolicy>>;
async function insertReview(
  f: AdminDiscussionRemovalFixture,
  policy: Policy,
  envelope: Record<string, unknown>,
  until?: Date,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_community.post_category_reviews(id,issuer_id,policy_id,purpose,envelope,digest,result,accepted_at,valid_until)
     VALUES($1,$2,$3,$4,$5,$6,'allow',clock_timestamp()-interval '1 second',coalesce($7::timestamptz,clock_timestamp()+interval '1 hour'))`,
      [
        id,
        policy.issuerId,
        policy.policyId,
        envelope['purpose'],
        envelope,
        categoryReviewDigest(envelope),
        until ?? null,
      ],
    ),
  );
  return id;
}
async function prepareMove(
  f: AdminDiscussionRemovalFixture,
  actor: ProfileActor,
  grant: string,
  postId: string,
  policy: Policy,
) {
  const body = {
    clientRequestId: randomUUID(),
    postId,
    expectedRevision: 0,
    targetCategory: 'scenery',
  };
  const envelope = (
    await f.pool.query<{ envelope: Record<string, unknown> }>(
      'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) envelope',
      [actor.accountId, body, grant, policy.policyId],
    )
  ).rows[0]!.envelope;
  await insertReview(f, policy, envelope);
  return () =>
    request(f.http)
      .post('/v1/community/category-commands')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
}
async function move(
  f: AdminDiscussionRemovalFixture,
  actor: ProfileActor,
  grant: string,
  postId: string,
  policy: Policy,
) {
  const send = await prepareMove(f, actor, grant, postId, policy);
  const result = await send();
  profileOk(result);
  assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
  return result.body.eventId as string;
}
async function laterChild(
  f: AdminDiscussionRemovalFixture,
  author: ProfileActor,
  postId: string,
  rootId: string | null,
  event: string,
  policy: Policy,
  until?: Date,
) {
  const kind = rootId ? ('reply' as const) : ('comment' as const);
  const body = {
    clientRequestId: randomUUID(),
    text: 'Synthetic later exact context',
    authorMode: 'anonymous' as const,
    imageAssetIds: [] as string[],
    ...(rootId ? { targetReplyId: null } : {}),
  };
  const original = await approveEnvelope(
    f.pool,
    await discussionApprovalEnvelope(
      f.app,
      f.pool,
      author.accountId,
      postId,
      body,
      rootId,
    ),
  );
  const envelope = (
    await f.pool.query<{ envelope: Record<string, unknown> }>(
      'SELECT whaleu_community.post_category_child_envelope($1,$2,$3,$4,$5) envelope',
      [
        author.accountId,
        body.clientRequestId,
        kind,
        original.decisionId,
        event,
      ],
    )
  ).rows[0]!.envelope;
  const review = await insertReview(f, policy, envelope, until);
  const published = await request(f.app.getHttpServer())
    .post(
      rootId
        ? `/v1/community/comments/${rootId}/replies`
        : `/v1/community/posts/${postId}/comments`,
    )
    .set('Authorization', `Bearer ${author.accessToken}`)
    .send(body);
  profileOk(published, 201);
  assert.equal(published.body.outcome, 'created');
  const id = published.body.resourceId as string;
  const exact = (
    await f.pool.query(
      `SELECT original_decision_id,original_digest,review_id,event_id FROM whaleu_community.post_category_child_bindings WHERE content_kind=$1 AND content_id=$2`,
      [kind, id],
    )
  ).rows[0]!;
  assert.deepEqual(exact, {
    original_decision_id: original.decisionId,
    original_digest: original.digest,
    review_id: review,
    event_id: event,
  });
  return { kind, id, review, original };
}
async function retirePolicy(f: AdminDiscussionRemovalFixture, policy: Policy) {
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'INSERT INTO whaleu_community.post_category_policy_withdrawals(policy_id) VALUES($1) ON CONFLICT DO NOTHING',
      [policy.policyId],
    ),
  );
}

test(
  'old category descendants retain exact original Review and media, while continuation denial remains owned by classification',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture(true);
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor(),
      classifier = await f.actor();
    await f.grant(admin);
    const grant = await f.grant(classifier);
    for (const images of [false, true]) {
      const post = await f.publish(author, { category: 'pets' });
      const root = await f.discussion(author, post.id, {
        authorMode: 'anonymous',
        images,
      });
      const reply = await f.discussion(author, post.id, {
        rootId: root.id,
        authorMode: 'anonymous',
        images,
      });
      const original = (
        await f.pool.query(
          'SELECT content_kind,content_id,decision_id,digest,envelope FROM whaleu_community.content_approval_bindings WHERE content_id=ANY($1::uuid[]) ORDER BY content_kind',
          [[root.id, reply.id]],
        )
      ).rows;
      const forbidden = await seedPolicy(f, {
        continuation: false,
        media: images,
      });
      const attempt = await prepareMove(
        f,
        classifier,
        grant,
        post.id,
        forbidden,
      );
      const denied = await attempt();
      assert.ok(
        denied.status >= 400 || denied.body.outcome === 'rejected',
        JSON.stringify(denied.body),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.post_category_heads WHERE post_id=$1',
            [post.id],
          )
        ).rows[0]!.n,
        0,
        'the canonical owner forbids moving existing descendants without continuation',
      );
      await retirePolicy(f, forbidden);
      const policy = await seedPolicy(f, { media: images });
      await move(f, classifier, grant, post.id, policy);
      assert.equal(
        (
          await f.pool.query(
            'SELECT current_category FROM whaleu_community.post_category_live WHERE post_id=$1',
            [post.id],
          )
        ).rows[0]!.current_category,
        'scenery',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.post_category_child_bindings WHERE content_id=ANY($1::uuid[])',
            [[root.id, reply.id]],
          )
        ).rows[0]!.n,
        0,
        'old children continue without invented supplemental publication history',
      );
      await f.removalApply(reply, admin);
      await f.removalApply(root, admin);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT content_kind,content_id,decision_id,digest,envelope FROM whaleu_community.content_approval_bindings WHERE content_id=ANY($1::uuid[]) ORDER BY content_kind',
            [[root.id, reply.id]],
          )
        ).rows,
        original,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
            [post.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
      await retirePolicy(f, policy);
    }
  },
);

test(
  'later category children require exact supplemental Review, and revocation cannot fall back to original-only visibility',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor(),
      classifier = await f.actor();
    await f.grant(admin);
    const grant = await f.grant(classifier);
    for (const revoked of [
      'none',
      'child-review',
      'root-review',
      'issuer',
      'policy',
    ] as const) {
      const post = await f.publish(author, { category: 'pets' });
      const policy = await seedPolicy(f);
      const event = await move(f, classifier, grant, post.id, policy);
      const root = await laterChild(f, author, post.id, null, event, policy);
      const reply = await laterChild(
        f,
        author,
        post.id,
        root.id,
        event,
        policy,
      );
      const beforeRoot = await f.removalManagement(root, admin),
        beforeReply = await f.removalManagement(reply, admin);
      if (revoked === 'none') {
        await f.removalApply(reply, admin);
        await f.removalApply(root, admin);
      } else {
        await withCommunityScopeWriter(f.pool, (tx) => {
          if (revoked === 'issuer')
            return tx.query(
              'INSERT INTO whaleu_community.post_category_issuer_withdrawals(issuer_id) VALUES($1)',
              [policy.issuerId],
            );
          if (revoked === 'policy')
            return tx.query(
              'INSERT INTO whaleu_community.post_category_policy_withdrawals(policy_id) VALUES($1)',
              [policy.policyId],
            );
          return tx.query(
            'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) VALUES($1)',
            [revoked === 'root-review' ? root.review : reply.review],
          );
        });
        const forbidden =
          revoked === 'child-review'
            ? [{ target: reply, version: beforeReply.targetVersion }]
            : [
                { target: root, version: beforeRoot.targetVersion },
                { target: reply, version: beforeReply.targetVersion },
              ];
        for (const { target, version } of forbidden) {
          const command = f.removalCommand(target, version);
          const denied = await f.removalSend(admin, command);
          assert.ok(
            denied.status >= 400,
            `${revoked}/${target.kind}: ${JSON.stringify(denied.body)}`,
          );
          const recovery = await f.removalRecovery(
            admin,
            command.clientRequestId,
          );
          profileOk(recovery);
          assert.deepEqual(recovery.body, { state: 'not_recorded' });
        }
        if (revoked === 'child-review') await f.removalApply(root, admin);
      }
      await retirePolicy(f, policy);
    }
  },
);

test(
  'category policy and selected supplemental Review exact deadlines survive tentative deletion until actual clock expiry',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor(),
      classifier = await f.actor();
    await f.grant(admin);
    const grant = await f.grant(classifier);
    const database = f.moderationApp.get(DatabaseService);
    for (const source of ['policy', 'supplemental-review'] as const) {
      for (const kind of ['comment', 'reply'] as const) {
        const post = await f.publish(author, { category: 'pets' });
        const deadline = (
          await f.pool.query<{ until: Date }>(
            "SELECT clock_timestamp()+interval '3 seconds' until",
          )
        ).rows[0]!.until;
        const policy = await seedPolicy(
          f,
          source === 'policy' ? { until: deadline } : {},
        );
        const event = await move(f, classifier, grant, post.id, policy);
        const root = await laterChild(
          f,
          author,
          post.id,
          null,
          event,
          policy,
          source === 'supplemental-review' && kind === 'comment'
            ? deadline
            : undefined,
        );
        const target =
          kind === 'comment'
            ? root
            : await laterChild(
                f,
                author,
                post.id,
                root.id,
                event,
                policy,
                source === 'supplemental-review' ? deadline : undefined,
              );
        const view = await f.removalManagement(target, admin),
          command = f.removalCommand(target, view.targetVersion);
        const original = database.transaction,
          run = original.bind(database);
        let tentative = false,
          expired = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const result = await work(tx);
            if (
              result &&
              typeof result === 'object' &&
              'outcome' in result &&
              result.outcome === 'applied'
            ) {
              tentative = (
                await tx.query<{ present: boolean }>(
                  'SELECT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions WHERE actor_id=$1 AND request_id=$2) present',
                  [admin.accountId, command.clientRequestId],
                )
              ).rows[0]!.present;
              assert.equal(
                (
                  await tx.query<{ live: boolean }>(
                    'SELECT clock_timestamp()<$1::timestamptz live',
                    [deadline],
                  )
                ).rows[0]!.live,
                true,
              );
              await tx.query(
                'SELECT pg_sleep(GREATEST(0,extract(epoch FROM($1::timestamptz-clock_timestamp())))+0.02)',
                [deadline],
              );
              expired = (
                await tx.query<{ expired: boolean }>(
                  'SELECT clock_timestamp()>=$1::timestamptz expired',
                  [deadline],
                )
              ).rows[0]!.expired;
            }
            return result;
          }, options);
        let response;
        try {
          response = await f.removalSend(admin, command);
        } finally {
          database.transaction = original;
        }
        assert.equal(tentative, true, `${kind}/${source}`);
        assert.equal(expired, true, `${kind}/${source}`);
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        assert.equal(
          (
            await f.pool.query(
              `SELECT deleted_at FROM whaleu_community.${kind === 'comment' ? 'root_comments' : 'replies'} WHERE id=$1`,
              [target.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2',
              [admin.accountId, command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        await retirePolicy(f, policy);
      }
    }
  },
);

async function block(
  f: AdminDiscussionRemovalFixture,
  blocker: string,
  blocked: string,
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic category block','profile',$4)",
      [id, blocker, blocked, randomUUID()],
    );
    await tx.query(
      "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
      [randomUUID(), blocker, id],
    );
  });
}

test(
  'moved named parents keep bidirectional block gates while named children keep outgoing-only and anonymous children stay author-undisclosed',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const classifier = await f.actor(),
      grant = await f.grant(classifier);
    const policy = await seedPolicy(f);
    for (const direction of [
      'parent-blocks-admin',
      'admin-blocks-parent',
      'child-blocks-admin',
      'admin-blocks-child',
      'anonymous-child',
    ] as const) {
      for (const kind of ['comment', 'reply'] as const) {
        const admin = await f.actor(),
          owner = await f.actor(),
          author = await f.actor();
        await f.grant(admin);
        const post = await f.publish(owner, { category: 'pets' });
        const anonymous = direction === 'anonymous-child';
        const root = await f.discussion(author, post.id, {
          authorMode: anonymous ? 'anonymous' : 'named',
        });
        const target =
          kind === 'comment'
            ? root
            : await f.discussion(author, post.id, {
                rootId: root.id,
                authorMode: anonymous ? 'anonymous' : 'named',
              });
        await move(f, classifier, grant, post.id, policy);
        const before = await f.removalManagement(target, admin);
        if (direction === 'parent-blocks-admin')
          await block(f, owner.accountId, admin.accountId);
        else if (direction === 'admin-blocks-parent')
          await block(f, admin.accountId, owner.accountId);
        else if (direction === 'child-blocks-admin')
          await block(f, author.accountId, admin.accountId);
        else await block(f, admin.accountId, author.accountId);
        const permitted =
          direction === 'child-blocks-admin' || direction === 'anonymous-child';
        if (permitted) {
          const management = await f.removalManagement(target, admin);
          assert.deepEqual(Object.keys(management).sort(), [
            'canRemove',
            'target',
            'targetVersion',
          ]);
          assert.equal(
            JSON.stringify(management).includes(author.accountId),
            false,
          );
          await f.removalApply(target, admin);
        } else {
          const response = await f.removalSend(
            admin,
            f.removalCommand(target, before.targetVersion),
          );
          assert.ok(
            response.status >= 400,
            `${direction}/${kind}: ${JSON.stringify(response.body)}`,
          );
          assert.equal(
            (
              await f.pool.query(
                `SELECT deleted_at FROM whaleu_community.${kind === 'comment' ? 'root_comments' : 'replies'} WHERE id=$1`,
                [target.id],
              )
            ).rows[0]!.deleted_at,
            null,
          );
        }
      }
    }
  },
);

test(
  'classification after the original discussion observation and before its target lock cannot replace the retained source CAS',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      author = await f.actor(),
      admin = await f.actor(),
      classifier = await f.actor();
    await f.grant(admin);
    const grant = await f.grant(classifier),
      policy = await seedPolicy(f);
    const database = f.moderationApp.get(DatabaseService);
    for (const kind of ['comment', 'reply'] as const) {
      const post = await f.publish(owner, { category: 'pets' });
      const root = await f.discussion(author, post.id, {
        authorMode: 'anonymous',
      });
      const target =
        kind === 'comment'
          ? root
          : await f.discussion(author, post.id, { rootId: root.id });
      const classify = await prepareMove(f, classifier, grant, post.id, policy);
      const view = await f.removalManagement(target, admin),
        command = f.removalCommand(target, view.targetVersion);
      const original = database.transaction,
        run = original.bind(database);
      let classified = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx) as (
              sql: string,
              values?: unknown[],
            ) => Promise<QueryResult>;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            if (
              !classified &&
              sql.startsWith(
                'SELECT whaleu_community.admin_discussion_removal_input_facts',
              )
            ) {
              // This hook is after the exact pre-wait observation, before resolve
              // enters the canonical Safety/post/root locks. The other real HTTP
              // transaction must finish classification before this reader resumes.
              classified = true;
              const moved = await classify();
              profileOk(moved);
              assert.equal(moved.body.outcome, 'applied');
            }
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      let response;
      try {
        response = await f.removalSend(admin, command);
      } finally {
        database.transaction = original;
      }
      assert.equal(classified, true);
      assert.ok(response.status >= 400, JSON.stringify(response.body));
      assert.equal(
        (
          await f.pool.query(
            'SELECT current_category FROM whaleu_community.post_category_live WHERE post_id=$1',
            [post.id],
          )
        ).rows[0]!.current_category,
        'scenery',
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT deleted_at FROM whaleu_community.${kind === 'comment' ? 'root_comments' : 'replies'} WHERE id=$1`,
            [target.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
      const recovered = await f.removalRecovery(admin, command.clientRequestId);
      profileOk(recovered);
      assert.deepEqual(recovered.body, { state: 'not_recorded' });
      // A fresh invocation with the old CAS gets a durable, read-only stale
      // receipt; a newly observed exact CAS can still remove the selected child.
      const stale = await f.removalSend(
        admin,
        f.removalCommand(target, view.targetVersion),
      );
      profileOk(stale);
      assert.equal(stale.body.code, 'ADMIN_DISCUSSION_REMOVAL_STALE');
      await f.removalApply(target, admin);
    }
  },
);
