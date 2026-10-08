# Errands: text-only lifecycle and read-only administration (E1/E2A)

This is a partial greenfield errand rewrite. It provides fresh, exactly reviewed
text publication, discovery/detail, single-winner acceptance, publisher cleanup,
owned history, remembered accepter contacts, recoverable receipts and durable
local accepted/completed notices. E2A adds bounded read-only historical management.
It does not implement an issuer, external provider, production import, administrative
mutations, media or group delivery. Reward is
an offered amount, not payment or settlement. No refund or runner rating exists.

## HTTP contract

Every route requires a current opaque owner bearer session. Success and failure
responses use `Cache-Control: no-store` and `Vary: Authorization`. Inputs reject
unknown/repeated keys and GET bodies. A shared PostgreSQL-backed budget permits
120 errand/notice requests per minute per validated account across its sessions.
The checked-in official Swagger document is `openapi/errands.json`.

- `POST /v1/errands`: `clientRequestId`, `targetRegionId`, `title`, `publicText`,
  `privateText`, `expectedTimeText`, `reward`, `publisherContacts`,
  `publicAssetIds`, `privateAssetIds`. Both publisher WeChat and phone are required.
  Nonempty asset arrays explicitly return `ERRAND_MEDIA_UNAVAILABLE`; no image
  is silently dropped, reviewed as text, fetched or exposed.
- `GET /v1/errands`: `regionId`, `filter=all|pending`, `sort=created|reward`,
  `direction=asc|desc`, `limit=1..50` (default 20), optional opaque `cursor`.
  Returns `context:{kind:discovery,regionId,discoveryMode:home|own_only}`,
  `items`, `continuation:more|end`, `nextCursor`.
- `GET /v1/errands/:orderId`: current exact public definition and lifecycle,
  relationship `publisher|accepter|none`, advisory capabilities, and only the
  independently authorized optional private sections described below.
- `POST /v1/errands/:orderId/accept|cancel|complete|delete`: `clientRequestId`
  and `expectedRevision` UUID. Accept additionally requires `contacts` with at
  least one of WeChat/phone. All successful HTTP command responses are 200,
  including immutable terminal business-rejection receipts.
- `GET /v1/me/errands?relation=published|accepted`: bounded own history across
  every target, age and lifecycle, excluding tombstones. Same pagination fields;
  context is `{kind:own,relation}`. No current campus is needed.
- `GET /v1/me/errands/contact-history`: `{status:empty}` or
  `{status:available,contacts}`. Only successful acceptance updates this account's
  preference, atomically with its transition. It is unrelated to verified phone.
- `GET /v1/me/errand-requests/:requestId`: owner-only terminal receipt recovery.
- `GET /v1/me/errand-notices`, `GET /v1/me/errand-notices/unread-count`, and
  `PUT /v1/me/errand-notices/:noticeId/read` with `{}`: notification-owner local
  notices. List supports `limit` and opaque `cursor`. Accepted notifies publisher;
  completed notifies accepter. Cancellation/self-deletion creates no notice.

A receipt contains only request ID, operation, `outcome:applied`, order UUID,
revision UUID and occurrence time, or `outcome:rejected` and a known error code.
It never includes an order body, contacts, identity facts or private text. A
pending/unknown transaction is not a successful receipt. Identical canonical
intent replays the original receipt; reusing its key for another intent conflicts.
Receipt replay/lookup deliberately follows the existing publication receipt rule:
current active owner session/account is required, even when later phone,
affiliation or feature eligibility changed. It does not grant current read access.
A terminal receipt cannot be changed or physically removed.

## Fresh validation and historical precision

Title/public/private/expected-time limits are 50/500/200/50 Unicode code points.
CRLF normalizes to LF, outer whitespace is trimmed, invalid surrogate/control
characters are rejected; no NFC conversion, parsing of expected-time prose, or
truncation occurs. WeChat is at most 50 code points; phone is up to 11 ASCII digits.
Required contacts differ between publish and accept as described above.

Reward is a base-10 string, range 1–500 inclusive, with at most 100 total decimal
digits excluding its decimal point. No exponent, sign, leading zero, binary float
conversion or cent rounding is permitted. Only trailing fractional zeros and an
empty decimal point are removed canonically. PostgreSQL stores unconstrained
`numeric`, and reward keysets compare numeric values directly. The 100-digit wire
budget is explicit fresh-input hardening; a two-decimal limit was not established
by source evidence. Historical data must undergo separate lossless mapping and
provenance review, never this fresh parser or silent rounding/truncation. E1 has
no historical importer. Expected time remains free text and never expires work.

