import { z } from 'zod';
export const profileDetailsFields = {
  region: z
    .string()
    .trim()
    .max(80)
    .refine((value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    )
    .transform((value) => value || null)
    .nullable(),
  gender: z.enum(['female', 'male']).nullable(),
  age: z.number().int().min(0).max(120).nullable(),
  showRegion: z.boolean(),
  showGender: z.boolean(),
  showAge: z.boolean(),
};
export const profileDetailsPatchSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2147483646),
  ...profileDetailsFields,
});
export type ProfileDetailsPatch = z.infer<typeof profileDetailsPatchSchema>;
export interface ProfileDetails {
  accountId: string;
  revision: number;
  region: string | null;
  gender: 'female' | 'male' | null;
  age: number | null;
  showRegion: boolean;
  showGender: boolean;
  showAge: boolean;
}
export type PublicProfileDetails =
  | { status: 'unavailable'; profileId: string }
  | {
      status: 'available';
      profileId: string;
      region: string | null;
      gender: ProfileDetails['gender'];
      age: number | null;
    };
export function emptyProfileDetails(accountId: string): ProfileDetails {
  return {
    accountId,
    revision: 0,
    region: null,
    gender: null,
    age: null,
    showRegion: false,
    showGender: false,
    showAge: false,
  };
}
export function publicProfileDetails(
  profileId: string,
  details: ProfileDetails,
): PublicProfileDetails {
  return {
    status: 'available',
    profileId,
    region: details.showRegion ? details.region : null,
    gender: details.showGender ? details.gender : null,
    age: details.showAge ? details.age : null,
  };
}
