import { z } from 'zod';
export const identityCampusRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
export const identityCampusRevisionSchema = z
  .string()
  .regex(/^ic1:[a-f0-9]{64}$/);
export const identityCampusSelectionSchema = z.strictObject({
  requestId: identityCampusRequestIdSchema,
  campusId: z.uuid().transform((value) => value.toLowerCase()),
  expectedStateRevision: identityCampusRevisionSchema,
});
export const identityCampusEmptyQuerySchema = z.strictObject({});
export type IdentityCampusIntent = z.infer<
  typeof identityCampusSelectionSchema
>;
export interface IdentityCampusSummary {
  id: string;
  name: string;
  operatingRegion: { id: string; name: string };
}
export type IdentityCampusReason =
  | 'current'
  | 'choice_required'
  | 'history_unknown'
  | 'inputs_changed'
  | 'choice_no_longer_valid'
  | 'affiliation_required'
  | 'affiliation_unavailable'
  | 'topology_unavailable';
export interface IdentityCampusState {
  affiliation: 'verified' | 'unverified' | 'unavailable';
  selection: 'valid' | 'selection_required' | 'unavailable';
  reason: IdentityCampusReason;
  selectedCampus: IdentityCampusSummary | null;
  options: { status: 'known' | 'unavailable'; items: IdentityCampusSummary[] };
  writeEligibility: {
    phone: 'verified' | 'unverified' | 'unavailable';
    safety: 'allowed' | 'restricted' | 'unavailable';
  };
  canSelect: boolean;
  expectedStateRevision: string | null;
  guidance:
    'choose' | 'reselect' | 'refresh' | 'await_affiliation' | 'unavailable';
}
export interface IdentityCampusReceipt {
  requestId: string;
  campusId: string;
  outcome: 'applied' | 'unchanged';
  selectionRevision: number;
}
