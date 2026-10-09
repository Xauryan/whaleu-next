# Native Ratings M3A: category creation

## Entry and authorization boundary

`rating-catalog` opens `rating-category-create` with only the selected region ID
(or no region for explicit global scope). The entry is a request to check
management authority, not a permission claim. No identity overlay, role label,
managed relation or current public category list is used to grant creation.

The five authenticated endpoints are:

- `GET /v1/ratings/category-management/context`, optional `regionId`
- `POST /v1/ratings/category-management/prepare`
- `POST /v1/ratings/category-management/categories`
- `GET /v1/ratings/category-management/requests/:requestId`
- `POST /v1/ratings/category-management/cancel`

The editor opens only after exact context decoding: matching region, current
catalog revision (nullable for a genuinely fresh scope), a 43-character scope
revision, the complete sorted unique campus list, same-source eligible parents,
and fixed limits of 32 nodes and three levels. A regional empty campus mapping is
invalid. Global context can represent no currently mapped campuses. This client
never fills missing mapping from an admin grant or a browsing campus. Management
context failure leaves ordinary catalog reading independent.

## Editor and confirmation

One root is always present. Child insertion is ordered after its parent; deleting
a node also removes its descendants. The root cannot be deleted or turned into a
second root. Existing parent selection can only use the current context options,
and total depth includes that parent's level. There are no controls for special
kinds, system categories, images, updates, overrides or reparenting.

The second confirmation displays the explicit global/local source scope, exact
region ID, every affected campus ID, selected existing parent, all node keys,
parents, levels and canonical name/description. Editing is disabled while that
confirmation is active. Dismissal during UUID generation fences the pending
callback before persistence. Names accept 1–100 Unicode characters; descriptions
accept 0–500; invalid controls and unpaired surrogates are rejected.

## Durable original intent and uncertainty

The v8 intent includes only `clientRequestId`, `regionId`,
`expectedCatalogRevision`, `expectedScopeRevision`, exact nullable parent and
parent-revision pair, ordered nodes and empty assets. It is saved/read back
before network dispatch. Preparation tokens and reserved IDs never enter the
journal. Every explicit retry prepares the same exact input and commits with
only that preparation's `expectedContextRevision`. Login/session change or
cancellation between these steps prevents the commit.

The shared origin/account journal reads versions 1–8 in the existing order and
checks every version before a new freeze. A corrupt or unresolved older slot
blocks replacement; original v1–v7 schemas and bytes are not migrated. v8 storage
readback and settlement failures preserve the original recovery key. History is
recovered before any route, current scope or permission read. Catalog, detail,
thread, independent recovery and existing management pages can dispatch v8
recovery without replaying historical text into their current display.

Explicit cancel needs a separate confirmation and sends the original intent,
not a reconstructed current scope. Applied history wins. A rejected terminal
receipt must use the exact fixed rejection-code allowlist. HTTP errors, pending
or unknown Review, unavailable grants/mapping, a missing receipt and malformed
responses cannot clear the journal, generate a replacement key, or become a
successful publication. A different session cannot reuse an old preparation;
new execution remains bound to the preparation session. A valid new session of
the same account may explicitly cancel the exact original intent or read its
historical receipt.

## Current projection invalidation

Only a strict durable applied category receipt, after successful local
settlement, publishes `releaseId` and the region/catalog revision set. No names,
text, actor IDs, tokens or campus mapping are included in this signal. Each
current public consumer cancels its pending work and clears old content and
paging: generic directory, rating catalog/detail, thread, random draw, and reply,
like and subscription notice pages. Existing create/edit/delete confirmations
also lose their old catalog-bound context. No event changes durable notice read
history, rewards, subscriptions or notification kinds. A rendering failure in
one subscriber cannot retain other subscribers' snapshots. Fresh data always
comes from a new authorized read.

## Acceptance boundaries

The category contract/gateway/pending/controller tests cover strict decoding,
tree/scope matching, origin/account isolation, every old journal version,
preparation/commit/recovery/cancel, nonterminal uncertainty, late callbacks,
session/Safety/scope/root-hide cancellation, and failed persistence/settlement.
Publication tests cover loaded and in-flight consumers and all three notice
categories, leaving the existing 21 target-invalidation notice tests unchanged.

`smoke-rating-category-management.mjs` is invoked both by the source-native test
and the emitted build smoke. It uses real page handlers, native runtime,
WechatTransport, ApiClient, durable storage and bounded WXML rendering against a
synthetic HTTPS server. It verifies the real empty/cold form state rather than
adding a fake `loaded` field or skipping the page. This synthetic check is
separate from backend HTTP/PostgreSQL causal publication tests and real WeChat
DevTools/device/provider acceptance. No check is claimed as run by this document;
consult the validation record for executed results.
