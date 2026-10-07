import type { Cancellation } from '../src/platform/contracts';
import type { VerificationSummary } from '../src/verification/contract';
import type { VerificationGateway } from '../src/verification/gateway';

export function summary(
  overrides: Partial<VerificationSummary> = {},
): VerificationSummary {
  return {
    affiliation: { status: 'unavailable' },
    studentNumber: { status: 'unavailable' },
    phone: { status: 'unavailable' },
    application: { status: 'unavailable' },
    ...overrides,
  };
}
export class FakeVerificationGateway implements VerificationGateway {
  readonly calls: Cancellation[] = [];
  implementation: VerificationGateway['summary'] = async () => summary();
  summary(cancel: Cancellation): Promise<VerificationSummary> {
    this.calls.push(cancel);
    return this.implementation(cancel);
  }
}
