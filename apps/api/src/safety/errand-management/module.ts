import { Module } from '@nestjs/common';
import { SafetyErrandManagementFacade } from './facade.js';
@Module({
  providers: [SafetyErrandManagementFacade],
  exports: [SafetyErrandManagementFacade],
})
export class SafetyErrandManagementModule {}
