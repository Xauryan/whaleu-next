# Native announcement administration and independent media

This is a local development slice, not full Next or production acceptance. The
actual emitted Mini Program App/Page/WXML uses the real transport, ordinary
AppModule, and a disposable PostgreSQL database in the acceptance test. Initial
school grants/campus facts and external storage/image-processing/Review are
synthetic. No WeChat, COS or model service is called. Runtime Media remains
unavailable until real adapters are separately installed and accepted.

## Source evidence and deliberate boundaries

Legacy reference: `WhaleUCampus/WhaleU` at
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`,
`treehole/app/controller/UpdateAnnouncement.php`, and registered
`miniprogram1/pages/fold3/gengxin_publish/gengxin_publish.{js,wxml}`.
The UI has version, line-preserving body, popup (default on), highlight,
display date, super-admin school multi-select, and 0–9 optional images. It has
no title/type/sort controls or independent popup-body/title controls. The old
textarea explicitly uses `maxlength="-1"`; Next's 10,000-code-point body and
60,000-byte aggregate command bounds are **new bounded protocol constraints**,
not legacy limits. UI edits synchronize popup overrides to title/body, while the
API permits explicit independent nullable overrides. New titles are generated
as `鲸语校园{version}` and never regenerated on edit. Type remains `minor`.
Dates never schedule publication. Stable creation ordinal, not date/version/
sort order, determines order; editing and disabling/enabling never reorder.

The legacy backend already permits current school administrators to modify
announcements they created and accepts `status` updates. This slice restores
those backend capabilities in the UI. There is no physical deletion. Old routes
had no ContentAuditMiddleware or separate manual-review action. Consequently
native text publication is an authenticated administrator operation with an
immutable exact-content/audience/media source/hash, not fabricated independent
content-review issuance. Every actual image still requires independent current
Media Safety Review.

## Separate sources and popup priority

Existing `/v1/announcements` and `/v1/me/announcements` accepted-source routes
remain in place, with their sealed catalog, completeness and historical ack
semantics. New native records use `/v1/native-announcements` and
`/v1/me/native-announcements`. Migration 0105 never initializes legacy catalog
coverage. Empty native storage proves only that no native announcements exist;
unavailable legacy history never becomes empty or a fabricated total.

The native list has explicit `新发布公告` / `历史公告` source tabs and source-bound
detail navigation. Responses reuse the compatible read DTO; the route and the
page's selected source identify the catalog. There is no combined total or
cross-source ordinal/time comparison.

The home popup adopts an explicit new product rule: native-source priority.
First select the latest visible native popup and only then consult the account's
stable ID marker. Even an acknowledged native candidate blocks fallback to
historical unread content. Only proven native `candidate:null` permits querying
the accepted source. An unavailable source stays unavailable. At most one modal
is displayed, and only the explicit `我知道了` handler writes an ack. Page hide,
navigation, refresh and reads never acknowledge. IDs, not versions/revisions,
key markers: same-ID edits or disable/enable keep the ack; a new ID using the
same version is independently unseen.

## Authority, targeting, and recovery

`/v1/announcement-management` exposes current capabilities, searchable regions,
management pages, exact item reads, immutable original-key commands, minimal
receipts/cancellation fences, and owner-only `draft-closure/:id` metadata.
Only a real global `super_admin`, or exactly one current fixed-region
`school_admin`, qualifies. Developer, organization-owner, identity/verified
school and browsing-campus settings never confer authority. School labels come
from the current grant's operating region.

School commands always submit `audience:{kind:'fixed'}` and the server expands
that current grant to every active physical campus in its region. Super-admins
explicitly choose all browsers or selected regions, expanded by the server.
Every selected region must be known, active, and have a nonempty current
mapping. Empty/unknown mappings never widen to global. School edits require both
original creator ownership and current grant permission for the existing source.
Global super-admins can manage others' published announcements, but cannot read,
edit or upload into another creator's private upload-preparation draft.

Drafts are new private upload/recovery infrastructure, not a claim that the old
one-time local edit handoff persisted drafts. CAS advances every mutation;
immutable account/request hashes and receipts recover response loss and prevent
altered retries. Request cancellation is durable and original-key-specific.
Only the original creator can cancel an unpublished draft. Its bindings retire
atomically through quiet cleanup. Published disabling retains source, receipts
and ack. Minimal closure remains available after grant loss or reassignment,
without returning draft text or restoring editing authority; invalid sessions
and blocked accounts still fail identity checks.

Native command journals are account/origin scoped and written/read back before
network dispatch. Unknown results remain frozen. Local input validation rejects
aggregate canonical UTF-8 commands over 60,000 bytes before writing a journal;
API and SQL enforce the identical all-fields budget. It includes content,
independent popup text, targeting, image changes and wrappers. Shared 64 KiB HTTP
parser and every existing Media resource/deadline/quota are unchanged. No text is
truncated. Current-account pending uploads remain listed by exact
announcement/slot/revision even after draft cancellation or route change, so
orphaned ready-unbound work can be queried/cancelled rather than silently evicted.

## Media12 and current proofs

Migration 0106 adds an independent `announcement-media-v1` typed12 owner with
`gallery0`–`gallery8`. There is no required cover. Prepare, actual multipart
bytes, seal/process/Review, status, immutable asset adoption, same-key recovery,
cancel, replacement/removal, private management reads and optional-guest public
reads use existing shared bounded ingress/delivery infrastructure. Invalid
bearer headers never downgrade to guest. Campus-targeted images require a
current matching physical campus; all-browser images also work without one.

The immutable operation hash includes full body/overrides, complete resolved
audience, slot bindings and every exact asset/manifest digest. The database
checks current head/revision, actual actor/grant, exact original request,
media ownership, Review and operation completeness. Final bounded owner proofs
revalidate account grants, whole topology mapping, announcement/directory state,
Safety and deadlines after waits; Media retains its own complete-set proofs
across storage open. Withdrawal, scope/revision change or image revocation cannot
release bytes from a stale reference. Disabling can retain the previous exact
immutable media facts even after Review revocation; re-enabling requires current
image Safety. Retained public content is publication-owned and does not vanish
merely because its original author's grant later expires.

## Verification boundaries

Targeted tests cover administrator publication rather than seeding native
announcements; guest/member campus reads; all-browser super publication;
creator/grant/scope rejection; stable identity/order/ack; response-loss recovery;
CAS; cancellation and immutable SQL history; 0/1/9 image behavior; replacement/
removal and whole-set stale proofs around storage. The emitted Page test covers
actual form handlers, uploads and current image bytes, publication response loss,
source navigation, native home popup explicit acknowledgement, editing,
disabling/enabling, route refresh/hide/show and lost-grant draft closure.

These local checks do not establish physical WeChat rendering, real Review/
storage/provider qualification, production deployment or historical import.

### Local validation on 2026-10-11

- `npm run check` passed: lint, full API/native type checks, statistics tests
  (5), search-evaluation tests (20), current deterministic OpenAPI artifacts,
  API units (1,832), native units (2,565), and all build/emitted smoke gates.
  API/native suites had zero failures, cancellations or skips.
- `npm run format:check`, `git diff --check` and the shard allocator's nine
  tests passed. Four-shard selection covers all 279 current integration files.
- The six `announcement-{authoring,authoring-native-roundtrip,media,concurrency,
native-roundtrip,read}.test.ts` files passed 41/41 cases against disposable
  PostgreSQL 18.6, sequentially, in 150.96 seconds; no failures, cancellations or
  skips. The cluster stopped normally. No native publication was seeded in place
  of executing the real administrator commands.
- The emitted authoring path uses 12 actual upload transfers and current image
  reads: 0/1/9 images, replacement/removal, lost-response recovery, stable route
  identity across refresh/background/account changes, new-ID/same-version popup,
  explicit acknowledgement and orphan upload cancellation after grant movement.
  It waits through the real shared upload-request rate window; no quota or
  timestamp is weakened for the test. A final caption-only correction additionally
  prevents a grant-less closure view from identifying itself as a super-admin.
- Validation is staged, not represented as one identical-source log: the full
  check completed at 18:56 UTC; subsequent changed test/smoke files passed targeted
  lint and API type checks, and the caption-adjusted native build/emitted smoke
  passed at 19:02 UTC. The final production code then passed the six-file PG run.
  A later test-only strengthening created a separate private B through the real
  Page, re-opened active A, verified refresh/background/account reauthorization
  retained A rather than the remembered B, and explicitly cancelled B. That final
  emitted PG re-run passed 1/1 at 19:08 UTC (87.75 seconds in the test body).
- Maximum aggregate-valid Chinese and emoji commands pass real HTTP and SQL;
  the next character fails before creating a receipt. Native invalid commands
  fail before durable pending storage. Native input controls do not silently
  truncate these Unicode inputs.
- All 106 SQL files in baseline `754e140` remain byte-for-byte unchanged:
  104 ordinary migrations plus two optional semantic migrations. Only new
  0105 and 0106 are added, bringing the SQL-file total to 108.

These are local results for this increment. The successful hosted baseline run
[38162875745](https://github.com/Xauryan/whaleu-next/actions/runs/38162875745)
precedes these changes; hosted CI for the new announcement tree remains pending.
