import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bioError,
  decodeCampus,
  decodeCampusPage,
  decodeOwnProfile,
  decodePreferences,
  nicknameError,
  validateCampusQuery,
  validatePreferencesPatch,
  validateProfilePatch,
} from '../src/profile/contract';
import { campus, ownProfile } from './profile-helpers';
test('profile decoder accepts only agreed fields and preserves null selection without inventing verification', () => {
  const result = decodeOwnProfile(ownProfile());
  assert.equal(result.nickname, null);
  assert.equal(result.selectedCampus, null);
  assert.equal('verifiedCampus' in result, false);
  assert.equal('roles' in result, false);
  for (const patch of [
    { revision: -1 },
    { revision: 0.1 },
    { revision: 2147483648 },
    { nickname: '' },
    { nickname: '🐳' },
    { bio: 'a'.repeat(101) },
    { bio: '\n'.repeat(6) },
    { accountId: 'wrong' },
    { selectedCampus: { ...campus(), verified: true } },
    { admin: true },
  ])
    assert.throws(() => decodeOwnProfile({ ...ownProfile(), ...patch }), {
      kind: 'protocol',
    });
});
test('nickname and bio boundaries mirror the reviewed character rules', () => {
  assert.equal(nicknameError('鲸鱼_#&@.+-Ab12'), '');
  assert.ok(nicknameError('with space'));
  assert.ok(nicknameError('a'.repeat(21)));
  assert.ok(nicknameError(''));
  assert.equal(bioError('🐳'.repeat(100)), '');
  assert.ok(bioError('🐳'.repeat(101)));
  assert.equal(bioError('\t你好\n'), '');
  assert.ok(bioError('hello\rworld'));
  assert.ok(bioError('\u0001'));
});
test('campus decoders reject unknown fields, invalid flags, duplicate ids and corrupt pagination', () => {
  assert.deepEqual(decodeCampus(campus()), campus());
  for (const patch of [
    { isActive: 1 },
    { shortName: '' },
    { district: '' },
    { fullName: 'a'.repeat(201) },
    { verified: true },
    { id: 'wrong' },
  ])
    assert.throws(() => decodeCampus({ ...campus(), ...patch }), {
      kind: 'protocol',
    });
  for (const value of [
    { items: [campus(), campus()], page: 1, pageSize: 20, total: 2 },
    { items: [campus()], page: 0, pageSize: 20, total: 1 },
    { items: [campus()], page: 1, pageSize: 20, total: 0 },
    { items: [], page: 1, pageSize: 101, total: 0 },
  ])
    assert.throws(() => decodeCampusPage(value), { kind: 'protocol' });
});
test('preferences require all booleans on response, reject incompatible comment defaults and unknown inputs', () => {
  const preferences = ownProfile().preferences;
  assert.deepEqual(decodePreferences(preferences), preferences);
  assert.throws(() =>
    decodePreferences({
      ...preferences,
      defaultCommentAnonymousEnabled: true,
      defaultCommentNonAnonymousEnabled: true,
    }),
  );
  assert.throws(() => decodePreferences({ ...preferences, showHotTopic: '1' }));
  assert.throws(() =>
    validatePreferencesPatch({ expectedRevision: 0, preferences: {} }),
  );
  assert.throws(() =>
    validatePreferencesPatch({
      expectedRevision: 0,
      preferences: {
        defaultCommentAnonymousEnabled: true,
        defaultCommentNonAnonymousEnabled: true,
      },
    }),
  );
  assert.throws(() =>
    validatePreferencesPatch({
      expectedRevision: 2147483647,
      preferences: { showHotTopic: false },
    }),
  );
  assert.throws(() => validateProfilePatch({ expectedRevision: 0 }));
  assert.throws(() =>
    validateProfilePatch({ expectedRevision: 0, nickname: '' }),
  );
  assert.throws(() =>
    validateCampusQuery({
      q: 'x'.repeat(101),
      district: '',
      page: 1,
      pageSize: 20,
    }),
  );
});
