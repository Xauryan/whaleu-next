#!/usr/bin/env bash
# Synthetic WeChat boundary, emitted native Pages, real loopback AppModule/PostgreSQL.
set -euo pipefail
[[ ${NODE_ENV:-} == test && ${WHALEU_TEST_MAINTENANCE:-} == controlled ]] || {
  echo 'Explicit NODE_ENV=test and WHALEU_TEST_MAINTENANCE=controlled required' >&2
  exit 64
}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
npm run build -w @whaleu/wechat
cd apps/api
# The complete manifest includes deliberate 30/60/120-second proof waits.
# Its aggregate ceiling is 30 minutes; per-file bounds and serial execution remain.
# Timeout stays inside the cluster wrapper, so normal cleanup also runs on expiry.
bash ../../scripts/run-controlled-test-postgres.sh \
  timeout 1800 node --import tsx --test --test-concurrency=1 \
  test/integration/private-message-images-native-roundtrip.test.ts \
  test/integration/course-ratings.test.ts \
  test/integration/course-ratings-native-roundtrip.test.ts \
  test/integration/course-comments-native-roundtrip.test.ts \
  test/integration/window-ratings-native-roundtrip.test.ts \
  test/integration/dish-recommendations-native-roundtrip.test.ts \
  test/integration/canteen-floor-scores.test.ts \
  test/integration/canteen-floor-score-proofs.test.ts \
  test/integration/canteen-floor-scores-native-roundtrip.test.ts \
  test/integration/scoped-post-pins.test.ts \
  test/integration/scoped-post-pin-proofs.test.ts \
  test/integration/scoped-post-pins-native-roundtrip.test.ts \
  test/integration/window-discussion.test.ts \
  test/integration/window-discussion-media.test.ts \
  test/integration/window-discussion-media-upgrade.test.ts \
  test/integration/window-discussion-images-native-roundtrip.test.ts \
  test/integration/window-discussion-concurrency.test.ts \
  test/integration/window-discussion-native-roundtrip.test.ts \
  test/integration/major-directory.test.ts \
  test/integration/major-discussion.test.ts \
  test/integration/major-discussion-concurrency.test.ts \
  test/integration/major-discussion-delete.test.ts \
  test/integration/major-discussion-media.test.ts \
  test/integration/major-discussion-media-upgrade.test.ts \
  test/integration/major-discussion-media-delete.test.ts \
  test/integration/major-discussion-images-native-roundtrip.test.ts \
  test/integration/major-discussion-native-roundtrip.test.ts \
  test/integration/owner-post-visibility-commands.test.ts \
  test/integration/owner-post-visibility.test.ts \
  test/integration/owner-post-visibility-native-roundtrip.test.ts \
  test/integration/community-text-review-native-roundtrip.test.ts \
  test/integration/community-feedback.test.ts \
  test/integration/school-configuration-native-roundtrip.test.ts \
  test/integration/school-qr-media.test.ts \
  test/integration/school-qr-native-roundtrip.test.ts \
  test/integration/errand-target-services-native-roundtrip.test.ts \
  test/integration/errand-draft-fence.test.ts \
  test/integration/errand-media.test.ts \
  test/integration/errand-media-native-roundtrip.test.ts \
  test/integration/errand-group-delivery.test.ts \
  test/integration/errand-group-native-roundtrip.test.ts \
  test/integration/school-posting-policy.test.ts \
  test/integration/school-posting-policy-native-roundtrip.test.ts \
  test/integration/organization-management.test.ts \
  test/integration/organization-media.test.ts \
  test/integration/organization-media-native-roundtrip.test.ts \
  test/integration/organization-management-native-roundtrip.test.ts \
  test/integration/activity-publication.test.ts \
  test/integration/activity-media.test.ts \
  test/integration/activity-publication-native-roundtrip.test.ts \
  test/integration/activity-read.test.ts \
  test/integration/activity-authority.test.ts \
  test/integration/activity-concurrency.test.ts \
  test/integration/activity-native-roundtrip.test.ts \
  test/integration/announcement-authoring.test.ts \
  test/integration/announcement-authoring-native-roundtrip.test.ts \
  test/integration/announcement-media.test.ts \
  test/integration/announcement-read.test.ts \
  test/integration/announcement-concurrency.test.ts \
  test/integration/announcement-native-roundtrip.test.ts \
  test/integration/student-verification.test.ts \
  test/integration/student-verification-evidence.test.ts \
  test/integration/student-verification-native-roundtrip.test.ts
