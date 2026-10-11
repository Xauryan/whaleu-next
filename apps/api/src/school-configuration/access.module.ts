import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { SchoolConfigurationAccess } from './access.js';
/** Shared current school authority, without school content, Media or Errand
 * presentation dependencies. Consumers such as student review need only this
 * boundary; importing the whole School Configuration owner would create cycles. */
@Module({
  imports: [
    IdentityModule,
    CampusModule,
    AuthorizationModule,
    SafetyPolicyModule,
  ],
  providers: [SchoolConfigurationAccess],
  exports: [SchoolConfigurationAccess],
})
export class SchoolConfigurationAccessModule {}
