import type { EffectiveContentEnvelopeV6 } from '../content-review/contracts.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prepareTextSource } from './source.js';
import type { TextSourceDescriptor, TextSourceKind } from './contracts.js';

export const TEXT_SOURCE_REVIEW_POLICY = 'local-text-source-v1' as const;
export const TEXT_SOURCE_INTENT_DOMAIN =
  'whaleu-community-text-source-intent:v1\n';
export const textSourceDescriptorSchema = z.discriminatedUnion('format', [
  z.strictObject({
    version: z.literal(1),
    format: z.literal('plain'),
    readingFormatting: z.enum(['auto', 'off']),
  }),
  z.strictObject({ version: z.literal(1), format: z.literal('markdown') }),
]);
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewedTextSourceSchema = z.discriminatedUnion('format', [
  z.strictObject({
    version: z.literal(1),
    format: z.literal('plain'),
    readingFormatting: z.enum(['auto', 'off']),
    sourceHash,
  }),
  z.strictObject({
    version: z.literal(1),
    format: z.literal('markdown'),
    sourceHash,
  }),
]);
export type ReviewedTextSource = z.infer<typeof reviewedTextSourceSchema>;
export const textSourceEmptyQuerySchema = z.strictObject({});
export const textSourceIdSchema = z
  .uuid()
  .refine((id) => id === id.toLowerCase(), 'Canonical identifier required');
/** Temporary text-only/local coverage limit, not a Markdown reference parser.
 * Do not scan substrings or silently discard references. The entire original
 * source is refused until native AST/reference context coverage is admitted. */
