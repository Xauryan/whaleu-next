import { Module } from '@nestjs/common';
import {
  COMMUNITY_BASE_VISIBILITY,
  UnavailableVisibility,
} from '../community/community-policy.js';
import { SafetyRepository } from './repository.js';
import { NamedBlockVisibility } from './visibility.js';
@Module({
  providers: [
    SafetyRepository,
    NamedBlockVisibility,
    { provide: COMMUNITY_BASE_VISIBILITY, useClass: UnavailableVisibility },
  ],
  exports: [SafetyRepository, NamedBlockVisibility],
})
export class SafetyPolicyModule {}
