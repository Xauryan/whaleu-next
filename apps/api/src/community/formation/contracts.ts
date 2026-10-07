import { z } from 'zod';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import type { AuthorView } from '../contracts.js';
import { textSchema } from '../text.js';

// The source uses UTF-8 byte substr for BOTH creator and joiner contacts.
// Reject overlong new writes rather than silently truncating or splitting UTF-8.
const contactText = (maximum: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(textSchema(maximum))
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maximum);
export const formationContactsSchema = z
  .strictObject({
    wechat: contactText(100),
    qq: contactText(50),
    phone: contactText(20),
  })
  .refine((value) =>
    Object.values(value).some((contact) => contact.length > 0),
  );
export const formationComponentSchema = z.strictObject({
  kind: z.literal('formation'),
  capacity: z.number().int().min(1).max(20),
  theme: z
    .string()
    .transform((value) => value.trim())
    .pipe(textSchema(12))
    .refine((value) => value.length > 0),
  contacts: formationContactsSchema,
  contactSharing: z.literal('members_v1'),
});
export const joinFormationSchema = z.strictObject({
  clientRequestId: z.uuidv4(),
  contacts: formationContactsSchema,
  contactSharing: z.literal('members_v1'),
});
export const emptyFormationQuerySchema = z.strictObject({});
export type FormationContacts = z.infer<typeof formationContactsSchema>;
export type FormationComponent = z.infer<typeof formationComponentSchema>;
export type JoinFormation = z.infer<typeof joinFormationSchema>;
export type FormationReceipt =
  | {
      requestId: string;
      operation: 'join_formation';
      outcome: 'created';
      resourceId: string;
      createdAt: string;
    }
  | {
      requestId: string;
      operation: 'join_formation';
      outcome: 'rejected';
      code: ApplicationErrorCode;
    };
export interface OwnFormationMembership {
  postId: string;
  membershipId: string;
  joinedAt: string;
  isCreator: boolean;
}
export interface FormationMemberView {
  id: string;
  author: AuthorView;
  isCreator: boolean;
  joinedAt: string;
  viewer: { isSelf: boolean };
}
export interface FormationView {
  id: string;
  postId: string;
  capacity: number;
  theme: string;
  status: 'open' | 'full' | 'unavailable';
  memberCount: number;
  members: FormationMemberView[];
  viewer: {
    isMember: boolean;
    isCreator: boolean;
    canJoin: boolean;
    reason: ApplicationErrorCode | null;
    canReadContacts: boolean;
  };
}
export interface FormationContactsView {
  postId: string;
  members: { membershipId: string; contacts: FormationContacts }[];
}
