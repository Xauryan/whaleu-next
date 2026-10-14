/** Emitted WXML branch/nullability proof only; API/PG behavior has its separate real journey. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist',
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const { initialSchoolUidLookupView, initialOwnSchoolUidView } = emitted(
  'school-uid/controller',
);
const { initialSchoolIdentityView } = emitted('school-identity/controller');
const { initialStudentView } = emitted('verification/student-controller');
const text = (nodes) =>
  nodes
    .map((node) => (typeof node === 'string' ? node : text(node.children)))
    .join('');
function view(name, scope) {
  return text(
    render(
      parse(readFileSync(path.join(dist, `pages/${name}/${name}.wxml`), 'utf8'))
        .children,
      scope,
      {},
    ),
  );
}
const school = { code: '12345', name: '合成学校' },
  otherSchool = { code: '54321', name: '合成新学校' };
const assigned = {
  status: 'assigned',
  school,
  uid: '9007199254740993',
  formattedUid: '9007199254740993',
};
for (const schoolUid of [
  { status: 'unavailable' },
  { status: 'unassigned' },
  assigned,
]) {
  const rendered = view('student-verification', {
    ...initialStudentView(),
    schoolUidView: { ...initialOwnSchoolUidView(), loaded: true, schoolUid },
  });
  if (schoolUid.status === 'assigned')
    assert.ok(rendered.includes(schoolUid.formattedUid));
  else
    assert.ok(
      rendered.includes(
        schoolUid.status === 'unavailable' ? '暂不可用' : '当前没有校内 UID',
      ),
    );
}
assert.ok(
  view('student-verification', {
    ...initialStudentView(),
    application: { state: 'approved', campusName: '合成校区' },
    schoolUidView: {
      ...initialOwnSchoolUidView(),
      loaded: true,
      schoolUid: { status: 'unavailable' },
    },
  }).includes('认证已通过，校内 UID 暂不可用'),
);
assert.doesNotThrow(() =>
  view('school-uid-lookup', initialSchoolUidLookupView()),
);
assert.ok(
  view('school-uid-lookup', {
    ...initialSchoolUidLookupView(),
    result: { status: 'unavailable' },
  }).includes('当前不可查询'),
);
assert.doesNotThrow(() =>
  view('school-identity-management', {
    ...initialSchoolIdentityView(),
    addressError: '',
  }),
);
const management = {
  target: {
    profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: '合成昵称',
  },
  current: { school, schoolUid: assigned },
  destination: {
    campusId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    campusName: '目标校区',
    school: otherSchool,
    destinationVersion: 'a'.repeat(64),
  },
  actions: { correctSchool: true, completeUid: false },
};
assert.ok(
  view('school-identity-management', {
    ...initialSchoolIdentityView(),
    addressError: '',
    management,
    confirming: 'correct_school',
  }).includes('永久保留'),
);
assert.ok(
  view('school-identity-management', {
    ...initialSchoolIdentityView(),
    addressError: '',
    management: {
      ...management,
      current: { school, schoolUid: { status: 'unavailable' } },
      destination: null,
      actions: { correctSchool: true, completeUid: true },
    },
    confirming: 'complete_uid',
  }).includes('补发当前学校 UID'),
);
console.log(
  'School UID emitted WXML branches passed: no-application unavailable, assigned bigint, deferred approval, empty lookup and action-specific confirmation. Not API/PG or physical-device acceptance.',
);
