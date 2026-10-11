import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { CampusService } from '../../campus/campus.service.js';
import { LocalPublicationEligibilitySource } from '../../verification/publication-eligibility.source.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import type { StoredPost } from '../community.repository.js';
import type { CommunitySpace } from '../contracts.js';
import { feedbackInputSchema, type FeedbackView } from './contracts.js';
import { requireFeedbackSpace } from './topic.js';
@Injectable()
export class FeedbackProjectionService {
  constructor(
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  /** Called only after Community visibility. School is an institution display,
   * never a current eligibility grant or a public identity locator. */
  async project(
    post: StoredPost,
    space: CommunitySpace,
    tx: PoolClient,
  ): Promise<FeedbackView> {
    await requireFeedbackSpace(space, tx);
    const definition = feedbackInputSchema.safeParse(post.feedback);
    if (!definition.success)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const scope = await this.approvals.scopeForPost(post.id, tx);
    if (!scope) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const institution = scope.affiliationAssertionId
      ? await this.affiliations.recordedInstitution(
          post.account_id,
          scope.affiliationAssertionId,
          post.published_at,
          tx,
        )
      : null;
    return {
      authorSchool: institution
        ? await this.campuses.institutionName(institution, tx)
        : null,
      hasContacts: Object.values(definition.data.contacts).some(
        (v) => v.trim().length > 0,
      ),
    };
  }
}
