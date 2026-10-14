import { consumeRatingGroupPermit } from './permit.js';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
} from 'node:fs/promises';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  digest,
  effectIdentity,
  type EffectIdentity,
  type Evidence,
  type Permit,
  type PreparedEffect,
  type ReceiptSubscription,
  type SyntheticEffectPort,
  type SyntheticStoreIdentity,
} from '../../ratings/group-promotion/contracts.js';
interface EffectCell {
  version: 1;
  domainId: string;
  key: string;
  effectId: string;
  fence: string;
  receipts: Evidence[];
}
export type SyntheticBehavior =
  'accept' | 'not_accepted' | 'drop_receipt' | 'defer_receipt';
/** Disposable subscription owns no raw unresolved receipt promise. Persisting
 * evidence can disclose a fixed outcome; it can never emit another effect. */
export class DeferredReceipt implements ReceiptSubscription {
  private receive: ((e: Evidence) => void) | null = null;
  private disposed = false;
  private evidence: Evidence | null = null;
  constructor(private readonly disclose = true) {}
  subscribe(receive: (e: Evidence) => void): void {
    if (this.disposed) throw Error('Receipt disposed');
    this.receive = receive;
    if (this.evidence && this.disclose) receive(this.evidence);
  }
  dispose(): void {
    this.disposed = true;
    this.receive = null;
    this.evidence = null;
  }
  fixedDurable(evidence: Evidence): void {
    if (this.disposed) return;
    this.evidence = evidence;
    if (this.disclose) this.receive?.(evidence);
  }
  get active(): boolean {
    return this.receive !== null;
  }
}
const activeCells = new Map<string, number>();
/** Explicit isolated fixture only. Preparation does asynchronous durable IO and
 * obtains an exclusive per-effect lock. Acceptance performs NO IO, await, wait,
 * timer, or user callback. A trusted microtask only persists the already-fixed
 * receipt. Until persistence succeeds, crashes remain unknown, never retryable.
 * A crashed lock is not automatically stolen: coordinated restore is required.
 * Every effect cell contains at most the stage's 2/3 bounded dispatch receipts. */
