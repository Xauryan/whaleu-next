import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { PublicationService } from '../src/community/publication.service.js';
import { ReplyPublicationService } from '../src/community/discussion/publication.service.js';
import { publishCommentSchema } from '../src/community/contracts.js';
import { publishReplySchema } from '../src/community/discussion/contracts.js';
import {
  canonicalEnvelope,
  discussionEnvelopeDraft,
} from '../src/community/content-review/contracts.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const images = [6, 7, 8].map((n) => ({
  assetId: id(n),
  digest: 'a'.repeat(64),
}));
const scope = {
  originalSpaceId: id(2),
  originalRegionId: id(3),
  authorOriginRegionId: id(3),
  identityRegionId: id(3),
  topologySnapshotId: null,
  sync: 'none' as const,
};
const draft = (reply: boolean) => ({
  version: 1,
  accountId: id(1),
  purpose: reply ? 'publish_reply' : 'publish_comment',
  spaceId: id(2),
  category: 'discussion',
  authorMode: 'named',
  commentsPolicy: 'open',
  postId: id(4),
  rootCommentId: reply ? id(5) : null,
  targetReplyId: null,
  text: '',
  component: { kind: 'none' },
  trading: null,
  scope,
});

for (const reply of [false, true]) {
  const kind = reply ? 'reply' : 'root';
  test(`${kind} image-omitted draft preserves strict final body and asset validation`, () => {
    const value = discussionEnvelopeDraft(draft(reply));
    assert.equal(Object.hasOwn(value, 'images'), false);
    assert.throws(
      () => canonicalEnvelope({ ...value, images: [] }),
      /Empty discussion/,
    );
    const final = canonicalEnvelope({ ...value, images });
    assert.equal(final.text, '');
    assert.deepEqual(final.images, images);
    assert.throws(
      () => canonicalEnvelope({ ...value, images: [images[0], images[0]] }),
      /Duplicate assets/,
    );
    assert.throws(
      () =>
        canonicalEnvelope({
          ...value,
          images: [...images, { assetId: id(9), digest: 'a'.repeat(64) }],
        }),
      /Invalid discussion definition/,
    );
    assert.throws(() =>
      canonicalEnvelope({
        ...value,
        images: [{ assetId: id(6), digest: 'invalid' }],
      }),
    );
    assert.throws(() => discussionEnvelopeDraft({ ...draft(reply), images }));
    assert.throws(() =>
      discussionEnvelopeDraft({ ...draft(reply), accountId: 'invalid' }),
    );
    assert.throws(
      () => discussionEnvelopeDraft({ ...draft(reply), spaceId: id(9) }),
      /Scope does not match space/,
    );
    assert.throws(
      () => discussionEnvelopeDraft({ ...draft(reply), postId: null }),
      /Missing post/,
    );
    assert.throws(
      () =>
        discussionEnvelopeDraft({
          ...draft(reply),
          rootCommentId: reply ? null : id(5),
        }),
      /Invalid discussion ancestry/,
    );
    assert.throws(() =>
      discussionEnvelopeDraft({ ...draft(reply), text: 'x'.repeat(501) }),
    );
    assert.throws(() =>
      discussionEnvelopeDraft({ ...draft(reply), text: '\u0000' }),
    );
    assert.throws(() =>
      discussionEnvelopeDraft({ ...draft(reply), unexpected: true }),
    );
    const body = {
      clientRequestId: id(10),
      text: '',
      imageAssetIds: [],
      authorMode: 'named',
      ...(reply ? { targetReplyId: null } : {}),
    };
    assert.equal(
      (reply ? publishReplySchema : publishCommentSchema).safeParse(body)
        .success,
      false,
    );
  });
}

type Mode =
  | 'owned'
  | 'unowned'
  | 'replayed'
  | 'wrong-order'
  | 'invalid-digest'
  | 'duplicate';
