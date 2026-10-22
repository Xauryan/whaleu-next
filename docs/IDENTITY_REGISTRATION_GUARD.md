# Ordinary registration guard: intermediate production contract

Status: Stage A v4 candidate, not a production account-deletion feature. The ordinary
`POST /v1/auth/wechat/login` path now checks a persistent registration policy in
its real account-creation transaction. Migration 0179 reserves storage and leaves
real completion authority **unavailable**. It does not relabel or activate the
0172–0174 synthetic lifecycle. No production account, provider, secret or database
has been used. The integrated candidate is tested against disposable local PostgreSQL
with synthetic test identities, including the actual Identity repository entry.

## Entry, defaults and atomicity

- Existing provider mappings still resolve their original account and retain the
  existing blocked/lifecycle/session checks. Refresh, session and logout are not
  registration and have no new gate. A previously removed mapping is a new
  registration attempt, not an existing-account login.
- The original provider/app/subject advisory lock is acquired before absence is
  checked. The same read-committed transaction then locks the policy row FOR SHARE,
  checks the gate, initializes native owners and inserts the account, mapping and
  session. A failure before or after admission rolls back the whole transaction.
- The installed policy is `inactive`, with `completion_protocol=unavailable` and
  no active key. New registration is allowed only if both persistent guard and
  epoch tables are empty and the exact write-closed schema qualifies. No environment
  setting can turn off an enforced policy.
- `IDENTITY_REGISTRATION_GUARD=automatic` is the default. `required` makes missing
  real completion authority a rejection, not an empty completion history.
- Missing schema, missing/unknown/multiple policy rows, unknown policy fields,
  invalid versions, query failures, missing epochs, changed key material or
  nonempty inactive storage reject new registration as `AUTH_NOT_CONFIGURED`.
  A currently blocked identity receives the existing safe `LOGIN_REJECTED` code;
  no deletion request, completion time or digest is disclosed to the client.
- Apply 0179 before deploying this runtime. It requires the recorded full 0178
  predecessor and runs in the normal transactional, checksum-verified migration
  runner. This integrated candidate is based on locally signed Home commit
  `2f9f77260119664af3a06c488963153fdc12dab3`, includes 0177/0178, and has been tested
  by applying the complete migration sequence in a fresh local test database.

## Schema qualification, retained fence and privileges

The guard first acquires the shared transaction form of the existing
`MIGRATION_LOCK`. The approved migrator takes that same key exclusively, so a
successful read retains its schema fence through commit. Contention fails closed
without waiting. No `LOCK TABLE`, `MAINTAIN` or broad table `UPDATE` is required.

Migration 0179 refuses pre-existing registration-guard namespace objects before
creating three exact tables. It records a finite catalog seal covering their
columns/defaults, validated constraints, indexes, enabled admission triggers,
owned functions and unexpected prefixed relations. Runtime verifies the exact
catalog-function body hash and metadata before invoking it, then compares the
installed seal. Missing columns or constraints and disabled/changed triggers are
not interpreted as empty deletion history. The managed transaction registers a
mandatory final schema proof after deferred constraints, preserving existing
100ms statement / 500ms proof budgets. Unmanaged clients cannot omit this proof.

At this stage all three tables are write-closed; the shared migration fence and
final unchanged seal retain that immutable fact. The final proof does not re-read
guard timestamps or convert them through JavaScript. A later real lifecycle must
replace this protocol and add its own completion authority/fences; it cannot
silently reuse this stage's immutability assumption. Out-of-band superuser/catalog
DDL is not an authorized deployment path.

