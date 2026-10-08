import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { bearerToken } from '../identity/tokens.js';
import { CampusService } from '../campus/campus.service.js';
import { SafetyAnnouncementReadFacade } from '../safety/announcement-read.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
export function optionalAnnouncementBearer(header: unknown): string | null {
  return header === undefined ? null : bearerToken(header);
}
@Injectable()
export class AnnouncementsAccessService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(SafetyAnnouncementReadFacade)
    private readonly safety: SafetyAnnouncementReadFacade,
  ) {}
  async resolve(token: string | null, campusId: string | null, tx: PoolClient) {
    await tx.query(
      "SELECT set_config('lock_timeout', CASE WHEN current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '500 milliseconds' THEN '500ms' ELSE current_setting('lock_timeout') END,true)",
    );
    await lockSafetyPolicy(tx);
    const session =
      token === null ? null : await this.identity.session(token, tx);
    if (session)
      await this.safety.requireAnnouncementReadAllowed(session.accountId, tx);
    if (campusId !== null) await this.campuses.requireSelectable(campusId, tx);
    return session;
  }
  async recheck(token: string | null, tx: PoolClient) {
    if (token !== null) await this.identity.session(token, tx);
  }
}
