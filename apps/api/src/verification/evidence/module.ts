import type { Provider } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import { VERIFICATION_EVIDENCE_ACCESS } from './access-port.js';
import type { VerificationEvidenceAccessPort } from './access-port.js';
import {
  VerificationEvidenceMediaService,
  VERIFICATION_EVIDENCE_MEDIA_RUNTIME,
} from './facade.js';
import type { VerificationEvidenceMediaRuntime } from './facade.js';
import {
  VerificationEvidenceMediaController,
  VerificationEvidenceMultipartInterceptor,
} from './controller.js';
import { VerificationEvidenceMediaRequestGuard } from './request-guard.js';
/** Register these in the owning VerificationModule together with its trusted
 * access provider. No separate module imports VerificationModule in a cycle. */
export const verificationEvidenceControllers = [
  VerificationEvidenceMediaController,
];
export const verificationEvidenceProviders: Provider[] = [
  { provide: VERIFICATION_EVIDENCE_MEDIA_RUNTIME, useValue: null },
  {
    provide: VerificationEvidenceMediaService,
    inject: [
      DatabaseService,
      IdentityService,
      VERIFICATION_EVIDENCE_ACCESS,
      VERIFICATION_EVIDENCE_MEDIA_RUNTIME,
      MediaDeliveryBudgetPool,
    ],
    useFactory: (
      database: DatabaseService,
      identity: IdentityService,
      access: VerificationEvidenceAccessPort,
      runtime: VerificationEvidenceMediaRuntime | null,
      budget: MediaDeliveryBudgetPool,
    ) =>
      new VerificationEvidenceMediaService(
        database,
        identity,
        access,
        runtime,
        budget,
      ),
  },
  VerificationEvidenceMultipartInterceptor,
  VerificationEvidenceMediaRequestGuard,
];