`role-contract.ts` describes only the additional read gate's minimum privileges:
SELECT on the three tables, UPDATE(slot) on the policy and UPDATE(epoch) on the
epoch registry for PostgreSQL FOR SHARE, and EXECUTE on the read-only catalog
function. It does not provision any role. No actual UPDATE is admitted by the
write-closed triggers. Unit tests pin this matrix; the authored, **unrun** PG role
test also asserts no MAINTAIN, broad UPDATE, INSERT, DELETE, TRUNCATE, TRIGGER or
REFERENCES rights and denial after removing either named UPDATE column. The
runtime does not reject the existing API role merely for having other existing
capabilities. An existing restricted role needs this additive read contract as a
separately authorized deployment step; a default owner-role installation follows
the unchanged ordinary registration path. Neither is a production grant here.

## Private provider digest and rotation boundary

`IDENTITY_DELETION_DIGEST_KEYRING` is an optional secret-management input, not a
checked-in example credential. Its exact JSON fields are `version: 1`,
`activeEpoch`, and one to eight `keys`, each containing `epoch` and `keyHex`.
An epoch is a lowercase letter followed by up to 31 lowercase letters, digits or
hyphens. A key is an independently provisioned 32-byte cryptographic random value
encoded as 64 hexadecimal characters. Validation proves shape, not entropy.
There is no generated or fallback key and no activation CLI in this stage.

HMAC-SHA-256 uses a canonical array containing a versioned domain, operation,
epoch, provider, exact application and provider subject. Union identity is not an
account-merge or cross-app key. Key-check HMACs have a separate domain and do not
contain provider identity. PostgreSQL stores only key-checks, digests, epoch,
request/generation/completion metadata and expiry, never the raw subject, union
identity or secret. Digests remain linkable pseudonyms, not anonymous data.

Every persisted epoch must be available with its original key-check. An extra
provisioned key may be rolled out across replicas before activation; absence of
any stored old key or reuse of an epoch with different bytes fails closed.
`activeEpoch` must match durable policy. Configuration cannot create epochs or
change policy. The eight-epoch bound is a hard operational admission bound, not
permission to drop an old key. No key retirement is implemented: a separately
reviewed lifecycle must prove no open request or applicable guard depends on an
epoch before retirement. Secrets belong only in approved server secret storage,
with access limited to Identity/deletion workers, never native clients, logs,
URLs or production database rows. Existing secret redaction includes this input.

## Completion facts, not request timestamps

A guard's interval is exactly 2,592,000 elapsed seconds after verified final
completion, not request creation, cooling expiry, worker start, calendar month,
application wall time or a user-supplied timestamp. The lookup uses PostgreSQL
`clock_timestamp()` and admits registration at equality with `reregister_after`.
A SQL-selected live guard always rejects the current attempt. Its timestamps are
never converted to JavaScript Date for a second decision: Date truncates
PostgreSQL microseconds and could admit up to 999 microseconds early. Expiry
after selection may conservatively deny that attempt, never admit it early.
Current 0179 denies all writes to guards, epoch registry and policy after its
initial inactive seed. This is a deliberate missing-authority boundary, **not**
a finished completion writer or a claim that real deletion works.

The runtime algorithm for an enforced policy is covered with injected SQL-result
fixtures. Those fixtures do not qualify a real PostgreSQL completion authority.
No route, environment switch or ordinary DML can fabricate a completed deletion
in this installed stage. Superuser/catalog tampering is not a supported activation
procedure. The future completion source requires its own schema qualification.

## Stage B design and remaining implementation

A separately versioned real lifecycle must supply all of the following before
replacing the write-closed 0179 admission boundary:

1. A real request journal, current request pointer and monotonically increasing
   generation under the account lock. Reauthentication must exchange a fresh
   one-use WeChat code with the configured real adapter, match the existing
   provider mapping to the requesting account after locks and use a bounded
   server-verified lifetime. A request must not auto-register or auto-cancel.
2. Capture a versioned HMAC digest for each exact provider mapping **before** that
   mapping is erased. Bind the private digest envelope to request, account,
   generation, key epoch and the request's immutable intent. Do not retain raw
   provider identifiers in the deletion journal. Keep capture epochs available
   across cooling and erasure until completion plus the entire guard lifetime.
