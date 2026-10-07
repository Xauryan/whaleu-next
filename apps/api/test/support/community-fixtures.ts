import { publicationHash } from '../../src/community/publication.repository.js';
import { postIntent } from '../../src/community/publication-intent.js';
import type { PublishPost } from '../../src/community/contracts.js';
/** Synthetic dependency-injection adapters. Never exported by or selectable in the application. */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ApprovedAsset,
  Authority,
  CommunityAuthorizationPort,
  CommunityVisibilityPort,
  ContentPublicationGate,
  Decision,
  MediaAttachmentPort,
  VisibilitySubject,
  VisibilityPurpose,
} from '../../src/community/community-policy.js';
import type {
  CommunitySpace,
  MediaView,
  PublicationOperation,
} from '../../src/community/contracts.js';
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export class FixtureAuthorization implements CommunityAuthorizationPort {
  beforeResolve: (() => Promise<void>) | null = null;
  afterResolve: (() => Promise<void>) | null = null;
  async resolve(
    accountId: string,
    space: CommunitySpace,
    tx: PoolClient,
  ): Promise<Decision<Authority>> {
    await this.beforeResolve?.();
    const rows = await tx.query<{ authority: Authority }>(
      'SELECT authority FROM whaleu_community_test.grants WHERE account_id=$1 AND space_id=$2 FOR SHARE',
      [accountId, space.id],
    );
    await this.afterResolve?.();
    return rows.rows[0]
      ? { kind: 'allow', value: rows.rows[0].authority }
      : { kind: 'unavailable' };
  }
}
export class FixtureVisibility implements CommunityVisibilityPort {
  readonly seen: VisibilitySubject[] = [];
  async check(
    viewer: string | null,
    subject: VisibilitySubject,
    tx: PoolClient,
    _purpose: VisibilityPurpose,
  ): Promise<Decision> {
    this.seen.push(subject);
    if (subject.authorMode === 'named') {
      // Synthetic local guard also serializes absent block rows against inserts.
      await tx.query('LOCK TABLE whaleu_community_test.blocks IN SHARE MODE');
      const result = await tx.query(
        'SELECT 1 FROM whaleu_community_test.blocks WHERE viewer=$1 AND author=$2 FOR SHARE',
        [viewer, subject.namedAccountId],
      );
      if (result.rowCount) return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    }
    return { kind: 'allow', value: undefined };
  }
}
export class FixtureContent implements ContentPublicationGate {
  unavailable = false;
  async check(
    input: Parameters<ContentPublicationGate['check']>[0],
    tx: PoolClient,
  ): Promise<Decision> {
    if (this.unavailable) return { kind: 'unavailable' };
    const result = await tx.query(
      'SELECT 1 FROM whaleu_community_test.approvals WHERE account_id=$1 AND purpose=$2 AND text_hash=$3 AND images=$4::jsonb AND intent_hash IS NOT DISTINCT FROM $5::text AND valid_until>clock_timestamp() FOR SHARE',
      [
        input.accountId,
        input.purpose,
        digest(input.text),
        JSON.stringify(input.images),
        input.structuredContent?.publicationIntentHash ?? null,
      ],
    );
    return result.rowCount
      ? { kind: 'allow', value: undefined }
      : { kind: 'deny', reason: 'CONTENT_REJECTED' };
  }
}
interface AssetRow {
  id: string;
  account_id: string;
  purpose: PublicationOperation;
  digest: string;
  ready: boolean;
}
export class FixtureMedia implements MediaAttachmentPort {
  async resolveOwned(
    actor: string,
    purpose: PublicationOperation,
    ids: string[],
    tx: PoolClient,
  ): Promise<Decision<ApprovedAsset[]>> {
    const images: ApprovedAsset[] = [];
    for (const id of ids) {
      const result = await tx.query<AssetRow>(
        'SELECT * FROM whaleu_community_test.assets WHERE id=$1 FOR SHARE',
        [id],
      );
      const asset = result.rows[0];
      if (
        !asset ||
        asset.account_id !== actor ||
        asset.purpose !== purpose ||
        !asset.ready
      )
        return { kind: 'deny', reason: 'MEDIA_NOT_READY' };
      images.push({ assetId: id, digest: asset.digest });
    }
    return { kind: 'allow', value: images };
  }
  async display(
    assets: ApprovedAsset[],
    tx: PoolClient,
  ): Promise<Decision<MediaView[]>> {
    const views: MediaView[] = [];
    for (const asset of assets) {
      const result = await tx.query<AssetRow>(
        'SELECT * FROM whaleu_community_test.assets WHERE id=$1 AND digest=$2 AND ready FOR SHARE',
        [asset.assetId, asset.digest],
      );
      if (!result.rowCount) return { kind: 'unavailable' };
      views.push({
        assetId: asset.assetId,
        width: 100,
        height: 100,
        displayUrl: `https://synthetic.invalid/media/${asset.assetId}`,
        thumbnailUrl: `https://synthetic.invalid/thumb/${asset.assetId}`,
        expiresAt: null,
      });
    }
    return { kind: 'allow', value: views };
  }
}
export async function fixtureSchema(pool: Pool) {
  await pool.query(`CREATE SCHEMA whaleu_community_test;
 CREATE TABLE whaleu_community_test.grants(account_id uuid,space_id uuid,authority jsonb NOT NULL,PRIMARY KEY(account_id,space_id));
 CREATE TABLE whaleu_community_test.blocks(viewer uuid,author uuid,PRIMARY KEY(viewer,author));
 CREATE TABLE whaleu_community_test.approvals(account_id uuid,purpose text,text_hash text,images jsonb,intent_hash text,valid_until timestamptz NOT NULL DEFAULT now()+interval '1 hour');
 CREATE TABLE whaleu_community_test.assets(id uuid PRIMARY KEY,account_id uuid,purpose text,digest text,ready boolean);`);
}
export async function approve(
  pool: Pool,
  accountId: string,
  text: string,
  purpose: PublicationOperation = 'publish_post',
  images: ApprovedAsset[] = [],
) {
  await pool.query(
    'INSERT INTO whaleu_community_test.approvals(account_id,purpose,text_hash,images) VALUES ($1,$2,$3,$4::jsonb)',
    [accountId, purpose, digest(text), JSON.stringify(images)],
  );
}
export function verified(region: string): Authority {
  return {
    phoneVerified: true,
    studentVerified: true,
    identityRegionId: region,
    crossRegionAllowed: false,
    unverifiedCategories: [],
    unverifiedCommentsAllowed: false,
    restrictedActions: [],
    canManage: false,
  };
}
export async function grant(
  pool: Pool,
  actor: string,
  space: string,
  authority: Authority,
) {
  await pool.query(
    'INSERT INTO whaleu_community_test.grants(account_id,space_id,authority) VALUES ($1,$2,$3::jsonb) ON CONFLICT(account_id,space_id) DO UPDATE SET authority=excluded.authority',
    [actor, space, JSON.stringify(authority)],
  );
}

