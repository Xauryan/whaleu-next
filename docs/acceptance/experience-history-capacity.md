# Bounded experience history capacity observation

Measured on signed commit `8f4eee24bff7fb35608b9bb56e50685fad8800d6` on
2026-10-08. This local warm-cache observation concerns worker transactions, not a
production SLA or automatic dispatcher backlog throughput. No runtime source,
constraint, trigger or database integrity check was bypassed or changed.

## Method

A normal AppModule and PostgreSQL 18.6 used canonical synthetic authorization and
review facts, genuinely new account creation, durable self-like/unlike commands
and the actual ExperienceWorker. Every history row came from a real source
transition and settlement. Later same-day likes legitimately reached the cap and
still exercised terminal settlement and reconciliation. No historical dates or
pre-settled rows were fabricated.

Starting histories of exactly 1,000 and 10,000 settled units were followed by
100 hot-owner samples, 100 fresh-owner samples and 100 two-owner parallel pairs.
Source mutation latency was recorded separately from worker selection/settlement.
All dates used the real database clock; the normal 10-second statement timeout
remained in effect. The complete measurement took 240.95 seconds.

## Results

All values are milliseconds, with 100 observations per window.

| Starting history | Hot p95 | Hot p99 | Hot mean | Fresh p95 | Parallel hot p95 | Parallel control p95 |
| ---------------- | ------: | ------: | -------: | --------: | ---------------: | -------------------: |
| 1,000            |    5.89 |    6.65 |     4.98 |      5.34 |             6.57 |                 5.78 |
| 10,000           |   11.79 |   13.48 |    10.37 |      5.54 |            14.87 |                 8.74 |

The provisional local development checks, p95 at most 250 ms and p99 at most
500 ms, passed in every measured mode. There were no worker/integrity errors,
deadlocks or statement timeouts. Growth was reported independently: hot p95 grew
2.003 times, and hot p99 2.029 times. These checks are not advertised service limits.

The final hot owner had 10,200 settlements and records, revision 10,200, balance
20, 10,189 capped outcomes and zero pending units. Both controls ended with 201
settlements/records each, balance 20 and zero pending work. Baseline plus applied
deltas reconciled exactly. Cleanup left zero application schemas; PostgreSQL
stopped and the source fingerprint remained unchanged.

## Query cost and interpretation

Warm EXPLAIN ANALYZE/BUFFERS measurements after ANALYZE confirmed linear aggregate
cost: lifetime reconciliation increased from 0.133 to 1.399 ms, and daily-action
reconciliation from 0.221 to 2.192 ms. Plans read 25 versus 249 shared-hit blocks,
with no shared-read or temporary blocks. The concentrated owner population used
sequential scans. Mean observed COMMIT time rose from 1.42 to 7.07 ms as deferred
checks grew. The measured source performs two lifetime and three daily aggregate
checks per community-unit settlement.

Environment: Node 24.19.0, PostgreSQL 18.6, fsync and synchronous_commit enabled,
32 MB shared buffers, maximum 50 connections, nine exposed logical CPUs and
approximately 9.73 GiB memory. Exposed resources are not guaranteed dedicated
hardware. The settlements heap was about 2.03 MiB, or 4.94 MiB including indexes.

The measured snapshot discovers only one earliest pending unit per owner per
automatic tick. Its default five-second interval can limit a hot owner's automatic
drain rate despite fast transactions. This benchmark does not establish dispatcher
throughput; any subsequent batching change needs separate ordering, fairness,
budget, restart and exactly-once tests.

Larger histories, realistic multi-owner distributions, multi-day/action mixes,
cold-cache behavior and higher concurrency remain concrete production-capacity
gates. The observed 10,000-row pass does not justify removing conservation checks
or claiming unbounded scale.
