# Media terminal account-policy owners

This inventory distinguishes current source coverage from executed cases. All entries keep their original Identity, source/Review, affiliation, phone, role, asset and transaction-final proofs. The policy applies to the current reader, not the asset uploader or content author.

| Family                | Registered terminal owner boundary                                                            | Account-policy integration                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Community             | `CommunityMediaDeliveryAuthorizer.authorize`                                                  | Existing explicit browse authorizer and NamedBlockVisibility viewer gate                   |
| Profile avatar        | `ProfileAvatarDelivery.open` → `ProfileAvatarService.target` → `ProfileVisibilityFacade.read` | Explicit viewer browse gate for custom and catalog avatars                                 |
| Rating category icon  | `RatingCategoryIconMediaService.authorizeCurrent`                                             | Existing explicit browse authorizer                                                        |
| Rating target cover   | `RatingTargetCoverMediaService.authorizeCurrent`                                              | Forced browse boundary                                                                     |
| Rating discussion     | `RatingDiscussionMediaService.authorizeCurrent`                                               | Forced browse boundary                                                                     |
| Activity              | `ActivityPublicationAccess.authorizeMediaRead`                                                | Forced browse boundary                                                                     |
| Announcement          | `AnnouncementAuthoringAccess.authorizeMediaRead`                                              | Forced browse boundary, including management branch; editor/manager grants remain required |
| Organization          | `OrganizationAccess.authorizeMediaRead`                                                       | Forced browse boundary                                                                     |
| School QR             | `SchoolQrMediaService.authorizeRead` registered callback                                      | Forced browse boundary; public, management and order authority stay distinct               |
| Verification evidence | `StudentVerificationAccess.authorizeRead`                                                     | Forced browse boundary; owner versus reviewer authority remains distinct                   |
| Errand                | `ErrandsService.mediaAuthority`                                                               | Forced browse boundary; participant/public eligibility unchanged                           |
| Private message       | `MessagingImageAuthority.authorizeRead`                                                       | Forced browse boundary; participant authority unchanged                                    |
| Major discussion      | `MajorDiscussionMediaOwner.authorizeRead`                                                     | Forced browse boundary                                                                     |
| Window discussion     | `WindowDiscussionMediaOwner.authorizeRead`                                                    | Forced browse boundary                                                                     |

The eleven forced boundaries use server-owned `AccountPolicyFor(() => 'browse', 'entry')`. They do not alter the default policy of shared authentication, scope loading, management or mutation helpers. This matters when a registry or owner is invoked directly without HTTP or decorated `open` context: a muted read must not inherit the generic interaction fallback.

`ExactMediaDeliveryService.open` invokes both authorizations within its awaited opening operation. The storage await does not inherently lose async context, and no returned later authorization callback was found in these pipelines. Nevertheless, terminal owners explicitly establish their read semantics. Authenticated rejection never becomes guest access.

## Evidence and limits

- Freeze2 passed the actual Community Media scenario: muted viewer receives image bytes; genuine separate-source suspension during paused storage causes exact suspended denial before any provider bytes escape; an unrelated viewer receives the unchanged asset.
- `account-policy-detached-major-media.test.ts` adds one actual direct owner case: genuine Major image and Review publication, distinct author/viewer, direct DatabaseService transaction with absent ambient policy, clear and mute allowed, genuine suspension denied with exact code, async context restored. At delivery this source was reviewed but had not been executed.
- The existing Activity, Organization, School QR, Student evidence, Major and Window Media integration files cover original independent authority and byte-delivery compatibility. Their ordinary HTTP/clear-actor cases do not establish muted detached semantics for all fourteen families.
- This inventory is not a claim that all SQL source owners or every Media race has been executed. The integration owner records the final frozen test results.
