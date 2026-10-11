import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../../identity/identity.service.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { SafetyRepository } from '../../safety/repository.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { AnnouncementsAccessService } from '../access.js';
import { requireNativeCurrent, lockNative } from './current-proof.js';
import { audienceSchema, contentSchema } from './contracts.js';
import type {
  AnnouncementContent,
  AnnouncementAudience,
  AnnouncementAudienceInput,
} from './contracts.js';
import type {
  AnnouncementMediaAccessPort,
  AnnouncementMediaReadTarget,
} from '../media/access-port.js';
import type { AnnouncementMediaBindings } from '../media/contracts.js';
export interface NativeAnnouncementRow {
  id: string;
  creator_id: string;
  ordinal: string;
  revision: string;
  revision_id: string;
  state: 'draft' | 'active' | 'inactive' | 'cancelled';
  content: AnnouncementContent;
  audience: AnnouncementAudience;
  media_bindings: AnnouncementMediaBindings;
  publication_hash: string;
  created_at: Date;
  updated_at: Date;
}
@Injectable()
export class AnnouncementAuthoringAccess implements AnnouncementMediaAccessPort {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(AuthorizationService) readonly authorization: AuthorizationService,
    @Inject(SafetyRepository) readonly safety: SafetyRepository,
    @Inject(AnnouncementsAccessService)
    readonly reads: AnnouncementsAccessService,
  ) {}
  async authenticate(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    return this.identity.session(token, tx);
  }
  async manager(accountId: string, tx: PoolClient) {
    await this.safety.restriction(accountId, tx);
    await requireNativeCurrent('authority', accountId, tx);
    const grants = await this.authorization.grants(accountId, tx);
    const global = grants
      .filter((g) => g.role === 'super_admin' && g.operatingRegionId === null)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const schools = grants.filter(
      (g) => g.role === 'school_admin' && g.operatingRegionId !== null,
    );
    if (!global && schools.length !== 1)
      throw new ApplicationError(
        schools.length ? 'AUTHORIZATION_UNAVAILABLE' : 'AUTHORIZATION_REQUIRED',
      );
    const grant = global ?? schools[0]!;
    registerTransactionDeadline(
      tx,
      grant.validUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    return {
      grant,
      management: global ? ('global' as const) : ('fixed' as const),
    };
  }
  async audience(
    accountId: string,
    input: AnnouncementAudienceInput,
    tx: PoolClient,
  ) {
    const auth = await this.manager(accountId, tx);
    if (auth.management === 'fixed' && input.kind !== 'fixed')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    if (auth.management === 'global' && input.kind === 'fixed')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    if (input.kind === 'all')
      return {
        ...auth,
        audience: audienceSchema.parse({
          kind: 'all',
          regionIds: [],
          campusIds: [],
        }),
      };
    const regionIds = (
      input.kind === 'fixed' ? [auth.grant.operatingRegionId!] : input.regionIds
    )
      .slice()
      .sort();
    const regions = (
      await tx.query<{ id: string; name: string }>(
        'SELECT id,name FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) AND is_active ORDER BY id FOR SHARE',
        [regionIds],
      )
    ).rows;
    if (regions.length !== regionIds.length)
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    const mapping = (
      await tx.query<{ id: string; region_id: string }>(
        'SELECT c.id,a.operating_region_id region_id FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.campuses c ON c.id=a.campus_id WHERE a.operating_region_id=ANY($1::uuid[]) AND c.is_active ORDER BY c.id FOR SHARE OF a,c',
        [regionIds],
      )
    ).rows;
    if (
      mapping.length > 4096 ||
      regionIds.some((id) => !mapping.some((m) => m.region_id === id))
    )
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    await requireNativeCurrent('mapping', JSON.stringify(regionIds), tx);
    return {
      ...auth,
      audience: audienceSchema.parse({
        kind: 'regions',
        regionIds,
        campusIds: mapping.map((m) => m.id),
      }),
    };
  }
  async row(id: string, tx: PoolClient, write = false) {
    if (write) await lockNative(id, tx);
    const row = (
      await tx.query<NativeAnnouncementRow>(
        `SELECT * FROM whaleu_announcements.native_announcements WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
    contentSchema.parse(row.content);
    audienceSchema.parse(row.audience);
    return row;
  }
  async requireEditor(
    accountId: string,
    row: NativeAnnouncementRow,
    tx: PoolClient,
  ) {
    const auth = await this.manager(accountId, tx);
    if (
      row.state === 'cancelled' ||
      (row.state === 'draft' && row.creator_id !== accountId) ||
      (row.creator_id !== accountId && auth.management !== 'global') ||
      (auth.management === 'fixed' &&
        (row.audience.kind !== 'regions' ||
          row.audience.regionIds.length !== 1 ||
          row.audience.regionIds[0] !== auth.grant.operatingRegionId))
    )
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return auth;
  }
  async publicRow(
    token: string | null,
    id: string,
    campusId: string | null,
    tx: PoolClient,
  ) {
    const session = await this.reads.resolve(token, campusId, tx),
      row = await this.row(id, tx);
    if (
      row.state !== 'active' ||
      (row.audience.kind !== 'all' &&
        (campusId === null || !row.audience.campusIds.includes(campusId)))
    )
      throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
    await requireNativeCurrent('entry', id, tx);
    return { row, session };
  }
  async authorizeMediaActor(
    actor: string,
    id: string,
    revision: number,
    tx: PoolClient,
  ) {
    const row = await this.row(id, tx, true);
    if (Number(row.revision) !== revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const auth = await this.requireEditor(actor, row, tx);
    return {
      actorAccountId: actor,
      announcementId: id,
      revision,
      authorityVersion: auth.grant.id,
    };
  }
  retainMediaCurrent(id: string, tx: PoolClient) {
    return requireNativeCurrent('entry', id, tx);
  }
  async authorizeMediaRead(
    token: string | null,
    target: AnnouncementMediaReadTarget,
    tx: PoolClient,
  ) {
    if (target.audience === 'public') {
      const { row, session } = await this.publicRow(
        token,
        target.announcementId,
        target.campusId,
        tx,
      );
      if (Number(row.revision) !== target.revision)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        accountId: session?.accountId ?? null,
        sessionId: session?.sessionId ?? null,
        authorityVersion: row.publication_hash,
      };
    }
    if (token === null) throw new ApplicationError('AUTHENTICATION_REQUIRED');
    const session = await this.authenticate(token, tx),
      row = await this.row(target.announcementId, tx);
    if (Number(row.revision) !== target.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const auth = await this.requireEditor(session.accountId, row, tx);
    await this.retainMediaCurrent(row.id, tx);
    return { ...session, authorityVersion: auth.grant.id };
  }
}
