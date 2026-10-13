import { z } from 'zod';
import type { OperationObject, SchemaObject } from '@nestjs/swagger';
import { publishPostSchema } from '../src/community/contracts.js';
import { relatedCanonicalIdSchema } from '../src/community/related-sync/contracts.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';

const convert = (value: z.ZodType): SchemaObject =>
  z.toJSONSchema(value, {
    target: 'openapi-3.0',
    io: 'input',
    metadata: z.registry(),
    reused: 'inline',
    cycles: 'throw',
  }) as SchemaObject;
export const relatedCanonicalIdErrorSchema = safeErrorResponseSchema.extend({
  error: safeErrorResponseSchema.shape.error.extend({
    code: z.literal('RELATED_CONTENT_CANONICAL_ID_REQUIRED'),
  }),
});
/** OAS 3.0 has no if/then keyword. This intersection preserves the actual
 * legacy input schema and adds the exact disjoint true vs absent/false rule. */
export function relatedRootPublicationInputSchema(): SchemaObject {
  const base = convert(publishPostSchema);
  const canonical = convert(relatedCanonicalIdSchema);
  return {
    ...base,
    allOf: [
      ...(base.allOf ?? []),
      {
        anyOf: [
          {
            type: 'object',
            properties: {
              syncToRelatedCampuses: { type: 'boolean', enum: [false] },
            },
          },
          {
            type: 'object',
            required: ['syncToRelatedCampuses'],
            properties: {
              syncToRelatedCampuses: { type: 'boolean', enum: [true] },
              spaceId: canonical,
              imageAssetIds: { type: 'array', items: canonical },
            },
          },
        ],
      },
    ],
  };
}
const timing =
  'The v4-only check runs after original-key receipt recovery and before new Review submission or approval issuance. Legacy none input schemas, normalization and hash bytes are unchanged; never rewrite a frozen historical request to lowercase.';
export function documentRelatedCanonicalIdentifiers(
  operation: OperationObject,
  kind: 'post' | 'comment' | 'reply',
  pathParameter?: string,
): void {
  const description =
    kind === 'post'
      ? 'When syncToRelatedCampuses is exactly true, spaceId and every imageAssetIds entry must be canonical lowercase UUIDs. With false or an absent flag, existing legacy UUID handling remains unchanged.'
      : kind === 'comment'
        ? 'When the server-resolved canonical root post uses related-sync v4, the raw post path identifier and every imageAssetIds entry must be canonical lowercase UUIDs. This condition depends on the existing root, not a client field; legacy none-root input handling remains unchanged.'
        : 'Replies inherit the canonical root. Their existing path/root-comment identifier, optional targetReplyId and imageAssetIds handling already canonicalizes UUIDs to lowercase before constructing the inherited envelope; this rule does not impose a new lowercase-input rejection on replies.';
  operation.description = [operation.description, description, timing]
    .filter(Boolean)
    .join(' ');
  if (kind === 'post') {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: relatedRootPublicationInputSchema() },
      },
    };
  } else if (kind === 'comment') {
    const extension = operation as OperationObject & {
      'x-related-canonical-identifiers'?: unknown;
    };
    extension['x-related-canonical-identifiers'] = {
      condition: 'server-resolved canonical root uses related-sync v4',
      pathParameters: { [pathParameter!]: convert(relatedCanonicalIdSchema) },
      bodyProperties: {
        imageAssetIds: {
          type: 'array',
          items: convert(relatedCanonicalIdSchema),
        },
      },
      validationOrder:
        'after original-key receipt recovery, before new Review submission or approval issuance',
    };
  }
  if (pathParameter) {
    const parameter = operation.parameters?.find(
      (value) =>
        !('$ref' in value) &&
        value.in === 'path' &&
        value.name === pathParameter,
    );
    if (parameter && !('$ref' in parameter))
      parameter.description =
        kind === 'comment'
          ? 'Canonical lowercase UUID required only when this post is a related-sync v4 root. Legacy none-root handling is unchanged.'
          : 'Existing reply handling canonicalizes the root-comment UUID to lowercase.';
  }
  if (kind !== 'reply')
    operation.responses['422'] = {
      description: `RELATED_CONTENT_CANONICAL_ID_REQUIRED: a new v4 intent contains a noncanonical UUID in a field listed above. ${timing}`,
      content: {
        'application/json': { schema: convert(relatedCanonicalIdErrorSchema) },
      },
    };
}
