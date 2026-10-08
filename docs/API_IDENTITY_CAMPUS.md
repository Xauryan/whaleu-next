# Own identity-campus selection

This bounded increment adds explicit own-account choice using already accepted
canonical affiliation, phone, safety and topology inputs. It does not issue any
of those inputs, verify a student number, reconcile old history, or grant roles.
The browsing campus, verified origin and fixed administrative region remain
separate. Only future publication resolves the new choice; stored publication
scope, review bindings and history never change.

## HTTP contract

All routes require a current active opaque access token and return
`Cache-Control: no-store` and `Vary: Authorization`. Unknown query/body keys are
rejected. There is no account selector or other-account route.

`GET /v1/me/identity-campus` is read-only, including when history is missing:

```ts
interface CampusSummary {
  id: string;
  name: string;
  operatingRegion: { id: string; name: string };
}
interface State {
  affiliation: 'verified' | 'unverified' | 'unavailable';
  selection: 'valid' | 'selection_required' | 'unavailable';
  reason:
    | 'current'
    | 'choice_required'
    | 'history_unknown'
    | 'inputs_changed'
    | 'choice_no_longer_valid'
    | 'affiliation_required'
    | 'affiliation_unavailable'
    | 'topology_unavailable';
  selectedCampus: CampusSummary | null;
  options: { status: 'known' | 'unavailable'; items: CampusSummary[] };
  writeEligibility: {
    phone: 'verified' | 'unverified' | 'unavailable';
    safety: 'allowed' | 'restricted' | 'unavailable';
  };
  canSelect: boolean;
  expectedStateRevision: string | null;
  guidance:
    'choose' | 'reselect' | 'refresh' | 'await_affiliation' | 'unavailable';
}
```

IDs are canonical lowercase UUIDs. Summaries contain only the physical campus
name and public operating-region ID/name. No assertion, verification snapshot,
selection event, issuer, origin, role, phone value or student number is exposed.

Current accepted `selection_required` is the only known missing-choice fact.
Absent head, a legitimate revision-zero/null head and unaccepted historical
provenance remain `unavailable/history_unknown`. A covered old event with changed
exact affiliation assertion/snapshot or topology snapshot becomes
`unavailable/inputs_changed`, even if that historical event has since expired.
An accepted expired event with unchanged bindings is
`unavailable/choice_no_longer_valid`, never a known missing choice. An otherwise
valid choice remains displayable even
when a separate campus inventory gap makes options unavailable. Affiliation
unavailable never yields an inferred candidate list or selected-campus detail.

Candidate visibility is independent of permission to save. Known unverified phone
or a known safety restriction does not hide independently valid candidates.
`canSelect` requires known nonempty options, verified affiliation/phone, known
allowed safety, and structurally consistent selection history. Missing phone or
safety coverage is unavailable, not permission. `expectedStateRevision` is present
only when `canSelect=true`, with format `ic1:` followed by 64 lowercase hex digits.
`known` options with an empty list is a real no-eligible-campus state; the client
shows no enabled confirmation and never treats it as a fetch failure.

`PUT /v1/me/identity-campus` accepts exactly:

```json
{
  "requestId": "<UUIDv4>",
  "campusId": "<UUID>",
  "expectedStateRevision": "ic1:<64 lowercase hex digits>"
}
```

A successful PUT, or `GET /v1/me/identity-campus/requests/:requestId`, returns only:

```json
{
  "requestId": "<UUIDv4>",
  "campusId": "<UUID>",
  "outcome": "applied",
  "selectionRevision": 1
}
```

Outcome is `applied | unchanged`; revision is a positive PostgreSQL integer,
maximum 2147483647. Unchanged applies only to a currently valid same-campus choice
with all exact current bindings. Same physical campus after a binding change
requires fresh explicit confirmation and a new event. No auto-save occurs for a
singleton, current browsing choice or remembered UI preference.

Distinct errors include:

- 404 `IDENTITY_CAMPUS_REQUEST_NOT_FOUND`: no successful receipt visible to this owner
- 409 `IDENTITY_CAMPUS_REQUEST_CONFLICT`: the same key has different immutable intent
- 409 `IDENTITY_CAMPUS_REVISION_CONFLICT`: reload and explicitly confirm again
- 409 `IDENTITY_CAMPUS_NOT_ELIGIBLE`: requested campus is not in the known current set
- 503 `IDENTITY_CAMPUS_UNAVAILABLE`: required choice inputs/history are unavailable
- Existing phone, affiliation, safety and active-session errors remain distinct

An awaited exact PUT's revision conflict proves its transaction rolled back and
that obsolete revision cannot authorize that intent later. The client may release
that rejected pending intent, refresh, and request a new explicit confirmation.
A missing receipt, lost response, authentication failure or transient server error
does not prove noncompletion: retain the exact account-bound request key, campus
and revision for recovery/retry. A successful historical receipt never describes
current authority; fetch current status separately afterward.

## Candidate completeness and catalog ownership

The version-1 reviewed topology's accepted complete outer provenance and explicit
complete origin group establish the reviewed institution scope. Under the held
outer gate, the campus owner reconciles the current physical inventory with the
snapshot in both directions:

