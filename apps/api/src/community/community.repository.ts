import { CommunityExperienceSourceCapture } from './experience-source/capture.js';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { CampusService } from '../campus/campus.service.js';
import { ApplicationError } from '../http/application-error.js';
import type { AuthorMode, Category, CommunitySpace } from './contracts.js';
import type { ApprovedAsset } from './community-policy.js';
export interface StoredPost {
  id: string;
  space_id: string;
  account_id: string;
  category: Category;
  text: string;
  author_mode: AuthorMode;
  comments_policy: 'open' | 'restricted';
  visibility: 'approved' | 'hidden';
  deleted_at: Date | null;
  published_at: Date;
}
export interface StoredComment {
  id: string;
  post_id: string;
  account_id: string;
  text: string;
  author_mode: AuthorMode;
  visibility: 'approved' | 'hidden';
  deleted_at: Date | null;
  created_at: Date;
}
export interface StoredReply extends StoredComment {
  root_comment_id: string;
  target_reply_id: string | null;
  sequence: string;
}
export interface Seek {
  at: string;
  id: string;
}
const spaceProjection =
  'id,kind,name,is_active AS "isActive",operating_region_id AS "operatingRegionId"';
@Injectable()
export class CommunityRepository {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(CommunityExperienceSourceCapture)
    private readonly experience: CommunityExperienceSourceCapture,
  ) {}
  async spaces(campusId: string) {
    const { campus, region } = await this.campuses.getBrowseContext(campusId);
    const result = await this.database.query<CommunitySpace>(
      `SELECT ${spaceProjection} FROM whaleu_community.spaces WHERE is_active AND (kind='global' OR operating_region_id=$1) ORDER BY name,id`,
      [campus.isActive && region?.isActive ? region.id : null],
    );
    return {
      regional: result.rows.find((space) => space.kind === 'regional') ?? null,
      global: result.rows.filter((space) => space.kind === 'global'),
    };
  }
  async space(id: string, tx: PoolClient): Promise<CommunitySpace> {
    const result = await tx.query<CommunitySpace>(
      `SELECT ${spaceProjection} FROM whaleu_community.spaces WHERE id=$1 FOR SHARE`,
      [id],
    );
    const space = result.rows[0];
    if (!space?.isActive)
      throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    if (space.operatingRegionId)
      await this.campuses.requireActiveRegion(space.operatingRegionId, tx);
    return space;
  }
  async post(id: string, tx: PoolClient, write = false): Promise<StoredPost> {
    const result = await tx.query<StoredPost>(
      `SELECT * FROM whaleu_community.posts WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [id],
    );
    if (!result.rows[0]) throw new ApplicationError('POST_NOT_FOUND');
    return result.rows[0];
  }
  async comment(
    id: string,
    tx: PoolClient,
    lock = false,
  ): Promise<StoredComment> {
    const result = await tx.query<StoredComment>(
      `SELECT * FROM whaleu_community.root_comments WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`,
      [id],
    );
    if (!result.rows[0]) throw new ApplicationError('COMMENT_NOT_FOUND');
    return result.rows[0];
  }
  async reply(id: string, tx: PoolClient, lock = false): Promise<StoredReply> {
    const result = await tx.query<StoredReply>(
      `SELECT * FROM whaleu_community.replies WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`,
      [id],
    );
    if (!result.rows[0]) throw new ApplicationError('REPLY_NOT_FOUND');
    return result.rows[0];
  }
  async images(
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
  ): Promise<ApprovedAsset[]> {
    const result = await tx.query<ApprovedAsset>(
      `SELECT asset_id AS "assetId",digest FROM whaleu_community.${kind}_images WHERE ${kind}_id=$1 ORDER BY position`,
      [id],
    );
    return result.rows;
  }
  async attach(
    kind: 'post' | 'comment' | 'reply',
    id: string,
    assets: ApprovedAsset[],
    tx: PoolClient,
  ): Promise<void> {
    for (const [position, asset] of assets.entries())
      await tx.query(
        `INSERT INTO whaleu_community.${kind}_images(${kind}_id,asset_id,digest,position) VALUES ($1,$2,$3,$4)`,
        [id, asset.assetId, asset.digest, position],
      );
  }
  async persona(
    postId: string,
    accountId: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name) VALUES ($1,$2,$3,'匿名鲸鱼') ON CONFLICT(post_id,account_id) DO NOTHING",
      [randomUUID(), postId, accountId],
    );
  }
  async event(
    key: string,
    type: string,
    resourceId: string,
    tx: PoolClient,
    context: Record<string, unknown> = {},
  ): Promise<string | null> {
    const inserted = await tx.query<{ id: string }>(
      'INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(event_key) DO NOTHING RETURNING id',
      [randomUUID(), key, type, resourceId, JSON.stringify(context)],
    );
    if (inserted.rows[0] && ['comment_created', 'reply_created'].includes(type))
      await tx.query(
        "INSERT INTO whaleu_community.local_update_events(event_id,origin,automatic_eligible) VALUES($1,'local_publication',$2)",
        [
          inserted.rows[0].id,
          this.config.COMMUNITY_UPDATES_PROCESSING === 'automatic',
        ],
      );
    if (inserted.rows[0]) await this.experience.enroll(inserted.rows[0].id, tx);
    return inserted.rows[0]?.id ?? null;
  }
}
