import { IdentitySelectionRepository } from './community-policy/identity-selection.repository.js';
import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { campusQuerySchema, operatingRegionQuerySchema } from './contracts.js';
import type { CampusPage, CampusQuery } from './contracts.js';
import { CampusRepository } from './campus.repository.js';
import { CampusService } from './campus.service.js';
import { CampusCommunityPolicyService } from './community-policy/campus-community-policy.service.js';
import { RegionalCommunityPolicyService } from './community-policy/regional-community-policy.service.js';
import { CampusContentScopeFacade } from './content-scope.facade.js';

@Controller('v1/campuses')
export class CampusController {
  constructor(
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  @Get()
  list(
    @Query(new SchemaValidationPipe(campusQuerySchema)) query: CampusQuery,
  ): Promise<CampusPage> {
    return this.campuses.list(query);
  }
}

@Controller('v1/operating-regions')
export class OperatingRegionController {
  constructor(
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  @Get()
  async list(
    @Query(new SchemaValidationPipe(operatingRegionQuerySchema))
    query: {
      campusId: string;
    },
  ) {
    const { region } = await this.campuses.getBrowseContext(query.campusId);
    return { items: region ? [region] : [] };
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [CampusController, OperatingRegionController],
  providers: [
    CampusRepository,
    CampusService,
    CampusCommunityPolicyService,
    IdentitySelectionRepository,
    RegionalCommunityPolicyService,
    CampusContentScopeFacade,
  ],
  exports: [
    CampusService,
    CampusCommunityPolicyService,
    IdentitySelectionRepository,
    RegionalCommunityPolicyService,
    CampusContentScopeFacade,
  ],
})
export class CampusModule {}