## Authority, regions and privacy

New commands and fresh content/contact/notice reads require current session,
verified account phone and complete whole-account Safety authority. Missing or
malformed authority is unavailable. Feature restrictions have their own Safety
owner, immutable coverage snapshots and publish/accept/all scopes; they do not
alter whole-account restrictions or block publisher cleanup/history.

Publication separately requires proven affiliation and a valid current physical
campus/source-region snapshot. Target can be home, related or foreign. Discovery
requires current affiliation/campus and shows pending/accepted work in a frozen
three-day window. Home target shows eligible work; every different target,
including related regions, shows only the viewer's publications. Neither shared
ID detail nor acceptance imposes same-region membership or a three-day expiry.

Nonparticipant detail and acceptance require base eligibility: reviewed
current affiliation, a current privileged authorization grant, or a separately
reviewed temporary-base entitlement. Temporary assertions are account-bound,
finite, provenance-covered records. They convey no school/affiliation facts.
Their bounded lifetime is explicit new authority hardening; no issuer, expiry,
legacy status-to-entitlement mapping or real grants are invented. Every selected
grant/assertion deadline remains checked through the final commit boundary.

Publisher or stored accepter may read private text after acceptance, completion
or cancellation, even after changing campus or losing affiliation. Both still
need current session/phone/account Safety and current exact content visibility.
Opposite contact plus safe display name appears only in currently accepted detail.
Completed/cancelled detail retains participant private text but omits the opposite
contact property. List/history/notice/receipt/cursor/log/error data never contains
private text or contact values. No administrator receives private access by role,
and no unproven named-user-block policy hides contractual relationships.

Review uses a strict `publish_errand` envelope under the canonical review owner,
separate from posts/categories/spaces. It includes every public/private text and
publisher-contact field plus immutable source/target/affiliation/campus scope.
The latest exact decision, current policy and event head control consumption;
durable visibility is distinct from consumption expiry. A current read compares
the stored definition with its immutable binding. Unknown/pending/held/revoked
reviews fail closed. No production review issuer is enabled by this slice.

## State, locking and durable effects

State is pending → accepted → completed. Publisher may cancel pending/accepted
work; accepter cannot cancel, complete or reopen it. Delete is a publisher-only
tombstone overlay retaining prior state, completed timestamp, accepter relation
and immutable transition evidence. There is no edit/reassignment/automatic expiry.

Order: common shared policy gate, active session/account, request-key row, current
authority facts, order row lock, private detail, immutable transition, contact
history and notice owner, terminal receipt, current session recheck. Authority
writers acquire the common exclusive gate first; ordinary commands never upgrade
it. Row locks serialize lifecycle/current privacy. SQL enforces legal transitions,
immutable definitions/tombstones/history, exact same-transaction review binding,
causal transition↔order and receipt↔transition facts, private snapshot durability,
and atomic accepted/completed notice obligations. Notice inserts verify dedupe
payloads; unread counts are derived transactionally by their owner.

Known terminal business rejection rolls back a savepoint and restores the managed
transaction deadline checkpoint before saving a minimal rejected receipt.
Unexpected database faults or unavailable authority/review roll back the request,
so the original key remains retryable. External calls never run under these locks.

Discovery and own lists scan at most 100 current candidate rows per page, using
indexed fixed keysets `(created_at,id)` or `(reward,created_at,id)` and current
review visibility. Sparse pages may contain no visible items with `more`; clients
must preserve that continuation rather than invent an empty end. Cursors bind
account/session, endpoint, region/relation, filter/sort/direction/limit and current
selection/topology where relevant. A fixed anchor/window expires after five
minutes. Opaque shared-owner quota creation is the last blocking domain operation;
managed deadlines are checked after it and deferred constraints. No exact total
is invented from page length.

## Read-only historical administration (E2A)

`GET /v1/admin/errands` accepts `regionId?`,
`status=all|pending|accepted|completed|cancelled|deleted` (default `all`),
`keyword` (trimmed, at most 100 Unicode code points, default empty),
`limit=1..50` (default 20), and an opaque cursor. It rejects every GET body,
including `{}`. The same shared errand request budget and no-store/Vary headers
apply, including malformed/oversized parser errors.

