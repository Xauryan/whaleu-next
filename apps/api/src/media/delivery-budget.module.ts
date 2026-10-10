import { Global, Module } from '@nestjs/common';
import { MediaDeliveryBudgetPool } from './delivery-budget.js';

/** Global only within this Nest container. Separate apps/tests never share an
 * implicit module-level counter; production owner wiring must inject this pool. */
@Global()
@Module({
  providers: [
    {
      provide: MediaDeliveryBudgetPool,
      useFactory: () => new MediaDeliveryBudgetPool(),
    },
  ],
  exports: [MediaDeliveryBudgetPool],
})
export class MediaDeliveryBudgetModule {}
