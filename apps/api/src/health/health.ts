import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseModule, DatabaseService } from '../database/database.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    if (!(await this.database.ready())) throw new ServiceUnavailableException();
    return { status: 'ok' };
  }
}

@Module({ imports: [DatabaseModule], controllers: [HealthController] })
export class HealthModule {}