A current locked school grant fixes the exact order target region. Omission
derives that unique binding; a mismatched target is denied. Conflicting school
evidence is unavailable. Global super-administrator/developer authority requires
an explicit target UUID. Native reads the existing authorization projection for
scope selection; neither that advisory projection nor a campus picker authorizes
the request. Browse campus, current identity, institution and related regions
never widen scope. Only the deterministically selected grant's expiry limits the
request; irrelevant shorter-lived grants do not. Current session, verified phone
and whole-account Safety remain mandatory, while publication affiliation and the
administrator's errand publish/accept restrictions do not gate management reads.

The catalog has no three-day cutoff and intentionally includes held historical
public-intended material. `all` includes tombstones; lifecycle filters exclude
all tombstones; `deleted` selects only tombstones. Each row preserves original
`state` plus separate `displayState` and deletion time. E1 did not record deletion
reasons, so a tombstone's `deletionReason` is explicitly `{status:unavailable}`;
live rows have `null`. Source/target IDs remain immutable. Current historical
labels include `active:false` when retired, or explicit unavailable metadata.
Retired school scope does not grant school administrators new authority.

Participants expose only current Profile-owned public UUID/display name or
`{status:unavailable}`; an unassigned accepter is `null`. Reads never create a
missing profile. Internal account IDs, identity/student numbers, contacts,
private text, review evidence and profile preferences are neither selected into
this administrative repository nor serialized. No management capability,
restriction or mutation UI is included.

`context.search` identifies matcher `public-text-name-uuid-v1` and
`legacyNumericReferences:unavailable`. The supported predicate is literal
case-insensitive title/public-text/current-name substring OR exact public profile
UUID. `%` and `_` are literal characters. No internal account-ID or guessed numeric
UID lookup exists. Numeric keywords produce clearly labeled text/name matches,
with total unavailable; old numeric-UID lookup awaits verified Profile-owned
mapping. A missing participant fact cannot prove an unmatched keyword negative:
uncertain page membership fails unavailable, while a count-only uncertainty can
leave the separately valid page intact.

Pages retain at most 50 items, scanning at most 100 candidates plus one continuation
witness in `(created_at DESC,id DESC)` order. Microsecond seek coordinates prevent
tied timestamps from skipping rows. Sparse pages may be empty with `more`; totals
never determine continuation. Cursors bind account/session, selected grant,
target, exact filters, limit, matcher capability/version and five-minute anchor.
Changing any scope requires restarting; no raw query or participant ID is in the
wire token.

`total` is `{status:known,value:"canonical decimal"}` (up to 100 digits) or
`{status:unavailable}`. It counts the anchored supported predicate before seek,
not page size. The shared optional-count runner has pool-scoped admission, finite
elapsed and statement budgets, rollbackable savepoints, bounded 256-row batches,
and bigint accumulation. Errands and Profile own separate 128-slot epoch vectors
covering insert/update/delete/truncate of their relevant source tables. Capture
precedes both count and page reads. No history-size ceiling applies when epoch
proof is available. Writer capacity at least 128 disables the epoch proof; the
final-only bounded 1024-candidate table-fence fallback can still prove small totals.
Missing/corrupt coverage, timeout or failed proof yields unavailable, never zero.

After cursor quota and deferred waits, a mandatory bounded final proof obtains
only owner SHARE NOWAIT table fences and rereads the entire candidate slice from
the original seek. Public projections, negative candidates, precise coordinates,
consumed seek and continuation must all remain identical, including empty/end
pages. Count proof follows this mandatory page proof; unchanged scalar count alone
cannot rescue stale page membership. Concurrent source writers can therefore
produce a retryable `ERRAND_UNAVAILABLE` page rather than stale disclosure. Optional
count failure alone preserves a valid page. No final owner row-lock wait is added.

## Explicit remaining parity

Full E2 remains open. E2A covers read-only exact-target/global historical search;
E2B still requires administrative deletion, protected-target sanctions,
expiration/release/history controls, durable notices and native mutation/recovery. The E1 core
already consumes separate typed feature restrictions; absent coverage is unavailable.

E3: public/private images, owned uploads, exact asset review and authorized delivery,
re-review/removal and interruption recovery. Empty media is explicit in E1.

E4: further local administrative/restriction notices, target-region QR/customer
service preferences, short links, per-destination durable errand-group then
still-pending forum-group delivery and provider/scheduler acceptance.

E5: authoritative schema, precision/timezone/identity/region/media/sanction/notice
mapping; complete provenance reconciliation and restore rehearsal; native-device
and independent-account acceptance. No synthetic historical region or external
receipt may be inferred. This increment is not full errand parity or production
readiness.