export class DurableSyntheticRatingGroupPort implements SyntheticEffectPort {
  private readonly secret: Buffer;
  private behavior: SyntheticBehavior = 'accept';
  private output: string | undefined;
  private readonly directory: string;
  constructor(
    readonly path: string,
    readonly domainId: string,
    secret: Buffer,
    create = false,
  ) {
    if (secret.length < 32) throw Error('Synthetic evidence key too short');
    this.secret = Buffer.from(secret);
    this.directory = `${path}.cells`;
    if (!existsSync(path)) {
      if (!create) throw Error('Synthetic registry restore required');
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          domainId,
          storeId: randomUUID(),
          ledgerInstanceId: null,
          restoreEpoch: null,
        }),
        {
          mode: 0o600,
          flag: 'wx',
        },
      );
    }
    const header = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      domainId: string;
    };
    if (
      header.version !== 1 ||
      header.domainId !== domainId ||
      !existsSync(this.directory)
    )
      throw Error('Synthetic registry domain mismatch');
  }
  async storageIdentity(): Promise<SyntheticStoreIdentity> {
    const header = JSON.parse(
      await readFile(this.path, 'utf8'),
    ) as SyntheticStoreIdentity;
    if (header.domainId !== this.domainId || typeof header.storeId !== 'string')
      throw Error('Synthetic store identity unavailable');
    return header;
  }
  /** Explicit fixture-only coordinated creation. Existing bindings cannot be
   * replaced by a fresh ledger or a new unrelated receipt-store generation. */
  async bindLedger(
    ledgerInstanceId: string,
    restoreEpoch: string,
  ): Promise<void> {
    const header = await this.storageIdentity();
    if (header.ledgerInstanceId !== null || header.restoreEpoch !== null)
      throw Error('Synthetic store already bound');
    await writeFile(
      this.path,
      JSON.stringify({ ...header, version: 1, ledgerInstanceId, restoreEpoch }),
      { mode: 0o600, flush: true },
    );
  }
  setBehavior(behavior: SyntheticBehavior, output?: string) {
    if (output !== undefined && Buffer.byteLength(output) > 1024)
      throw Error('Synthetic output budget');
    this.behavior = behavior;
    this.output = output;
  }
  private file(effectId: string) {
    if (!/^[0-9a-f-]{36}$/.test(effectId))
      throw Error('Invalid fixture effect');
    return join(this.directory, `${effectId}.json`);
  }
  private async load(identity: EffectIdentity): Promise<EffectCell> {
    try {
      const c = JSON.parse(
        await readFile(this.file(identity.effectId), 'utf8'),
      ) as EffectCell;
      if (
        c.version !== 1 ||
        c.domainId !== this.domainId ||
        c.key !== identity.key ||
        c.effectId !== identity.effectId ||
        c.receipts.length > 3
      )
        throw Error('Synthetic cell mismatch');
      return c;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        version: 1,
        domainId: this.domainId,
        key: identity.key,
        effectId: identity.effectId,
        fence: '0',
        receipts: [],
      };
    }
  }
  private async save(c: EffectCell) {
    const file = this.file(c.effectId),
      temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(c), {
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    await rename(temp, file);
  }
  private sign(value: Omit<Evidence, 'proofHash'>): string {
    return createHmac('sha256', this.secret)
      .update(digest(value))
      .digest('hex');
  }
  authenticate(e: Evidence): boolean {
    const { proofHash, ...value } = e;
    if (!/^[a-f0-9]{64}$/.test(proofHash)) return false;
    return timingSafeEqual(
      Buffer.from(proofHash, 'hex'),
      Buffer.from(this.sign(value), 'hex'),
    );
  }
  async prepare(
    identity: EffectIdentity,
    input: unknown,
    signal: AbortSignal,
  ): Promise<PreparedEffect> {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (
      bytes > (identity.stage === 'generation' ? 512 : 1024) ||
      (identity.stage === 'generation' &&
        this.output !== undefined &&
        Buffer.byteLength(this.output) > 128)
    )
      throw Error('Synthetic input/token budget exceeded');
    if (signal.aborted || (activeCells.get(this.path) ?? 0) >= 32)
      throw Error('Synthetic preparation unavailable');
    const lock = `${this.file(identity.effectId)}.lock`;
    await mkdir(lock);
    activeCells.set(this.path, (activeCells.get(this.path) ?? 0) + 1);
    let released = false,
      used = false,
      disposed = false;
    const release = async () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (activeCells.get(this.path) ?? 1) - 1);
      if (remaining) activeCells.set(this.path, remaining);
      else activeCells.delete(this.path);
      await rm(lock, { recursive: true });
    };
    try {
      const cell = await this.load(identity);
      if (BigInt(cell.fence) > BigInt(identity.fence) || signal.aborted)
        throw Error('Stale synthetic preparation');
      cell.fence = identity.fence;
      await this.save(cell);
      if (signal.aborted) throw Error('Preparation aborted');
      const behavior = this.behavior,
        output = this.output,
        receiptId = `synthetic:${randomUUID()}`;
      const frozen = Object.freeze({ ...identity });
      const completion = new DeferredReceipt(
        behavior !== 'drop_receipt' && behavior !== 'defer_receipt',
      );
      const prior = cell.receipts.find(
        (e) => e.attemptId === identity.attemptId,
      );
      const old = prior ? Object.freeze({ ...prior }) : undefined;
      if (
        cell.receipts.some(
          (e) => e.kind === 'accepted' && e.attemptId !== identity.attemptId,
        )
      )
        throw Error('Original key already accepted');
      const persist = async (fixed: Readonly<Omit<Evidence, 'proofHash'>>) => {
        try {
          // The synchronous boundary already fixed every acceptance field. Only
          // authentication and metadata persistence happen here; never re-sample
          // time, choose an outcome, or emit again after a signing/storage failure.
          const e: Evidence =
            old ?? Object.freeze({ ...fixed, proofHash: this.sign(fixed) });
          if (!old) {
            // Durable recovery stores only the authenticated acceptance tuple.
            // Optional output is delivered once to the bounded live subscription;
            // after a crash it is unavailable and composition uses its qualified
            // deterministic/native fallback. No source bytes enter the receipt store.
            const metadata = { ...e };
            delete metadata.output;
            const unsigned: Omit<Evidence, 'proofHash'> & {
              proofHash?: string;
            } = metadata;
            delete unsigned.proofHash;
            cell.receipts.push({ ...unsigned, proofHash: this.sign(unsigned) });
            await this.save(cell);
          }
          completion.fixedDurable(e);
        } catch {
          /* receipt remains unknown; no callback is a new emission */
        } finally {
          await release().catch(() => {});
        }
      };
      return {
        identity: frozen,
        dispose: () => {
          if (used || disposed) return;
          disposed = true;
          completion.dispose();
          void release().catch(() => {});
        },
        dispatch: (permit: Permit) => {
          const start = performance.now();
          if (
            used ||
            disposed ||
            cell.fence !== frozen.fence ||
            !consumeRatingGroupPermit(permit, frozen)
          )
            throw Error('Synthetic permit unavailable');
          used = true;
          const now = Date.now();
          const raw = Object.freeze({
            ...frozen,
            kind:
              behavior === 'not_accepted'
                ? ('not_accepted' as const)
                : ('accepted' as const),
            receiptId,
            acceptedAt: now,
            observedAt: now,
            ...(output === undefined ? {} : { output }),
          });
          const fixed = old ?? raw;
          // Only authentication/metadata persistence is queued. The immutable
          // acceptance tuple was fixed above and cannot change in that callback.
          queueMicrotask(() => {
            void persist(fixed);
          });
          if (performance.now() - start > 1) {
            completion.dispose();
            throw Error(
              'Synthetic acceptance exceeded one millisecond; outcome remains unknown',
            );
          }
          return completion;
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  async reconcile(
    identity: EffectIdentity,
    signal: AbortSignal,
  ): Promise<Evidence | null> {
    if (signal.aborted) return null;
    const evidence = (await this.load(identity)).receipts.find(
      (e) => e.attemptId === identity.attemptId,
    );
    return evidence && digest(identity) === digest(effectIdentity(evidence))
      ? evidence
      : null;
  }
  async receipt(identity: EffectIdentity): Promise<Evidence | null> {
    return this.reconcile(identity, new AbortController().signal);
  }
  /** Test diagnostics only, never used by selection/dispatch/reconciliation. */
  async receiptCount(): Promise<number> {
    let count = 0;
    for (const file of await readdir(this.directory))
      if (file.endsWith('.json')) {
        const c = JSON.parse(
          await readFile(join(this.directory, file), 'utf8'),
        ) as EffectCell;
        count += c.receipts.length;
      }
    return count;
  }
}
