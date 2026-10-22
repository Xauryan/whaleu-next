# Exact historical publication producers

Only the 0137 related-sync upgrade witness and the 0144 pre0148 in-flight
rating-card upgrade witness install this test adapter. Their historical phases
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

The override is selected only for 137 and 144. Other registered historical
fixtures retain their current composition; an unbounded/current restart installs
neither the producer nor the transaction proxy. An already captured historical
owner cannot write across a ledger upgrade or recognized partial Home deployment.

Pure tests cover byte provenance, real Nest constructor injection, exact journal
arguments, closed configuration, source downgrade rejection, prefix/checksum and
partial deployment failures, options/result/error/savepoint preservation, and a
DDL change after the callback tail that must roll back before COMMIT. The original
two integration files remain unchanged and must still run in full to establish
real PostgreSQL old-producer and post-upgrade replay acceptance.
