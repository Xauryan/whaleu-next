# SQL migration contract

`0001_identity_sessions.sql` creates the new identity/session schema. It contains
no import or transformation of legacy records. Production schema mapping and all
legacy-data migration remain separate, required milestones.
`0002_identity_retention_index.sql` adds the terminal-session lookup index for
operator-only maintenance; applying it does not delete any records.
`0003_campus_profile.sql` introduces the campus/profile schema (see the migration
file for its exact name and checksum).
`0004_community.sql` introduces operating regions, community content, durable
publication receipts and outbox records. It does not seed real publishing grants.
`0005_authorization_identity_privacy.sql` introduces explicitly approved scoped
roles and an append-only privileged-identity access ledger. No account is granted
administrator or developer status automatically.

- Add immutable UTF-8 files named `0001_descriptive_name.sql`, in increasing order
- SQL files are trusted repository code and require review before execution
- Each file runs inside its own transaction and records its SHA-256 checksum in
  `whaleu_meta.schema_migrations` in the same transaction
- Do not include transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`)
  or commands that require execution outside a transaction, such as concurrent indexes
- The database-local session advisory lock serializes migrations. Waiting is bounded
- Applied files must not be removed, reordered, or edited; create a new forward migration
- A failed transaction rolls back and does not record a successful application
- `db:status` does not create schema or tables; `db:migrate` creates only bookkeeping
  when this directory contains no SQL files
- No automatic startup migration and no automatic down/reset command is provided
- Review a backup/restore rehearsal and run in a disposable database before any
  separately authorized production migration

The SQL runner is migration infrastructure, not a legacy-data migration tool.
Full source-database import, production reconciliation, cutover and rollback
remain separate milestones. The reviewed school registry tool below covers only
its explicit mapping subset.

`0006_school_identifiers.sql` adds empty canonical five/ten-digit institution
registries, source provenance, reviewed legacy crosswalks and scheme-scoped
historical aliases. Private institution/campus relationships remain unchanged;
unresolved public institution IDs are null. The separate `schools:migrate` tool
is dry-run by default and only applies explicit reviewed mappings. See
[school identifier migration](../../../docs/SCHOOL_IDENTIFIERS.md). It is not a
complete legacy import or evidence that any production records were migrated.

`0007_verification_ledger.sql` creates an empty local verification ledger with
immutable assertions/snapshots/events, a versioned current head, and private raw
staging envelopes. It does not import legacy records, infer student numbers,
create applications, activate providers or grant roles. See
[verification V1](../../../docs/API_VERIFICATION.md) for authority, preservation,
expiry, lock ordering and deferred production migration requirements.

`0008_community_polls.sql` adds empty poll definitions/options, immutable ballots/
selections and an isolated durable ballot-request ledger inside `whaleu_community`.
It preserves C1 migration checksums and creates no synthetic authority. New-write
text limits are API-only so reconciled historical raw text/deadlines can be
preserved at insert. Poll definitions, options, ballots and terminal receipts
cannot be edited; atomic/deferred integrity checks prevent incomplete commits.
It is not a production import. See [C2A polls](../../../docs/API_COMMUNITY.md#c2a-poll-contract).

`0009_community_discussion.sql` adds flat replies, constrained same-thread targets,
shared interaction ordering, reply assets, comment/reply likes, singleton author
root-pin state and immutable discussion mutation receipts. It extends publication
operations and audited identity target kinds forward without editing 0001–0008.
Root parent/ownership and reply content/relations are immutable; deferred checks
reject future/cyclic targets and unfinished receipts. No production import or
provider activation occurs. See [C2B discussion](../../../docs/API_COMMUNITY.md#c2b-discussion-contract).

`0010_community_trading.sql` adds empty named-regional listing storage, exact
scale-free NUMERIC amounts, independent raw historical price/subtype fields,
chosen listing contacts, separate urgency/resolution and immutable owner status
receipts. Deferred checks bind the parent category/mode/scope and exclude polls.
Trading body/ownership/scope and listing metadata are immutable while safety
visibility/deletion and owner resolution remain separate. No contacts enter
outbox payloads, and no migration grants authority, imports production data or
activates group delivery/payment. See [C2C trading](../../../docs/API_COMMUNITY.md#c2c-trading-listings-development-slice).

`0011_community_formations.sql` adds empty post-formation definitions, immutable
creator/member seats and minimal account-owned join receipts. Existing migrations
are unchanged. Capacity/unique creator, account membership, component/parent
shape and receipt completion are enforced independently in PostgreSQL. This is
not a source-data migration. Preserve raw historical statuses/counts/contacts and
provenance in a separately authorized reconciliation flow; never infer consent,
truncate data or guess repairs for conflicting creators/duplicate actors/overflow.

`0012_community_saved.sql` adds empty account-owned Saved relations, durable
membership epochs, independent per-post update preferences/history, minimal
immutable desired-state receipts and pending reward/ranking obligations. Parent
locking and shared discussion order establish future event-time eligibility;
current/active epoch and preference/history shape are checked at commit. Existing
migrations, publication hashes and receipts remain unchanged. No notices,
experience grants, ranking updates, provider consent or production import are
performed. See [C2E Saved](../../../docs/API_COMMUNITY.md#c2e-saved-posts-and-per-post-preferences-increment-1)
for read/cleanup policy, pagination bounds and retained delivery work.

`0014_named_blocks.sql` adds empty directional named block relationships,
account-owned immutable receipts, coverage heads, transition audits and bounded
rate counters in `whaleu_safety`. No old account receives fabricated empty history;
only identity's new-native-account transaction establishes initial coverage.
Creation provenance is immutable, revisions are monotonic, and deferred checks
require exact completed receipts and matching owner transition audit. Inactive
relationships and receipts remain retained to prevent stale-request resurrection.
No moderation, ban/grant issuance, provider, production import or verification
assertion is created. See [S1A named blocking](../../../docs/API_SAFETY.md).

`0016_community_runtime_policy.sql` adds empty immutable topology, identity-selection,
regional policy and exact-content review ledgers with versioned heads and atomic
publication approval bindings. It preserves all prior migrations and publication
receipt hashes. Existing approved/native content gains no review evidence; unknown
history remains unavailable. Statement-level safety writer gates, canonical digest
checks, immutable reviewed definitions, and consumption/visibility lifetime separation
are documented in [runtime policy](../../../docs/COMMUNITY_RUNTIME_POLICY.md). No
startup records, grants, runtime approval writer, provider, production import or
identity-selector endpoint are installed.

Migration 0017 adds empty, immutable own identity-campus selection receipts and
phantom-safe catalog statement gates. It does not seed choices, topology or
verification. Existing migrations remain unchanged.
