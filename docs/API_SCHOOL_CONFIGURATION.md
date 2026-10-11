# School service configuration

This increment implements an independent operating-region service owner and a
native school-services/management flow. It does not enable production Media,
copy legacy data, configure official-account secrets or deliver third-party
messages. Physical-device acceptance remains a separate release gate.

## Source and product boundary

The legacy source reviewed for this increment is
[WhaleUCampus/WhaleU at 57cf169c](https://github.com/WhaleUCampus/WhaleU/tree/57cf169c11123acf249909a1a7215b8cb1ec1f8e):

- `treehole/app/service/SchoolConfigService.php`: allowed configuration keys
  (15–43), completion rules (128–162), public projections (248–305), field
  normalization (462–524), historical sequence-change notices (613–665).
- `treehole/app/service/AdminScopeService.php` (170–188) and
  `PermissionService.php` (15–22, 50–69): fixed school administration and explicit
  true-super-administrator target selection. A developer title is not authority.
- `miniprogram1/packageShare/pages/vxgroup/vxgroup.js` (54–105, 196–204): refresh
  after returning/switching school, three group entries, official account and
  administrator contact, and contact copying.

The six independent entries are `treehole`, `trading`, `errand`, `review`,
`official_account`, and `admin`. Only the first three groups and last two contacts
are public. Hiding disabled entries is an explicit **new rule**; the old public
reader did not consume `enabled`. School-group sequence numbers remain editable,
but the legacy hard-coded recipient 597 is not a Next identity. Reconciled legacy
import and a trusted operations-recipient mapping remain open. No fake defaults
or synthetic real-user contacts are seeded.

Existing unverified/related-region posting policy remains owned by region policy.
Official-account application IDs, secrets, push configuration and provider tests
are deliberately absent from all input/output DTOs and tables in this owner.

## Authority and publication

- A current authenticated account, complete Safety eligibility, and actual active
  `school_admin`/`super_admin` grant are required for management. A school admin
  has one fixed operating region. A true super admin must select an active target
  explicitly. Browsing campus, student verification, profile titles and a
  developer-only grant never grant this authority.
- Each entry has its own increasing revision. Saving one entry is a complete,
  strict command with an expected revision, exact fields and a QR keep/remove/
  replace action. Unrelated entries do not invalidate each other's upload scopes.
- An immutable `admin_publication` records the actual actor/grant and full
  canonical snapshot hash. This is authorized operations publication, not a
  Community Review decision and not image approval. Public reads require the
  exact committed source and current pointer; missing records are unconfigured.
- Current scope/source fingerprints are checked at transaction completion under
  bounded nonblocking fences. Concurrent uncertain scope facts fail unavailable.

## HTTP

- `GET /v1/school-services?campusId=...`: guest-capable, strict supplied-bearer
  handling, five entries in fixed order. Disabled entries reveal no retained
  data or QR reference. QR `configured` means an attached configuration exists;
  it does not grant bytes or assert current image-review availability.
- `GET /v1/me/school-configuration/capabilities`: advisory exact management mode.
- `GET /v1/me/school-configuration[?regionId=...]`: six private management entries.
- `POST /v1/me/school-configuration/:regionId/entries/:entryKey`: entry CAS save.
- `GET /v1/me/school-configuration/requests/:requestId`: own historical receipt.
- `POST /v1/me/school-configuration/requests/:requestId/cancel`: exact-hash fence
  serialized with save. It prevents a future same-key save, never undoes a save.

Successful saves return metadata only: request ID/hash, region, entry, revision
and outcome. Exact retries return the original receipt; changed same-key payloads
conflict. Recovery after management revocation still returns the owner's already
submitted metadata, without configuration content or renewed authority.

The native journal retains one unresolved command per account/environment before
network submission. Response loss, page reconstruction and cancellation use that
same identity. Unknown outcomes cannot silently become fresh requests.

## QR Media owner

School QR Media9 uses independent `school_configuration` ownership, exact
region/entry/revision prepare scopes and immutable appearances. It reuses Media
intent/ingress budgets, processing, current image-review/safety facts, lifecycle,
exact immutable delivery and native process-wide file/transfer reservations.
Images from other owners, arbitrary external QR URLs and copied descriptors are
not attach authority. QR replacement and clearance retire the old binding in the
same entry publication transaction. Public QR delivery resolves the physical
campus again, excludes the review group and requires the current enabled entry,
revision and binding. Supplied invalid credentials never fall back to guest.

Native QR views use inline leased local files, not unconstrained external image
URLs or platform preview windows. Close, hide, account/scope changes and the short
preview lifetime revoke local presentation. Upload completion alone is never a
claim of reviewed/published success. Default runtime configuration still has no
production storage/Review provider; explicit synthetic DI exercises the complete
pipeline in disposable simulated acceptance.

## Validation scope

Targeted tests cover authorization, canonical hash parity, strict safe links,
public redaction, CAS/replay/cancellation, original-key lost-response recovery,
copy-time currentness, campus/account changes, and Media ownership/currentness.
The real PostgreSQL/native simulated journey is distinct from physical WeChat
acceptance. Do not describe this slice as a completed rewrite or production-ready.
