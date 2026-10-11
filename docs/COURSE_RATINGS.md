# Specialist course scoring, C1

This is a bounded local-development vertical slice inside Ratings. It restores the
source-backed course controller's scoring semantics on new Next native pages. It
is not evidence that specialist course pages were registered in the legacy native
application, nor that a real course catalog/history has been migrated or activated.
Generic integer 1–5 Ratings, its protocol registry, creator ownership and five-bucket
summaries are unchanged.

## Evidence and admission

The fixed source is [Course.php at 57cf169c](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Course.php):

- Lines 14–89: bounded list, mutually exclusive department/category, score/time
  sorting. Executable department `99` means `department_id BETWEEN 90 AND 99`
  (40–50), regardless of the contradictory adjacent comment.
- Lines 101–124: course metadata/detail. Lines 295–315: course-name substring
  search. Search does not silently expand to course codes or department names.
- Lines 143–244: all three independent dimensions, first lifetime tuple per
  user/course; any existing tuple blocks a replacement. Lines 250–252: each is
  0.5–5 in half steps. Lines 258–281: three independent averages, one decimal.
  Overall is an independently answered dimension, never the mean of two others.
- No edit, clear, delete, author list, reward, notification, image or review-provider
  side effect is inferred for a numeric course score.

Legacy `user_id`/`openid` input is an identity bypass, not a compatibility requirement.
Next uses the current authenticated Identity session, Verification phone fact and
Safety policy for reads and fresh writes. Pure course scores do not inherit the
student/temporary-verification gate of `Classcomment`. Course directory admission
is intentionally stricter than the token-dependent legacy middleware.

An accepted source's explicit `authenticated_phone` policy permits current
phone-authenticated actors to use its mapped catalog. There is no blanket student
requirement, browsing-campus authority or guessed `university_id=1`. An internal
Campus-owned facade proves the accepted canonical campus UUID, institution and
region remain active. Labels and raw source campus keys confer no authority.

## Production boundary and history

Migration 0112 creates empty source, crosswalk, history, command and score storage.
There is no source adapter, import command, catalog-admin API, seed catalog or
provider activation. The production default is `COURSE_CATALOG_UNAVAILABLE`.
Only tests insert explicitly synthetic accepted source records and separate
synthetic known-empty history assertions.

Course identities retain a unique source namespace/source course key, separate
from generic target IDs, and never fabricate a creator. Immutable catalog snapshots
preserve name, department, category, nature, code, raw source campus key/label,
explicit canonical campus mapping evidence and source creation time. Catalog
acceptance seals a snapshot against later entry appends; changing the directory
requires a new accepted revision. A current head can withdraw it. Catalogs include
coverage, source revision/reference, policy reference and a finite validity window.

Directory completeness and score-history completeness are separate. An independent
history assertion currently supports an explicitly reconciled empty historical
baseline (`accepted_empty`) or `unknown`. Native tuples are subsequently retained
for the lifetime of the stable source course identity. A fresh accepted directory
never resets or proves historical nonparticipation. Missing/expired/unknown history
makes aggregate coverage unavailable; a missing own native tuple is `unavailable`,
not `not_submitted`. Existing native own tuples are still exact known own facts.
Fresh first-score commands require accepted historical nonparticipation coverage.

No authoritative legacy DDL/export, actual course rows, account crosswalk, campus
mapping or reconciled nonempty baseline has been supplied. Nonempty/partial/
malformed historical tuples, identities already migrated to generic targets,
complete population/counts, and the source interpretation of axis labels remain
unverified. They require separate reconciliation/import work; this slice does not
invent zero history or claim production equivalence.

## Typed HTTP contract

All routes are under `/v1/ratings/courses`, use bearer sessions, strict bodies and
query validation, account-scoped Ratings rate limits, `Cache-Control: no-store` and
`Vary: Authorization`.

- `GET /`: name `search`, exclusive `department` or `category`, `sort=rating|time`,
  `limit=1..50`, opaque bounded `cursor`. Department filters are 1–54 or 99. Rating
  order uses the independent overall mean, descending, with stable ID ties; time
  uses exact source microseconds and ID ties. Continuations bind account/session,
  current phone/Safety, catalog revision, score/coverage revision and every filter.
