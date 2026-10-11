import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError, z } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { ProfileAdminParticipantFacade } from '../../profile/admin-participant.facade.js';
import {
  DirectoryRepository,
  literalDirectoryPattern,
} from '../directory/repository.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { OrganizationMediaService } from '../media/facade.js';
import { organizationMediaSlotSchema } from '../media/contracts.js';
import type { OrganizationMediaBindings } from '../media/contracts.js';
import { OrganizationAccess } from './access.js';
import type { OrganizationRow, OrganizationAuthority } from './access.js';
import {
  lockOrganization,
  requireOrganizationCurrent,
  requireOrganizationDirectoryCurrent,
} from './current-proof.js';
import {
  organizationCommandHash,
  organizationReceiptSchema,
  organizationRecoverySchema,
  organizationDetailSchema,
  organizationListItemSchema,
  organizationListSchema,
  organizationPublicDetailSchema,
  organizationPersonSchema,
} from './contracts.js';
import type {
  OrganizationCommand,
  CreateOrganization,
  SaveOrganization,
  ReviewOrganization,
  OrganizationMemberCommand,
  OrganizationData,
  OrganizationReceipt,
  OrganizationListQuery,
  OrganizationListItem,
} from './contracts.js';
const listPosition = z.strictObject({
  v: z.literal(1),
  kind: z.literal('native-organizations'),
  epoch: z.string().regex(/^[1-9][0-9]*$/),
  after: z.uuid(),
});
const unavailable = () => {
  throw new ApplicationError('ORGANIZATION_UNAVAILABLE');
};
export function requireOrganizationImages(
  data: OrganizationData,
  bindings: OrganizationMediaBindings,
) {
  if (
    !bindings.avatar ||
    !bindings.mainQr ||
    (data.platform === 'wechat' && !bindings.managerContact)
  )
    throw new ApplicationError('ORGANIZATION_MEDIA_REQUIRED');
  if (
    (data.platform !== 'wechat' && bindings.managerContact) ||
    (data.platform === 'official' && bindings.linkedOfficialQr)
  )
    throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
}
function item(
  row: OrganizationRow,
  role: OrganizationListItem['role'],
): OrganizationListItem {
  return organizationListItemSchema.parse({
    source: 'managed',
    id: row.id,
    regionId: row.region_id,
    revision: Number(row.revision),
    authorityVersion: Number(row.authority_version),
    state: row.state,
    data: row.data,
    role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OrganizationAccess) readonly access: OrganizationAccess,
    @Inject(DirectoryRepository) private readonly taxonomy: DirectoryRepository,
    @Inject(ProfileAdminParticipantFacade)
    private readonly profiles: ProfileAdminParticipantFacade,
    @Inject(OrganizationMediaService)
    private readonly media: OrganizationMediaService,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  private async run<T>(work: (tx: PoolClient) => Promise<T>) {
    try {
      return await this.database.transaction(
        async (tx) => {
          await tx.query("SET LOCAL lock_timeout='500ms'");
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof ZodError ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['57014', '55P03', '23514'].includes(String(error.code)))
      )
        throw new ApplicationError('ORGANIZATION_UNAVAILABLE');
      throw error;
    }
  }
  private async requestLock(actor: string, key: string, tx: PoolClient) {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('whaleu:organization-request:v1:'||$1||':'||$2,0))`,
      [actor, key],
    );
  }
  private async recorded(actor: string, key: string, tx: PoolClient) {
    const row = (
      await tx.query<{ receipt: unknown }>(
        'SELECT receipt FROM whaleu_organizations.organization_requests WHERE actor_id=$1 AND client_request_id=$2',
        [actor, key],
      )
    ).rows[0];
    return row ? organizationReceiptSchema.parse(row.receipt) : null;
  }
  private async cancelled(actor: string, key: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM whaleu_organizations.organization_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor, key],
        )
      ).rows[0]?.request_hash ?? null
    );
  }
  private async command(
    token: string,
    id: string,
    command: OrganizationCommand,
    work: (
      actor: string,
      hash: string,
      tx: PoolClient,
    ) => Promise<OrganizationReceipt>,
  ) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx, true),
        actor = session.accountId,
        hash = organizationCommandHash(actor, id, command);
      await this.requestLock(actor, command.clientRequestId, tx);
      const prior = await this.recorded(actor, command.clientRequestId, tx);
      if (prior) {
        if (prior.requestHash !== hash)
          throw new ApplicationError('ORGANIZATION_REQUEST_CONFLICT');
        return prior;
      }
      const fence = await this.cancelled(actor, command.clientRequestId, tx);
      if (fence !== null)
        throw new ApplicationError(
          fence === hash
            ? 'ORGANIZATION_CANCELLED'
            : 'ORGANIZATION_REQUEST_CONFLICT',
        );
      const result = await work(actor, hash, tx);
      await this.access.recheck(token, tx);
      await requireOrganizationCurrent(id, tx);
      return result;
    });
  }
  private cas(row: OrganizationRow, command: OrganizationCommand) {
    if (
      Number(row.revision) !== command.expectedRevision ||
      Number(row.authority_version) !== command.expectedAuthorityVersion
    )
      throw new ApplicationError('ORGANIZATION_REVISION_CONFLICT');
  }
  private async category(
    region: string,
    data: OrganizationData,
    tx: PoolClient,
  ) {
    const catalog = await this.taxonomy.catalog(region, data.kind, tx);
    await this.taxonomy.category(catalog, data.categoryId, tx);
    return catalog.taxonomyId;
  }
  private async publish(
    input: {
      actor: string;
      hash: string;
      command: OrganizationCommand;
      row: OrganizationRow;
      authority: OrganizationAuthority;
      data: OrganizationData;
      bindings: OrganizationMediaBindings;
      state: OrganizationRow['state'];
      outcome: OrganizationReceipt['outcome'];
      changed?: boolean;
      target?: string;
      previousOwner?: string;
      taxonomyId?: string;
    },
    tx: PoolClient,
    afterEvent?: (eventId: string) => Promise<void>,
  ) {
    const { actor, hash, command, row, authority } = input;
    const revision =
        Number(row.revision) +
        (command.action === 'save' || command.action === 'submit' ? 1 : 0),
      authorityVersion =
        Number(row.authority_version) +
        ([
          'approve',
          'reject',
          'add_admin',
          'remove_admin',
          'transfer_owner',
        ].includes(command.action)
          ? 1
          : 0),
      eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_organizations.organization_events(id,organization_id,actor_id,client_request_id,action,prior_revision,revision,prior_authority_version,authority_version,source_role,source_grant_id,target_account_id,previous_owner_id,data,media_bindings,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17)`,
      [
        eventId,
        row.id,
        actor,
        command.clientRequestId,
        command.action,
        Number(row.revision),
        revision,
        Number(row.authority_version),
        authorityVersion,
        authority.role,
        authority.grantId,
        input.target ?? null,
        input.previousOwner ?? null,
        JSON.stringify(input.data),
        JSON.stringify(input.bindings),
        input.state,
        command.action === 'reject' ? command.reason : null,
      ],
    );
    if (afterEvent) await afterEvent(eventId);
    if (command.action !== 'create')
      await tx.query(
        `UPDATE whaleu_organizations.organizations SET revision=$2,authority_version=$3,state=$4,data=$5::jsonb,media_bindings=$6::jsonb,category_id=$7,taxonomy_revision_id=$8,first_approval_id=CASE WHEN $9='approve' THEN $10::uuid ELSE first_approval_id END,review_reason=CASE WHEN $9='reject' THEN $11 WHEN $9 IN ('submit','approve') THEN NULL ELSE review_reason END,updated_at=transaction_timestamp() WHERE id=$1`,
        [
          row.id,
          revision,
          authorityVersion,
          input.state,
          JSON.stringify(input.data),
          JSON.stringify(input.bindings),
          input.data.categoryId,
          input.taxonomyId ?? row.taxonomy_revision_id,
          command.action,
          eventId,
          command.action === 'reject' ? command.reason : null,
        ],
      );
    const receipt = organizationReceiptSchema.parse({
      requestId: command.clientRequestId,
      requestHash: hash,
      organizationId: row.id,
      revision,
      authorityVersion,
      outcome: input.outcome,
      changed: input.changed ?? true,
    });
    await tx.query(
      `INSERT INTO whaleu_organizations.organization_requests(actor_id,client_request_id,organization_id,command,request_hash,event_id,receipt) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)`,
      [
        actor,
        command.clientRequestId,
        row.id,
        JSON.stringify(command),
        hash,
        eventId,
        JSON.stringify(receipt),
      ],
    );
    return receipt;
  }
  create(token: string, command: CreateOrganization) {
    return this.command(
      token,
      command.organizationId,
      command,
      async (actor, hash, tx) => {
        await this.access.home(actor, command.regionId, tx);
        const taxonomyId = await this.category(
          command.regionId,
          command.data,
          tx,
        );
        await lockOrganization(command.organizationId, tx);
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_organizations.organizations WHERE id=$1',
              [command.organizationId],
            )
          ).rowCount
        )
          throw new ApplicationError('ORGANIZATION_REQUEST_CONFLICT');
        const row = (
          await tx.query<OrganizationRow>(
            `INSERT INTO whaleu_organizations.organizations(id,region_id,applicant_account_id,revision,authority_version,state,taxonomy_revision_id,category_id,data) VALUES($1,$2,$3,1,1,'draft',$4,$5,$6::jsonb) RETURNING *`,
            [
              command.organizationId,
              command.regionId,
              actor,
              taxonomyId,
              command.data.categoryId,
              JSON.stringify(command.data),
            ],
          )
        ).rows[0]!;
        return this.publish(
          {
            actor,
            hash,
            command,
            row,
            authority: { role: 'applicant', grantId: null },
            data: command.data,
            bindings: {},
            state: 'draft',
            outcome: 'created',
          },
          tx,
        );
      },
    );
  }
  save(token: string, id: string, command: SaveOrganization) {
    return this.command(token, id, command, async (actor, hash, tx) => {
      const row = await this.access.row(id, tx, true);
      this.cas(row, command);
      const authority = await this.access.editable(actor, row, tx);
      // Platform and kind are stable identities. A different service is a new application.
      if (
        command.data.platform !== row.data.platform ||
        command.data.kind !== row.data.kind
      )
        throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
      if (
        command.action === 'submit' &&
        !['draft', 'rejected'].includes(row.state)
      )
        throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
      const taxonomyId = await this.category(row.region_id, command.data, tx);
      const bindings = await this.media.mutate(
        {
          actorAccountId: actor,
          organizationId: id,
          applicationRevision: Number(row.revision),
          currentBindings: row.media_bindings,
          changes: command.mediaChanges,
        },
        tx,
      );
      const state = command.action === 'submit' ? 'pending' : row.state;
      if (state === 'pending' || state === 'approved')
        requireOrganizationImages(command.data, bindings);
      return this.publish(
        {
          actor,
          hash,
          command,
          row,
          authority,
          data: command.data,
          bindings,
          state,
          outcome: command.action === 'submit' ? 'submitted' : 'saved',
          taxonomyId,
        },
        tx,
      );
    });
  }
  review(
    token: string,
    id: string,
    regionId: string,
    command: ReviewOrganization,
  ) {
    return this.command(token, id, command, async (actor, hash, tx) => {
      const row = await this.access.row(id, tx, true);
      this.cas(row, command);
      if (row.region_id !== regionId)
        throw new ApplicationError('AUTHORIZATION_REQUIRED');
      const authority = await this.access.reviewer(actor, row, tx);
      if (row.state !== 'pending' || row.first_approval_id !== null)
        throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
      await this.category(row.region_id, row.data, tx);
      if (command.action === 'approve') {
        await this.access.home(row.applicant_account_id, row.region_id, tx);
        requireOrganizationImages(row.data, row.media_bindings);
        await this.media.requireCurrentBindings(id, row.media_bindings, tx);
      }
      return this.publish(
        {
          actor,
          hash,
          command,
          row,
          authority,
          data: row.data,
          bindings: row.media_bindings,
          state: command.action === 'approve' ? 'approved' : 'rejected',
          outcome: command.action === 'approve' ? 'approved' : 'rejected',
        },
        tx,
        async (eventId) => {
          if (command.action === 'approve')
            await tx.query(
              `INSERT INTO whaleu_organizations.organization_grants(id,organization_id,account_id,role,source_event_id) VALUES($1,$2,$3,'organization_owner',$4)`,
              [randomUUID(), id, row.applicant_account_id, eventId],
            );
        },
      );
    });
  }
  member(token: string, id: string, command: OrganizationMemberCommand) {
    return this.command(token, id, command, async (actor, hash, tx) => {
      const row = await this.access.row(id, tx, true);
      this.cas(row, command);
      const authority = await this.access.authority(actor, row, tx);
      if (
        row.state !== 'approved' ||
        (command.action === 'transfer_owner' &&
          authority.role === 'organization_admin')
      )
        throw new ApplicationError('AUTHORIZATION_REQUIRED');
      const target = await this.profiles.resolve(command.targetProfileId, tx);
      if (!target) throw new ApplicationError('ORGANIZATION_MEMBER_NOT_FOUND');
      if (target.accountId === actor && command.action !== 'remove_admin')
        throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
      if (command.action !== 'remove_admin')
        await this.requireMemberHome(target.accountId, row.region_id, tx);
      const members = await this.access.grants(id, tx),
        existing = members.find((g) => g.account_id === target.accountId),
        owner = members.find((g) => g.role === 'organization_owner');
      if (
        !owner ||
        members.filter((g) => g.role === 'organization_owner').length !== 1
      )
        unavailable();
      if (
        command.action === 'remove_admin' &&
        existing?.role === 'organization_owner'
      )
        throw new ApplicationError('ORGANIZATION_OWNER_PROTECTED');
      if (
        command.action === 'transfer_owner' &&
        owner!.account_id === target.accountId
      )
        throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
      if (
        (command.action === 'add_admin' ||
          command.action === 'transfer_owner') &&
        !existing &&
        members.length >= 100
      )
        throw new ApplicationError('ORGANIZATION_MEMBER_LIMIT');
      const changed =
        command.action === 'add_admin'
          ? !existing
          : command.action === 'remove_admin'
            ? !!existing
            : true;
      return this.publish(
        {
          actor,
          hash,
          command,
          row,
          authority,
          data: row.data,
          bindings: row.media_bindings,
          state: row.state,
          outcome:
            command.action === 'add_admin'
              ? 'admin_added'
              : command.action === 'remove_admin'
                ? 'admin_removed'
                : 'owner_transferred',
          changed,
          target: target.accountId,
          ...(command.action === 'transfer_owner'
            ? { previousOwner: owner!.account_id }
            : {}),
        },
        tx,
        async (eventId) => {
          if (!changed) return;
          if (command.action === 'remove_admin')
            await tx.query(
              `UPDATE whaleu_organizations.organization_grants SET revoked_at=transaction_timestamp(),revoke_event_id=$2,version=version+1 WHERE id=$1`,
              [existing!.id, eventId],
            );
          else {
            if (command.action === 'transfer_owner')
              await tx.query(
                `UPDATE whaleu_organizations.organization_grants SET revoked_at=transaction_timestamp(),revoke_event_id=$3,version=version+1 WHERE organization_id=$1 AND revoked_at IS NULL AND (role='organization_owner' OR account_id=$2)`,
                [id, target.accountId, eventId],
              );
            await tx.query(
              `INSERT INTO whaleu_organizations.organization_grants(id,organization_id,account_id,role,source_event_id) VALUES($1,$2,$3,$4,$5)`,
              [
                randomUUID(),
                id,
                target.accountId,
                command.action === 'transfer_owner'
                  ? 'organization_owner'
                  : 'organization_admin',
                eventId,
              ],
            );
            if (command.action === 'transfer_owner')
              await tx.query(
                `INSERT INTO whaleu_organizations.organization_grants(id,organization_id,account_id,role,source_event_id) VALUES($1,$2,$3,'organization_admin',$4)`,
                [randomUUID(), id, owner!.account_id, eventId],
              );
          }
        },
      );
    });
  }
  private async requireMemberHome(
    accountId: string,
    regionId: string,
    tx: PoolClient,
  ) {
    try {
      await this.access.home(accountId, regionId, tx);
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'DIRECTORY_SCOPE_UNAVAILABLE',
          'AFFILIATION_VERIFICATION_REQUIRED',
          'PHONE_VERIFICATION_REQUIRED',
          'IDENTITY_CAMPUS_REQUIRED',
        ].includes(error.code)
      )
        throw new ApplicationError('ORGANIZATION_MEMBER_NOT_FOUND');
      throw error;
    }
  }
  lookup(token: string, id: string, profileId: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        row = await this.access.row(id, tx);
      await this.access.authority(s.accountId, row, tx);
      const target = await this.profiles.resolve(profileId, tx);
      if (!target) throw new ApplicationError('ORGANIZATION_MEMBER_NOT_FOUND');
      await this.requireMemberHome(target.accountId, row.region_id, tx);
      await requireOrganizationCurrent(id, tx);
      await this.access.recheck(token, tx);
      return organizationPersonSchema.parse({
        profileId: target.profileId,
        displayName: target.displayName,
      });
    });
  }
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        row = await this.access.row(id, tx),
        authority = await this.access.authority(
          session.accountId,
          row,
          tx,
          true,
        ),
        members = await this.access.grants(id, tx),
        profiles = await this.profiles.batch(
          members.map((m) => m.account_id),
          tx,
        );
      const admin = ['school_admin', 'super_admin'].includes(authority.role),
        editable =
          row.state !== 'pending' &&
          (authority.role !== 'applicant' || row.first_approval_id === null);
      await this.access.recheck(token, tx);
      await requireOrganizationCurrent(id, tx);
      return organizationDetailSchema.parse({
        ...item(row, authority.role),
        mediaBindings: row.media_bindings,
        reviewReason: row.review_reason,
        members: members.map((m) => {
          const p = profiles.get(m.account_id);
          return {
            profile:
              p?.status === 'available'
                ? { profileId: p.profileId, displayName: p.displayName }
                : null,
            role: m.role,
            grantId: m.id,
            validFrom: m.valid_from.toISOString(),
            validUntil: m.expires_at?.toISOString() ?? null,
          };
        }),
        permissions: {
          edit: editable,
          submit: editable && ['draft', 'rejected'].includes(row.state),
          review: admin && row.state === 'pending',
          manageMembers:
            authority.role !== 'applicant' && row.state === 'approved',
          transferOwner:
            authority.role !== 'applicant' &&
            authority.role !== 'organization_admin' &&
            row.state === 'approved',
        },
      });
    });
  }
  publicDetail(token: string, regionId: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.access.home(session.accountId, regionId, tx);
      const row = await this.access.row(id, tx);
      if (row.region_id !== regionId || row.state !== 'approved')
        throw new ApplicationError('ORGANIZATION_NOT_FOUND');
      await this.category(regionId, row.data, tx);
      await this.media.requireCurrentBindings(id, row.media_bindings, tx);
      const available = await this.access.canManage(session.accountId, row, tx);
      const bindings: OrganizationMediaBindings = {};
      for (const slot of organizationMediaSlotSchema.options)
        if (slot !== 'managerContact' && row.media_bindings[slot])
          bindings[slot] = row.media_bindings[slot];
      await requireOrganizationCurrent(id, tx);
      await this.access.recheck(token, tx);
      return organizationPublicDetailSchema.parse({
        ...item(row, 'reader'),
        mediaBindings: bindings,
        management: { available },
      });
    });
  }
  context(token: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        home = await this.access.home(s.accountId, null, tx);
      return { regionId: home.identityRegionId };
    });
  }
  capabilities(token: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx);
      await this.access.base(s.accountId, tx);
      return this.access.schools.capabilities(token, tx);
    });
  }
  list(
    token: string,
    mode: 'mine' | 'review' | 'public',
    regionId: string | undefined,
    query: OrganizationListQuery,
  ) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.access.base(session.accountId, tx);
      let region: string | null = null,
        managementRole: 'school_admin' | 'super_admin' | null = null;
      if (mode === 'review') {
        const scope = await this.access.schools.authorizeAccount(
          session.accountId,
          regionId,
          tx,
        );
        region = scope.region.id;
        managementRole =
          scope.management === 'global' ? 'super_admin' : 'school_admin';
      } else if (mode === 'public') {
        if (!regionId)
          throw new ApplicationError('DIRECTORY_SCOPE_UNAVAILABLE');
        const home = await this.access.home(session.accountId, regionId, tx);
        region = home.identityRegionId;
      }
      const epoch = (
        await tx.query<{ revision: string }>(
          'SELECT revision FROM whaleu_organizations.native_directory_epoch WHERE singleton FOR SHARE',
        )
      ).rows[0]?.revision;
      if (!epoch) unavailable();
      const scope = discoveryContinuationScope([
        'native-organizations',
        1,
        mode,
        session.accountId,
        session.sessionId,
        region,
        query.kind ?? null,
        query.categoryId ?? null,
        query.q ?? null,
        query.limit,
        epoch,
      ]);
      let after: string | null = null;
      if (query.cursor) {
        const position = await this.cursors.get(query.cursor, scope, tx, (v) =>
          listPosition.parse(v),
        );
        if (position.epoch !== epoch)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        after = position.after;
      }
      const rows = (
        await tx.query<OrganizationRow>(
          `SELECT o.* FROM whaleu_organizations.organizations o WHERE ($1::uuid IS NULL OR o.region_id=$1) AND ($2::text IS NULL OR o.data->>'kind'=$2) AND ($3::uuid IS NULL OR o.category_id=$3) AND ($4::text IS NULL OR translate(o.data->>'name','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C" LIKE translate($4,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C" ESCAPE E'\\\\') AND ($5::uuid IS NULL OR o.id>$5) AND (CASE WHEN $6='public' THEN o.state='approved' WHEN $6='review' THEN o.state='pending' ELSE (o.applicant_account_id=$7 AND o.first_approval_id IS NULL) OR EXISTS(SELECT 1 FROM whaleu_organizations.organization_grants g WHERE g.organization_id=o.id AND g.account_id=$7 AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())) END) ORDER BY o.id LIMIT $8 FOR SHARE`,
          [
            region,
            query.kind ?? null,
            query.categoryId ?? null,
            query.q === undefined ? null : literalDirectoryPattern(query.q),
            after,
            mode,
            session.accountId,
            query.limit + 1,
          ],
        )
      ).rows;
      const items: OrganizationListItem[] = [];
      for (const row of rows.slice(0, query.limit)) {
        if (mode === 'public') {
          await this.category(row.region_id, row.data, tx);
          await this.media.requireCurrentBindings(
            row.id,
            row.media_bindings,
            tx,
          );
          items.push(item(row, 'reader'));
        } else if (mode === 'review') items.push(item(row, managementRole!));
        else {
          const authority = await this.access.authority(
            session.accountId,
            row,
            tx,
            true,
          );
          items.push(item(row, authority.role));
        }
        await requireOrganizationCurrent(row.id, tx);
      }
      const more = rows.length > query.limit;
      const nextCursor = more
        ? await this.cursors.create(
            scope,
            session.accountId,
            {
              v: 1,
              kind: 'native-organizations',
              epoch,
              after: rows[query.limit - 1]!.id,
            },
            tx,
          )
        : null;
      await requireOrganizationDirectoryCurrent(tx);
      await this.access.recheck(token, tx);
      return organizationListSchema.parse({
        items,
        continuation: more ? 'more' : 'end',
        nextCursor,
      });
    });
  }
  recover(token: string, requestId: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        receipt = await this.recorded(s.accountId, requestId, tx),
        cancelled = receipt
          ? null
          : await this.cancelled(s.accountId, requestId, tx);
      return organizationRecoverySchema.parse(
        receipt
          ? { state: 'recorded', requestId, receipt }
          : cancelled
            ? { state: 'cancelled', requestId, requestHash: cancelled }
            : { state: 'not_recorded', requestId },
      );
    });
  }
  cancel(token: string, requestId: string, requestHash: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx, true);
      await this.requestLock(s.accountId, requestId, tx);
      const receipt = await this.recorded(s.accountId, requestId, tx);
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ApplicationError('ORGANIZATION_REQUEST_CONFLICT');
        return organizationRecoverySchema.parse({
          state: 'recorded',
          requestId,
          receipt,
        });
      }
      const previous = await this.cancelled(s.accountId, requestId, tx);
      if (previous !== null && previous !== requestHash)
        throw new ApplicationError('ORGANIZATION_REQUEST_CONFLICT');
      if (previous === null)
        await tx.query(
          'INSERT INTO whaleu_organizations.organization_cancel_fences(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
          [s.accountId, requestId, requestHash],
        );
      return organizationRecoverySchema.parse({
        state: 'cancelled',
        requestId,
        requestHash,
      });
    });
  }
}
