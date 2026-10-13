import { z } from 'zod';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { OperationObject, SchemaObject } from '@nestjs/swagger';

/** Swagger cannot expand an unnamed union-valued @Query into parameters.
 * Keep the exact joint runtime schema as an extension and expose its real
 * fields, requiring only fields that every accepted variant requires. */
export function documentScopedRemovalQuery(
  document: OpenAPIObject,
  path: string,
  runtimeSchema: z.ZodType,
): void {
  const operation = document.paths[path]?.get as
    (OperationObject & { 'x-query-schema'?: SchemaObject }) | undefined;
  if (!operation)
    throw new Error(`Missing actual scoped-removal management route ${path}`);
  const schema = z.toJSONSchema(runtimeSchema, {
    target: 'openapi-3.0',
    io: 'input',
    metadata: z.registry(),
    reused: 'inline',
    cycles: 'throw',
  }) as SchemaObject;
  const variants = (schema.anyOf ?? schema.oneOf ?? [schema]) as SchemaObject[];
  const names = [
    ...new Set(
      variants.flatMap((variant) => Object.keys(variant.properties ?? {})),
    ),
  ];
  operation.parameters = names.map((name) => {
    const properties = variants.flatMap((variant) =>
      variant.properties?.[name] ? [variant.properties[name]!] : [],
    );
    const unique = [
      ...new Map(
        properties.map((value) => [JSON.stringify(value), value]),
      ).values(),
    ];
    return {
      name,
      in: 'query',
      required: variants.every((variant) => variant.required?.includes(name)),
      schema: unique.length === 1 ? unique[0]! : { anyOf: unique },
      ...(name === 'viewSpaceId'
        ? {
            description:
              'Required only with version=3. Forbidden for omitted version or version=2. Never inferred from display metadata.',
          }
        : {}),
      ...(name === 'version'
        ? {
            description:
              'Omit for legacy pure removal, use 2 for original-scope compound options, or 3 with viewSpaceId for destination-scoped pure removal.',
          }
        : {}),
    };
  });
  operation['x-query-schema'] = schema;
}

/** Account-policy wrappers preserve operation annotations but Swagger's
 * method.name-based parameter lookup can miss the original parameter metadata.
 * Derive the exact real command/cancel body and recovery locator explicitly;
 * this is documentation-only and never substitutes a broader request schema. */
export function documentScopedRemovalInputs(
  document: OpenAPIObject,
  base: string,
  commandSchema: z.ZodType,
  requestIdSchema: z.ZodType,
): void {
  const input = (value: z.ZodType) =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
      metadata: z.registry(),
      reused: 'inline',
      cycles: 'throw',
    }) as SchemaObject;
  for (const suffix of ['/commands', '/commands/cancel']) {
    const operation = document.paths[base + suffix]?.post;
    if (!operation)
      throw new Error(`Missing actual scoped-removal POST ${base + suffix}`);
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: input(commandSchema) } },
    };
    operation.parameters = [];
  }
  const recovery = document.paths[`${base}/requests/{requestId}`]?.get;
  if (!recovery)
    throw new Error(`Missing actual scoped-removal recovery GET ${base}`);
  recovery.parameters = [
    {
      name: 'requestId',
      in: 'path',
      required: true,
      schema: input(requestIdSchema),
    },
  ];
}
