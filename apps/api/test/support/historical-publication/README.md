# Exact historical publication producers

The 0137 related-sync upgrade witness and the 0144 pre0148 in-flight rating-card
upgrade witness use the closed 137/144 entrypoint. A separate exact0174 entrypoint
is explicitly opted into only by the like/save deletion-lineage loop and its
synthetic cooling-refusal witness. Their historical phases
must genuinely produce the old requests, approvals, content and receipts without
installing Home or changing the production owner's fail-closed behavior.

The saved publication service is the complete source at
`c27f173d8057f349469f4f96855d31edb9cff7c5`. Its original Git blob and SHA-256 are
recorded in `provenance.json` and independently pinned by the pure test. Reversing
only the declared import mappings, including the inline import type, reproduces
both hashes. One explicit discussion-target adapter first runs unchanged current
authorization, then checks the legacy category and c27 envelope versions 1–5.
Water, unknown categories and newer source/Home envelopes are rejected, not cast
into a widened contract. All returned fields are retained and the Media helper is
re-exported unchanged. The adapter path, original dependency and hash are pinned
in provenance and tested independently. The byte-preserved file is excluded from formatting for that reason.
It still uses current Safety, authorization, Media, Review, related distribution,
approval binding and publication-journal dependencies. No decision, approval,
receipt, source value, database result or permission is fabricated.

The wrapper's only input restriction rejects future text-source requests before
they could be interpreted as old plain text. All source-free post/comment calls
use the original decorated producer methods. The current reply producer's new
source-parent hook is likewise rejected; ordinary legacy replies retain the
original shared approval/scope helpers. Current Review and journal recovery run
unchanged, and the existing historical definition/enrollment adapters retain
exactly their previous scope.

The added DatabaseService proxy is test-only. It wraps only `transaction`, calls
the real transaction owner once, and passes through the same transaction client,
options, callback result and thrown error. The real owner still manages BEGIN,
savepoints, constraint flushing, COMMIT and ROLLBACK. Early receipt returns are
fenced as well as newly created content. The prefix proof is acquired before the
callback, re-enrolled after it, and checked again in the real mandatory pre-COMMIT
proof phase. Savepoint restoration does not turn a failed proof into a permit.

The shared historical boundary requires test mode, loopback `whaleu_test`,
disabled SSL, an exact complete ordered migration/checksum prefix, the actual
migration-runner shared advisory fence and retained migration-ledger SHARE lock.
It already rejects partial text-source objects. Additional Home checks use a
finite inventory from checked-in 0177/0178 declarations: exact relation/type and
function names, renamed predecessors, and bounded triggers/columns/constraints.
They do not repeat an unrestricted catalog-prefix scan. These are recognized
successor checks, not a claim to attest every possible arbitrary database edit.

The original override remains selected only for 137 and 144 and still rejects 174. The separate `follow-social.ts` entrypoint accepts no caller-supplied prefix
and requires exactly 174, plus three correctly typed lifecycle columns and the
enabled deletion lifecycle guard on the accounts table. It preserves the current
lifecycle-aware Identity repository, authentication, account locks and new-peer
creation contract. It does not route through the pre-deletion Identity adapter or
change the synthetic deletion owner. Existing follow/social fixture callers do
not opt in by default; local rehearsal and current-source fail-closed tests remain
unchanged. An unbounded/current restart installs neither the producer nor the
transaction proxy. An already captured historical
owner cannot write across a ledger upgrade or recognized partial Home deployment.

Pure tests cover byte provenance, real Nest constructor injection, exact journal
arguments, closed configuration, source downgrade rejection, prefix/checksum and
partial deployment failures, options/result/error/savepoint preservation, and a
DDL change after the callback tail that must roll back before COMMIT. The original
two upgrade integration files retain their full commands and replay assertions;
the rating upgrade explicitly proves only the nullable 0175/0178 cohort-column
additions before comparing whole rows. Both must still run in full to establish
real PostgreSQL old-producer and post-upgrade replay acceptance. The original
follow/social file retains all unsupported-content/reward deletion assertions and
adds a content-empty synthetic actor entering cooling through the real deletion
request owner. Its fresh HTTP publication must fail with no post or journal
writes. No lifecycle SQL override or successful receipt is fabricated. Pure tests
exercise current Identity and publication-journal refusal before any receipt
lookup for cooling, erasing and completed accounts.

For the epoch-aware successor, the exact0174 deletion fixture separately installs
the pinned lifecycle-aware Identity adapter. The publication adapter itself still
overrides only its database and producer; it cannot authorize Identity or epoch
fallback. Current epoch authentication is tested on current schema, while the
historical owner retains original refresh, logout and lifecycle rejection.
