-- Withdraw unsupported display values without publishing or inferring a replacement.
SET LOCAL lock_timeout='5s';
UPDATE whaleu_profile.details SET gender=NULL,show_gender=false,revision=revision+1,updated_at=clock_timestamp() WHERE gender='other' AND revision<2147483647;
-- Saturated revisions cannot be incremented; revoke the unsupported field anyway.
UPDATE whaleu_profile.details SET gender=NULL,show_gender=false,updated_at=clock_timestamp() WHERE gender='other';
ALTER TABLE whaleu_profile.details DROP CONSTRAINT details_gender_check;
ALTER TABLE whaleu_profile.details ADD CONSTRAINT details_gender_check CHECK(gender IN ('female','male'));
