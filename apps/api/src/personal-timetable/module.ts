import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PersonalTimetableController } from './controller.js';
import { PersonalTimetableRepository } from './repository.js';
import { PersonalTimetableService } from './service.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [PersonalTimetableController],
  providers: [PersonalTimetableRepository, PersonalTimetableService],
})
export class PersonalTimetableModule {}
