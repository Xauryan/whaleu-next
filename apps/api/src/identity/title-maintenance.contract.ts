/** Internal identity-owned bounded live sweep; never an HTTP identity DTO.
 * Late commits / eligibility changes behind the cursor require a later sweep. */
export interface TitleMaintenanceSweep {
  readonly runStartedAt: Date;
  readonly upperAccountId: string | null;
}
export interface TitleMaintenanceCursor extends TitleMaintenanceSweep {
  readonly cursorAccountId: string | null;
}
