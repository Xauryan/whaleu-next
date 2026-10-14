import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OfficialEffectStage } from './contracts.js';
import { OFFICIAL_PROFILE, officialDigest } from './profile.js';

export interface OfficialEffectIdentity {
  effectId: string;
  commandId: string;
  accountRef: string;
  destinationRef: string;
  stage: OfficialEffectStage;
  purpose: string;
  manifestHash: string;
  renderedHash: string;
  assetAppearanceId: string | null;
  assetRevision: string | null;
  variantHash: string | null;
  logicalKey: string;
}
export type OfficialEvidenceKind =
  | 'not_sent'
  | 'not_accepted'
  | 'material_accepted'
  | 'draft_created'
  | 'publish_submitted'
  | 'published'
  | 'publication_rejected'
  | 'unknown';
export interface OfficialProviderEvidence {
  effect: OfficialEffectIdentity;
  attemptId: string;
  kind: OfficialEvidenceKind;
  receiptRef: string | null;
  acceptedAt: string | null;
  proofHash: string;
}
export interface OfficialPermit {
  readonly effect: OfficialEffectIdentity;
  readonly attemptId: string;
  readonly fence: string;
  readonly authorityDigest: string;
  readonly expiresAt: number;
  readonly leaseUntil: number;
}
export interface OfficialPrepared {
  readonly preparedHash: string;
  dispatch(permit: OfficialPermit): OfficialProviderEvidence;
}
export interface OfficialSyntheticProvider {
  readonly profile: 'synthetic-official-v1';
  prepare(
    effect: OfficialEffectIdentity,
    body: Buffer,
    draft?: OfficialEffectIdentity,
  ): Promise<OfficialPrepared>;
  arm(
    effect: OfficialEffectIdentity,
    attemptId: string,
    fence: string,
    leaseUntil: number,
  ): void;
  reconcile(
    effect: OfficialEffectIdentity,
  ): Promise<OfficialProviderEvidence | null>;
  contentHash(effect: OfficialEffectIdentity): Promise<string | null>;
  verify(evidence: OfficialProviderEvidence): boolean;
}
const permits = new WeakSet<object>();
export function createOfficialPermit(
  effect: OfficialEffectIdentity,
  attemptId: string,
  fence: string,
  authorityDigest: string,
  leaseUntil: number,
): OfficialPermit {
  const permit = Object.freeze({
    effect,
    attemptId,
    fence,
    authorityDigest,
    expiresAt: performance.now() + OFFICIAL_PROFILE.permitMs,
    leaseUntil,
  });
  permits.add(permit);
  return permit;
}
const TEST_KEY =
  'PUBLIC TEST VALUE ONLY: synthetic-official-v1 effect receipts';
/** Explicit isolated test-storage adapter. Synchronous shared filesystem fence and
 * receipt persist across processes/restart. It performs no network/provider call.
 * The entire directory and database form one fixture; partial reset is rejected. */
