import type { Readable } from 'node:stream';
import type { ExactObject } from '../media/contracts.js';
import type { ProcessedImage } from '../media/processing/protocol.js';
import type {
  ImmutableMediaStorage,
  StoredObjectMeasurement,
} from '../media/storage-port.js';
import type { ToolCatalog } from './contracts.js';
export const CAMPUS_TOOLS_RUNTIME = Symbol('CAMPUS_TOOLS_RUNTIME');
export interface ToolAcceptance {
  readonly reference: string;
  readonly proof: string;
}
/** Configuration-owned source verifier. It must authenticate the exact canonical
 * digest AND every scope/policy/validity/media/head fact it covers. User roles,
 * source booleans, environment strings and a successful parser cannot supply it. */
export interface ToolSourceAuthority {
  accept(catalog: ToolCatalog, digest: string): Promise<ToolAcceptance>;
  verify(
    catalog: ToolCatalog,
    digest: string,
    acceptance: ToolAcceptance,
  ): boolean;
}
export interface ToolStagingInput {
  readonly original: ExactObject;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly sha256: string;
  readonly bytes: number;
  readonly destinations: readonly [ExactObject, ExactObject];
}
export interface ToolMediaAdmissionPort {
  /** Trusted staging is resolved by exact accepted digest+asset identity; no raw
   * URL, storage locator or arbitrary bytes comes from the public manifest. */
  staging(catalogDigest: string, assetId: string): Promise<ToolStagingInput>;
  process(source: Readable, mime: string): Promise<ProcessedImage>;
  /** Immutable writes must measure the real supplied bytes and reject overwrite. */
  put(
    bytes: Buffer,
    destination: ExactObject,
  ): Promise<StoredObjectMeasurement>;
}
export interface CampusToolsRuntime {
  readonly authority: ToolSourceAuthority;
  readonly storage: ImmutableMediaStorage;
  readonly admission: ToolMediaAdmissionPort;
  /** Trusted configuration attests enforced controlled destination navigation.
   * No default and never a boolean supplied by catalog content. */
  readonly webview: null | {
    allows(catalog: ToolCatalog, entryId: string): boolean;
  };
}

/** Adapter failures are unavailable authority, never permission or absent data. */
export function acceptedToolSource(
  runtime: CampusToolsRuntime | null,
  catalog: ToolCatalog,
  digest: string,
  acceptance: ToolAcceptance,
): boolean {
  try {
    return runtime?.authority.verify(catalog, digest, acceptance) === true;
  } catch {
    return false;
  }
}
export function acceptedToolWebview(
  runtime: CampusToolsRuntime | null,
  catalog: ToolCatalog,
  entryId: string,
): boolean {
  try {
    return runtime?.webview?.allows(catalog, entryId) === true;
  } catch {
    return false;
  }
}
