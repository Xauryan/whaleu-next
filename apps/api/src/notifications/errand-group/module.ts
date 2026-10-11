import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DatabaseModule } from '../../database/database.js';
import { ErrandGroupSource } from '../../errands/group-source.js';
import { ERRAND_GROUP_RUNTIME, ERRAND_GROUP_SOURCE } from './contracts.js';
import type { ErrandGroupSourcePort } from './contracts.js';
import { ErrandGroupEnrollment } from './enrollment.js';
import { ErrandGroupRepository } from './repository.js';
import { ErrandGroupWorker } from './worker.js';
@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: ERRAND_GROUP_RUNTIME, useValue: null },
    {
      provide: ERRAND_GROUP_SOURCE,
      inject: [ModuleRef],
      useFactory: (modules: ModuleRef): ErrandGroupSourcePort => ({
        current: (p, stage, tx) =>
          modules
            .get(ErrandGroupSource, { strict: false })
            .current(p, stage, tx),
      }),
    },
    ErrandGroupEnrollment,
    ErrandGroupRepository,
    ErrandGroupWorker,
  ],
  exports: [ErrandGroupEnrollment, ErrandGroupWorker],
})
export class ErrandGroupDeliveryModule {}
