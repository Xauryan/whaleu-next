import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { SystemNoticesController } from './controller.js';
import { SystemNoticesRepository } from './repository.js';
import { SystemNoticesService } from './service.js';

// Deliberately independent of Community and Safety: owners retain administrative
// notices after the reported content becomes inaccessible or is removed.
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [SystemNoticesController],
  providers: [SystemNoticesRepository, SystemNoticesService],
  exports: [SystemNoticesService],
})
export class SystemNoticesModule {}
