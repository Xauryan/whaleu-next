import { sealToolCatalog } from './contracts.js';
/** Canonical transport rejects duplicate keys, ambiguous number/string escapes,
 * BOMs and incidental formatting before anything can become trusted evidence. */
export function validateToolManifest(source: string, now = Date.now()) {
  if (Buffer.byteLength(source, 'utf8') > 262144)
    throw new Error('MANIFEST_TOO_LARGE');
  const raw = source.endsWith('\n') ? source.slice(0, -1) : source;
  const sealed = sealToolCatalog(JSON.parse(raw) as unknown);
  if (raw !== sealed.canonical) throw new Error('NONCANONICAL_MANIFEST');
  const { catalog } = sealed;
  const reasons: string[] = [];
  if (catalog.coverage !== 'complete') reasons.push('PARTIAL_COVERAGE');
  if (Date.parse(catalog.validity.effectiveAt) > now)
    reasons.push('FUTURE_EFFECTIVE');
  if (
    catalog.validity.kind === 'finite' &&
    Date.parse(catalog.validity.expiresAt) <= now
  )
    reasons.push('EXPIRED');
  if (
    Date.parse(catalog.source.observedAt) > now ||
    Date.parse(catalog.source.publishedAt) > now
  )
    reasons.push('FUTURE_SOURCE');
  return {
    ...sealed,
    report: {
      state: reasons.length ? ('quarantined' as const) : ('candidate' as const),
      campusId: catalog.campusId,
      digest: sealed.digest,
      entries: catalog.entries.length,
      reasons,
      trusted: false as const,
    },
  };
}