3. Owner admission must cover the actual installed schema, including 0175 source
   review, 0176 Reading and 0177/0178 Home. Unknown relations/indirect references,
   unsupported history or schema drift must block admission/completion. The old
   whole-table synthetic cohort seals cannot qualify production accounts.
4. A completion transaction must hold the same provider identity lock used by
   ordinary registration (or obtain it with NOWAIT while holding account locks),
   prove exact request/generation/current lifecycle, final owner receipts,
   current transaction causes, identity/session removal and actual storage/media
   erasure or an explicitly accepted retained-history policy. It must insert
   guard facts and publish terminal completion in that **same** transaction.
5. The SQL admission trigger must reference the actual completed lifecycle fact,
   not a caller-supplied timestamp/UUID, mutable boolean, manually supplied row
   count or an arbitrary completed-looking document. A deferred exact closure
   must prevent committing either a terminal fact without its guards or guards
   without its terminal fact. Failed/unknown external deletion is still pending.
6. Policy/key transitions need durable monotone revisions and exclusive singleton
   fencing. `enforced` cannot downgrade to `inactive`; retiring keys must account
   for unfinished captures as well as all nonexpired completed guards. Actual
   activation, config, role grants and provider operations remain separate gates.

Existing production owner gaps are substantive: 0172/0173 Profile/Timetable/
Follow-Social erasers only admit the synthetic cohort; baseline retention only
accepts exact untouched native Experience/Safety/Verification state. Community
posts/discussions/images/reviews, Messaging, Ratings and specialist histories,
Errands, Activities, Organizations/Announcements, Official callbacks/delivery,
verification/phone evidence, authorization and moderation histories, legacy maps,
Media ingress/derived objects and actual external effects are not certified by
those erasers. Reading output/source jobs and Home/source proof metadata are
newer owners too. Missing coverage must not become an empty-inventory proof.

No 0171–0178 migration, existing deletion trigger or owner registry is changed.
The 0174 rehearsal inventory deliberately does not whitelist 0179's tables, and
remains fail-closed against newer Home/Reading/Identity owners. A future real
inventory must be independently versioned; widening the synthetic list is not
that implementation.

## Evidence and limits

