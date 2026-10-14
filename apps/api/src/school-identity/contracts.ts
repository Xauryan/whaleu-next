import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  schoolUidSchema,
  schoolUidSchoolSchema,
} from '../school-uid/contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
const stateVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const schoolIdentityRequestIdSchema = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());
export const schoolIdentityManagementQuerySchema = z.strictObject({
  targetProfileId: id,
  destinationCampusId: id.optional(),
});
const base = {
  version: z.literal(1),
  targetProfileId: id,
  expectedStateVersion: stateVersion,
};
const correction = {
  action: z.literal('correct_school'),
  destinationCampusId: id,
  expectedDestinationVersion: stateVersion,
};
const completion = { action: z.literal('complete_uid') };
export const schoolIdentityCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...base,
    clientRequestId: schoolIdentityRequestIdSchema,
    ...correction,
  }),
  z.strictObject({
    ...base,
    clientRequestId: schoolIdentityRequestIdSchema,
    ...completion,
  }),
]);
export type SchoolIdentityCommand = z.infer<typeof schoolIdentityCommandSchema>;
const applied = {
  outcome: z.enum(['applied', 'unchanged']),
  eventId: id,
  recordedAt: z.iso.datetime({ precision: 3 }),
};
const rejected = {
  outcome: z.literal('rejected'),
  code: z.enum(['SCHOOL_IDENTITY_STALE', 'SCHOOL_IDENTITY_CANCELLED']),
};
export const schoolIdentityReceiptSchema = z.union([
  z.strictObject({
    ...base,
    requestId: schoolIdentityRequestIdSchema,
    ...correction,
    ...applied,
  }),
  z.strictObject({
    ...base,
    requestId: schoolIdentityRequestIdSchema,
    ...completion,
    ...applied,
  }),
  z.strictObject({
    ...base,
    requestId: schoolIdentityRequestIdSchema,
    ...correction,
    ...rejected,
  }),
  z.strictObject({
    ...base,
    requestId: schoolIdentityRequestIdSchema,
    ...completion,
    ...rejected,
  }),
]);
export type SchoolIdentityReceipt = z.infer<typeof schoolIdentityReceiptSchema>;
export const schoolIdentityRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    receipt: schoolIdentityReceiptSchema,
  }),
  z.strictObject({ state: z.literal('not_recorded') }),
]);
export type SchoolIdentityRecovery = z.infer<
  typeof schoolIdentityRecoverySchema
>;
export const schoolIdentityManagementSchema = z
  .strictObject({
    target: z.strictObject({
      profileId: id,
      displayName: z.string().min(1).max(100),
    }),
    stateVersion,
    current: z.strictObject({
      schoolUid: schoolUidSchema,
      school: schoolUidSchoolSchema.nullable(),
    }),
    destination: z
      .strictObject({
        campusId: id,
        campusName: z.string().min(1).max(200),
        school: schoolUidSchoolSchema,
        destinationVersion: stateVersion,
      })
      .nullable(),
    actions: z.strictObject({
      correctSchool: z.boolean(),
      completeUid: z.boolean(),
    }),
  })
  .refine(
    (value) =>
      value.current.schoolUid.status !== 'assigned' ||
      (value.current.school?.code === value.current.schoolUid.school.code &&
        value.current.school.name === value.current.schoolUid.school.name),
  )
  .refine(
    (value) =>
      !value.actions.completeUid ||
      (value.current.school !== null &&
        value.current.schoolUid.status !== 'assigned'),
  )
  .refine(
    (value) => !value.actions.correctSchool || value.current.school !== null,
  );
export type SchoolIdentityManagement = z.infer<
  typeof schoolIdentityManagementSchema
>;
export const schoolIdentityEmptyQuerySchema = z.strictObject({});
export const schoolIdentityEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
/** Fixed ASCII fields, action-specific, no request ID and no trailing newline. */
export function schoolIdentityCommandCanonical(
  raw: SchoolIdentityCommand,
): string {
  const command = schoolIdentityCommandSchema.parse(raw);
  return (
    'whaleu:school-identity-command:v1\n' +
    [
      String(command.version),
      command.action,
      command.targetProfileId,
      command.expectedStateVersion,
      ...(command.action === 'correct_school'
        ? [command.destinationCampusId, command.expectedDestinationVersion]
        : []),
    ].join('\n')
  );
}
export function schoolIdentityCommandHash(
  command: SchoolIdentityCommand,
): string {
  return createHash('sha256')
    .update(schoolIdentityCommandCanonical(command), 'utf8')
    .digest('hex');
}
