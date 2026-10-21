import { mediaAttachmentDescriptorSchema } from '../../media/contracts.js';
import { z } from 'zod';
import type { AuthorView, MediaView } from '../contracts.js';

export const publicationPageQuerySchema = z.strictObject({
  kind: z.enum(['topic', 'reply']),
  identity: z.enum(['named', 'anonymous']),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .optional()
    .transform((value) => (value === undefined ? 20 : Number(value))),
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const emptyPublicationBodySchema = z.strictObject({}).optional();
export type PublicationPageQuery = z.infer<typeof publicationPageQuerySchema>;
export type PublicationKind = 'post' | 'comment' | 'reply';
export interface PublicationItem {
  kind: PublicationKind;
  targetId: string;
  postId: string;
  rootCommentId: string | null;
  createdAt: string;
  preview: {
    text: string;
    images: MediaView[];
    author: AuthorView;
    createdAt: string;
    isSelf: true;
  };
}
export interface PublicationPage {
  items: PublicationItem[];
  continuation: 'more' | 'scan_pending' | 'end';
  nextCursor: string | null;
}

const nullableValue = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('known'), value: value.nullable() }),
    z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
  ]);
const experienceDisplay = z.strictObject({
  title: nullableValue(z.strictObject({ key: z.string(), name: z.string() })),
  color: nullableValue(z.number().int()),
  level: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('known'), value: z.number().int() }),
    z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
  ]),
});
export const publicationAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('named'),
    profileId: z.uuid(),
    displayName: z.string(),
    avatar: mediaAttachmentDescriptorSchema.nullable(),
    experienceDisplay,
  }),
  z.strictObject({
    kind: z.literal('anonymous'),
    personaId: z.uuid(),
    displayName: z.string(),
    avatar: mediaAttachmentDescriptorSchema.nullable(),
    isPostAuthor: z.boolean(),
  }),
]);
export const publicationPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      kind: z.enum(['post', 'comment', 'reply']),
      targetId: z.uuid(),
      postId: z.uuid(),
      rootCommentId: z.uuid().nullable(),
      createdAt: z.iso.datetime(),
      preview: z.strictObject({
        text: z.string(),
        images: z.array(mediaAttachmentDescriptorSchema),
        author: publicationAuthorSchema,
        createdAt: z.iso.datetime(),
        isSelf: z.literal(true),
      }),
    }),
  ),
  continuation: z.enum(['more', 'scan_pending', 'end']),
  nextCursor: z.string().nullable(),
});
