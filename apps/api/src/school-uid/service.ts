import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { SchoolUidProjectionFacade } from './projection.facade.js';
import { retainManagementIdentity } from '../authorization/school-admin-management/proof.js';
import { hashToken } from '../identity/tokens.js';
@Injectable()
export class SchoolUidService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SchoolUidProjectionFacade)
    private readonly projection: SchoolUidProjectionFacade,
  ) {}
  @AccountPolicy('private_self_service', 'entry')
  own(token: string) {
    return this.db.transaction(
      async (tx) => {
        const session = await this.identity.session(token, tx);
        await retainManagementIdentity(
          {
            actor: session.accountId,
            sessionId: session.sessionId,
            tokenHash: hashToken(token),
          },
          tx,
        );
        return this.projection.required(session.accountId, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
