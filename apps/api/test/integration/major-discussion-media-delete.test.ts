import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { finished } from 'node:stream/promises';
import sharp from 'sharp';
import request from 'supertest';
import { MajorDiscussionNoticeOwner } from '../../src/notifications/major-discussion/owner.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { MAJOR_DISCUSSION_V2 } from '../../src/majors/discussion/contracts-v2.js';
import type {
  MajorRootPublishV2,
  MajorReplyPublishV2,
} from '../../src/majors/discussion/contracts-v2.js';
import {
  majorDiscussionMediaFixture,
  readyMajorDiscussionImage,
  reviewMajorDiscussionV2,
  majorMediaOk as ok,
  majorMediaPrefix,
} from '../support/major-discussion-media-fixture.js';

test(
  'Major Media17 composes withdrawal with full-set delivery, addressed references and actual concurrent writers',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 18, height: 11, channels: 3, background: '#336699' },
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
      catalog = await f.accept([w]);
    await f.acceptDiscussion([w.id]);
    const http = f.app.getHttpServer();
    const post = (path: string, body: object, actor = a) =>
      request(http)
        .post(path)
        .set('Authorization', 'Bearer ' + actor.accessToken)
        .send(body);
    const get = (path: string, actor = a) =>
      request(http)
        .get(path)
        .set('Authorization', 'Bearer ' + actor.accessToken);
    const del = (id: string, rootId: string | null = null, actor = a) =>
      post(
        `/v1/majors/${w.id}/discussion/${id}/delete`,
        { clientRequestId: randomUUID(), rootId },
        actor,
      );
    const prepare = async (
      actor = a,
      rootId: string | null = null,
      target: string | null = null,
    ) => {
      const command: MajorRootPublishV2 | MajorReplyPublishV2 = {
        protocol: MAJOR_DISCUSSION_V2,
        clientRequestId: randomUUID(),
        expectedCatalogRevision: catalog,
        expectedMajorRevision: w.revision,
        body: 'Major text remains required',
        images: [],
        ...(rootId ? { replyToReplyId: target } : {}),
      };
      const image = await readyMajorDiscussionImage(
        f,
        actor,
        {
          publicationRequestId: command.clientRequestId,
          majorId: w.id,
          catalogRevision: catalog,
          majorRevision: w.revision,
          rootId,
          replyToReplyId: target,
          ordinal: 0,
        },
        bytes,
      );
      command.images = [image.fact];
      const review = await reviewMajorDiscussionV2(
        f.pool,
        actor.accountId,
        w.id,
        command,
        rootId,
      );
      return {
        command,
        image,
        review,
        route: `/v2/majors/${w.id}/discussion${rootId ? `/${rootId}/replies` : ''}`,
      };
    };
    const publish = async (
      actor = a,
      rootId: string | null = null,
      target: string | null = null,
    ) => {
      const draft = await prepare(actor, rootId, target),
        response = await post(draft.route, draft.command, actor);
      ok(response);
      const id = response.body.commentId as string;
      const appearance = (
        await f.pool.query<{ binding_id: string }>(
          'SELECT binding_id FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1',
          [id],
        )
      ).rows[0]!;
      const path = `${majorMediaPrefix}/majors/${w.id}/comments/${id}/bindings/${appearance.binding_id}`;
      return {
        ...draft,
        id,
        receipt: response.body,
        descriptor: path + '?ordinal=0',
        bytesPath: path + '/display-v1?ordinal=0',
      };
    };
    await t.test(
      'HTTP root/reply image-only and whitespace text cannot publish; addressed deletion preserves another author images',
      async () => {
        const root = await publish(),
          addressed = await publish(a, root.id),
          survivor = await publish(b, root.id, addressed.id);
        for (const body of ['', ' ', '\u3000']) {
          ok(
            await post(root.route, {
              ...root.command,
              clientRequestId: randomUUID(),
              body,
            }),
            400,
          );
          ok(
            await post(
              survivor.route,
              { ...survivor.command, clientRequestId: randomUUID(), body },
              b,
            ),
            400,
          );
        }
        ok(await del(addressed.id, root.id));
        ok(await get(addressed.descriptor), 503);
        ok(await get(survivor.descriptor));
        ok(await get(survivor.bytesPath));
        const page = await get(`/v2/majors/${w.id}/discussion/${root.id}`);
        ok(page);
        const visible = page.body.items.find(
          (v: { id: string }) => v.id === survivor.id,
        );
        assert.equal(visible.replyToReplyId, null);
        assert.equal(visible.addressedAuthor, null);
        assert.equal(visible.images.length, 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
              [survivor.image.fact.assetId],
            )
          ).rowCount,
          1,
        );
      },
    );
    for (const ancestor of [false, true])
      await t.test(
        `storage-open ${ancestor ? 'root ancestor' : 'subject'} deletion returns zero bytes and retains immutable images`,
        async () => {
          const root = await publish(),
            subject = ancestor ? await publish(b, root.id) : root;
          ok(await get(subject.descriptor));
          const open = f.storage.openExact.bind(f.storage);
          let entered!: () => void,
            release!: () => void,
            count = 0,
            quiet = Promise.resolve();
          const reached = new Promise<void>((r) => {
              entered = r;
            }),
            gate = new Promise<void>((r) => {
              release = r;
            });
          f.storage.openExact = async (...args) => {
            const value = await open(...args);
            quiet = finished(value.stream).catch(() => undefined);
            value.stream.on('data', (v: Buffer) => {
              count += v.length;
            });
            value.stream.pause();
            entered();
            await gate;
            return value;
          };
          const pending = get(subject.bytesPath).then((r) => r);
          try {
            await Promise.race([
              reached,
              pending.then((r) =>
                assert.fail(
                  'Expected paused storage: ' + JSON.stringify(r.body),
                ),
              ),
            ]);
            ok(await del(root.id));
          } finally {
            release();
            f.storage.openExact = open;
          }
          ok(await pending, 503);
          await quiet;
          assert.equal(count, 0);
          ok(await get(subject.descriptor), 503);
          ok(
            await get(
              `/v2/majors/discussion-requests/${subject.command.clientRequestId}`,
              ancestor ? b : a,
            ),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
                [subject.image.fact.assetId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE variant_name IN('thumb-v1','display-v1') AND asset_id=$1",
                [subject.image.fact.assetId],
              )
            ).rowCount,
            0,
          );
        },
      );
    await t.test(
      'existing positive-like membership can be withdrawn after root deletion and source/Review loss',
      async () => {
        const root = await publish();
        const liked = await post(
          `/v1/majors/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w),
          b,
        );
        ok(liked);
        ok(await del(root.id));
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
        );
        await f.pool.query(
          "UPDATE whaleu_community.major_discussion_media_review_heads SET state='revoked' WHERE decision_id=$1",
          [root.review],
        );
        try {
          ok(
            await post(
              `/v1/majors/${w.id}/discussion/${root.id}/like`,
              f.like(catalog, w, false, liked.body.membershipRevision),
              b,
            ),
          );
          ok(
            await get(
              `/v2/majors/discussion-requests/${root.command.clientRequestId}`,
            ),
          );
          ok(await del(root.id));
        } finally {
          await f.pool.query(
            "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
          );
        }
      },
    );
    for (const kind of ['reply', 'like'] as const)
      await t.test(
        `actual concurrent ${kind} and root withdrawal preserve serialized visibility without deadlock`,
        async () => {
          const root = await publish();
          const draft = kind === 'reply' ? await prepare(b, root.id) : null;
          const command = draft?.command ?? f.like(catalog, w),
            route =
              draft?.route ?? `/v1/majors/${w.id}/discussion/${root.id}/like`;
          const notices = f.app.get(MajorDiscussionNoticeOwner),
            capture = notices.capture.bind(notices);
          let entered!: () => void, release!: () => void;
          const reached = new Promise<void>((r) => {
              entered = r;
            }),
            gate = new Promise<void>((r) => {
              release = r;
            });
          notices.capture = async (...args) => {
            await capture(...args);
            if (args[1] === command.clientRequestId) {
              entered();
              await gate;
            }
          };
          const deadlocks = async () =>
            (
              await f.pool.query<{ n: string }>(
                'SELECT deadlocks::text n FROM pg_stat_database WHERE datname=current_database()',
              )
            ).rows[0]!.n;
          const before = await deadlocks();
          const pending = post(route, command, b).then((r) => r);
          let deleting: Promise<request.Response> | undefined;
          try {
            await Promise.race([
              reached,
              pending.then((r) => assert.fail(JSON.stringify(r.body))),
            ]);
            deleting = del(root.id).then((r) => r);
            await f.waitForLock(
              kind === 'reply'
                ? "pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1'"
                : 'INSERT INTO whaleu_majors.major_discussion_tombstones',
            );
            release();
            const [mutation, deleted] = await Promise.all([pending, deleting]);
            ok(deleted);
            ok(mutation, kind === 'reply' ? 200 : 503);
            assert.equal(await deadlocks(), before);
            ok(await get(root.descriptor), 503);
            if (kind === 'reply') {
              const thread = await get(
                `/v2/majors/${w.id}/discussion/${root.id}`,
              );
              ok(thread, 404);
              assert.equal(
                thread.body.error.code,
                'MAJOR_DISCUSSION_NOT_FOUND',
              );
              ok(
                await get(
                  `/v2/majors/discussion-requests/${command.clientRequestId}`,
                  b,
                ),
              );
            }
          } finally {
            release();
            notices.capture = capture;
            await pending;
            if (deleting) await deleting;
          }
        },
      );
  },
);
