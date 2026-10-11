import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  OrganizationAccess,
  organizationAuthorityVersion,
} from '../../organizations/management/access.js';
import { requireOrganizationCurrent } from '../../organizations/management/current-proof.js';
import type {
  ActivityMediaAccessPort,
  ActivityMediaReadTarget,
} from '../media/access-port.js';
import type { ActivityMediaBindings } from '../media/contracts.js';
import type { ActivityPublicationContent } from './contracts.js';
import { activityPublicationContentSchema } from './contracts.js';
import { lockActivity, requireActivityCurrent } from './current-proof.js';
import { ActivityReviewService } from './review.js';
export interface ActivityDraftRow {
  id: string;
  account_id: string;
  organization_id: string;
  organization_revision: string;
  authority_version: string;
  region_id: string;
  revision: string;
  state: 'draft' | 'published' | 'cancelled';
  content: ActivityPublicationContent;
  media_bindings: ActivityMediaBindings;
}
export interface NativeActivityRow {
  id: string;
  original_publisher_account_id: string;
  organization_id: string;
  organization_revision: string;
  region_id: string;
  revision: string;
  organizer_label: string;
  content: ActivityPublicationContent;
  media_bindings: ActivityMediaBindings;
  organizer_qr: {
    organizationId: string;
    applicationRevision: number;
    slot: 'mainQr';
    bindingId: string;
    assetId: string;
    manifestDigest: string;
  } | null;
  review_decision_id: string;
  created_at: Date;
  ordinal: string;
}
@Injectable()
export class ActivityPublicationAccess implements ActivityMediaAccessPort {
  constructor(
    @Inject(OrganizationAccess) readonly organizations: OrganizationAccess,
    @Inject(ActivityReviewService) readonly review: ActivityReviewService,
  ) {}
  authenticate(token: string, tx: PoolClient, write = false) {
    return this.organizations.authenticate(token, tx, write);
  }
  recheck(token: string, tx: PoolClient) {
    return this.organizations.recheck(token, tx);
  }
  async manager(
    actor: string,
    id: string,
    revision: number | null,
    tx: PoolClient,
  ) {
    const row = await this.organizations.row(id, tx);
    await this.organizations.home(actor, row.region_id, tx);
    if (
      row.state !== 'approved' ||
      (revision !== null && Number(row.revision) !== revision)
    )
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    // A school reviewer is not a publisher. Check real target grant even when the
    // same account also happens to have global/school administrative authority.
    const grant = (await this.organizations.grants(id, tx)).find(
      (g) => g.account_id === actor,
    );
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const authority = { role: grant.role, grantId: grant.id };
    await requireOrganizationCurrent(id, tx);
    return {
      row,
      grant,
      authorityVersion: organizationAuthorityVersion(row, authority),
    };
  }
  async draft(id: string, tx: PoolClient, write = false) {
    await lockActivity(id, tx);
    const row = (
      await tx.query<ActivityDraftRow>(
        `SELECT * FROM whaleu_activities.publication_drafts WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ACTIVITY_NOT_FOUND');
    activityPublicationContentSchema.parse(row.content);
    return row;
  }
  async requireDraft(actor: string, row: ActivityDraftRow, tx: PoolClient) {
    if (row.account_id !== actor || row.state !== 'draft')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const owner = await this.manager(
      actor,
      row.organization_id,
      Number(row.organization_revision),
      tx,
    );
    if (owner.authorityVersion !== row.authority_version)
      throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
    return owner;
  }
  async native(id: string, actor: string, tx: PoolClient) {
    const row = (
      await tx.query<NativeActivityRow>(
        'SELECT * FROM whaleu_activities.native_activities WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ACTIVITY_NOT_FOUND');
    await this.organizations.home(actor, row.region_id, tx);
    const org = await this.organizations.row(row.organization_id, tx);
    if (org.state !== 'approved' || org.region_id !== row.region_id)
      throw new ApplicationError('ACTIVITY_NOT_FOUND');
    await requireOrganizationCurrent(org.id, tx);
    await requireActivityCurrent('native', id, tx);
    const envelope = await this.review.published(
      row.review_decision_id,
      row.id,
      tx,
    );
    if (
      envelope.accountId !== row.original_publisher_account_id ||
      envelope.organization.organizationId !== row.organization_id
    )
      throw new ApplicationError('ACTIVITY_UNAVAILABLE');

    return row;
  }
  async authorizeMediaActor(
    actor: string,
    id: string,
    revision: number,
    tx: PoolClient,
  ) {
    const row = await this.draft(id, tx, true);
    if (Number(row.revision) !== revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.requireDraft(actor, row, tx);
    return {
      actorAccountId: actor,
      activityId: id,
      revision,
      organizationId: row.organization_id,
      organizationRevision: Number(row.organization_revision),
      authorityVersion: row.authority_version,
    };
  }
  async retainMediaCurrent(id: string, tx: PoolClient) {
    await requireActivityCurrent('draft', id, tx);
  }
  async authorizeMediaRead(
    token: string,
    target: ActivityMediaReadTarget,
    tx: PoolClient,
  ) {
    const session = await this.authenticate(token, tx);
    if (target.audience === 'public') {
      const row = await this.native(target.activityId, session.accountId, tx);
      if (Number(row.revision) !== target.revision)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        ...session,
        authorityVersion: `published:${row.review_decision_id}`,
      };
    }
    const row = await this.draft(target.activityId, tx);
    if (Number(row.revision) !== target.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.requireDraft(session.accountId, row, tx);
    await requireActivityCurrent('draft', row.id, tx);
    return { ...session, authorityVersion: row.authority_version };
  }
}
