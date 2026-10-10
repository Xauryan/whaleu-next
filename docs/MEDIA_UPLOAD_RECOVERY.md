# Single-image multipart v2 and original-actor recovery

This additive slice is a **test-DI-only implementation**, not a production upload rollout. Normal AppModule authenticates and returns `MEDIA_UNAVAILABLE`; it constructs neither a storage root nor a synthetic Review issuer. Native ordinary runtime has no upload transfer. There is no HTTP, environment, or configuration synthetic-enable switch.

## Protocol and ownership

The `/v2/media` routes are distinct from the unchanged strict v1 contract. Prepare includes the SHA-256 of the original selected bytes. Its canonical original-request hash is actor-specific and distinct from the server-authorized scope hash. An original actor can recover a request even after losing publication scope. Recovery contains operation metadata only and never grants a current image read.

Cancel-by-request creates a durable actor/request/hash fence even when prepare has not arrived. A later matching prepare cannot create an orphan. Different hashes conflict. New keys, including tombstones, consume the same bounded actor budget. Bound history, including detached attachments, takes precedence over intent deadlines and current Review availability; media cancel never deletes a published owner resource.

A grant is bound to a real server session, intent generation, exact original-byte declaration, and deadline. Tokens are not stored. Native constructs a fixed first-party route; grant JSON cannot choose a destination, header, key, or token. Another session cannot settle the original writer. Asking for a grant from a new session durably revokes the old writer's settlement; another grant remains blocked until genuine quiescence. Existing Identity intentionally allows multiple active device sessions, so a new login alone does not revoke older sessions or media grants. Explicit server logout revokes the bearer; refresh preserves its session. Reauthentication may recover the original actor's operation, but cannot transfer the old grant to the new session.

There are independent deadlines:

- 30-minute operation deadline controls upload and processing.
- Unbound-ready retention is asset creation plus 24 hours.
- Community draft retention is draft creation plus 24 hours.
- `bindBefore` is the earlier ready/draft deadline, with current Media and owner proofs still required.
- Bound history does not expire merely because the upload deadline passed.

## Native multipart ingress

`MediaMultipartInterceptor` authenticates and obtains a durable claim before constructing Nest's `FileInterceptor`. The locked Nest/Multer implementation parses the body. There is no handwritten multipart parser, memory storage, base64 upload, or whole-file buffer at the ingress boundary.

The storage engine receives `file.stream`. Exact staging, sealed, writer, and scratch identities are persisted before any effect. Observation happens only after all of the following:

1. The entire native multipart parser completes successfully.
2. The whole HTTP request and counting stream terminate successfully.
3. Exactly one file, named `file`, and zero text fields have been accepted.
4. Actual byte count and SHA-256 match the immutable declaration.
5. The exact writer has finished and cannot write again.
6. A new transaction rechecks current session, scope, generation, deadline, and mandatory final proofs.

File-part end, progress 100, object existence, abort, an expired lease, or a successful platform callback are not observation/readiness evidence. Storage success followed by malformed trailing fields cannot be recovered as observed from object existence alone. After proven quiescence the same exact bytes can be sent through a new complete multipart request; exclusive storage validates an existing destination without overwriting it.

### Actual parser/resource boundaries

- File bytes: at most 5 MiB, exactly the declared length and digest.
- Whole wire body: at most 5 MiB + 64 KiB, including preamble, parts and epilogue, also on chunked input.
- HTTP headers: at most 16 KiB as admitted by this route; the Node HTTP server has its own parser limit too.
- Part headers: locked busboy 1.6.0 enforces a fixed 16 KiB header-byte ceiling. It has a fixed 2000-pair storage ceiling. Its documented configurable `headerPairs` limit is not implemented in that version, so this slice does not set or claim a 16-pair rejection limit.
- Multer: one file, one part, zero text fields; field name at most 16 bytes.
- Stream/parser high-water marks: 16 KiB; exact-file adapter respects backpressure.
- Writer: 15-second inactivity timeout and 120-second total timeout, shortened by the current grant/session/intent deadline.
- Admission: one unresolved writer per actor; at most two active requests per interceptor instance; no waiting queue.
- Retry: at most five transfers for an attempt; durable actor transfer accounting and original reservation are separate.

The local slot remains occupied until actual parser/writer completion and scratch deletion. Unknown quiescence or failed scratch deletion does not replenish slots. These are bounded-process controls, not a claim of distributed isolation or a production hostile-image resource sandbox.

