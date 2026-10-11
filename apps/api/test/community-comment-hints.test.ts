import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CommunitySerializer } from '../src/community/community-serialization.js';
import type { Authority } from '../src/community/community-policy.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import type { StoredPost } from '../src/community/community.repository.js';

const space: CommunitySpace = {
  id: 'synthetic-space',
  kind: 'regional',
  operatingRegionId: 'synthetic-region',
  name: 'Synthetic region',
  isActive: true,
};
const post: StoredPost = {
  id: 'synthetic-post',
  space_id: space.id,
  account_id: 'synthetic-owner',
  category: 'discussion',
  text: 'Synthetic named text',
  author_mode: 'named',
  comments_policy: 'open',
  visibility: 'approved',
  deleted_at: null,
  published_at: new Date(0),
};
const lightweight: Authority = {
  runtime: true,
  phoneVerified: true,
  studentVerified: false,
  affiliationStatus: 'unavailable',
  identityStatus: 'unavailable',
  configurationStatus: 'unavailable',
  identityRegionId: null,
  crossRegionAllowed: false,
  unverifiedCategories: [],
  unverifiedCommentsAllowed: false,
  restrictedActions: [],
  canManage: false,
  canDisableComments: false,
};
const eligible: Authority = {
  ...lightweight,
  affiliationStatus: 'unverified',
  configurationStatus: 'known',
  unverifiedCommentsAllowed: true,
};

test('local review comment hints resolve full current eligibility without granting authority', async (t) => {
  const cases: {
    name: string;
    full: Authority | null;
    review?: boolean;
    post?: Partial<StoredPost>;
    allowed?: boolean;
  }[] = [
    {
      name: 'phone-only read becomes named comment eligible only after full advisory',
      full: eligible,
      allowed: true,
    },
    {
      name: 'missing phone remains denied',
      full: { ...eligible, phoneVerified: false },
    },
    {
      name: 'unknown affiliation remains unavailable',
      full: { ...eligible, affiliationStatus: 'unavailable' },
    },
    {
      name: 'unknown regional policy remains unavailable',
      full: { ...eligible, configurationStatus: 'unavailable' },
    },
    {
      name: 'regional comments disabled remain denied',
      full: { ...eligible, unverifiedCommentsAllowed: false },
    },
    {
      name: 'safety-restricted comments remain denied',
      full: { ...eligible, restrictedActions: ['publish_comment'] },
    },
    {
      name: 'unavailable full advisory cannot borrow phone authority',
      full: null,
    },
    {
      name: 'disabled review does not load publication facts',
      full: eligible,
      review: false,
    },
    {
      name: 'restricted post remains unavailable in named local review',
      full: eligible,
      post: { comments_policy: 'restricted' },
    },
    {
      name: 'anonymous own post cannot gain a named local review exception',
      full: eligible,
      post: { author_mode: 'anonymous' },
    },
  ];
  for (const scenario of cases)
    await t.test(scenario.name, async () => {
      let reads = 0;
      const currentPost = { ...post, ...scenario.post };
      const tx = {
        query: async (sql: string) => ({
          rows: sql.includes('post_likes') ? [{ count: 0, liked: false }] : [],
        }),
      } as unknown as PoolClient;
      type Dependencies = ConstructorParameters<typeof CommunitySerializer>;
      const serializer = new CommunitySerializer(
        {
          projection: async () => ({ saveCount: 0, isSaved: false }),
        } as unknown as Dependencies[0],
        { images: async () => [] } as unknown as Dependencies[1],
        {} as Dependencies[2],
        {} as Dependencies[3],
        {
          advisory: async (
            viewer: string,
            scope: CommunitySpace,
            client: PoolClient,
            context: unknown,
          ) => {
            reads++;
            assert.equal(viewer, currentPost.account_id);
            assert.equal(scope, space);
            assert.equal(client, tx);
            assert.deepEqual(context, {
              publication: true,
              targetPostId: post.id,
            });
            return scenario.full;
          },
        } as unknown as Dependencies[4],
        { project: async () => null } as unknown as Dependencies[5],
        { project: async () => null } as unknown as Dependencies[6],
        { project: async () => null } as unknown as Dependencies[7],
        {
          available: async () => scenario.review !== false,
        } as unknown as Dependencies[8],
      );
      serializer.author = async () => ({
        kind: 'named',
        profileId: 'synthetic-profile',
        displayName: 'Synthetic user',
        avatar: null,
        experienceDisplay: {
          title: { status: 'unavailable', value: null },
          color: { status: 'unavailable', value: null },
          level: { status: 'unavailable', value: null },
        },
      });
      const before = structuredClone(lightweight);
      const result = await serializer.post(
        currentPost,
        space,
        currentPost.account_id,
        lightweight,
        tx,
      );
      assert.equal(result.viewer.canComment, scenario.allowed ?? false);
      assert.equal(
        reads,
        scenario.review === false ||
          currentPost.comments_policy === 'restricted'
          ? 0
          : 1,
      );
      assert.deepEqual(
        lightweight,
        before,
        'Read/interaction authority is not mutated into publication authority',
      );
    });
});
