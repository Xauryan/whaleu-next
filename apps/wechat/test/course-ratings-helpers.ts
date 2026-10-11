import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  CourseRatingController,
  type CourseMode,
  type CourseRatingView,
} from '../src/course-ratings/controller';
import type {
  Course,
  CourseDetail,
  CourseFirstScore,
  CoursePage,
  CourseReceipt,
} from '../src/course-ratings/contract';
import type { CourseRatingsGateway } from '../src/course-ratings/gateway';
import { PendingCourseRatingStore } from '../src/course-ratings/pending';
import { setup } from './community-helpers';
export const id = '11111111-1111-4111-8111-111111111111';
export const revision = '22222222-2222-4222-8222-222222222222';
export const catalogRevision = '33333333-3333-4333-8333-333333333333';
export const campusId = '44444444-4444-4444-8444-444444444444';
export const requestId = '55555555-5555-4555-8555-555555555555';
export const otherId = '66666666-6666-4666-8666-666666666666';
export const recordedAt = '2026-10-11T12:00:00.000Z';
export const course = (patch: Partial<Course> = {}): Course => ({
  id,
  revision,
  name: '合成课程',
  department: 1,
  category: '合成类别',
  nature: '合成性质',
  code: 'SYN-001',
  campusId,
  campusLabel: '合成校区',
  sourceCampusKey: 'synthetic-campus',
  createdAt: recordedAt,
  summary: {
    kind: 'known',
    count: 0,
    gradeScore: null,
    abilityScore: null,
    overallScore: null,
  },
  ...patch,
});
export const detail = (patch: Partial<CourseDetail> = {}): CourseDetail => ({
  catalogRevision,
  course: course(),
  myScore: { kind: 'not_submitted' },
  ...patch,
});
export const page = (patch: Partial<CoursePage> = {}): CoursePage => ({
  catalogRevision,
  scoreRevision: '1',
  items: [course()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const payload = (
  patch: Partial<CourseFirstScore> = {},
): CourseFirstScore => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedCourseRevision: revision,
  gradeScore: 0.5,
  abilityScore: 4.5,
  overallScore: 1.5,
  ...patch,
});
export const receipt = (input = payload(), courseId = id): CourseReceipt => ({
  requestId: input.clientRequestId,
  operation: 'course.first-score.v1',
  outcome: 'applied',
  courseId,
  gradeScore: input.gradeScore,
  abilityScore: input.abilityScore,
  overallScore: input.overallScore,
  recordedAt,
});
export const missing = () =>
  new ClientError('http', 'Synthetic missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export function courseHarness(mode: CourseMode = 'detail') {
  const s = setup(),
    pendingCourseRatings = new PendingCourseRatingStore(
      s.storage,
      'synthetic-course',
    );
  const calls: Array<{ method: string; args: unknown[] }> = [],
    commands: CourseFirstScore[] = [],
    ids = { count: 0, next: async () => requestId };
  const impl: CourseRatingsGateway = {
    list: async () => page(),
    detail: async () => detail(),
    submit: async (courseId, input) => {
      impl.detail = async () =>
        detail({
          myScore: {
            kind: 'recorded',
            gradeScore: input.gradeScore,
            abilityScore: input.abilityScore,
            overallScore: input.overallScore,
            recordedAt,
          },
          course: course({
            summary: {
              kind: 'known',
              count: 1,
              gradeScore: input.gradeScore,
              abilityScore: input.abilityScore,
              overallScore: input.overallScore,
            },
          }),
        });
      return receipt(input, courseId);
    },
    receipt: async () => {
      throw missing();
    },
  };
  const gateway: CourseRatingsGateway = {
    list: (...args) => {
      calls.push({ method: 'list', args });
      return impl.list(...args);
    },
    detail: (...args) => {
      calls.push({ method: 'detail', args });
      return impl.detail(...args);
    },
    submit: (...args) => {
      calls.push({ method: 'submit', args });
      commands.push(args[1]);
      return impl.submit(...args);
    },
    receipt: (...args) => {
      calls.push({ method: 'receipt', args });
      return impl.receipt(...args);
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    courseRatings: gateway,
    pendingCourseRatings,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: CourseRatingView[] = [];
  const controller = new CourseRatingController(runtime, mode, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    controller,
    views,
    impl,
    gateway,
    pendingCourseRatings,
    calls,
    commands,
    ids,
    view: () => views[views.length - 1]!,
  };
}
export function choose(s: ReturnType<typeof courseHarness>) {
  s.controller.chooseScore('gradeScore', 0.5);
  s.controller.chooseScore('abilityScore', 4.5);
  s.controller.chooseScore('overallScore', 1.5);
  s.controller.confirm();
}
