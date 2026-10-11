# Native organization application and management

This owner is separate from the 0032 accepted legacy directory snapshots. It
creates no default organizations, applicants, administrators or owners. A stable
native target is `{ source: 'managed', organizationId }`; only its narrow
`OrganizationAuthorityFacade` can establish current management authority for a
future Activities integration. No activity publication is included here.

## Source evidence and preserved behavior

Legacy repository `WhaleUCampus/WhaleU`, commit
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`,
`treehole/app/controller/GroupChat.php`:

- apply 649–787: explicit applicant, pending state, category and actual region,
  qq/wechat/official platform, name at most 10 code points, introduction at most
  1000, QQ number 5–16 digits; avatar/main QR required; WeChat manager-contact image
  required; optional linked official QR and up to nine introduction images.
- approve 795–827 and reject thereafter: exact school administrator or global
  super-administrator, rejection reason required, first approval grants applicant
  group ownership for official accounts too.
- managers/findUserByUid/addAdmin/removeAdmin/transferOwner: target-specific owner
  and administrator roles. Administrators can add/remove administrators, never
  remove the owner. Remove-self is allowed. Add/transfer-self is not.
- transfer 476–542: old owner becomes an administrator. The old implementation
  incorrectly used the operator instead of the actual old owner during a school
  administrator transfer. This owner fixes that bug atomically and has a partial
  unique index allowing only one unrevoked owner.
- update 927–997: authorized edits preserve approved status. Next does the same,
  with exact CAS plus an atomic event, receipt and current Media replacement.
- `treehole/route/app.php`: apply/update have ImageAuditMiddleware, not
  ContentAuditMiddleware. Business school approval never supplies image Safety
  approval; every image binds only after its independent exact Review.

The legacy numeric school UID has no accepted mapping in Next. Member lookup uses
an existing public profile ID, visibly labeled “公开主页ID”, and independently
checks the target's canonical current phone, affiliation and identity-home region
against the organization's own region. It never guesses a legacy numeric UID or
uses the global official category's old region 999. Removing an administrator does
not require the removed account to retain verification.

## Business state and authority

1. A verified applicant creates a real draft with no organization grant.
2. The applicant uploads avatar/main QR, manager contact for WeChat, optional
   linked official QR, and introduction slots 0–8 through Media10.
3. Save preserves draft/rejected status. Submit freezes the exact new content
   revision pending school business review. Pending content cannot be edited.
4. Rejection stores a reason with an immutable causal event. The applicant may
   edit and resubmit; no ownership is inferred or granted by rejection.
5. First approval revalidates the actual applicant, taxonomy and all Media
   bindings, and atomically grants one owner role to that applicant.
6. Approved edits preserve publication status and revalidate all kept/replaced
   images. Owner/admin/exact school management can edit.
7. Owner/admin/exact school management can add/remove administrators. Transfer is
   restricted to owner or school management. It revokes the actual old owner and
   target administrator, creates the sole new owner, and demotes the actual old
   owner to administrator. The school operator gets no accidental target grant.

Authority is an independent organization/account/role ledger with validity,
revocation, version, source event and revoke event. Its target identity is not a
catalog row, title, campus selection or a generic global `role_grants` record.
Schools use the existing fixed school-admin grant and true global super-admin
with explicit region on review. Developer grants confer no organization power.
At most 100 management members are admitted. A transfer to a nonmember at capacity
is rejected before any event/revocation; transfer to an existing administrator is
allowed and does not change the member count.

## Commands and native recovery

Every mutation carries clientRequestId, expectedRevision and
expectedAuthorityVersion. Lowercase canonical UUIDs are required before hashing or
locking. Canonical actor/target/full-command SHA-256 is checked against the same
original request key. Receipts are immutable; a replay cannot repeat a role grant.
Cancellation is a serialized original-key/hash fence and cannot undo a committed
command. A user with a revoked role can still recover their own historical receipt
using a current session, but a receipt cannot restore current authority.

Native App/Page/WXML entries use the actual API gateways, account/environment
isolated command journals, one unresolved command per account, explicit recovery,
same-key retry and server-confirmed cancellation. Hide, unload, account/session
change and identity-scope invalidation clear private render state. Media shares
the App's existing finite file/budget registry. Pending journals contain no bearer,
provider key, local path or image bytes. Unresolved image requests remain visible
by original revision and slot after content advances, with original-key recovery
and cancellation. Cancelling a never-bound upload does not undo a committed
organization command; bound-history recovery leaves legal image bindings intact.

## Discovery and media privacy

The category/search page shows two clearly labeled independently paginated
sections: accepted historical directory, and native approved organizations.
They have no invented combined total. Both are discoverable through the existing
`directory-detail` user entry route, with `source=managed` for native identity.
Native cursors bind account/session, region, kind, category, literal name query,
limit and the live source revision; changes require restarting pagination.

Native public details require the existing real session/phone/affiliation/home
region/Campus/Safety gates and approved content. Applicant account IDs, membership
account IDs, review notes, management details and the managerContact image never
enter public DTOs. The exact management capability includes real native grants and
exact school/super authority, so a school reviewer can re-enter management from
an approved public detail. The legacy source remains separately unavailable for
management until its actual authority is accepted; no owner is inferred.

The Media owner is described in [ORGANIZATION_MEDIA.md](ORGANIZATION_MEDIA.md).
Default production runtime is null and fails closed. Synthetic fixtures explicitly
wire loopback immutable storage, ingress, processing and Review; this is not real
WeChat-device/provider/COS acceptance or production data migration.
