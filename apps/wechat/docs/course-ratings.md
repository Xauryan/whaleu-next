# Native course ratings

These are new Next surfaces. The legacy specialist course controller is
source-backed, but registered legacy native course pages have not been proven.
Entry links appear in the current generic, scoped and recovery Ratings pages.
The course API and local pending journal are separate from the generic mutable
integer 1–5 score feature.

- `course-ratings` lists source-accepted courses, name-substring search, exclusive
  department/category filters, rating/time sorting and bounded replacement pages.
  Department `99` explicitly means the source department `90–99` group. Course
  name, department, category, nature, campus label and code stay visible.
- `course-rating-detail` displays a composite fresh course, own first score and
  three independent aggregate means. Unavailable history never means unsubmitted
  or zero respondents. A known-empty summary has count zero and three null means.
- Each independent axis (`grade_score`, `ability_score`, `overall_score`) exposes
  all ten half-step choices, 0.5 through 5. The overall choice is never computed
  from the other two. Every value must be chosen and reviewed in a separate
  confirmation before the first submission. There is no edit/delete handler.
- The confirmed request UUID, catalog revision, course revision and exact three
  scores are saved and read back under API-origin/account scope before dispatch.
  Duplicate taps, lost responses, restart, hide/unload and login changes preserve
  the original request. Only a matching applied or serialized rejected receipt
  releases it. Receipt absence, an own-read saying not submitted, authentication
  failure, source withdrawal, phone or Safety changes never unlock a new key.
- The catalog page always exposes pending receipt recovery before catalog reads.
  Historical receipts do not become current visibility or write authority. After
  settlement, current course/own/summary state is independently reread. Rejected
  revisions require fresh selection and explicit confirmation.
- Existing session, account-epoch, cancellation and private app-hide machinery
  clears private page state synchronously. Reads and writes use the current
  authenticated session; phone and Safety eligibility are server-owned. There is
  no affiliation gate or browser-campus authority inference.

Focused tests cover strict decoding, all 1,000 three-axis combinations, gateway
routing/auth refresh, storage faults, first-submit confirmation, response loss,
restart, account/hide fencing, typed terminal rejections, filter/cursor revisions,
and unavailable/empty distinctions. The separate API integration worker executes
emitted App, Page handlers and repository WXML through actual gateways and a real
loopback AppModule/database. Only native `wx` callbacks and platform networking
are simulated. Actual WeChat DevTools/device rendering, live providers, accepted
production data and full legacy parity remain unverified.