function harness(mode: Mode) {
  const events: string[] = [];
  const stop = new Error('Reached validated approval before content writes');
  const tx = {
    query: async () => {
      assert.fail('No SQL mutation before validated approval');
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const space = {
    id: id(2),
    kind: 'regional',
    name: 'test',
    isActive: true,
    operatingRegionId: id(3),
  };
  const post = {
    id: id(4),
    account_id: id(1),
    space_id: id(2),
    category: 'discussion',
    author_mode: 'named',
    comments_policy: 'open',
    publication_envelope_version: 1,
  };
  const root = { id: id(5), post_id: id(4), account_id: id(1) };
  type Args = ConstructorParameters<typeof PublicationService>;
  const repository = {
    attach: async () => assert.fail('No attachment before approval'),
    event: async () => assert.fail('No event before approval'),
  } as unknown as Args[0];
  const access = {
    accessiblePost: async () => ({ post, space }),
    accessibleComment: async () => ({ post, space, comment: root }),
    interaction: async () => {},
    authority: async () => ({
      phoneVerified: true,
      studentVerified: true,
      identityRegionId: id(3),
      restrictedActions: [],
      canManage: false,
      publicationScope: scope,
    }),
  } as unknown as Args[1];
  const publications = {
    execute: async (
      _token: string,
      _request: string,
      _operation: string,
      _intent: unknown,
      create: (actor: string, tx: PoolClient) => Promise<unknown>,
    ) => create(id(1), tx),
  } as unknown as Args[2];
  const profiles = {
    prepare: async () => assert.fail('No profile mutation before approval'),
  } as unknown as Args[6];
  const service = new PublicationService(
    repository,
    access,
    publications,
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    profiles,
    {
      check: async (input) => {
        events.push('review');
        assert.deepEqual(input.envelope, canonicalEnvelope(input.envelope));
        return { kind: 'allow', value: undefined };
      },
    } as Args[7],
    {
      resolveOwned: async () => {
        events.push('resolve-owned');
        if (mode === 'unowned' || mode === 'replayed')
          return { kind: 'deny', reason: 'MEDIA_NOT_READY' };
        return {
          kind: 'allow',
          value:
            mode === 'wrong-order'
              ? [...images].reverse()
              : mode === 'invalid-digest'
                ? images.map((image) => ({ ...image, digest: 'invalid' }))
                : mode === 'duplicate'
                  ? [images[0]!, images[0]!, images[2]!]
                  : images,
        };
      },
    } as unknown as Args[8],
  );
  const approved = service.approved.bind(service);
  service.approved = async (
    ...args: Parameters<PublicationService['approved']>
  ) => {
    await approved(...args);
    throw stop;
  };
  const replies = new ReplyPublicationService(
    repository,
    access,
    publications,
    service,
    profiles,
  );
  return {
    events,
    stop,
    close: () => clearTransactionDeadlines(tx),
    run: (
      reply: boolean,
      text: string,
      ids = images.map((image) => image.assetId),
    ) => {
      const body = {
        clientRequestId: id(10),
        text,
        imageAssetIds: ids,
        authorMode: 'named' as const,
      };
      return reply
        ? replies.create('token', id(5), { ...body, targetReplyId: null })
        : service.comment('token', id(4), body);
    },
  };
}
for (const reply of [false, true]) {
  const kind = reply ? 'reply' : 'root';
  for (const text of ['', 'mixed text and images'])
    test(`${kind} actual publication resolves three owned images before strict final approval (${text ? 'mixed' : 'pure'})`, async () => {
      const f = harness('owned');
      try {
        await assert.rejects(f.run(reply, text), (error) => error === f.stop);
        assert.deepEqual(f.events, ['resolve-owned', 'review']);
      } finally {
        f.close();
      }
    });
  test(`${kind} blank image-free internal call cannot reach Review or writes`, async () => {
    const f = harness('owned');
    try {
      await assert.rejects(f.run(reply, '', []), /Empty discussion/);
      assert.deepEqual(f.events, []);
    } finally {
      f.close();
    }
  });
  for (const mode of [
    'unowned',
    'replayed',
    'wrong-order',
    'invalid-digest',
    'duplicate',
  ] as const)
    test(`${kind} ${mode} image proof cannot reach Review or writes`, async () => {
      const f = harness(mode);
      try {
        await assert.rejects(
          f.run(reply, ''),
          (error) =>
            error instanceof ApplicationError &&
            error.code === 'MEDIA_NOT_READY',
        );
        assert.deepEqual(f.events, ['resolve-owned']);
      } finally {
        f.close();
      }
    });
}

for (const reply of [false, true]) {
  test(`${reply ? 'reply' : 'root'} draft retains inherited distribution and Home parent constraints`, () => {
    const related = {
      ...draft(reply),
      version: 4,
      allowAnonymousDm: null,
      scope: {
        ...scope,
        sync: 'inherited_related',
        configurationRevisionId: null,
        identityCampusId: null,
        identitySelectionId: null,
        affiliationSnapshotId: null,
        affiliationAssertionId: null,
        parentDistribution: {
          postId: id(4),
          decisionId: id(11),
          digest: 'b'.repeat(64),
        },
      },
    };
    assert.equal(
      canonicalEnvelope({ ...discussionEnvelopeDraft(related), images })
        .version,
      4,
    );
    assert.throws(
      () => discussionEnvelopeDraft({ ...related, allowAnonymousDm: true }),
      /Invalid inherited distribution scope/,
    );
    assert.throws(
      () =>
        discussionEnvelopeDraft({
          ...related,
          scope: {
            ...related.scope,
            parentDistribution: {
              ...related.scope.parentDistribution,
              postId: id(12),
            },
          },
        }),
      /Invalid inherited distribution scope/,
    );
    const home = {
      ...draft(reply),
      version: 8,
      allowAnonymousDm: null,
      textSource: null,
      homeParent: { postId: id(4), decisionId: id(11), digest: 'b'.repeat(64) },
    };
    assert.equal(discussionEnvelopeDraft(home).version, 8);
    assert.throws(
      () =>
        discussionEnvelopeDraft({
          ...home,
          homeParent: { ...home.homeParent, postId: id(12) },
        }),
      /Invalid composed Home parent/,
    );
    assert.throws(
      () => discussionEnvelopeDraft({ ...home, category: 'feedback' }),
      /Invalid composed Home parent/,
    );
    assert.throws(() =>
      discussionEnvelopeDraft({ ...draft(reply), purpose: 'publish_post' }),
    );
    assert.throws(() =>
      discussionEnvelopeDraft({
        ...draft(reply),
        textSource: { version: 1, format: 'plain' },
      }),
    );
  });
}
