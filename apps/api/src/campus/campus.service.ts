import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { CampusRepository } from './campus.repository.js';
import type {
  Campus,
  CampusPage,
  CampusQuery,
  OperatingRegion,
} from './contracts.js';

@Injectable()
export class CampusService {
  constructor(
    @Inject(CampusRepository) private readonly repository: CampusRepository,
  ) {}
  list(query: CampusQuery): Promise<CampusPage> {
    return this.repository.list(query);
  }
  find(id: string): Promise<Campus | null> {
    return this.repository.find(id);
  }
  async getBrowseContext(
    campusId: string,
  ): Promise<{ campus: Campus; region: OperatingRegion | null }> {
    const campus = await this.repository.find(campusId);
    if (!campus) throw new ApplicationError('CAMPUS_NOT_FOUND');
    return { campus, region: await this.repository.mappedRegion(campusId) };
  }
  async requireActiveRegion(
    id: string,
    transaction: PoolClient,
  ): Promise<OperatingRegion> {
    const region = await this.repository.region(id, transaction);
    if (!region?.isActive)
      throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    return region;
  }
  async requireSelectable(
    id: string,
    transaction: PoolClient,
  ): Promise<Campus> {
    const campus = await this.repository.find(id, transaction);
    if (!campus) throw new ApplicationError('CAMPUS_NOT_FOUND');
    if (!campus.isActive) throw new ApplicationError('CAMPUS_UNAVAILABLE');
    return campus;
  }
}