export class FileSyntheticOfficialProvider implements OfficialSyntheticProvider {
  readonly profile = 'synthetic-official-v1' as const;
  constructor(
    private readonly directory: string,
    private readonly fixtureEpoch: string,
  ) {
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, 'fixture-epoch');
    if (existsSync(marker)) {
      if (readFileSync(marker, 'utf8') !== fixtureEpoch)
        throw new Error('Synthetic fixture epoch mismatch');
    } else writeFileSync(marker, fixtureEpoch, { flag: 'wx', mode: 0o600 });
  }
  private path(key: string, suffix: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid effect key');
    return join(this.directory, `${key}.${suffix}`);
  }
  private sign(
    input: Omit<OfficialProviderEvidence, 'proofHash'>,
  ): OfficialProviderEvidence {
    return {
      ...input,
      proofHash: createHmac('sha256', TEST_KEY)
        .update(JSON.stringify(input))
        .digest('hex'),
    };
  }
  verify(evidence: OfficialProviderEvidence): boolean {
    const { proofHash, ...input } = evidence;
    const expected = this.sign(input).proofHash;
    return (
      /^[a-f0-9]{64}$/.test(proofHash) &&
      timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(proofHash, 'hex'),
      )
    );
  }
  arm(
    effect: OfficialEffectIdentity,
    attemptId: string,
    fence: string,
    leaseUntil: number,
  ): void {
    const path = this.path(effect.logicalKey, 'fence');
    const temp = this.path(effect.logicalKey, `fence-${fence}`);
    writeFileSync(
      temp,
      JSON.stringify({
        effect,
        attemptId,
        fence,
        leaseUntil,
        fixtureEpoch: this.fixtureEpoch,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    renameSync(temp, path);
  }
  async prepare(
    effect: OfficialEffectIdentity,
    body: Buffer,
    draft?: OfficialEffectIdentity,
  ): Promise<OfficialPrepared> {
    if (
      effect.stage === 'publish_submit' &&
      (!draft ||
        draft.stage !== 'draft_create' ||
        draft.accountRef !== effect.accountRef ||
        draft.manifestHash !== effect.manifestHash ||
        draft.renderedHash !== effect.renderedHash)
    )
      throw new Error('Exact draft required');
    const expected =
      effect.stage === 'material' ? effect.variantHash : effect.renderedHash;
    const preparedHash = createHash('sha256').update(body).digest('hex');
    if (preparedHash !== expected) throw new Error('Prepared bytes mismatch');
    return Object.freeze({
      preparedHash,
      dispatch: (permit: OfficialPermit) => {
        if (
          !permits.delete(permit) ||
          permit.effect.logicalKey !== effect.logicalKey
        )
          throw new Error('Synthetic permit identity rejected');
        if (
          performance.now() >= permit.expiresAt ||
          Date.now() + 1000 >= permit.leaseUntil
        )
          return this.sign({
            effect,
            attemptId: permit.attemptId,
            kind: 'not_sent',
            receiptRef: null,
            acceptedAt: null,
          });
        const lock = this.path(effect.logicalKey, 'lock');
        let fd: number | undefined;
        try {
          fd = openSync(lock, 'wx', 0o600);
          const armed = JSON.parse(
            readFileSync(this.path(effect.logicalKey, 'fence'), 'utf8'),
          ) as {
            effect: OfficialEffectIdentity;
            attemptId: string;
            fence: string;
            leaseUntil: number;
            fixtureEpoch: string;
          };
          if (
            armed.fence !== permit.fence ||
            armed.attemptId !== permit.attemptId ||
            armed.fixtureEpoch !== this.fixtureEpoch ||
            officialDigest(armed.effect) !== officialDigest(effect) ||
            armed.leaseUntil !== permit.leaseUntil ||
            Date.now() + 1000 >= armed.leaseUntil
          )
            throw new Error('Synthetic shared fence rejected');
          if (draft) {
            const prior = JSON.parse(
              readFileSync(this.path(draft.logicalKey, 'receipt'), 'utf8'),
            ) as OfficialProviderEvidence;
            if (
              !this.verify(prior) ||
              prior.kind !== 'draft_created' ||
              officialDigest(prior.effect) !== officialDigest(draft)
            )
              throw new Error('Original synthetic draft changed');
          }
          const receipt = this.path(effect.logicalKey, 'receipt');
          if (existsSync(receipt))
            return JSON.parse(
              readFileSync(receipt, 'utf8'),
            ) as OfficialProviderEvidence;
          const evidence = this.sign({
            effect,
            attemptId: permit.attemptId,
            kind:
              effect.stage === 'material'
                ? 'material_accepted'
                : effect.stage === 'draft_create'
                  ? 'draft_created'
                  : 'publish_submitted',
            receiptRef: `synthetic:${effect.logicalKey}`,
            acceptedAt: new Date().toISOString(),
          });
          writeFileSync(receipt, JSON.stringify(evidence), {
            flag: 'wx',
            mode: 0o600,
          });
          return evidence;
        } finally {
          if (fd !== undefined) {
            closeSync(fd);
            unlinkSync(lock);
          }
        }
      },
    });
  }
  async reconcile(
    effect: OfficialEffectIdentity,
  ): Promise<OfficialProviderEvidence | null> {
    const path = this.path(effect.logicalKey, 'receipt');
    if (!existsSync(path)) return null; // absence cannot prove nonacceptance after an ambiguous crash.
    const evidence = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as OfficialProviderEvidence;
    if (
      !this.verify(evidence) ||
      officialDigest(evidence.effect) !== officialDigest(effect)
    )
      throw new Error('Synthetic receipt mismatch');
    return evidence;
  }
  async contentHash(effect: OfficialEffectIdentity): Promise<string | null> {
    return (await this.reconcile(effect))?.effect.renderedHash ?? null;
  }
}
