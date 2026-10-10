/** Static acceptance source. Execute only with the exclusive heavy-test lease.
 * Both owners and their two authorization transactions are real AppModule
 * services. Only disposable storage, catalog and Review evidence are synthetic.
 * No test occupies a budget slot by calling acquire as a substitute for an owner.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { configureHttp } from '../../src/http/http.js';
import {
  MEDIA_POLICY_VERSION,
  MEDIA_TRANSFORM_VERSION,
  mediaManifestSchema,
  type ExactObject,
} from '../../src/media/contracts.js';
import {
  ratingsDiscussionMemberRecoverySchema,
  type RatingsDiscussionMediaDescriptor,
} from '../../src/media/contracts-ratings-discussion.js';
import type { AuthorizedMediaStream } from '../../src/media/delivery.js';
import { MediaDeliveryBudgetPool } from '../../src/media/delivery-budget.js';
import { sealManifest } from '../../src/media/manifest.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import type { ImmutableMediaStorage } from '../../src/media/storage-port.js';
import { ProfileAvatarCatalog } from '../../src/profile/avatar/catalog.js';
import { avatarCommandSchema } from '../../src/profile/avatar/contracts.js';
import { ProfileAvatarDelivery } from '../../src/profile/avatar/delivery.js';
import { avatarAppearanceId } from '../../src/profile/avatar/repository.js';
import { avatarCurrentSchema } from '../../src/profile/avatar/selection-contract.js';
import {
  PROFILE_AVATAR_RUNTIME,
  ProfileAvatarService,
} from '../../src/profile/avatar/service.js';
import {
  RATINGS_DISCUSSION_MEDIA_RUNTIME,
  RatingDiscussionMediaService,
} from '../../src/ratings/discussion-media.service.js';
import { ratingDiscussionMediaRootSchema } from '../../src/ratings/discussion-media-projection-contracts.js';
import { observeRatingsCiQueries } from '../support/ratings-ci-diagnostics.js';
import { seedReviewPolicy } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { approveProfileAvatar } from '../support/media/profile-runtime-fixture.js';
import {
  discussionHttpOk,
  syntheticRatingDiscussionFixture,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { SyntheticMediaIngressStorage } from '../support/media/synthetic-ingress-storage.js';

function closed(stream: Readable): Promise<void> {
  return stream.closed
    ? Promise.resolve()
    : new Promise((resolve) => stream.once('close', resolve));
}

interface HeldSource {
  readonly input: Readable;
  readonly stream: PassThrough;
  readonly quiet: Promise<void>;
  release(): void;
}

/** Opens the genuine immutable file, then gates its bytes outside SQL. Abort
 * closes that file before the delivery-visible source emits close, so observed
 * budget recovery cannot race outstanding provider I/O. */
class HeldDeliveryStorage implements ImmutableMediaStorage {
  readonly held: HeldSource[] = [];
  hold = false;
  opens = 0;

  constructor(private readonly underlying: ImmutableMediaStorage) {}

  get provider() {
    return this.underlying.provider;
  }
  get environment() {
    return this.underlying.environment;
  }
  seal(source: ExactObject, destination: ExactObject) {
    return this.underlying.seal(source, destination);
  }
  deleteExact(object: ExactObject) {
    return this.underlying.deleteExact(object);
  }
  async openExact(object: ExactObject, maximumBytes: number) {
    this.opens++;
    const opened = await this.underlying.openExact(object, maximumBytes);
    if (!this.hold) return opened;
    opened.stream.pause();
    const sourceQuiet = closed(opened.stream);
    const stream = new PassThrough({
      destroy(error, done) {
        opened.stream.destroy();
        void sourceQuiet.then(() => done(error));
      },
    });
    opened.stream.on('error', (error) => stream.destroy(error));
    // A failed authorization can destroy this source before any controller owns it.
    stream.on('error', () => {});
    let released = false;
    this.held.push({
      input: opened.stream,
      stream,
      quiet: closed(stream),
      release() {
        if (released || stream.destroyed) return;
        released = true;
        opened.stream.pipe(stream);
      },
    });
    return { stream, bytes: opened.bytes };
  }
  async closeAll() {
    for (const source of this.held) source.stream.destroy();
    await Promise.all(this.held.map((source) => source.quiet));
  }
}

