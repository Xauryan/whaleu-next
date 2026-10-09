import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { DmVerificationFacade } from '../verification/dm-eligibility.facade.js';
import { DmSafetyFacade } from '../safety/dm.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ApplicationError } from '../http/application-error.js';
@Injectable()
export class MessagingAccess {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(DmVerificationFacade)
    private readonly verification: DmVerificationFacade,
    @Inject(DmSafetyFacade) readonly safety: DmSafetyFacade,
  ) {}
  async authenticate(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    return this.identity.session(token, tx);
  }
  async require(actor: string, tx: PoolClient, phone = true) {
    if (!(await this.identity.activeAccount(actor, tx)))
      throw new ApplicationError('DM_NOT_FOUND');
    await this.verification.require(actor, tx, { phone });
    await this.safety.requireActor(actor, tx);
  }
  async final(token: string, tx: PoolClient) {
    await this.identity.session(token, tx);
  }
}
