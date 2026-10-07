-- Empty new-target business schemas. No legacy records are imported or seeded here.
CREATE SCHEMA whaleu_campus;
CREATE SCHEMA whaleu_profile;

CREATE TABLE whaleu_campus.institutions (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE TABLE whaleu_campus.campuses (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  short_name text CHECK (char_length(short_name) BETWEEN 1 AND 100),
  district text NOT NULL CHECK (char_length(district) BETWEEN 1 AND 100),
  is_active boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX campuses_directory ON whaleu_campus.campuses(is_active DESC, sort_order DESC, id);
CREATE INDEX campuses_institution ON whaleu_campus.campuses(institution_id);
CREATE INDEX campuses_district ON whaleu_campus.campuses(district);

-- Identity owns account lifecycle. Its stable account UUID is the only dependency.
-- Selection is a browsing context, never proof of institution membership or admin scope.
CREATE TABLE whaleu_profile.profiles (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
  nickname text CHECK (char_length(nickname) BETWEEN 1 AND 20 AND nickname ~ '^[一-龥a-zA-Z0-9_#&@.+-]+$'),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 100 AND char_length(bio) - char_length(replace(bio, E'\n', '')) <= 5),
  selected_campus_id uuid REFERENCES whaleu_campus.campuses(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  preferences jsonb NOT NULL DEFAULT '{"showOfficialAccountTip":true,"showHotTopic":true,"showGroupNotice":true,"showTradingGroupNotice":true,"showErrandGroupNotice":true,"defaultAnonymousEnabled":false,"defaultCommentAnonymousEnabled":false,"defaultCommentNonAnonymousEnabled":false,"defaultAllowAnonymousDm":false,"hideProfilePosts":false,"activitySubscribed":true}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(preferences) = 'object'),
  CHECK (preferences ?& ARRAY['showOfficialAccountTip','showHotTopic','showGroupNotice','showTradingGroupNotice','showErrandGroupNotice','defaultAnonymousEnabled','defaultCommentAnonymousEnabled','defaultCommentNonAnonymousEnabled','defaultAllowAnonymousDm','hideProfilePosts','activitySubscribed']),
  CHECK (preferences - ARRAY['showOfficialAccountTip','showHotTopic','showGroupNotice','showTradingGroupNotice','showErrandGroupNotice','defaultAnonymousEnabled','defaultCommentAnonymousEnabled','defaultCommentNonAnonymousEnabled','defaultAllowAnonymousDm','hideProfilePosts','activitySubscribed'] = '{}'::jsonb),
  CHECK (jsonb_typeof(preferences->'showOfficialAccountTip') = 'boolean'
    AND jsonb_typeof(preferences->'showHotTopic') = 'boolean'
    AND jsonb_typeof(preferences->'showGroupNotice') = 'boolean'
    AND jsonb_typeof(preferences->'showTradingGroupNotice') = 'boolean'
    AND jsonb_typeof(preferences->'showErrandGroupNotice') = 'boolean'
    AND jsonb_typeof(preferences->'defaultAnonymousEnabled') = 'boolean'
    AND jsonb_typeof(preferences->'defaultCommentAnonymousEnabled') = 'boolean'
    AND jsonb_typeof(preferences->'defaultCommentNonAnonymousEnabled') = 'boolean'
    AND jsonb_typeof(preferences->'defaultAllowAnonymousDm') = 'boolean'
    AND jsonb_typeof(preferences->'hideProfilePosts') = 'boolean'
    AND jsonb_typeof(preferences->'activitySubscribed') = 'boolean'),
  CHECK (NOT (preferences @> '{"defaultCommentAnonymousEnabled":true,"defaultCommentNonAnonymousEnabled":true}'::jsonb))
);
CREATE INDEX profiles_selected_campus ON whaleu_profile.profiles(selected_campus_id);
