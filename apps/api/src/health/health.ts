import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import {
  APPLICATION_MIGRATIONS,
  ApplicationReadinessService,
  readApplicationMigrations,
} from './readiness.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ApplicationReadinessService)
    private readonly readiness: ApplicationReadinessService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    if (!(await this.readiness.ready()))
      throw new ServiceUnavailableException();
    return { status: 'ok' };
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    ApplicationReadinessService,
    { provide: APPLICATION_MIGRATIONS, useValue: readApplicationMigrations },
  ],
})
export class HealthModule {}
