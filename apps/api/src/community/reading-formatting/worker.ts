import { Inject, Injectable } from '@nestjs/common';
import { ReadingFormattingRuntime, decodeCandidate } from './runtime.js';
import type { QueueCursor, ReadingClaim } from './runtime.js';
import { formatSource } from './formatter.js';
/** One invocation carries its exact raw cursor across ticks; restart relies on
 * durable probe deferral/quarantine. No process-local semaphore is authority. */
@Injectable()
export class ReadingFormattingWorker {
  private cursor: QueueCursor | null = null;
  constructor(
    @Inject(ReadingFormattingRuntime)
    private readonly runtime: ReadingFormattingRuntime,
  ) {}
  async tick() {
    const rows = await this.runtime.candidates(this.cursor);
    const report = {
      examined: 0,
      claimed: 0,
      completed: 0,
      deferred: 0,
      skipped: 0,
      wrapped: false,
    };
    if (!rows.length) {
      this.cursor = null;
      report.wrapped = true;
      return report;
    }
    const claims: ReadingClaim[] = [];
    for (const raw of rows) {
      if (report.claimed === 2) break;
      const decoded = decodeCandidate(raw);
      report.examined++;
      this.cursor = {
        nextProbeAt: decoded.schedule.next_probe_at,
        jobKey: decoded.schedule.job_key,
      };
      if (!decoded.job.success) {
        try {
          if (await this.runtime.defer(raw, 'invalid_payload'))
            report.deferred++;
        } catch {
          report.skipped++;
        }
        continue;
      }
      try {
        const claim = await this.runtime.claim(raw);
        if (!claim) {
          report.skipped++;
          continue;
        }
        report.claimed++;
        claims.push(claim);
      } catch {
        // Failed owner proof was rolled back. Only exact locked scheduling facts
        // in a fresh TX permit maintenance; no error is converted into lifecycle.
        try {
          if (await this.runtime.defer(raw, 'authority_unavailable'))
            report.deferred++;
          else report.skipped++;
        } catch {
          report.skipped++;
        }
      }
    }
    // Deterministic local work is cheap. Claim at most two first, then complete
    // sequentially so one invocation never conflicts with its own slot fences.
    for (const claim of claims) {
      const formatted = formatSource(claim.source);
      if (formatted.kind !== 'plan') {
        try {
          await this.runtime.retry(claim);
        } catch {
          /* Expiry remains DB-owned. */
        }
        report.skipped++;
        continue;
      }
      try {
        if (await this.runtime.complete(claim, formatted.plan))
          report.completed++;
        else report.skipped++;
      } catch {
        report.skipped++;
      }
    }
    return report;
  }
  async run(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 32)
      throw new TypeError('Expected 1..32 ticks');
    const reports = [];
    for (let i = 0; i < ticks; i++) {
      const report = await this.tick();
      reports.push(report);
      if (report.wrapped) break;
    }
    return reports;
  }
}
