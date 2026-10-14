import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TOOL_CATALOG_VERSION = 'campus-tools-canonical-v1' as const;
export const toolId = z.uuid().refine((value) => value === value.toLowerCase());
export const toolDigest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      // eslint-disable-next-line no-control-regex -- Accepted plain text excludes controls.
      (v) => v === v.normalize('NFC') && !/[\u0000-\u001f\u007f]/u.test(v),
    );
export function toolInstantMicros(value: string): bigint {
  const [whole, fraction = ''] = value.slice(0, -1).split('.');
  return (
    BigInt(Date.parse(`${whole}Z`)) * 1000n + BigInt(fraction.padEnd(6, '0'))
  );
}
const instant = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19),
  );
const sourceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const toolLinkPolicySchema = z.strictObject({
  id: toolId,
  version: z.literal(1),
  rules: z
    .array(
      z.strictObject({
        action: z.enum(['copy', 'webview']),
        host: z
          .string()
          .max(253)
          .refine((v) => v.split('.').every((label) => label.length <= 63))
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/),
        path: z
          .string()
          .regex(/^\/[A-Za-z0-9_./~-]*$/)
          .max(512),
        query: z
          .array(
            z.strictObject({
              key: sourceId,
              value: z.string().regex(/^[A-Za-z0-9_~-]{1,128}$/),
            }),
          )
          .max(8),
      }),
    )
    .max(16),
});
export type ToolLinkPolicy = z.infer<typeof toolLinkPolicySchema>;
/** Explicit canonical ASCII subset shared with native. Exact full destinations,
 * including query order and values, are accepted independently for each action. */
