# V3 publication batches

This is additive coordination for test-DI Community post images. Normal AppModule
registers authenticated unavailable implementations. It does not enable a provider,
issuer, native-device flag, public object URL, or production upload capability.

## Wire and identities

`apps/api/src/media/contracts-v3.ts` is the strict API source of truth. Batch
identity is version 1; batch/member HTTP metadata is version 3. The single-file
engine's nested observation remains version 2 and its grant remains version 1.
The existing v1/v2 DTOs, request-hash domains and ordinal-zero input schemas are
unchanged. A v3 member cannot be operated through the old mutation routes.

- `POST /v3/media/batches/prepare`: immutable batch identity
- `GET /v3/media/batches/requests/:id`: original-actor metadata recovery
- `POST /v3/media/batches/requests/:id/cancel`: original request hash fence,
  including before prepare exists
- `POST /v3/media/batches/recover-publication`: unique exact ordered asset-set
  recovery, including the editing gap before a publication has been sealed
- `POST /v3/media/batches/:id/members/prepare`: one immutable declaration/member
- `POST /v3/media/batches/:id/layout`: complete layout CAS and explicit removals
- `POST /v3/media/batches/:id/seal`: complete ready set plus exact publication key
- `POST /v3/media/batches/:id/reopen`: only Community-proven non-created terminal
- `POST /v3/media/batches/:id/fence-publication`: explicit cancellation only;
  distinct durable Community cancellation outcome or an actual existing receipt
- `GET /v3/media/upload-intents/:id`, plus `POST` suffixes `grant`, `finalize`,
  `cancel`, and `uploads/:grantId`: shared single-file engine

Each member's `sourceSlot` is immutable. `orderedMemberIds` assigns final binding
ordinals. A reorder never changes manifest, declaration, intent, or asset identity.
The attachment-plan digest includes the resulting sealed revision, which remains
unchanged when the batch becomes consumed. Command replay returns the stored exact
metadata result. A subsequent recovery read obtains current state.

Status includes original batch identity and each member's original declaration for
missing-journal reconstruction. It never contains post text, temporary paths,
provider locators, bearer/grant secrets, dimensions, or current read descriptors.
Unknown members remain explicit. A failed or cancelled live member blocks sealing
until an explicit layout removal. `bound_history` verifies the complete immutable
bindings and remains history after owner deletion; it is not read authorization.

## Bounded resources

There are at most nine live and nine retiring metadata entries, 128 retained member
identities and 128 metadata commands per batch, and sixteen new batch keys per actor
per UTC day. Community publication cancellation has a separate 128-new-keys-per-actor
UTC-day budget. These limits do not evict unresolved receipts. The existing three
active intents, one unresolved writer per actor, five transfer attempts, 5 MiB
single input and 100 MiB daily budgets are unchanged. Both multipart route versions
share a two-request admission counter per injected storage instance.

A batch cancellation fence commits before cleanup is attempted. Logical terminal
status distinguishes physical cleanup `pending`, `retained`, and `confirmed`.
Sealed unknown publication is not cancelled by a missing receipt. An explicit
publication cancellation uses the Community command's serialization key and a
separate durable cancellation artifact, never a fabricated Review rejection.

## Transactions and lock order

Publication holds its original Community command key/row and owner/draft authority,
then batch, actor reservation when needed, all intent UUIDs ascending, all asset
UUIDs ascending, then bindings. Metadata changes, ingress, lifecycle and cleanup
acquire the same batch-before-intent order. Queue/GC candidates are unlocked hints;
the complete selection predicate is checked again after batch lock acquisition.
Queue claims skip busy batch/intent candidates in a bounded 128-hint scan, releasing
skipped candidate locks through a savepoint before considering the next identity.
Readers use shared relation fences. No new global exclusive reader latch exists.

`MediaBatchRepository.peekSealed` requires the whole sealed ordered set and exact
`PublicationMediaContext`, and returns versioned mapping evidence bound in a WeakMap
to the repository, transaction, and read epoch. `consumeSealed` runs after every
binding insert inside the existing Community publication transaction. The additive
SQL guards verify source mapping and final receipt/content/binding/outbox closure.
Rollback cannot reuse an evidence capability in a new transaction.

Every final response/proof snapshot follows its last Media write. Intermediate
seal/command response observations are checkpointed and replaced by a fresh full-set
validation after command persistence, including all retention deadlines. The new
source tables participate in existing Media writer epochs and final relation fences.

## Verification status

Integrated local acceptance passed 6,046 tests: 5 stats, 20 search evaluations,
1,427 API units, 2,274 native units, 2,279 main PostgreSQL tests and 41 semantic
tests. Every group had zero failures, cancellations, skips and TODOs. Lint,
typechecks, OpenAPI generation checks, build/emitted Page smoke and repository
format checks passed. Main PostgreSQL took 53 minutes 53 seconds within its
unchanged 3,600-second stage budget. Individual test and statement budgets were
not raised.

All 2,012 source hashes and exact tree were checked before and after each stage.
The tested tree was `bd9cf779aa4173fb1c133a76b6d77e026290e6ff`, based on signed
`a1fbcf1`. Only documentation acceptance/status edits followed. Main migrations
0001–0073 and both existing optional semantic migrations remain byte-identical;
main migrations 0074–0076 are additive.

Real local PostgreSQL/HTTP coverage includes nine-member atomic rollback,
publication/cancellation winners, retained resources and original-command
recovery. Two actual native process SIGKILL cuts cover reserved-before-body and
seal-commit/response-loss recovery. These do not establish cross-process server
writer retirement: foreign/unknown writers remain retained. Native gallery
coverage includes bounded file leases and emitted Page wiring, not physical
WeChat device acceptance. Hosted CI is pending for this increment. Real provider,
device and production activation remain separate gates.
