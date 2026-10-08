# Announcement reads and popup acknowledgement

This partial slice supplies public content reads, account-owned popup
acknowledgement, native list/detail and an authenticated feed popup. It is separate
from ordinary Updates, feedback, general guide preferences and post view/rewards.
Empty migration 0034 creates no announcement population, issuer or admin grants.

## Public content and scope

List, detail, latest popup and created-since checks permit genuinely absent bearer
credentials. A supplied invalid bearer fails authentication rather than becoming a
guest. Signed-in reads retain current account restriction checks. No phone,
student-affiliation or verified identity-campus gate is added to these reads.

Optional campusId is an explicit physical browsing-campus filter. Omitted context
sees all_browsers announcements only. A campus-targeted audience uses an exact
accepted campus set; institution, identity campus, operating region and global
community space are not substitutes. Supplied inactive/missing campuses never
fall back to a broader global result.

Stable announcement identities are distinct from immutable accepted content,
popup, audience and order revisions. A sealed current catalog proves complete
coverage; missing/incomplete evidence is unavailable, not empty. Approval binds
the exact revision and targeting. Known empty catalog is distinct from absent
source data. No raw audience list, private author/reviewer or source ID appears in
public results.

## Reads and newness

- GET /v1/announcements: current summaries in accepted source-ID-equivalent order
- GET /v1/announcements/:id: full current text and explicit media state
- GET /v1/announcements/popup: latest eligible popup body or known none
- GET /v1/announcements/changes: currently visible created-since observation
- GET /v1/me/announcements/popup: latest candidate plus current owner's marker
- PUT /v1/me/announcements/:id/popup-acknowledgement: explicit own confirmation

See the [generated contract](openapi/announcements.json) for exact schemas.
The latest label is catalog order, not date/version/unread status. Opaque keyset
pagination supports more than the old first-50 client ceiling; catalog/context or
session changes require explicit restart. No read body/status snapshots persist
in the native client.

The changes endpoint compares created_at strictly greater than an exact
microsecond-capable since value. Its default window is 30 elapsed days from the
database observation clock. It does not use updated_at, popup acknowledgement or
saved last-visit state. Unknown temporal coverage or bounded count failure returns
unavailable rather than a smaller count. Counts are decimal strings. Native labels
this as recently published announcements, never an unread-all badge.

## Popup confirmation

The automatic native popup requires an account and selects the latest currently
eligible popup before checking its marker. If latest is acknowledged, it does not
drain an older unseen queue. Reading list/detail, expanding, navigating, hiding or
backgrounding never acknowledges.

Only explicit close/我知道了 submits campus context and expected current revision.
The command verifies current visibility, popup eligibility, revision, session and
safety, then atomically inserts an immutable account+announcement marker. Replays
and concurrent requests preserve its first timestamp. Same-ID edits retain the
marker; different IDs sharing a version label remain independent. A global ID's
marker survives browsing-campus changes.

Missing markers prove unseen only with accepted fresh-local identity or adequate
per-owner historical coverage. Otherwise marker state is unavailable. Existing
accepted historic markers may have unknown timestamps; these are not fabricated.
Withdrawal, retargeting or an edit before an initial stale command prevents that
command from marking the changed revision.

Failed confirmation closes the current popup locally with unconfirmed status.
It does not persist optimistic success; a future foreground read can retry. Late
responses from old accounts, campuses, sessions or closed generations cannot reopen
or mark another popup.

## Lifecycle, reuse and remaining work

Native text remains selectable with preserved paragraphs/indentation. Unavailable
images do not expose raw URLs or preview controls. Guest routes are reachable from
status/login as well as the feed. Feed reload resolves the same physical browsing
context for both post feed and popup, including a failed region lookup. Identity
selection and browsing context remain distinct.

Current policy gates, owner locks, deadlines and final transaction checks protect
reads and commands. Shared PostgreSQL request limits and bounded navigation
metadata are reused; they do not mark content acknowledged. Offline official
Swagger export mounts no live application or documentation route.

Admin publication/edit/withdraw/delete, trusted media, production content
issuance/import, source-campus crosswalks, complete historic markers, feedback and
other platforms remain unfinished. Physical WeChat rendering is unverified. See
[acceptance](acceptance/announcements.md).
