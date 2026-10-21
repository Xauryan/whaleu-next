export type ProfileSocialCount =
  { status: 'known'; value: number } | { status: 'unavailable'; value: null };
export interface OwnProfileStats {
  accountId: string;
  following: ProfileSocialCount;
  followers: ProfileSocialCount;
  receivedInteractions: { status: 'unavailable'; value: null };
}
export const unavailableSocialCount = (): {
  status: 'unavailable';
  value: null;
} => ({ status: 'unavailable', value: null });
export const unavailableProfileStats = (
  accountId: string,
): OwnProfileStats => ({
  accountId,
  following: unavailableSocialCount(),
  followers: unavailableSocialCount(),
  receivedInteractions: unavailableSocialCount(),
});