- `GET /:id`: one current proven projection containing `catalogRevision`, metadata,
  independent `summary` and actor-private `myScore`.
- `GET /:id/my-score` and `GET /:id/summary`: independently typed own/aggregate views.
- `POST /:id/first-score`: strict `clientRequestId`, `expectedCatalogRevision`,
  `expectedCourseRevision`, `gradeScore`, `abilityScore`, `overallScore`. All axes
  are real-scale numbers 0.5–5 in 0.5 increments, without string coercion.
- `GET /requests/:id`: minimal actor-only original command receipt, requiring the
  current session but independent of later source withdrawal or phone/Safety
  changes. It does not return current private metadata or other actors.

The separate `course.first-score.v1` receipt contains the original tuple and time,
without authors/account IDs. A durable terminal rejection identifies only
`COURSE_ALREADY_RATED` or `COURSE_REVISION_CONFLICT`. Unavailable source/history or
eligibility is a transport error with no fabricated terminal receipt. A receipt
lookup returning `REQUEST_NOT_FOUND` is not permission to regenerate a pending key.
Same actor/key with changed intent is `REQUEST_CONFLICT`; exact replay returns the
immutable original outcome before consulting current source eligibility.

## Storage, exactness and races

Each dimension is stored as an integer half-unit 1–10 in a separate course table.
The `(course_id, actor_id)` primary key is lifetime uniqueness. Per-original-key
and per-actor/course transactional locks serialize concurrent first submissions.
Score insertion and its exact typed/hash-bound command receipt commit atomically;
deferred constraints enforce the pair. Updates/deletes/truncates of tuples,
receipts and immutable source snapshots are rejected by PostgreSQL triggers.
There is no score-edit/delete API.

Means are calculated independently in PostgreSQL numeric arithmetic from each
half-unit sum/population and rounded to one decimal. A proven zero count has null
means. Unknown coverage has no count/means. Neither is a zero-star rating.

Identity, Verification, Safety and Campus retain their existing current owner
proofs and expiry deadlines. Course source/history/score epochs add required
bounded final proofs through the shared Database transaction wrapper. The wrapper
flushes deferred constraint waits before nonblocking final fences and clock checks.
Initial source/history timestamp admission uses PostgreSQL clock comparisons, so JavaScript millisecond truncation cannot admit a future source. A failed final proof rolls back tentative tuples, receipts and epochs. Concurrent
source writers may intentionally produce unavailable rather than stale success.

## Native surface and verification scope

New registered Next pages provide catalog search/filters, detail, three independent
ten-choice controls, explicit irreversible-first-submit confirmation, original
account/origin pending storage and receipt-first recovery. They are reachable from
Ratings. Pending payloads are frozen before the network operation; response loss,
restart, hide/back, double-click, account change and late callbacks cannot silently
replace intent or publish another account's own score.

The test journey runs actual emitted App/Page/WXML and production native transport/
gateways against loopback Nest AppModule and disposable PostgreSQL 18.6. Only the
WeChat platform transport/storage callbacks and accepted test source facts are
synthetic. No numeric-score review provider is needed or activated. Local emitted
simulation is not a physical device, real provider or production acceptance claim.

Course comments/Classcomment anonymity and one-time likes, major/department
comments, canteen floors, windows' signed −10..10 ratings/comments and dish
endorsements remain pending. They retain distinct source semantics and histories;
none is converted into generic courses or generic integer 1–5 targets.

## Focused local acceptance

On the C1 candidate, the course contract plus offline Ratings OpenAPI suite passed
12 tests. Native course contract/gateway/controller/WXML coverage passed 23 tests
and the full native build passed. A fresh controlled PostgreSQL 18.6 run passed
46 tests across course storage/current-proof checks, the emitted native roundtrip,
and unchanged generic R1/owner-proof regressions, with no skips.

Additional counterexamples include a history deadline in an off-page candidate,
time-driven cursor invalidation without epoch mutation, real two-connection
entry-first/seal-first races, unsupported repeatable-read source writers, raw
unavailable-source terminal receipts, uppercase UUID normalization, phone expiry
after a real deferred wait and an external queued source-withdrawal writer. Early
fixture/OpenAPI integration failures were corrected before these verified runs.
This focused record does not claim all PostgreSQL suites, hosted CI, physical
WeChat devices, real providers or production import have been accepted.
