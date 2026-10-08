# Member-scoped organization directory

This partial read slice covers category hubs, approved entry lists, name search
and detail for school groups, organizations and official accounts. It is separate
from post-based group formation. Three registered native pages are reachable from
the community surface. Empty migrations create no directory population or issuer.

## Authority and current data

Every read requires a current session, verified phone, canonical safety coverage,
valid student affiliation and resolved current identity-campus home region.
Browsing-campus selection, same institution, related-region membership and admin
roles do not bypass these Stage 1 member gates. Administrative cross-region and
unapproved review access are explicitly deferred, not declared complete parity.

Directory context is resolved through current owners. The repository does not
read identity/verification/safety tables directly or impersonate a publication
action. Shared policy gates, current row locks and finite deadlines remain held
through the final transaction check. Foreign direct detail yields a generic
not-found result; no private row fields accompany denied/unavailable results.

Current taxonomy and regional entry populations have separately sealed immutable
revisions and accepted complete coverage. Shared official taxonomy is global;
its entries remain region-owned. Independent taxonomy heads prevent regional
catalogs from silently using superseded global categories. Exact current approval
is bound to entry content revision and accepted scope, not an approved boolean
standing alone. No runtime approval/import endpoint is installed.

Missing or incomplete accepted catalog evidence is unavailable. Only complete
accepted coverage can establish a genuine empty list. Source-approved current
records do not fabricate historical reviewers, timestamps, role history or media
coverage. Real catalog population needs trusted import/reconciliation later.

## Transport and ordering

- GET /v1/directory/context resolves the eligible current home region
- GET /v1/directory/regions/:regionId/categories selects a required kind
- GET /v1/directory/regions/:regionId/entries lists a category or searches names
- GET /v1/directory/regions/:regionId/entries/:entryId returns approved detail

The [generated OpenAPI contract](openapi/organization-directory.json) describes
exact queries and strict DTOs. Unknown/repeated parameters and unsupported GET
bodies are rejected. Responses are no-store and Vary: Authorization, including
pre-controller guard failures. Shared account request limits are metadata writes;
GETs do not change visits, entries, approvals, roles or other directory facts.

Search is a literal substring with explicit ASCII-only case folding under C
collation; Chinese and other stored text remain unchanged. Percent, underscore
and backslash are literal. No accent, pinyin, normalization or general Unicode
case-fold claim is made. Controls/malformed Unicode are rejected before trim.

Accepted bigint display/search ordinals preserve trusted snapshot order. Ordinals
are unique within their accepted population, so no UUID tie-break is needed.
Category/list display order and search order are distinct accepted source facts.
There is no live visit-based popularity writer in this slice. Revision-bound
opaque cursors use the established Community navigation owner; changed scope or
catalog requires explicit restart. More than 50 entries can be traversed without
an offset or silent first-page ceiling. No exact total is returned.

## Public fields and native behavior

Category kind (school/org/official), entry platform (qq/wechat/official), and badge
(normal/official/partner) are distinct. An ordinary group can have an official
badge without becoming an official-account platform.

Summaries exclude contacts, applicants, reviewers, managers, internal source IDs
and raw media references. Authorized detail may expose a known QQ group number;
copy uses the current loaded DTO and checks cancellation immediately before actual
clipboard dispatch. Unknown contact/media data stays explicit. Platform-inapplicable
slots are not_applicable; proven absent media differs from unavailable referenced
media. Managers, management actions and visits remain unavailable, not empty/zero.
Unknown dates are never fabricated. No raw URL is surfaced as unavailable media.

Pages clear bodies, contacts and cursors on error, hide, session/account/identity
selection or safety changes. Next/Previous fetch fresh pages; search draft differs
from submitted intent. A page return preserves only permitted navigation intent
and rereads current authority. No directory DTO/contact history is persisted.

Media providers/preview, uploads, applications/edits, review/admin workflows,
ownership/managers, visit recording, historic import, other platforms and physical
WeChat rendering remain unfinished. See [acceptance](acceptance/organization-directory.md).
