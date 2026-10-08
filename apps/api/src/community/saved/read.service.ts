import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import type { Authority } from '../community-policy.js';
import type { CommunitySpace } from '../contracts.js';
import type { StoredPost } from '../community.repository.js';
import { SavedRepository } from './repository.js';
import { encodeSavedCursor, savedCursor } from './cursor.js';
import type {
  PostUpdatePreferences,
  SavedPage,
  SavedPageQuery,
  SavedStatus,
} from './contracts.js';
export function preferenceReason(
  authority: Authority | null,
): ApplicationErrorCode | null {
  if (!authority) return 'COMMUNITY_UNAVAILABLE';
  if (!authority.phoneVerified) return 'PHONE_VERIFICATION_REQUIRED';
  if (authority.restrictedActions.includes('set_post_update_preference'))
    return 'COMMUNITY_ACTION_RESTRICTED';
  return null;
}
@Injectable()
export class SavedReadService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(SavedRepository) private readonly saved: SavedRepository,
  ) {}
  private async projectPreferences(
    actor: string,
    postId: string,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<PostUpdatePreferences> {
    const settings = await this.saved.preferences(actor, postId, tx),
      reason = preferenceReason(authority);
    return {
      postId,
      savedUpdatesEnabled: settings?.saved_updates_enabled ?? true,
      externalUpdatesEnabled: settings?.external_updates_enabled ?? true,
      revision: settings?.revision ?? '0',
      canSetPreference: reason === null,
      reason,
      inAppCapability: 'local',
      inAppProcessing: this.config.COMMUNITY_UPDATES_PROCESSING,
      externalCapability: 'unavailable',
    };
  }
  preferences(token: string, postId: string): Promise<PostUpdatePreferences> {
    return this.community.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx),
          { post, space } = await this.access.accessiblePost(postId, actor, tx);
        const result = await this.projectPreferences(
          actor,
          post.id,
          await this.access.advisory(actor, space, tx),
          tx,
        );
        await this.access.actor(token, tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  status(token: string, postIds: string[]): Promise<{ items: SavedStatus[] }> {
    return this.community.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx),
          results = new Map<string, SavedStatus>();
        // Deterministic parent lock ordering also applies to caller-ordered batches.
        for (const id of [...postIds].sort()) {
          try {
            const { post, space } = await this.access.accessiblePost(
                id,
                actor,
                tx,
              ),
              state = await this.saved.own(actor, post.id, tx),
              projection = await this.saved.projection(post.id, actor, tx);
            results.set(id, {
              postId: id,
              status: 'available',
              ...projection,
              savedAt: state?.saved_at?.toISOString() ?? null,
              saveEpochId: state?.epoch_id ?? null,
              preferences: await this.projectPreferences(
                actor,
                post.id,
                await this.access.advisory(actor, space, tx),
                tx,
              ),
            });
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              error.code !== 'POST_NOT_FOUND'
            )
              throw error;
            results.set(id, { postId: id, status: 'unavailable' });
          }
        }
        await this.access.actor(token, tx);
        return { items: postIds.map((id) => results.get(id)!) };
      },
      { isolationLevel: 'read committed' },
    );
  }
  list(token: string, query: SavedPageQuery): Promise<SavedPage> {
    return this.community.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx),
          seek = savedCursor(query.cursor, actor, query.limit);
        // One bounded, current policy-filtered set feeds total, pagination and items.
        // Over the bound we fail honestly rather than return an unfiltered total.
        const candidates = (
          await tx.query<{ post_id: string }>(
            'SELECT post_id FROM whaleu_community.saved_posts WHERE account_id=$1 AND epoch_id IS NOT NULL ORDER BY post_id LIMIT 1025',
            [actor],
          )
        ).rows;
        if (candidates.length > 1024)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const visible: {
          post: StoredPost;
          space: CommunitySpace;
          authority: Authority | null;
          savedAt: string;
          saveEpochId: string;
        }[] = [];
        for (const candidate of candidates) {
          try {
            const { post, space } = await this.access.accessiblePost(
                candidate.post_id,
                actor,
                tx,
              ),
              current = await this.saved.own(actor, post.id, tx);
            if (!current?.epoch_id || !current.saved_at) continue;
            visible.push({
              post,
              space,
              authority: await this.access.advisory(actor, space, tx),
              savedAt: current.saved_at.toISOString(),
              saveEpochId: current.epoch_id,
            });
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              error.code !== 'POST_NOT_FOUND'
            )
              throw error;
          }
        }
        visible.sort(
          (a, b) =>
            b.savedAt.localeCompare(a.savedAt) ||
            b.saveEpochId.localeCompare(a.saveEpochId),
        );
        const remaining = seek
          ? visible.filter(
              (item) =>
                item.savedAt < seek.at ||
                (item.savedAt === seek.at && item.saveEpochId < seek.id),
            )
          : visible;
        const page = remaining.slice(0, query.limit),
          items: SavedPage['items'] = [];
        for (const item of page)
          items.push({
            post: await this.serializer.post(
              item.post,
              item.space,
              actor,
              item.authority,
              tx,
            ),
            savedAt: item.savedAt,
            saveEpochId: item.saveEpochId,
          });
        const last = page.at(-1);
        await this.access.actor(token, tx);
        return {
          items,
          visibleSavedCount: visible.length,
          nextCursor:
            remaining.length > query.limit && last
              ? encodeSavedCursor(
                  last.savedAt,
                  last.saveEpochId,
                  actor,
                  query.limit,
                )
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