/** Observe the injected production implementation without changing its limits,
 * keys or release decisions. Every acquisition still comes from real delivery. */
function observeBudget(pool: MediaDeliveryBudgetPool) {
  const original = pool.acquire;
  const active = new Map<string, number>();
  const acquisitions: string[] = [];
  pool.acquire = (key) => {
    const release = original.call(pool, key);
    acquisitions.push(key);
    active.set(key, (active.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      release();
      if (released) return;
      released = true;
      const remaining = active.get(key)! - 1;
      if (remaining) active.set(key, remaining);
      else active.delete(key);
    };
  };
  return {
    acquisitions,
    count: (key: string) => active.get(key) ?? 0,
    total: () => [...active.values()].reduce((sum, value) => sum + value, 0),
    restore: () => {
      pool.acquire = original;
    },
  };
}

function imageQuery(image: RatingsDiscussionMediaDescriptor) {
  return {
    protocol: image.protocol,
    targetId: image.targetId,
    rootId: image.rootId,
    replyId: image.replyId ?? 'null',
    subjectRevision: image.subjectRevision,
    contextId: image.contextId,
    contextToken: image.contextToken,
    bindingId: image.bindingId,
    ordinal: image.ordinal,
    attachmentSetDigest: image.attachmentSetDigest,
    variant: 'display-v1',
  };
}

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE';

test(
  'real Profile and Ratings discussion share account2/server64 delivery credits while root9 remains whole-set authorized',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 48, height: 36, channels: 3, background: '#486b9a' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    const diagnostics = observeRatingsCiQueries(f.app, {
      syntheticFixture: 'ratings-discussion-shared-delivery',
      enabled: process.env['WHALEU_RATINGS_CI_DIAGNOSTICS'] === '1',
    });
    t.after(() => {
      diagnostics.restore();
      if (diagnostics.enabled)
        t.diagnostic(JSON.stringify(diagnostics.snapshot()));
    });
    const resources: {
      app?: INestApplication;
      budget?: ReturnType<typeof observeBudget>;
    } = {};
    const storage = new HeldDeliveryStorage(f.storage);
    const active = new Set<AuthorizedMediaStream>();
    const sockets: Socket[] = [];
    const abort = async (delivery: AuthorizedMediaStream) => {
      const quiet = closed(delivery.stream);
      delivery.abort();
      await quiet;
      // An output can close before the underlying file. Wait for source closure too.
      await Promise.all(
        storage.held
          .filter((source) => source.stream.destroyed)
          .map((source) => source.quiet),
      );
    };
    const abortAll = async () => {
      await Promise.all([...active].map(abort));
      await storage.closeAll();
    };
    t.after(async () => {
      try {
        await abortAll();
      } finally {
        resources.budget?.restore();
        for (const socket of sockets) socket.destroy();
        try {
          await resources.app?.close();
        } finally {
          await f.close();
        }
      }
    });

    assert.equal(f.baseApp.get(RatingDiscussionMediaService).runtime, null);
    assert.equal(f.baseApp.get(ProfileAvatarService).runtime, null);
    const pool = f.app.get(MediaDeliveryBudgetPool);
    const ingressStorage = new SyntheticMediaIngressStorage(f.storage);
    const catalogVersion = 'synthetic-ratings-discussion-shared-delivery';
    const module = await Test.createTestingModule({
      imports: [AppModule.register(f.app.get<RuntimeConfig>(APP_CONFIG))],
    })
      .overrideProvider(MediaDeliveryBudgetPool)
      .useValue(pool)
      .overrideProvider(RATINGS_DISCUSSION_MEDIA_RUNTIME)
      .useValue({ planning: ingressStorage, storage, ingressStorage })
      .overrideProvider(PROFILE_AVATAR_RUNTIME)
      .useValue({
        planning: ingressStorage,
        storage,
        ingressStorage,
        catalog: new ProfileAvatarCatalog(catalogVersion),
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    resources.app = app;
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    assert.equal(app.get(MediaDeliveryBudgetPool), pool);
    const http = app.getHttpServer();
    const discussion = app.get(RatingDiscussionMediaService);
    const profile = app.get(ProfileAvatarService);
    const profileDelivery = app.get(ProfileAvatarDelivery);
    assert.ok(discussion.delivery);

    const author = f.creator;
    const otherSession = await f.freshSession(author);
    assert.equal(otherSession.accountId, author.accountId);
    assert.notEqual(otherSession.sessionId, author.sessionId);
    const viewers: Awaited<ReturnType<typeof f.actor>>[] = [];
    for (let index = 0; index < 32; index++) viewers.push(await f.actor());
    assert.equal(new Set(viewers.map((viewer) => viewer.accountId)).size, 32);
    assert.ok(viewers.every((viewer) => viewer.accountId !== author.accountId));
    const draft = await f.draft(author);
    let setupRecoveries = 0;
    // This is exclusively the delivery-budget fixture's uploaded prerequisite.
    // At most one original-key recovery across all nine members, only after a
    // proved rolled-back RATING_UNAVAILABLE. Never reuse as a generic retry.
    // The separate maintenance-recovery regression always forces/asserts 503.
    const upload = await f.ready(
      author,
      draft,
      Array.from({ length: 9 }, () => png),
      '',
      undefined,
      async (memberId, sendOriginal) => {
        const snapshot = async () =>
          (
            await f.pool.query<{
              identity: {
                intentId: string;
                requestId: string;
                requestHash: string;
                expectedHash: string;
                batchId: string;
                generation: number;
                state: string;
                writerState: string;
              };
              state: unknown;
              jobs: number;
              assets: number;
              requests: number;
              comments: number;
            }>(
              `SELECT jsonb_build_object('intentId',i.id,'requestId',m.client_request_id,
          'requestHash',i.request_hash,'expectedHash',whaleu_media.ratings_discussion_member_hash(m.actor_id,m.input),
          'batchId',m.batch_id,'generation',i.generation,'state',i.state,'writerState',g.writer_state) identity,
          jsonb_build_object('member',to_jsonb(m),'intent',to_jsonb(i),'ingress',to_jsonb(g),
            'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM whaleu_media.object_attempts a WHERE a.intent_id=i.id)) state,
          (SELECT count(*)::int FROM whaleu_media.jobs j WHERE j.intent_id=i.id) jobs,
          (SELECT count(*)::int FROM whaleu_media.assets a WHERE a.intent_id=i.id) assets,
          (SELECT count(*)::int FROM whaleu_ratings.requests r WHERE r.account_id=m.actor_id AND r.request_id=$2) requests,
          (SELECT count(*)::int FROM whaleu_ratings.comments c WHERE c.account_id=m.actor_id AND c.request_id=$2) comments
          FROM whaleu_media.ratings_discussion_members m JOIN whaleu_media.upload_intents i ON i.id=m.intent_id
          JOIN whaleu_media.upload_ingress g ON g.intent_id=i.id WHERE m.member_id=$1`,
              [memberId, draft.payload.clientRequestId],
            )
          ).rows[0]!;
        const before = await snapshot();
        const first = await sendOriginal();
        if (
          first.status !== 503 ||
          first.body.error?.code !== 'RATING_UNAVAILABLE'
        )
          return first;
        t.diagnostic(
          JSON.stringify({
            stage: 'budget-setup-finalize-first-failure',
            status: first.status,
            code: first.body.error.code,
            recoveryUsed: setupRecoveries,
          }),
        );
        assert.equal(
          setupRecoveries++,
          0,
          'only one explicit original-key recovery is allowed for this entire setup',
        );
        const after = await snapshot();
        assert.deepEqual(
          after,
          before,
          'failed finalize must leave the original uploaded prerequisite unchanged',
        );
        assert.equal(after.identity.state, 'prepared');
        assert.equal(after.identity.writerState, 'observed');
        assert.equal(after.identity.requestHash, after.identity.expectedHash);
        for (const key of ['jobs', 'assets', 'requests', 'comments'] as const)
          assert.equal(after[key], 0, key);
        const recovered = await f.auth(
          request(f.http).get(
            `/v3/media/ratings-discussion/upload-requests/${after.identity.requestId}`,
          ),
          author,
        );
        discussionHttpOk(recovered);
        const record = ratingsDiscussionMemberRecoverySchema.parse(
          recovered.body,
        );
        assert.equal(record.state, 'recorded');
        if (record.state !== 'recorded')
          assert.fail('original upload recovery missing');
        assert.equal(record.requestHash, after.identity.requestHash);
        assert.equal(record.status.status, 'uploaded');
        assert.equal(record.status.memberId, memberId);
        assert.equal(record.status.intentId, after.identity.intentId);
        assert.equal(record.status.batchId, after.identity.batchId);
        assert.deepEqual(
          await snapshot(),
          after,
          'recovery retains the original generation and uploaded state',
        );
        const second = await sendOriginal();
        discussionHttpOk(second); // A second failure is terminal; no loop or new identity.
        t.diagnostic(
          JSON.stringify({
            stage: 'budget-setup-original-key-recovered',
            unchangedSnapshot: true,
            noEffects: true,
            status: second.status,
            recoveries: setupRecoveries,
          }),
        );
        return second;
      },
    );
    const publication = await f.execute(author, upload.intent);
    if (publication.receipt.operation !== 'create_comment_scoped')
      assert.fail('root receipt');
    const rootId = publication.receipt.result.subjectId;
    const context = await f.context(author, 'read');
    const read = await f
      .auth(
        request(http).get(`/v4/ratings/discussion/comments/${rootId}`),
        author,
      )
      .query({ contextId: context.id, contextToken: context.token });
    discussionHttpOk(read);
    const root = ratingDiscussionMediaRootSchema.parse(read.body);
    assert.equal(root.body, '');
    assert.equal(root.images.length, 9);
    assert.deepEqual(
      root.images.map((image) => image.ordinal),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    const first = root.images[0]!;
    const last = root.images[8]!;
    const manifests = (
      await f.pool.query<{ asset_id: string; manifest: unknown }>(
        `SELECT b.asset_id,a.manifest FROM whaleu_media.bindings b
       JOIN whaleu_media.assets a ON a.id=b.asset_id
       WHERE b.owner_kind='ratings' AND b.resource_kind='rating_comment'
         AND b.resource_id=$1 AND b.detached_at IS NULL ORDER BY b.ordinal`,
        [rootId],
      )
    ).rows;
    assert.equal(manifests.length, 9);
    const variants = manifests.map(
      (row) => mediaManifestSchema.parse(row.manifest).variants[1],
    );
    const firstVariant = variants[0]!;

    // A genuine catalog asset is selected through Profile's original command,
    // exact Review envelope, CAS, current pointer and immutable receipt.
    const image = async () => ({
      ...(await f.storage.upload(png)),
      mime: 'image/png' as const,
      width: 48,
      height: 36,
    });
    const catalog = sealManifest({
      version: 1,
      policyVersion: MEDIA_POLICY_VERSION,
      transformVersion: MEDIA_TRANSFORM_VERSION,
      original: await image(),
      variants: [
        { ...(await image()), name: 'thumb-v1' },
        { ...(await image()), name: 'display-v1' },
      ],
    });
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_profile.avatar_catalog_items
       (catalog_version,item_id,label,content_hash,manifest,available)
       VALUES($1,'shared-delivery','Synthetic real Profile owner',$2,$3::jsonb,true)`,
        [catalogVersion, catalog.digest, JSON.stringify(catalog.manifest)],
      ),
    );
    await seedReviewPolicy(f.pool);
    const current = await profile.ownCurrent(author.accessToken);
    assert.equal(current.avatar.state, 'none');
    const command = avatarCommandSchema.parse({
      protocol: 'profile-media-v1',
      clientRequestId: randomUUID(),
      expectedRevision: current.revision,
      source: { kind: 'catalog', catalogVersion, itemId: 'shared-delivery' },
    });
    await approveProfileAvatar(f.pool, {
      version: 1,
      purpose: 'select_profile_avatar',
      accountId: author.accountId,
      clientRequestId: command.clientRequestId,
      expectedRevision: command.expectedRevision,
      appearanceId: avatarAppearanceId(
        author.accountId,
        command.clientRequestId,
      ),
      previousAppearanceId: null,
      slot: 'avatar',
      source: {
        kind: 'catalog',
        catalogVersion,
        itemId: 'shared-delivery',
        contentHash: catalog.digest,
      },
    });
    discussionHttpOk(
      await f
        .auth(request(http).post('/v1/me/profile/avatar-commands'), author)
        .send(command),
    );
    const selected = avatarCurrentSchema.parse(
      await profile.ownCurrent(author.accessToken),
    );
    assert.ok(selected.profileId);
    if (selected.avatar.state !== 'available')
      assert.fail('real selected avatar');
    const profileId = selected.profileId;
    const appearanceId = selected.avatar.appearanceId;
    const profilePath = `/v1/profiles/${profileId}/avatar/${appearanceId}/display-v1`;

    const track = (delivery: AuthorizedMediaStream) => {
      active.add(delivery);
      delivery.stream.on('error', () => {});
      delivery.stream.once('close', () => active.delete(delivery));
      return delivery;
    };
    const openProfile = async (token: string) => {
      const socket = new Socket();
      sockets.push(socket);
      return track(
        await profileDelivery.open(
          token,
          profileId,
          appearanceId,
          'display-v1',
          socket,
        ),
      );
    };
    const openDiscussion = async (descriptor = first) =>
      track(
        await discussion.delivery!.open(
          author.accessToken,
          {
            targetId: descriptor.targetId,
            rootId: descriptor.rootId,
            replyId: descriptor.replyId,
            subjectRevision: descriptor.subjectRevision,
            contextId: descriptor.contextId,
            contextToken: descriptor.contextToken,
            attachmentSetDigest: descriptor.attachmentSetDigest,
            purpose: 'download',
            requestId: randomUUID(),
          },
          descriptor.bindingId,
          descriptor.ordinal,
          'display-v1',
        ),
      );
    const heldOpen = async (open: () => Promise<AuthorizedMediaStream>) => {
      const before = storage.held.length;
      const delivery = await open();
      assert.equal(storage.held.length, before + 1);
      assert.equal(storage.held[before]!.input.readableEnded, false);
      assert.equal(delivery.stream.readableEnded, false);
      return { delivery, source: storage.held[before]! };
    };
    const complete = async (held: Awaited<ReturnType<typeof heldOpen>>) => {
      const quiet = closed(held.delivery.stream);
      const chunks: Buffer[] = [];
      const readBytes = (async () => {
        for await (const chunk of held.delivery.stream)
          chunks.push(Buffer.from(chunk as Uint8Array));
      })();
      held.source.release();
      await readBytes;
      await Promise.all([quiet, held.source.quiet]);
      const bytes = Buffer.concat(chunks);
      assert.equal(
        bytes.length,
        Number(held.delivery.headers['Content-Length']),
      );
      return bytes;
    };

    await t.test(
      'both real download routes return exact bytes before budget contention',
      async () => {
        const avatar = await f.auth(
          request(http).get(profilePath),
          otherSession,
        );
        discussionHttpOk(avatar);
        assert.deepEqual(avatar.body, png);
        const image = await f
          .auth(
            request(http).get('/v3/media/ratings-discussion/images'),
            author,
          )
          .query(imageQuery(first));
        discussionHttpOk(image);
        assert.equal(sha256(image.body as Buffer), firstVariant.sha256);
        assert.equal(image.body.length, firstVariant.bytes);
        assert.equal(image.headers['cache-control'], 'private, no-store');
        assert.equal(avatar.headers['cache-control'], 'private, no-store');
      },
    );

    storage.hold = true;
    const observed = observeBudget(pool);
    resources.budget = observed;
    const accountKey = `account:${author.accountId}`;
    const wholeSets: string[][] = [];
    const authorizeCurrent = discussion.authorizeCurrent;
    discussion.authorizeCurrent = async (
      ...args: Parameters<typeof authorizeCurrent>
    ) => {
      const actual = await authorizeCurrent.apply(discussion, args);
      wholeSets.push(actual.images.map((image) => image.bindingId));
      return actual;
    };
    t.after(() => {
      discussion.authorizeCurrent = authorizeCurrent;
    });

    await t.test(
      'two sessions share account2 across Profile and root9; abort and completion restore credits',
      async () => {
        try {
          const avatar = await heldOpen(() =>
            openProfile(otherSession.accessToken),
          );
          assert.equal(observed.count(accountKey), 1);
          const secondAvatar = await heldOpen(() =>
            openProfile(author.accessToken),
          );
          assert.equal(observed.count(accountKey), 2);
          const fullAccountOpens = storage.opens;
          await assert.rejects(openDiscussion(), unavailable);
          assert.equal(
            storage.opens,
            fullAccountOpens,
            'two real Profile sessions already exhaust the account',
          );
          await abort(secondAvatar.delivery);
          assert.equal(observed.count(accountKey), 1);
          const acquiredBefore = observed.acquisitions.length;
          const setsBefore = wholeSets.length;
          const image = await heldOpen(() => openDiscussion());
          assert.equal(
            observed.acquisitions.length - acquiredBefore,
            1,
            'one download is one credit, not nine',
          );
          assert.equal(observed.count(accountKey), 2);
          assert.deepEqual(
            wholeSets.slice(setsBefore),
            [
              root.images.map((item) => item.bindingId),
              root.images.map((item) => item.bindingId),
            ],
            'both authorization transactions retain the complete ordered nine-image set',
          );
          const opens = storage.opens;
          await assert.rejects(openDiscussion(last), unavailable);
          await assert.rejects(openProfile(author.accessToken), unavailable);
          assert.equal(
            storage.opens,
            opens,
            'capacity rejects before provider open',
          );
          assert.equal(observed.total(), 2);

          await abort(avatar.delivery);
          assert.equal(observed.count(accountKey), 1);
          const recovered = await heldOpen(() => openDiscussion(last));
          assert.equal(
            observed.count(accountKey),
            2,
            'Profile abort restores a Ratings credit',
          );
          assert.equal(sha256(await complete(image)), firstVariant.sha256);
          assert.equal(
            observed.count(accountKey),
            1,
            'normal exact-byte completion restores one credit',
          );
          const profileRecovered = await heldOpen(() =>
            openProfile(otherSession.accessToken),
          );
          assert.equal(
            observed.count(accountKey),
            2,
            'Ratings completion restores a Profile credit',
          );
          assert.deepEqual(await complete(profileRecovered), png);
          await abort(recovered.delivery);
          assert.equal(observed.total(), 0);
        } finally {
          await abortAll();
        }
      },
    );

    await t.test(
      '64 actual Profile deliveries exhaust the shared server; the one freed credit admits one root9 image',
      async () => {
        try {
          assert.equal(observed.total(), 0);
          // Each real authenticated account reads through Profile owner/Safety/
          // Review twice. No guest keys, invented IDs or direct pool reservations.
          const sourcesBefore = storage.held.length;
          const pending = await Promise.allSettled(
            viewers.flatMap((viewer) => [
              openProfile(viewer.accessToken),
              openProfile(viewer.accessToken),
            ]),
          );
          for (const result of pending)
            if (result.status === 'rejected') throw result.reason;
          const profiles = pending.map((result) => {
            assert.equal(result.status, 'fulfilled');
            if (result.status !== 'fulfilled')
              assert.fail('authenticated Profile delivery');
            return result.value;
          });
          assert.equal(profiles.length, 64);
          assert.equal(storage.held.length - sourcesBefore, 64);
          for (const source of storage.held.slice(sourcesBefore)) {
            assert.equal(
              source.input.readableEnded,
              false,
              'provider source has not emitted its bytes',
            );
            assert.equal(source.stream.closed, false);
          }
          for (const viewer of viewers)
            assert.equal(observed.count(`account:${viewer.accountId}`), 2);
          assert.equal(observed.total(), 64);
          assert.equal(
            observed.count(accountKey),
            0,
            'the requested account is below its own limit',
          );
          const opens = storage.opens;
          await assert.rejects(openDiscussion(), unavailable);
          assert.equal(storage.opens, opens);

          await abort(profiles[0]!);
          assert.equal(observed.total(), 63);
          const acquiredBefore = observed.acquisitions.length;
          const image = await heldOpen(() => openDiscussion(last));
          assert.equal(observed.acquisitions.length - acquiredBefore, 1);
          assert.equal(
            observed.total(),
            64,
            'the nine-image set does not reserve nine delivery slots',
          );
          assert.equal(observed.count(accountKey), 1);
          await assert.rejects(openProfile(author.accessToken), unavailable);
          await assert.rejects(openDiscussion(), unavailable);
          await abort(image.delivery);
          assert.equal(observed.total(), 63);
          for (const descriptor of root.images) {
            const before = observed.acquisitions.length;
            const setsBefore = wholeSets.length;
            const member = await heldOpen(() => openDiscussion(descriptor));
            assert.equal(observed.acquisitions.length - before, 1);
            assert.equal(
              observed.total(),
              64,
              `ordinal ${descriptor.ordinal} uses the one free delivery credit`,
            );
            assert.equal(observed.count(accountKey), 1);
            assert.deepEqual(wholeSets.slice(setsBefore), [
              root.images.map((item) => item.bindingId),
              root.images.map((item) => item.bindingId),
            ]);
            const bytes = await complete(member);
            assert.equal(bytes.length, variants[descriptor.ordinal]!.bytes);
            assert.equal(sha256(bytes), variants[descriptor.ordinal]!.sha256);
            assert.equal(
              observed.total(),
              63,
              `ordinal ${descriptor.ordinal} completed without retaining sibling credits`,
            );
          }
          const recovered = await heldOpen(() =>
            openProfile(viewers[0]!.accessToken),
          );
          assert.deepEqual(await complete(recovered), png);
          assert.equal(
            observed.total(),
            63,
            'normal completion also frees the global slot',
          );
          await abortAll();
          assert.equal(observed.total(), 0);
          const afterDrain = await heldOpen(() => openDiscussion());
          assert.equal(sha256(await complete(afterDrain)), firstVariant.sha256);
          assert.equal(observed.total(), 0);
        } finally {
          await abortAll();
        }
      },
    );

    await t.test(
      'a held ninth asset denies the first image before any credit or provider open',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const assetId = manifests[8]!.asset_id;
          const row = (
            await tx.query<{
              revision: string;
              manifest_digest: string;
              policy_revision: string;
            }>(
              `SELECT h.revision::text,a.manifest_digest,a.policy_revision
           FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
           WHERE a.id=$1 FOR UPDATE OF a,h`,
              [assetId],
            )
          ).rows[0]!;
          const event = randomUUID();
          const revision = String(BigInt(row.revision) + 1n);
          await tx.query(
            `INSERT INTO whaleu_media.asset_safety_events
           (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
           VALUES($1::uuid,$2,$3,'held',$4,$5,'synthetic-shared-delivery',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
            [
              event,
              assetId,
              revision,
              row.manifest_digest,
              row.policy_revision,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [assetId, revision, event],
          );
        });
        const acquiredBefore = observed.acquisitions.length;
        const opens = storage.opens;
        await assert.rejects(
          openDiscussion(),
          (error: unknown) => error instanceof ApplicationError,
        );
        assert.equal(observed.acquisitions.length, acquiredBefore);
        assert.equal(storage.opens, opens);
        assert.equal(observed.total(), 0);
        const denied = await f
          .auth(
            request(http).get('/v3/media/ratings-discussion/images'),
            author,
          )
          .query(imageQuery(first));
        assert.notEqual(denied.status, 200);
        assert.equal(Buffer.isBuffer(denied.body), false);
        // Unrelated Profile authority and its shared delivery credit still work.
        const avatar = await heldOpen(() =>
          openProfile(otherSession.accessToken),
        );
        assert.deepEqual(await complete(avatar), png);
        assert.equal(observed.total(), 0);
      },
    );
  },
);
