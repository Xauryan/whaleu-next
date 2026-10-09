# Ratings random selection (R3R development slice)

Status: local implementation, under integrated acceptance. This is a new explicit native API
contract, not a claim that missing legacy SQL details have been reconstructed.
There is no production import, real Review issuer, provider, role seeding or
release activation. The complete rewrite and production acceptance remain open.

## Request and result

`GET /v1/ratings/random-target?categoryId=<uuid>&campusId=<uuid>&minimumAverage=4.2`

All fields are strict. `categoryId` is required; `campusId` and `minimumAverage`
are optional. No region, cursor, limit, batch, repeat or caller-identity fields
are accepted. GET bodies are empty. Current session, account Safety and canonical
phone verification are required, with the existing shared rating throttle and
no-store/Vary Authorization headers.

- Omitted campus means **global only**, not the user's home or browsing campus.
- Explicit campus is a new native physical campus UUID. Its accepted institution
  membership selects all active physical campuses of that institution, their
  exact operating-region assignments, and global. Authentication relationship
  groups never define the university. Every regional scope is separately checked
  through the current rating access authority; a denied sibling fails the request.
- The selected category and all its visible descendants are searched in each
  current sealed catalog. The same canonical category UUID is used in each
  catalog; names are never matched. Missing/hidden category branches in a sealed
  complete catalog contribute no candidates; unknown catalog evidence fails.
- Global targets may be reached through a valid global or authorized regional
  catalog, as permitted by canonical detail reads. Regional targets must match
  the authorized catalog region. Every path is validated before duplicate target
  identities are collapsed; an unknown second path cannot be hidden by an allow.
  Results carry the actual validated catalog region used for detail reads.
- Omitted minimum imposes no score requirement: unknown and known-zero summaries
  remain eligible. A supplied minimum is 1–5 with at most one decimal place.
  Comparison is inclusive against exact `sum/count`, not rounded display average.
  Known-zero has no average and does not qualify. Any visible candidate with an
  unknown summary makes the entire filtered request `RATING_SCORE_UNAVAILABLE`.
- One eligible target is chosen uniformly with Node's cryptographic integer draw.
  Requests are independent and may repeat. Empty complete pools return null.

Response:

```json
{
  "context": {
    "campusId": null,
    "categoryId": "<uuid>",
    "minimumAverage": null
  },
  "candidateCount": 0,
  "item": null
}
```

A non-null item is `{regionId: uuid|null, target: RatingTarget, summary:
RatingSummary}`. `candidateCount` is the entire eligible pool size, never a count
of the current page. Zero count is equivalent to null item. Errors do not return a
partial item/count. Unknown source information is not an empty successful pool.

## Complete streaming admission and existing authority

The owner-native pool scans all candidate paths to authenticated EOF in transport
batches of 128. This is not a 128-candidate pool limit. Independent whole-request
budgets are 10,000 distinct raw targets, 50,000 catalog/target paths, 201 catalogs
(global plus 200 regions), 64 MiB parsed metadata and 15 seconds. Per-statement
preparation uses at most two seconds or the shorter remaining/configured budget.
Exceeding any budget returns `RATING_UNAVAILABLE` with no count or sample; a scan
prefix is never reported as complete. The campus owner separately rejects
inventories above 1000 campuses / 200 regions rather than returning partial scope.

A private transaction/read-epoch-bound handle and owner-issued immutable batches
prove source and sequence. Review rejects copied, replayed, skipped, mixed-pool,
cross-transaction and restored-savepoint batches. All structural paths, canonical
Review bindings and summary provenance are checked; only then are eligible target
IDs deduplicated and sorted for a single cryptographic index draw. The selected
item retains the existing single-target detail/Review/summary proof. The original
Ratings 161-fact and Review 520-fact limits are unchanged; no IDs are hidden inside
one per-item fact and CountProofCollector is unchanged.

Forward migration 0054 adds a Ratings complete-pool epoch covering catalog/head,
category, membership, target/source/creation, baseline/summary and causal scoring
writes. A separate Review binding epoch covers binding writes without invalidating
existing publication's own earlier Review navigation observation. Existing Review
epochs still cover decisions/events/heads/policies. Stream proofs retain fixed
mutation metadata and deadlines, not per-target facts. These single-row epochs
serialize their participating writers; throughput at production load is an open
release gate. Authority-table trigger ordering acquires the existing Safety gate
before the pool epoch; score writers do not upgrade shared Safety to exclusive.

Both owners require complete EOF and pre-sample epoch/deadline checks. Mandatory
final proofs use NOWAIT fences and fixed-size epoch reads after deferred waits;
all deadlines are checked after all proofs. This covers unselected targets,
phantoms, threshold changes, negative observations and ABA. A concurrent write,
expiry or budget failure cannot become a stale successful sample. Existing
bounded final-proof timeouts remain unchanged. Scores are not modified by reads.

Campus scope is backed by accepted current topology plus bidirectional physical
inventory reconciliation. Added/removed/reassigned campuses, assignment changes,
institution changes, region activity and topology replacement are checked under
source locks and a final NOWAIT fence. Region IDs come only from active physical
campus assignments; orphan regions and inactive-only campus regions are excluded.
Legacy school→campus crosswalks are not fabricated from names or institution-only
legacy identifiers. This slice makes no historical-mapping acceptance claim.

## Native client

The category page opens a separate random-selection page with only categoryId.
The page explicitly starts at global-only, does not auto-draw, and never converts
a region selection into a guessed campus. Optional physical-campus search is an
explicit temporary selection, not an identity/preference mutation. Results are
fetched from the complete-pool endpoint and opened with its returned regionId.
Cancellation, newer requests, account/session changes and page hide discard stale
results. See native tests and the R3R acceptance record.

## Remaining acceptance

Representative production corpus/load acceptance, exact legacy source comparison,
authoritative production catalog/score coverage, real providers and WeChat device
acceptance remain open. Author cumulative received-like deletion policy is
unchanged and remains unresolved.
