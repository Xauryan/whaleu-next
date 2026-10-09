# Native category creation (M3A)

This slice adds one complete administrative creation path. It does not implement category editing, campus-specific overrides, sorting, stopping/restarting, archive, media attachments, or production legacy migration.

## Authority and scope

`GET /v1/ratings/category-management/context` resolves current explicit grants, verified phone, Safety, and canonical Campus inventory. An active `developer` or `super_admin` global grant may create a global or supported regional tree. A current fixed `school_admin` grant may create only in that exact canonical region. Role labels, names, client assertions, legacy identifiers, and partial campus membership do not confer authority.

A regional creation spans every currently proven canonical campus assigned to that region. A global creation publishes to the global catalog and every current supported region in one release. Native categories are `general`, with independent immutable non-system identity. Unknown topology, missing mappings, conflicting inventory, or excessive complete scope rejects the entire operation.

Existing accepted effective rows remain opaque and retain the existing region/global protocol. Preserving them byte-for-byte does not establish a canonical base, legacy campus mapping, or campus-specific visibility. Future campus-specific reads require their own source and placement evidence.

## Protocol

Five authenticated, strict, uncached routes provide context, preparation, publication, cancellation, and historical receipt recovery. An intent binds:

- One request ID, explicit region/global scope, expected catalog and scope revisions
- An optional existing canonical parent and its exact revision
- A single ordered tree of 1–32 uniquely keyed nodes, within three total levels
- Canonical names and descriptions, without assets or caller-supplied administrative flags

Preparation assigns stable category IDs/revisions, source scope revision, release ID, and before/after catalogs. It is bound to its account, current session, original intent, and a maximum five-minute lifetime. Preparation does not approve content. Publication requires exact version-4 `publish_rating_categories` Review evidence for the whole release envelope.

Cancellation uses the exact original intent and a current valid same-account session. It can recover after a login refresh or grant removal. A completed receipt wins. New execution remains bound to the preparation session. Unknown infrastructure, Review, or topology errors do not become durable rejection receipts.

The operation shares the existing Ratings request namespace. Existing request hashes and native journals v1–v7 retain their meaning. The new category journal is v8, with account/session generation protection, original-byte retry, explicit cancellation, and cross-page receipt recovery.

## Immutable publication

Migration 0058 adds stable category identities, base and scope versions, exact Review bindings, catalog materializations, per-category lineage, preparation, release manifests, transitions, and closures. It does not change earlier migration files or overwrite old categories, targets, reviews, scores, comments, replies, likes, subscriptions, notices, or Experience history.

Every affected catalog is sealed. Its existing categories, lineage, and target memberships are copied exactly; only the prepared new category tree is appended. Release-wide limits are 10,000 resulting category rows, 100,000 copied memberships, and 33 catalog scopes. Oversized or stale releases roll back as a unit.

Deferred SQL checks validate both directions of identity, source, preparation, release, current head, exact Review, lineage, and receipt. M1 target creation copies category lineage exactly and appends only its independently authorized target membership. Native identities cannot be silently downgraded to opaque rows or lost through a replacement catalog head.

Writers acquire the common exclusive Safety gate before rating epochs and entity rows. Final proofs use after-state heads, NOWAIT fences, and exact deadlines after deferred constraints. They do not retain a replaced before-head as a current fact.

## Immediate current visibility

Every new category and ancestor must have exact currently valid Review. This gate applies to category lists, target reads and interactions, new target creation/editing, already materialized notification previews, and the complete random pool. A separate child approval cannot bypass a revoked parent. Unknown evidence fails closed; authoritative denial removes or makes the content unavailable.

Campus inventory and topology changes invalidate rating catalog/random proofs, including empty pools and unselected candidates. Scope source deadlines remain applicable even when no target is selected. The native catalog event contains only stable release/catalog identifiers and clears stale views and in-flight callbacks across consumers.

Historical receipts and authorized owner cleanup do not require current category visibility. Category management grants do not expand creator-only target editing or deletion permissions. Category creation emits no reward or notification.

## Remaining work

- M3B: exact campus context/read/write protocol, explicit legacy compatibility proofs, scope-aware notification/random resolution and new scoped target commands
- M3C: reviewed base editing; typed `inherit`/`set` campus overrides; exact sibling ordering; separate ordinary active state and irreversible archive; full affected-scope administration
- M3D: canonical media-owner integration, optional draft assistance, explicit-source dry-run migration and unresolved conflict reporting

Production source snapshots, exact legacy crosswalks, grant provenance, and conflict decisions are cutover requirements. They are not fabricated by this native creation path. Private source evidence and production data are not part of this repository.