/** Poll fixture approval binds every normalized publication behavior field. */
export async function approvePoll(
  pool: Pool,
  actor: string,
  body: PublishPost,
  images: ApprovedAsset[] = [],
) {
  await pool.query(
    "INSERT INTO whaleu_community_test.approvals(account_id,purpose,text_hash,images,intent_hash) VALUES ($1,'publish_post',$2,$3::jsonb,$4)",
    [
      actor,
      digest(body.text),
      JSON.stringify(images),
      publicationHash('publish_post', postIntent(body)),
    ],
  );
}

/** Reply approval binds the resolved post/root/target, effective identity and ordered assets. */
export async function approveReply(
  pool: Pool,
  actor: string,
  postId: string,
  rootCommentId: string,
  body: import('../../src/community/discussion/contracts.js').PublishReply,
  effectiveMode: import('../../src/community/contracts.js').AuthorMode = body.authorMode,
  images: ApprovedAsset[] = [],
) {
  const { replyApprovalHash } =
    await import('../../src/community/discussion/publication.service.js');
  await pool.query(
    "INSERT INTO whaleu_community_test.approvals(account_id,purpose,text_hash,images,intent_hash) VALUES($1,'publish_reply',$2,$3::jsonb,$4)",
    [
      actor,
      digest(body.text),
      JSON.stringify(images),
      replyApprovalHash(postId, rootCommentId, body, effectiveMode),
    ],
  );
}

/** Trading approval uses the identical full-intent hash boundary. */
export const approveTrading = approvePoll;

/** Formation approval includes chosen contacts and explicit sharing consent. */
export const approveFormation = approvePoll;
