import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SchoolUidController } from './controller.js';
import { SchoolUidService } from './service.js';
import { SchoolUidProjectionFacade } from './projection.facade.js';
import { SchoolUidLedger } from './ledger.js';
import { SchoolUidCoverageFacade } from './coverage.facade.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [SchoolUidController],
  providers: [
    SchoolUidService,
    SchoolUidProjectionFacade,
    SchoolUidLedger,
    SchoolUidCoverageFacade,
  ],
  exports: [
    SchoolUidProjectionFacade,
    SchoolUidLedger,
    SchoolUidCoverageFacade,
  ],
})
export class SchoolUidModule {}