## Writer recovery and cleanup

The fixture uses real exclusive files, actual streaming SHA-256, and immutable hard-link publication. Its writer token is irreversibly retired before proof issuance. The proof is opaque, tied to the exact writer/instance/staging/scratch, and cannot be created from a timeout or an absence check. Scratch and destination share actual active-write tracking.

The fixture proves only writers owned by its live instance. Foreign or restarted instances remain unknown/retained. This slice does not implement a cross-process supervisor or prove that a crashed provider can never write again. A future provider or process-recovery integration must supply that evidence; elapsed heartbeats are insufficient. Cancellation can become logically terminal while physical cleanup remains pending or retained.

## Durable native journal

The native journal is one strict record per normalized API origin and original actor. Its immutable prepare, request hash, revision, phase, IDs, deadline hints, and optional publication reference are saved and read back before the next mutation. It contains no original bytes, image path, URL, bearer, grant, refresh token, Review assertion, or publication body.

Account changes synchronously revoke the view, tasks, owned ephemeral files and in-memory grants, while retaining the original actor's unresolved journal. Recovery after another login or process restart uses the current session for that actor. Lost local files cannot be reconstructed from a saved path or filename. The old operation must be confirmed cancelled before a newly selected image gets a new request ID. Publication uncertainty consults the existing publication receipt owner first.

The adapter uses the existing `js-sha256` implementation over bounded 64 KiB file chunks, inspects image type, and reports frame count as unknown where the platform does not provide evidence. Server sharp/Review remains authoritative. SDK bridge tests are not iOS/Android device or domain/redirect acceptance.

## Verification status

Integrated full local acceptance passed 5,891 tests on the exact frozen tree:
5 stats, 20 search evaluation, 1,382 API, 2,224 native, 2,233 main PostgreSQL
and 27 semantic tests. Every group had zero failures, skips, cancellations and
TODOs. All lint/typecheck/OpenAPI/build/emitted smoke and repository formatting
checks passed. The main PostgreSQL suite took 50 minutes 41 seconds. Every gate
verified all 1,966 source hashes before and after execution; integration replay
matched the tested tree exactly. Historical main migrations 0001–0072 are
byte-identical; only additive 0073 is new. Hosted checks for this publication
remain pending.

Validation uses an independent checkout based on signed commit `9471d5a3c22699f460cc77e9ac6d8bc98139761e`, with existing locked dependencies and no package installation. Source is frozen before aggregate validation; exact tree, source hashes, commands, exit statuses and complete logs accompany the implementation handoff.

The executable coverage includes:

1. Strict v2 schemas/hash/journal/adapter tests, API/native type checks and lint, official OpenAPI generation/check, native compiled-build smoke including the actual compose Page and SHA vendor resolution.
2. Real HTTP/Nest/Multer and disposable PostgreSQL: JPEG and PNG, original hash, sharp transformations, independent Media/content Review, publication receipt/binding/outbox and authenticated download hash.
3. Wrong/extra files and fields, incomplete/invalid closing boundary, part headers over16KiB, empty files, wrong MIME/digest, file/wire budget overflow, chunked input and cancellation.
4. Real chunked socket ordering: a complete file part with an unfinished request cannot settle; cancellation prevents late observation; excessive epilogue hits whole-wire cap; two held requests exhaust local admission; actual15-second idle timeout waits for genuine writer quiescence.
5. Prepare response loss and cancellation fence, observed response loss, current-session grant replacement, logout and refresh, late observe after cancellation, bound/detached priority, independent operation/ready/draft deadlines, unknown writer cleanup.
6. Native actual-file HTTP bridge, account/session epoch switching, journal write-readback failure/corruption, uncertain publication and lost picker file. A separate native Node process is actually SIGKILLed after real server prepare commits but before the controller sees the response; a fresh process/current same-actor session recovers the original intent/key from disk and explicitly cancels before clearing the journal. This does not prove server-writer process-death reclamation or physical-device behavior.
7. Existing Media/Community read, publication, lock/concurrency, cleanup and mandatory final-proof regressions, plus repository-wide checks, full integration and semantic suites. Aggregate pass counts must come from the matching frozen-source run, not from this coverage list.

Tests not represented by an executed case remain unverified. In particular, real devices, production domain/redirect behavior, real COS/issuer, hostile-image hard resource isolation, and cross-process writer-death supervision are not delivered or enabled here.
