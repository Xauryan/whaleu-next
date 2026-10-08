/** Public cosmetics only. Availability is independent for each dimension. */
export interface PublicExperienceTitle {
  key: string;
  name: string;
}
export type PublicNullable<T> =
  { status: 'known'; value: T | null } | { status: 'unavailable'; value: null };
export interface PublicExperienceDisplay {
  title: PublicNullable<PublicExperienceTitle>;
  color: PublicNullable<number>;
  level:
    { status: 'known'; value: number } | { status: 'unavailable'; value: null };
}