The starting production tree is Git commit
`89e829a10b664d300089e531e3b0b9cef17fa60d`, materialized into an independent physical
source directory. The fixed legacy source was subsequently retrieved read-only at
`WhaleUCampus/WhaleU@4494e36b9451e3a92874ccf85f574a36e28e3d48` and each materialized
file matched its remote Git blob SHA. [User.php lines 38–67](https://github.com/WhaleUCampus/WhaleU/blob/4494e36b9451e3a92874ccf85f574a36e28e3d48/treehole/app/controller/User.php#L38-L67)
place provider locking around login and query the guard only when no user exists.
[AccountRegistrationGuard.php lines 66–85](https://github.com/WhaleUCampus/WhaleU/blob/4494e36b9451e3a92874ccf85f574a36e28e3d48/treehole/app/service/AccountRegistrationGuard.php#L66-L85)
sets the block to completedAt plus 30*86400, rejects unfinished deletion and
admits at exact expiry. [AccountErasureService.php lines 357–366](https://github.com/WhaleUCampus/WhaleU/blob/4494e36b9451e3a92874ccf85f574a36e28e3d48/treehole/app/service/AccountErasureService.php#L357-L366)
updates the guard and deleted state in the final transaction after media checks.
Thus completion-based timing matches both the explicit task requirement and this
fixed legacy implementation; no legacy code was executed.

Important non-equivalences remain explicit. The legacy guard HMACs both OpenID
and server-verified UnionID (AccountRegistrationGuard.php lines 27–48) and blocks
while deletion is still running. This bounded Next contract covers the existing
app-scoped provider subject only and cannot yet create real pending or completed
deletion facts. UnionID anti-re-registration is separate from account merging:
a future explicit same-provider/app guard may use the adapter's server-verified
UnionID without changing mapping/merge behavior. Its missing-UnionID and cross-app
scope need an independently reviewed contract; no scope is inferred here. It does NOT
claim UnionID anti-re-registration parity. The legacy single-secret fingerprint
rejects rotation, while this candidate models retained epochs. Legacy interactive
login plus explicit cancellation consent may cancel cooling
(AccountDeletionService.php lines 152–174); Next's ordinary login still never
cancels deletion. Any new explicit cancellation route requires its own versioned
policy and cannot silently copy the legacy side effect.

Focused unit execution covers HMAC domains/rotation/privacy, persistent inactive
admission, unknown/missing facts, database-time expiry, actual repository call
ordering/rollback, preserved existing login and unchanged refresh/session behavior.
An initial root-directory invocation failed to load the API decorator tsconfig;
the corrected invocation from `apps/api` passed 67/67 tests without compilation.
Both logs are retained. PostgreSQL, strict typecheck, full suites, Home integration,
real providers/native devices and complete lifecycle remain unrun or unimplemented.

### Independent review correction (Stage A v2)

The sealed first candidate contained a real sub-millisecond boundary bug: after
PostgreSQL selected a live guard, JavaScript Date could truncate both observed
time and expiry to the same millisecond and allow registration prematurely.
The independent v2 successor removes that second time decision, validates the
completion interval in SQL and treats any valid selected row as blocked. New
unit cases model same-millisecond microseconds, exact equality and expiry after
selection. They do not substitute for actual PostgreSQL integration testing.
The v1 recovery bundle is preserved unchanged, including its original evidence.

### v3 partial-schema correction and rejected v2 privilege design

The first inactive-table check did not prove that required columns, constraints
and write-closed triggers still existed. v3 adds exact catalog qualification,
a retained shared migrator fence and required post-deferred proof as described
above. The earlier v2 proposal used SHARE table locks and MAINTAIN privileges;
that design was rejected and preserved separately, with no PG or grants executed.
The v1 recovery input is unchanged. v3 requests no such privileges and keeps
negative privilege tests rather than weakening them.

The v3 recovery README records the exact latest focused test command/result and
all failed attempts. Its new PostgreSQL suite is source only, not executed;
Home integration, strict typecheck and real deletion remain outstanding. A unit
catalog fixture is never evidence that actual PostgreSQL migration/roles passed.

### v4 exact catalog and budget successor

This successor preserves v3 and narrows its qualification gaps: only the exact
zero-argument marker OID is excluded, all FK/internal and user trigger states are
sealed, and PostgreSQL18 constraint enforcement/inheritance attributes are explicit.
Catalog sources are fixed to three relations and two non-marker functions; unknown
prefixed functions/relations contribute only existence sentinels. Per-kind scans
stop at their fixed cap plus one. At most128 facts,32KiB per serialized fact and
256KiB summed serialized facts enter aggregation; overflow yields no valid seal.
Source expressions, arguments, function bodies/config are bounded to16KiB before
deparsing/JSON aggregation, with an explicit overflow bit (never replacing a
missing default with an indistinguishable null). Metadata transports at most16KiB
function bodies. The existing100ms statement/500ms proof budget is unchanged.

Authored PostgreSQL coverage now includes marker overload, internal-FK disable,
NOT ENFORCED, source/fact/item/aggregate overflow, both migration-lock directions
and release after COMMIT/ROLLBACK. It also invokes actual createSession, observes
tentative account/session/token/native-baseline writes, forces a late schema
failure and verifies all writes plus DDL roll back. These are not PG passes until
the separately coordinated integrated run occurs. The final integration base is
the parent's exact Home commit2f9f77260119664af3a06c488963153fdc12dab3/tree
4ac8f485cd905d36e900bef15c19d491cd13d062, which includes0177/0178.
