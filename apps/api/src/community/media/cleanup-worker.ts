import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { MEDIA_ATTACHMENT } from '../community-policy.js';
import type { MediaAttachmentPort } from '../community-policy.js';
import { CommunityMediaCleanupFacade } from './cleanup-facade.js';

export type CommunityMediaCleanupResult =
  | { readonly status: 'idle' }
  | {
      readonly status: 'progress' | 'enumeration-complete';
      readonly jobId: string;
      readonly detachedTargets: number;
    };

/** Explicit bounded worker, with no timers, remote storage calls or activation
 * flags. One invocation performs at most 16 typed parent detaches. Normal
 * unavailable Media wiring can still create durable exact-object obligations;
 * only the separate Media cleanup owner may establish physical absence. */
@Injectable()
export class CommunityMediaCleanupWorker {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunityMediaCleanupFacade)
    private readonly owner: CommunityMediaCleanupFacade,
    @Inject(MEDIA_ATTACHMENT) private readonly media: MediaAttachmentPort,
  ) {}

  runOnePage(jobId?: string): Promise<CommunityMediaCleanupResult> {
    return this.database.transaction<CommunityMediaCleanupResult>(
      async (tx) => {
        const page = await this.owner.claimPage(tx, jobId);
        if (!page) return { status: 'idle' };
        if (page.parents.length) {
          if (!this.media.detachMany)
            throw new ApplicationError('MEDIA_UNAVAILABLE');
          // One Media mutation boundary owns the entire page. Repeated detach
          // calls would invalidate each earlier mandatory epoch with the next
          // target's writes. Unsupported ports must not use that unsafe fallback.
          await this.media.detachMany(
            page.parents.map((parent) => ({
              kind: parent.resourceKind,
              id: parent.resourceId,
            })),
            tx,
          );
        }
        const status = await this.owner.completePage(page, tx);
        return {
          status,
          jobId: page.jobId,
          detachedTargets: page.parents.length,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
