import { z } from 'zod';
import type { Campus } from '../campus/contracts.js';

export const preferenceDefaults = Object.freeze({
  showOfficialAccountTip: true,
  showHotTopic: true,
  showGroupNotice: true,
  showTradingGroupNotice: true,
  showErrandGroupNotice: true,
  defaultAnonymousEnabled: false,
  defaultCommentAnonymousEnabled: false,
  defaultCommentNonAnonymousEnabled: false,
  defaultAllowAnonymousDm: false,
  hideProfilePosts: false,
  activitySubscribed: true,
});

export const preferencesSchema = z.strictObject({
  showOfficialAccountTip: z.boolean(),
  showHotTopic: z.boolean(),
  showGroupNotice: z.boolean(),
  showTradingGroupNotice: z.boolean(),
  showErrandGroupNotice: z.boolean(),
  defaultAnonymousEnabled: z.boolean(),
  defaultCommentAnonymousEnabled: z.boolean(),
  defaultCommentNonAnonymousEnabled: z.boolean(),
  defaultAllowAnonymousDm: z.boolean(),
  hideProfilePosts: z.boolean(),
  activitySubscribed: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export function validCommentDefaults(preferences: {
  [K in keyof Preferences]?: boolean | undefined;
}): boolean {
  return !(
    preferences.defaultCommentAnonymousEnabled &&
    preferences.defaultCommentNonAnonymousEnabled
  );
}
export const expectedRevisionSchema = z.number().int().min(0).max(2147483646);
export const profilePatchSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    nickname: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[\u4e00-\u9fa5a-zA-Z0-9_#&@.+-]+$/u)
      .optional(),
    bio: z
      .string()
      .transform((value) => value.replaceAll('\r\n', '\n').trim())
      .refine(
        (value) =>
          [...value].length <= 100 &&
          value.split('\n').length <= 6 &&
          [...value].every((character) => {
            const code = character.codePointAt(0)!;
            return (
              code === 9 ||
              code === 10 ||
              (code >= 32 &&
                code !== 127 &&
                !(code >= 0xd800 && code <= 0xdfff))
            );
          }),
      )
      .optional(),
  })
  .refine((value) => value.nickname !== undefined || value.bio !== undefined);
export const preferencesPatchSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  preferences: preferencesSchema
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0 && validCommentDefaults(value),
    ),
});
export const campusSelectionSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  campusId: z.uuid(),
});
export type ProfilePatch = z.infer<typeof profilePatchSchema>;
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;
export type CampusSelection = z.infer<typeof campusSelectionSchema>;
export interface OwnProfile {
  readonly accountId: string;
  readonly nickname: string | null;
  readonly bio: string;
  readonly selectedCampus: Campus | null;
  readonly revision: number;
  readonly preferences: Preferences;
}