export function sourceTextAvailable(
  text: string,
  source: TextSourceDescriptor,
): boolean {
  return (
    source.format !== 'markdown' ||
    (!text.includes('whaleu-asset:') && !/#[0-9]/.test(text))
  );
}
export const textSourceKindSchema = z.enum(['post', 'comment', 'reply']);
export function sourceDescriptor(
  source: ReviewedTextSource,
): TextSourceDescriptor {
  return source.format === 'plain'
    ? {
        version: 1,
        format: 'plain',
        readingFormatting: source.readingFormatting,
      }
    : { version: 1, format: 'markdown' };
}
export function reviewedTextSource(
  text: string,
  descriptor: TextSourceDescriptor,
  kind: TextSourceKind,
): ReviewedTextSource {
  const source = prepareTextSource(text, descriptor, kind);
  if (
    !source ||
    source.canonicalText !== text ||
    !sourceTextAvailable(text, descriptor)
  )
    throw new TypeError('Invalid canonical source');
  return { ...source.descriptor, sourceHash: source.sourceHash };
}
export function reviewedTextSourceMatches(
  text: string,
  value: unknown,
  kind: TextSourceKind,
): boolean {
  const decoded = reviewedTextSourceSchema.safeParse(value);
  if (!decoded.success) return false;
  const source = prepareTextSource(text, sourceDescriptor(decoded.data), kind);
  return (
    !!source &&
    source.canonicalText === text &&
    source.sourceHash === decoded.data.sourceHash &&
    sourceTextAvailable(text, source.descriptor)
  );
}
export function appendTextSource<T extends object>(
  intent: T,
  source: TextSourceDescriptor | undefined,
): T & { textSource?: TextSourceDescriptor } {
  return source === undefined
    ? intent
    : { ...intent, textSource: textSourceDescriptorSchema.parse(source) };
}
const sourceReadFields = {
  version: z.literal(1),
  kind: textSourceKindSchema,
  id: textSourceIdSchema,
  postId: textSourceIdSchema,
  rootCommentId: textSourceIdSchema.nullable(),
  text: z.string(),
};
export const textSourceReadSchema = z
  .discriminatedUnion('classification', [
    z.strictObject({
      ...sourceReadFields,
      classification: z.literal('legacyPlain'),
    }),
    z.strictObject({
      ...sourceReadFields,
      classification: z.literal('reviewedSource'),
      sourceRevision: z.literal(1),
      textSource: reviewedTextSourceSchema,
      readingFormattingEligible: z.boolean(),
      presentationStatus: z.enum(['not_configured', 'ineligible']),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      (value.kind === 'post' &&
        (value.postId !== value.id || value.rootCommentId !== null)) ||
      (value.kind === 'comment' && value.rootCommentId !== value.id) ||
      (value.kind === 'reply' && value.rootCommentId === null)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid source identity' });
    if (value.classification === 'reviewedSource') {
      const source = prepareTextSource(
        value.text,
        sourceDescriptor(value.textSource),
        value.kind,
      );
      if (
        !reviewedTextSourceMatches(value.text, value.textSource, value.kind) ||
        !source ||
        source.canonicalText !== value.text ||
        source.sourceHash !== value.textSource.sourceHash ||
        source.readingFormattingEligible !== value.readingFormattingEligible ||
        value.presentationStatus !==
          (source.readingFormattingEligible ? 'not_configured' : 'ineligible')
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid source evidence' });
    }
  });
export type TextSourceRead = z.infer<typeof textSourceReadSchema>;
export const textSourceCapabilitySchema = z
  .strictObject({
    version: z.literal(1),
    authorMode: z.enum(['named', 'anonymous']),
    availability: z.enum(['available', 'unavailable']),
    operations: z
      .array(z.enum(['publish_post', 'publish_comment', 'publish_reply']))
      .max(3),
    formats: z.array(z.enum(['plain', 'markdown'])).max(2),
    readingFormatting: z.array(z.enum(['auto', 'off'])).max(2),
    media: z.literal('unavailable'),
    markdownReferences: z.literal('unavailable'),
    formatter: z.literal('not_configured'),
  })
  .superRefine((value, ctx) => {
    const unique = <T>(values: T[]) => new Set(values).size === values.length;
    const unavailable = value.availability === 'unavailable';
    if (
      !unique(value.operations) ||
      !unique(value.formats) ||
      !unique(value.readingFormatting) ||
      (unavailable
        ? value.operations.length +
            value.formats.length +
            value.readingFormatting.length !==
          0
        : value.operations.length === 0 ||
          value.formats.join(',') !== 'plain,markdown' ||
          value.readingFormatting.join(',') !== 'auto,off')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inconsistent source capability',
      });
  });
export type TextSourceCapability = z.infer<typeof textSourceCapabilitySchema>;

/** New-domain only. Legacy publication hashes never call this helper. */
export function textSourceIntentHash(
  operation: 'publish_post' | 'publish_comment' | 'publish_reply',
  intent: unknown,
): string {
  if (
    typeof intent !== 'object' ||
    intent === null ||
    !Object.hasOwn(intent, 'textSource') ||
    !textSourceDescriptorSchema.safeParse(
      (intent as { textSource: unknown }).textSource,
    ).success
  )
    throw new TypeError('Invalid explicit source intent');
  return createHash('sha256')
    .update(
      TEXT_SOURCE_INTENT_DOMAIN + JSON.stringify({ operation, intent }),
      'utf8',
    )
    .digest('hex');
}

/** Reconstruct original ordered intent from actual canonical definition and the
 * separately persisted requested mode, never approval JSON source metadata. */
export function sourceOriginalIntentHash(
  envelope: EffectiveContentEnvelopeV6,
  requestedMode: 'named' | 'anonymous',
): string {
  const descriptor = sourceDescriptor(envelope.textSource);
  const intent =
    envelope.purpose === 'publish_post'
      ? {
          spaceId: envelope.spaceId,
          category: envelope.category,
          text: envelope.text,
          imageAssetIds: [],
          authorMode: requestedMode,
          commentsPolicy: envelope.commentsPolicy,
          ...(envelope.allowAnonymousDm === false
            ? { allowAnonymousDm: false }
            : {}),
        }
      : envelope.purpose === 'publish_comment'
        ? {
            postId: envelope.postId,
            text: envelope.text,
            imageAssetIds: [],
            authorMode: requestedMode,
          }
        : {
            rootCommentId: envelope.rootCommentId,
            targetReplyId: envelope.targetReplyId,
            text: envelope.text,
            imageAssetIds: [],
            authorMode: requestedMode,
          };
  return textSourceIntentHash(
    envelope.purpose,
    appendTextSource(intent, descriptor),
  );
}

/** Additive composition only; historical v6 intent reconstruction remains frozen. */
export function composedSourceOriginalIntentHash(
  envelope:
    | import('../content-review/contracts.js').EffectiveContentEnvelopeV7
    | import('../content-review/contracts.js').EffectiveContentEnvelopeV8,
  requestedMode: 'named' | 'anonymous',
): string {
  if (envelope.version !== 7 && envelope.version !== 8)
    throw new TypeError('Unknown composed source version');
  if (envelope.textSource === null)
    throw new TypeError('Missing composed source');
  if (envelope.version === 7) {
    if (
      envelope.home.requestedIntent.authorMode !== requestedMode ||
      envelope.home.requestedIntent.textSource === undefined
    )
      throw new TypeError('Invalid original composed mode');
    const requested = envelope.home.requestedIntent;
    if (
      requested.component !== undefined ||
      requested.imageAssetIds.length !== 0 ||
      requested.syncToRelatedCampuses === true ||
      requested.allowAnonymousDm === true
    )
      throw new TypeError('Invalid composed source request');
    const intent = {
      spaceId: requested.spaceId,
      category: requested.category,
      text: requested.text,
      imageAssetIds: [],
      authorMode: requestedMode,
      commentsPolicy: requested.commentsPolicy,
      ...(requested.allowAnonymousDm === false
        ? { allowAnonymousDm: false }
        : {}),
    };
    return textSourceIntentHash(
      'publish_post',
      appendTextSource(intent, requested.textSource),
    );
  }
  const intent =
    envelope.purpose === 'publish_comment'
      ? {
          postId: envelope.postId,
          text: envelope.text,
          imageAssetIds: [],
          authorMode: requestedMode,
        }
      : {
          rootCommentId: envelope.rootCommentId,
          targetReplyId: envelope.targetReplyId,
          text: envelope.text,
          imageAssetIds: [],
          authorMode: requestedMode,
        };
  return textSourceIntentHash(
    envelope.purpose,
    appendTextSource(intent, sourceDescriptor(envelope.textSource)),
  );
}
