/** Feature-only diagnostics; no processing permit and no replacement read authority. */
import { ClientError, isRecord } from '../api/errors';
import {
  decodeTextSourceCapability,
  type TextSourceCapability,
} from './text-source-contract';
export interface ReadingCapability extends Omit<
  TextSourceCapability,
  'version' | 'formatter'
> {
  readonly version: 2;
  readonly formatter: Readonly<{
    version: 'plain-cjk-slices-v2';
    schema: 'installed' | 'missing' | 'unavailable';
    worker: Readonly<{
      requestedMode: 'disabled' | 'manual_only' | 'automatic';
      readiness: 'not_observed';
    }>;
  }>;
}
function invalid(): never {
  throw new ClientError('protocol', 'Invalid reading readiness');
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
export function decodeReadingCapability(raw: unknown): ReadingCapability {
  if (!isRecord(raw) || raw.version !== 2 || !isRecord(raw.formatter))
    invalid();
  // Reuse the exact v1 publication decoder; never relax its known wire literal.
  const source = decodeTextSourceCapability({
    ...raw,
    version: 1,
    formatter: 'not_configured',
  });
  const f = raw.formatter;
  exact(f, ['version', 'schema', 'worker']);
  if (
    f.version !== 'plain-cjk-slices-v2' ||
    (f.schema !== 'installed' &&
      f.schema !== 'missing' &&
      f.schema !== 'unavailable') ||
    !isRecord(f.worker)
  )
    invalid();
  const worker = f.worker;
  exact(worker, ['requestedMode', 'readiness']);
  if (
    (worker.requestedMode !== 'disabled' &&
      worker.requestedMode !== 'manual_only' &&
      worker.requestedMode !== 'automatic') ||
    worker.readiness !== 'not_observed'
  )
    invalid();
  return Object.freeze({
    ...source,
    version: 2,
    formatter: Object.freeze({
      version: f.version,
      schema: f.schema,
      worker: Object.freeze({
        requestedMode: worker.requestedMode,
        readiness: worker.readiness,
      }),
    }),
  });
}