export function canonicalToolLink(
  raw: string,
  action: 'copy' | 'webview',
  policy: ToolLinkPolicy,
): string | null {
  if (
    raw.length > 2048 ||
    !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./~?=&-]*$/.test(raw)
  )
    return null;
  if (/(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.href !== raw ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    /(?:^|\.)xn--/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|localdomain|corp|onion)$/.test(
      url.hostname,
    )
  )
    return null;
  return policy.rules.some((rule) => {
    const query = rule.query.map((q) => `${q.key}=${q.value}`).join('&');
    return (
      rule.action === action &&
      raw === `https://${rule.host}${rule.path}${query ? `?${query}` : ''}`
    );
  })
    ? raw
    : null;
}
const position = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
const mediaSlot = z.strictObject({
  id: sourceId,
  bindingId: toolId,
  assetId: toolId,
  manifestDigest: toolDigest,
  alt: text(300),
});
const link = z.strictObject({
  url: z.string().max(2048),
  action: z.enum(['copy', 'webview']),
});
const base = {
  id: toolId,
  sourceId,
  ordinal: z.number().int().min(0).max(31),
  revision: toolId,
  title: text(160),
  state: z.enum(['enabled', 'disabled', 'withdrawn']),
};
export const toolEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('map'),
    coordinateSystem: z.literal('gcj02'),
    center: position,
    zoom: z.number().int().min(3).max(20),
    markers: z
      .array(
        z.strictObject({
          id: z.number().int().min(0).max(2147483647),
          sourceId,
          title: text(160),
          category: text(80),
          details: text(2000),
          position,
        }),
      )
      .max(128),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('shuttle'),
    groups: z
      .array(
        z.strictObject({
          id: sourceId,
          title: text(160),
          slots: z.array(mediaSlot).max(8),
        }),
      )
      .max(4),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('research'),
    description: text(4000),
    compatibility: text(400).nullable(),
    image: mediaSlot.nullable(),
    link: link.extend({ action: z.literal('copy') }).nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('web-link'),
    link: link.extend({ action: z.literal('webview') }),
  }),
]);
export type ToolEntry = z.infer<typeof toolEntrySchema>;
export const toolCatalogSchema = z
  .strictObject({
    version: z.literal(TOOL_CATALOG_VERSION),
    id: toolId,
    campusId: toolId,
    expectedHead: toolId.nullable(),
    applicability: z.enum(['applicable', 'not_applicable']),
    coverage: z.enum(['complete', 'partial']),
    status: z.enum(['active', 'withdrawn']),
    source: z.strictObject({
      reference: text(300),
      digest: toolDigest,
      policyReference: text(300),
      maintainer: text(160),
      attribution: text(300),
      observedAt: instant,
      publishedAt: instant,
    }),
    validity: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('finite'),
        effectiveAt: instant,
        expiresAt: instant,
      }),
      z.strictObject({
        kind: z.literal('policy_exempt'),
        effectiveAt: instant,
        exemptionReference: text(300),
      }),
    ]),
    linkPolicy: toolLinkPolicySchema,
    entries: z.array(toolEntrySchema).max(32),
  })
  .superRefine((catalog, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: readonly (string | number)[], label: string) => {
      if (new Set(values).size !== values.length) fail(`Duplicate ${label}`);
    };
    unique(
      catalog.entries.map((e) => e.id),
      'entry ID',
    );
    unique(
      catalog.entries.map((e) => e.sourceId),
      'source ID',
    );
    unique(
      catalog.entries.map((e) => e.revision),
      'entry revision',
    );
    unique(
      catalog.entries.map((e) => e.ordinal),
      'ordinal',
    );
    if (catalog.entries.some((entry, i) => entry.ordinal !== i))
      fail('Entries must be in contiguous accepted order');
    if (
      (catalog.applicability === 'not_applicable' ||
        catalog.status === 'withdrawn') &&
      catalog.entries.length
    )
      fail('Inactive scope cannot carry entries');
    if (
      catalog.validity.kind === 'finite' &&
      toolInstantMicros(catalog.validity.expiresAt) <=
        toolInstantMicros(catalog.validity.effectiveAt)
    )
      fail('Invalid validity interval');
    const bindings: string[] = [];
    for (const entry of catalog.entries) {
      if (entry.kind === 'map') {
        unique(
          entry.markers.map((m) => m.id),
          'marker ID',
        );
        unique(
          entry.markers.map((m) => m.sourceId),
          'marker source ID',
        );
      }
      if (entry.kind === 'shuttle') {
        unique(
          entry.groups.map((g) => g.id),
          'group ID',
        );
        for (const group of entry.groups) {
          unique(
            group.slots.map((s) => s.id),
            'slot ID',
          );
          bindings.push(...group.slots.map((s) => s.bindingId));
        }
      }
      if (entry.kind === 'research' && entry.image)
        bindings.push(entry.image.bindingId);
      if (
        (entry.kind === 'research' || entry.kind === 'web-link') &&
        entry.link &&
        !canonicalToolLink(
          entry.link.url,
          entry.link.action,
          catalog.linkPolicy,
        )
      )
        fail('Unaccepted canonical link');
    }
    unique(bindings, 'media binding');
    if (bindings.length > 32) fail('Catalog Media binding budget exceeded');
    for (const rule of catalog.linkPolicy.rules) {
      const query = rule.query.map((q) => `${q.key}=${q.value}`).join('&');
      if (
        !canonicalToolLink(
          `https://${rule.host}${rule.path}${query ? `?${query}` : ''}`,
          rule.action,
          catalog.linkPolicy,
        )
      )
        fail('Invalid link policy rule');
      unique(
        rule.query.map((q) => q.key),
        'query key',
      );
      if (
        rule.query.some((q) =>
          /^(?:url|redirect|return|next|callback|continue|token|uid|location)$/i.test(
            q.key,
          ),
        )
      )
        fail('Unsafe query key');
    }
  });
export type ToolCatalog = z.infer<typeof toolCatalogSchema>;
/** Fixed sorted keys, exact array order, NFC strings, finite JSON numbers with
 * negative zero represented as zero, explicit null, no optional fields. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}
export function sealToolCatalog(input: unknown) {
  const catalog = toolCatalogSchema.parse(input);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(catalog);
  const encoded = canonical(catalog);
  return {
    catalog,
    canonical: encoded,
    digest: createHash('sha256')
      .update(`${TOOL_CATALOG_VERSION}\n`)
      .update(encoded)
      .digest('hex'),
  };
}
export function toolMediaSlots(catalog: ToolCatalog): {
  entry: ToolEntry;
  groupId: string | null;
  slot: z.infer<typeof mediaSlot>;
}[] {
  const result: {
    entry: ToolEntry;
    groupId: string | null;
    slot: z.infer<typeof mediaSlot>;
  }[] = [];
  for (const entry of catalog.entries) {
    if (entry.kind === 'shuttle')
      for (const group of entry.groups)
        for (const slot of group.slots)
          result.push({ entry, groupId: group.id, slot });
    if (entry.kind === 'research' && entry.image)
      result.push({ entry, groupId: null, slot: entry.image });
  }
  return result;
}