1. Every active physical campus of the verified institution must have a complete
   active reviewed assignment, an explicit complete active region/group, and a
   matching current assignment and active physical region. A known different
   group is excluded; the same institution alone never makes it eligible.
2. Every snapshot assignment belonging to this institution must have an existing
   physical campus and assignment with matching institution, region and activity.
   Missing, conflicting or remapped rows are unavailable, never silently dropped.
3. Every snapshot region in the origin's institution/group must have complete
   coverage and matching physical existence/activity. Relevant group coverage is
   explicit. An unrelated unknown region is ignored only if it is outside this
   proven scope and no institution inventory assignment depends on it.
4. A complete set may contain zero or one eligible campuses. Inactive physical
   rows omitted by the snapshot do not count as active unexplained inventory.
   Snapshot-declared inactive rows still require reverse reconciliation.

The institution schema has no independent activity flag; existence is required.
No undocumented institution-active claim is invented. Current campus and region
activity is checked. Public search, school codes, profile browsing and grants do
not supply any coverage proof.

Migration 0017 adds BEFORE STATEMENT INSERT/UPDATE/DELETE exclusive-gate triggers
for institutions, campuses, operating regions and physical assignments, covering
phantom catalog insertion as well as existing rows. Future multi-statement writers
must acquire the same gate before any earlier row lock; a trigger cannot repair
an already inverted lock order. No ordinary-user catalog/topology writer exists.

## Atomic writes, versioning and recovery

`IdentityCampusModule` orchestrates only narrow Identity, Verification, Campus and
SafetyPolicy owners. Campus owns topology, selection and receipt SQL. Verification
owns assertions/snapshots and never queries a student number for this operation.
The normal `AppModule` wires this module without fixture/provider overrides.

Read lock order is shared outer safety gate, active account/session/access token,
verification head, safety head, topology head, own selection head, UUID-ordered
regions, institutions, campuses and assignments. PUT takes the exclusive outer
gate first, before authentication or any request row. Successful receipt lookup
precedes all current phone/safety/affiliation/topology eligibility. The exclusive
gate serializes bounded writes across accounts, an intentional throughput cost.
No network/provider call occurs in these transactions.

The versioned SHA-256 comparison fingerprint binds account, head existence,
revision and pointer, latest recorded revision, current exact affiliation,
topology snapshot, phone and canonical safety state, and sorted locked region,
institution, campus and assignment facts. Mutable row versions are included so
changing then restoring a catalog/safety value still invalidates an old intent.
The token is not a credential; every fact is resolved again under locks.

After comparison succeeds, an absent head with no events is initialized at zero,
and a new event, exactly-one head advancement and immutable success receipt commit
atomically. A legitimate zero/null head is distinct from absent in the version.
Absent/zero head with orphan events, a missing/mismatched current event, or a tail
newer than the head is structurally unreconciled and cannot be silently repaired.
Old events are never modified or backfilled.

The accepted event's source is this authenticated account/request and versioned
own-choice policy. Acceptance means an eligible choice, not a new credential or
proof of physical-campus enrollment. Validity is bounded by consumed affiliation
and topology deadlines, or explicitly policy-exempt only when both inputs are.
Readers continue composing all current dependency deadlines. A phone-only change
to the canonical verification snapshot conservatively invalidates selection too.

Receipt rows are append-only, owner/key unique, hash-checked and foreign-key bound
to the actual account/event/revision. Their campus must match the selected event
and current head at insertion. Identical replay requires a current active session
but no current choice/phone/affiliation/safety grant, and never restores an older
head. Only successes are durable; transient failures roll back completely.

Every asserted positive affiliation, phone, safety, topology or selection fact
registers its locked deadline. The transaction wrapper completes deferred
constraint waits, checks a fresh database clock, then commits. Session/account
are rechecked before return. Expiry during any wait rolls back event, head and
receipt together.

## Acceptance and release boundary

The new API integration suite uses guarded disposable loopback PostgreSQL 18.6+
and the real `AppModule`. It creates only canonical synthetic prerequisites; real
HTTP selection creates the event that community authority subsequently consumes.
The separate native roundtrip suite exercises the real gateway/controller against
that application. Unit tests cover strict inputs and owner orchestration.

No provider, SSO, review issuer, media override, topology/configuration admin,
real grant, import, production fixture endpoint or startup authority is added.
Physical-device/provider acceptance, historical data crosswalk/import coverage,
production verification/topology issuance and full rewrite parity remain open.

## Shared catalog writer ordering

The catalog gate-first contract also applies to community spaces used in
federated search. Migration 0028 puts the operating-region gate before its count
epoch trigger and adds the corresponding early space gate. Multi-statement
writers must acquire the exclusive common safety gate before earlier row/count
locks; triggers do not repair previous inversions. TRUNCATE/DDL maintenance still
requires outer-gate-first coordination. No new topology or identity authority is
created. See [search catalog protocol](COMMUNITY_SEARCH.md#catalog-writer-protocol).
