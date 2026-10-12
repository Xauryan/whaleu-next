import { MajorDiscussionMediaService } from '../../src/majors/discussion/media/facade.js';
import { MajorDiscussionMediaReviewFacade } from '../../src/community/content-review/major-discussion-media-review.facade.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import { finished } from 'node:stream/promises';
import {
  majorDiscussionMediaFixture,
  readyMajorDiscussionImage,
  reviewMajorDiscussionV2,
  majorMediaOk as ok,
  majorMediaPrefix,
} from '../support/major-discussion-media-fixture.js';
import { reviewMajorDiscussion } from '../support/major-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  majorDiscussionIntentHashV2,
  MAJOR_DISCUSSION_V2,
} from '../../src/majors/discussion/contracts-v2.js';
import type {
  MajorRootPublishV2,
  MajorReplyPublishV2,
} from '../../src/majors/discussion/contracts-v2.js';
const base = '/v2/majors';
test(
  'Major Media17 real multipart processing, exact v2 publication, whole-set current reads and original-key recovery',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 20, height: 12, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const f = await majorDiscussionMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const a = await f.actor({ identity: false }),
      b = await f.actor({ identity: false }),
      w = f.add(),
      foreign = f.add();
    const catalog = await f.accept([w, foreign]);
    await f.acceptDiscussion([w.id, foreign.id]);
    const http = f.app.getHttpServer();
    const post = (path: string, input: object, actor = a) =>
      request(http)
        .post(path)
        .set('Authorization', 'Bearer ' + actor.accessToken)
        .send(input);
    const get = (path: string, actor = a) =>
      request(http)
        .get(path)
        .set('Authorization', 'Bearer ' + actor.accessToken);
    const q: MajorRootPublishV2 = {
      protocol: MAJOR_DISCUSSION_V2,
      clientRequestId: randomUUID(),
      expectedCatalogRevision: catalog,
      expectedMajorRevision: w.revision,
      body: 'Major image publication',
      images: [],
    };
    const context = {
      publicationRequestId: q.clientRequestId,
      majorId: w.id,
      catalogRevision: catalog,
      majorRevision: w.revision,
      rootId: null,
      replyToReplyId: null,
    };
    const one = await readyMajorDiscussionImage(
        f,
        a,
        { ...context, ordinal: 0 },
        bytes,
      ),
      two = await readyMajorDiscussionImage(
        f,
        a,
        { ...context, ordinal: 1 },
        bytes,
      );
    q.images = [one.fact, two.fact];
    let rootId = '',
      replyId = '',
      review = '';
    let references: {
      majorId: string;
      commentId: string;
      bindingId: string;
      ordinal: number;
    }[] = [];
    const path = (
      ref: {
        majorId: string;
        commentId: string;
        bindingId: string;
        ordinal: number;
      },
      variant?: string,
    ) =>
      `${majorMediaPrefix}/majors/${ref.majorId}/comments/${ref.commentId}/bindings/${ref.bindingId}${variant ? '/' + variant : ''}?ordinal=${ref.ordinal}`;
    const safety = async (asset: string, state: 'allow' | 'held') =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,h.revision+1,$3,a.manifest_digest,a.policy_revision,'synthetic-major-media',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
          [id, asset, state],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1',
          [asset, id],
        );
      });
    await t.test(
      'upload and processing create no comments; unconfigured exact Review fails closed',
      async () => {
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_majors.major_discussion_comments',
            )
          ).rows[0]!.n,
          0,
        );
        const r = await post(`${base}/${w.id}/discussion`, q);
        ok(r, 503);
        assert.equal(r.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
      },
    );
    await t.test(
      'v1 golden publication unchanged before mixed v2 population',
      async () => {
        const old = f.root(catalog, w, 'legacy exact text');
        await reviewMajorDiscussion(f.pool, a.accountId, w.id, old);
        ok(await post(`/v1/majors/${w.id}/discussion`, old));
        const page = await get(`/v1/majors/${w.id}/discussion`);
        ok(page);
        assert.equal(page.body.items.length, 1);
        assert.equal('images' in page.body.items[0], false);
      },
    );
    await t.test(
      'text-and-image root atomically publishes exactly two bindings and one durable receipt',
      async () => {
        review = await reviewMajorDiscussionV2(f.pool, a.accountId, w.id, q);
        const r = await post(`${base}/${w.id}/discussion`, q);
        ok(r);
        rootId = r.body.commentId;
        assert.ok(rootId);
        const repeat = await post(`${base}/${w.id}/discussion`, q);
        ok(repeat);
        assert.deepEqual(repeat.body, r.body);
        const page = await get(`${base}/${w.id}/discussion`);
        ok(page);
        assert.equal(page.body.totalCount, 2);
        const item = page.body.items.find(
          (x: { id: string }) => x.id === rootId,
        );
        assert.equal(item.body, q.body);
        assert.equal(item.images.length, 2);
        references = item.images;
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1',
              [rootId],
            )
          ).rows[0]!.n,
          2,
        );
        ok(await get(`/v1/majors/${w.id}/discussion`), 503);
      },
    );
    await t.test(
      'same key altered body or order conflicts; no foreign Major UUID authority',
      async () => {
        for (const changed of [
          { ...q, body: 'different' },
          { ...q, images: [...q.images].reverse() },
        ]) {
          const r = await post(`${base}/${w.id}/discussion`, changed);
          ok(r, 409);
          assert.equal(r.body.error.code, 'REQUEST_CONFLICT');
        }
        ok(await get(path({ ...references[0]!, majorId: foreign.id })), 503);
      },
    );
    await t.test(
      'derived descriptor/bytes are private, Range is rejected before storage',
      async () => {
        const descriptor = await get(path(references[0]!));
        ok(descriptor);
        assert.equal(descriptor.body.protocol, 'major-discussion-media-v1');
        assert.equal(descriptor.body.kind, 'major-discussion-media');
        assert.equal('url' in descriptor.body, false);
        const image = await get(path(references[0]!, 'display-v1'));
        ok(image);
        assert.match(image.headers['cache-control']!, /no-store/);
        assert.equal(image.headers['content-type'], 'image/png');
        let opens = 0;
        const original = f.storage.openExact.bind(f.storage);
        f.storage.openExact = async (...args) => {
          opens++;
          return original(...args);
        };
        const r = await get(path(references[0]!, 'display-v1')).set(
          'Range',
          'bytes=0-3',
        );
        assert.notEqual(r.status, 200);
        assert.equal(opens, 0);
        f.storage.openExact = original;
      },
    );
    await t.test(
      'reply text-and-image notice uses causal reply first image; like notice has no thumbnail',
      async () => {
        const command: MajorReplyPublishV2 = {
          ...q,
          clientRequestId: randomUUID(),
          images: [],
          replyToReplyId: null,
        };
        const ready = await readyMajorDiscussionImage(
          f,
          b,
          {
            ...context,
            publicationRequestId: command.clientRequestId,
            rootId,
            ordinal: 0,
          },
          bytes,
        );
        command.images = [ready.fact];
        await reviewMajorDiscussionV2(
          f.pool,
          b.accountId,
          w.id,
          command,
          rootId,
        );
        const r = await post(
          `${base}/${w.id}/discussion/${rootId}/replies`,
          command,
          b,
        );
        ok(r);
        replyId = r.body.commentId;
        const notices = await get('/v2/me/major-discussion/notices');
        ok(notices);
        const notice = notices.body.items.find(
          (n: { kind: string }) => n.kind === 'reply',
        );
        assert.equal(notice.target.commentId, rootId);
        assert.equal(notice.preview.thumbnail.commentId, replyId);
        assert.equal(notice.preview.thumbnail.ordinal, 0);
        const like = await post(
          `/v1/majors/${w.id}/discussion/${replyId}/like`,
          f.like(catalog, w),
        );
        ok(like);
        const liked = await get('/v2/me/major-discussion/notices', b);
        ok(liked);
        assert.equal(
          liked.body.items.find((n: { kind: string }) => n.kind === 'like')
            .preview.thumbnail,
          null,
        );
      },
    );
    await t.test(
      'held sibling closes first descriptor, body, count and dependent replies without retirement',
      async () => {
        const directory = await get('/v1/majors?limit=1');
        ok(directory);
        assert.ok(directory.body.nextCursor);
        await safety(two.fact.assetId, 'held');
        const continued = await get(
          '/v1/majors?limit=1&cursor=' +
            encodeURIComponent(directory.body.nextCursor),
        );
        assert.ok(continued.status >= 400);
        assert.equal(continued.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
        const directoryCurrent = await get('/v1/majors?limit=50');
        ok(directoryCurrent);
        const major = directoryCurrent.body.items.find(
          (item: { id: string }) => item.id === w.id,
        );
        assert.equal(major.summary.kind, 'known');
        assert.equal(major.summary.rootCount, 1);
        assert.notEqual(major.summary.hotComment?.id, rootId);
        const page = await get(`${base}/${w.id}/discussion`);
        ok(page);
        assert.equal(page.body.totalCount, 1);
        assert.equal(
          page.body.items.some((x: { id: string }) => x.id === rootId),
          false,
        );
        ok(await get(`${base}/${w.id}/discussion/${rootId}`), 404);
        ok(await get(path(references[0]!)), 503);
        ok(
          await post(
            `/v1/majors/${w.id}/discussion/${rootId}/like`,
            f.like(catalog, w),
            b,
          ),
          404,
        );
        const notices = await get('/v2/me/major-discussion/notices');
        ok(notices);
        assert.equal(
          notices.body.items.every(
            (n: { status: string }) => n.status === 'unavailable',
          ),
          true,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) AND detached_at IS NULL',
              [q.images.map((i) => i.assetId)],
            )
          ).rows[0]!.n,
          2,
        );
        await safety(two.fact.assetId, 'allow');
        ok(await get(path(references[0]!)));
      },
    );
    await t.test(
      'current phone denial closes descriptors and bytes while the owning original receipt remains recoverable',
      async () => {
        await f.certify(a.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        for (const route of [
          path(references[0]!),
          path(references[0]!, 'display-v1'),
        ]) {
          const denied = await get(route);
          ok(denied, 403);
          assert.equal(denied.body.error.code, 'PHONE_VERIFICATION_REQUIRED');
        }
        ok(await get(`${base}/discussion-requests/${q.clientRequestId}`));
        await f.certify(a.accountId, { identity: false });
        ok(await get(path(references[0]!)));
      },
    );
    await t.test(
      'post-storage-open sibling hold prevents the first byte',
      async () => {
        const original = f.storage.openExact.bind(f.storage);
        let reached!: () => void,
          release!: () => void,
          byteCount = 0;
        const entered = new Promise<void>((resolve) => {
            reached = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        let quiet = Promise.resolve();
        f.storage.openExact = async (...args) => {
          const value = await original(...args);
          quiet = finished(value.stream).catch(() => undefined);
          value.stream.on('data', (chunk: Buffer) => {
            byteCount += chunk.length;
          });
          value.stream.pause();
          reached();
          await gate;
          return value;
        };
        const pending = get(path(references[0]!, 'display-v1')).then((r) => r);
        await Promise.race([
          entered,
          pending.then((r) => assert.fail(JSON.stringify(r.body))),
        ]);
        try {
          await safety(two.fact.assetId, 'held');
        } finally {
          release();
        }
        const r = await pending;
        await quiet;
        f.storage.openExact = original;
        ok(r, 503);
        assert.equal(byteCount, 0);
        await safety(two.fact.assetId, 'allow');
      },
    );
    for (const change of [
      'catalog-aba',
      'media-zero-row',
      'campus-zero-row',
    ] as const)
      await t.test(
        `post-open ${change} invalidates a previously allowed plan even after values look unchanged`,
        async () => {
          const original = f.storage.openExact.bind(f.storage);
          let entered!: () => void,
            release!: () => void,
            count = 0;
          const reached = new Promise<void>((resolve) => (entered = resolve)),
            gate = new Promise<void>((resolve) => (release = resolve));
          let quiet = Promise.resolve();
          f.storage.openExact = async (...args) => {
            const value = await original(...args);
            quiet = finished(value.stream).catch(() => undefined);
            value.stream.on('data', (chunk: Buffer) => (count += chunk.length));
            value.stream.pause();
            entered();
            await gate;
            return value;
          };
          const pending = get(path(references[0]!, 'display-v1')).then(
            (r) => r,
          );
          try {
            await Promise.race([
              reached,
              pending.then((r) => assert.fail(JSON.stringify(r.body))),
            ]);
            if (change === 'catalog-aba') {
              await f.pool.query(
                "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
              );
              await f.pool.query(
                "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
              );
            } else
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  change === 'media-zero-row'
                    ? 'UPDATE whaleu_media.major_discussion_scopes SET id=id WHERE false'
                    : 'UPDATE whaleu_campus.campuses SET id=id WHERE false',
                ),
              );
          } finally {
            release();
            f.storage.openExact = original;
          }
          const response = await pending;
          await quiet;
          ok(response, 503);
          assert.equal(count, 0);
          ok(await get(path(references[0]!)));
        },
      );
    await t.test(
      'Review revocation closes the whole publication and is reversible evidence, never image deletion',
      async () => {
        await f.pool.query(
          "UPDATE whaleu_community.major_discussion_media_review_heads SET state='revoked' WHERE decision_id=$1",
          [review],
        );
        ok(await get(path(references[0]!)), 503);
        ok(await get(`${base}/discussion-requests/${q.clientRequestId}`));
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1',
              [rootId],
            )
          ).rows[0]!.n,
          2,
        );
        await f.pool.query(
          "UPDATE whaleu_community.major_discussion_media_review_heads SET state='active' WHERE decision_id=$1",
          [review],
        );
      },
    );
    await t.test(
      'partial bindings roll back publication and the original key later publishes text plus ordered images exactly once',
      async () => {
        const command: MajorRootPublishV2 = {
          ...q,
          clientRequestId: randomUUID(),
          body: 'Exact text + pictures',
          images: [],
        };
        const first = await readyMajorDiscussionImage(
            f,
            a,
            {
              ...context,
              publicationRequestId: command.clientRequestId,
              ordinal: 0,
            },
            bytes,
          ),
          second = await readyMajorDiscussionImage(
            f,
            a,
            {
              ...context,
              publicationRequestId: command.clientRequestId,
              ordinal: 1,
            },
            bytes,
          );
        command.images = [first.fact, second.fact];
        await reviewMajorDiscussionV2(f.pool, a.accountId, w.id, command);
        const media = f.app.get(MajorDiscussionMediaService),
          original = media.acceptAndBind.bind(media);
        media.acceptAndBind = (id, actor, scope, images, tx) =>
          original(id, actor, scope, images.slice(0, 1), tx);
        try {
          const failed = await post(`${base}/${w.id}/discussion`, command);
          assert.notEqual(failed.status, 200);
        } finally {
          media.acceptAndBind = original;
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_majors.major_discussion_commands WHERE actor_id=$1 AND request_id=$2',
              [a.accountId, command.clientRequestId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
              [command.images.map((image) => image.assetId)],
            )
          ).rowCount,
          0,
        );
        const outcomes = await Promise.all([
          post(`${base}/${w.id}/discussion`, command),
          post(`${base}/${w.id}/discussion`, command),
        ]);
        for (const response of outcomes) ok(response);
        assert.deepEqual(outcomes[0]!.body, outcomes[1]!.body);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE actor_id=$1 AND request_id=$2',
              [a.accountId, command.clientRequestId],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
              [command.images.map((image) => image.assetId)],
            )
          ).rowCount,
          2,
        );
      },
    );
    for (const change of ['zero-row', 'aba'] as const)
      await t.test(
        `Review ${change} committed after consume cannot be forgotten by a later publication epoch capture`,
        async () => {
          const command: MajorRootPublishV2 = {
            ...q,
            clientRequestId: randomUUID(),
            images: [],
          };
          const ready = await readyMajorDiscussionImage(
            f,
            a,
            {
              ...context,
              publicationRequestId: command.clientRequestId,
              ordinal: 0,
            },
            bytes,
          );
          command.images = [ready.fact];
          const decision = await reviewMajorDiscussionV2(
            f.pool,
            a.accountId,
            w.id,
            command,
          );
          const facade = f.app.get(MajorDiscussionMediaReviewFacade),
            original = facade.consume.bind(facade);
          let entered!: () => void, release!: () => void;
          const reached = new Promise<void>((resolve) => (entered = resolve)),
            gate = new Promise<void>((resolve) => (release = resolve));
          facade.consume = async (envelope, tx) => {
            const value = await original(envelope, tx);
            if (envelope.requestId === command.clientRequestId) {
              entered();
              await gate;
            }
            return value;
          };
          const pending = post(`${base}/${w.id}/discussion`, command).then(
            (r) => r,
          );
          try {
            await Promise.race([
              reached,
              pending.then((r) => assert.fail(JSON.stringify(r.body))),
            ]);
            if (change === 'zero-row')
              await f.pool.query(
                'UPDATE whaleu_community.major_discussion_media_review_heads SET state=state WHERE false',
              );
            else {
              await f.pool.query(
                "UPDATE whaleu_community.major_discussion_media_review_heads SET state='revoked' WHERE decision_id=$1",
                [decision],
              );
              await f.pool.query(
                "UPDATE whaleu_community.major_discussion_media_review_heads SET state='active' WHERE decision_id=$1",
                [decision],
              );
            }
          } finally {
            facade.consume = original;
            release();
          }
          const result = await pending;
          ok(result, 503);
          assert.equal(result.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
          for (const table of ['comments', 'commands'])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_majors.major_discussion_${table} WHERE actor_id=$1 AND request_id=$2`,
                  [a.accountId, command.clientRequestId],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [ready.fact.assetId],
              )
            ).rowCount,
            0,
          );
          ok(await post(`${base}/${w.id}/discussion`, command));
        },
      );
    await t.test(
      'unbound original-key cancel creates cleanup obligations; bound source history cannot be detached',
      async () => {
        const requestId = randomUUID(),
          ready = await readyMajorDiscussionImage(
            f,
            a,
            { ...context, publicationRequestId: requestId, ordinal: 0 },
            bytes,
          );
        ok(
          await post(`${base}/discussion-requests/${requestId}/cancel`, {
            protocol: MAJOR_DISCUSSION_V2,
            operation: 'major.discussion.root.v2',
            majorId: w.id,
            intentHash: null,
          }),
        );
        const cancelled = await post(
          `${majorMediaPrefix}/upload-intents/${ready.status.intentId}/cancel`,
          {},
        );
        ok(cancelled);
        assert.equal(cancelled.body.status, 'terminal');
        assert.equal(cancelled.body.reason, 'cancelled');
        assert.notEqual(cancelled.body.cleanup, 'confirmed');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [ready.fact.assetId],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_media.bindings SET detached_at=clock_timestamp() WHERE asset_id=$1',
              [one.fact.assetId],
            ),
          ),
          (error: unknown) =>
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === '23514',
        );
        ok(await get(path(references[0]!)));
      },
    );
    await t.test(
      'metadata-only cancellation fences late original publication and survives source loss',
      async () => {
        const cancelled = {
          ...q,
          clientRequestId: randomUUID(),
          body: 'cancelled',
          images: [],
        };
        const r = await post(
          `${base}/discussion-requests/${cancelled.clientRequestId}/cancel`,
          {
            protocol: MAJOR_DISCUSSION_V2,
            operation: 'major.discussion.root.v2',
            majorId: w.id,
            intentHash: null,
          },
        );
        ok(r);
        const late = await post(`${base}/${w.id}/discussion`, cancelled);
        ok(late);
        assert.deepEqual(late.body, r.body);
        await f.accept([{ ...w, active: false }, foreign]);
        ok(await get(`${base}/${w.id}/discussion`), 404);
        ok(await get(path(references[0]!)), 404);
        const receipt = await get(
          `${base}/discussion-requests/${q.clientRequestId}`,
        );
        ok(receipt);
        assert.equal(receipt.body.commentId, rootId);
        const hash = majorDiscussionIntentHashV2(
          a.accountId,
          w.id,
          null,
          'major.discussion.root.v2',
          q,
        );
        const bound = await post(
          `${base}/discussion-requests/${q.clientRequestId}/cancel`,
          {
            protocol: MAJOR_DISCUSSION_V2,
            operation: 'major.discussion.root.v2',
            majorId: w.id,
            intentHash: hash,
          },
        );
        ok(bound);
        assert.equal(bound.body.outcome, 'applied');
        for (const mismatch of [
          { majorId: foreign.id, operation: 'major.discussion.root.v2' },
          {
            majorId: w.id,
            operation: 'major.discussion.reply.v2',
            rootId,
          },
        ]) {
          const conflict = await post(
            `${base}/discussion-requests/${q.clientRequestId}/cancel`,
            {
              protocol: MAJOR_DISCUSSION_V2,
              ...mismatch,
              intentHash: hash,
            },
          );
          ok(conflict, 409);
          assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) AND detached_at IS NULL',
              [q.images.map((i) => i.assetId)],
            )
          ).rows[0]!.n,
          2,
        );
      },
    );
  },
);
