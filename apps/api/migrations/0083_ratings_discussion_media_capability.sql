-- Independent discussion image capability; this migration does not activate
-- command4, Review7, Media7 or a context4 route. No production issuer is seeded.
-- All previous migration/codec/hash/receipt bytes remain unchanged.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_ratings.discussion_media_capability_epoch(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_ratings.discussion_media_capability_epoch VALUES(true,0);
CREATE FUNCTION whaleu_ratings.guard_discussion_media_capability_epoch_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Discussion capability epoch is owner derived' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE FUNCTION whaleu_ratings.guard_discussion_media_capability_epoch_row() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.singleton IS DISTINCT FROM OLD.singleton OR OLD.epoch=9223372036854775807 OR NEW.epoch IS DISTINCT FROM OLD.epoch+1
 THEN RAISE EXCEPTION 'Discussion capability epoch must advance exactly once' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_capability_epoch_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_capability_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.guard_discussion_media_capability_epoch_write();
CREATE TRIGGER discussion_capability_epoch_row BEFORE UPDATE ON whaleu_ratings.discussion_media_capability_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.guard_discussion_media_capability_epoch_row();

CREATE FUNCTION whaleu_ratings.advance_discussion_media_capability_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE whaleu_ratings.discussion_media_capability_epoch SET epoch=epoch+1 WHERE singleton AND epoch<9223372036854775807;
 IF NOT FOUND THEN RAISE EXCEPTION 'Discussion capability epoch unavailable' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE TABLE whaleu_ratings.discussion_media_capability_sources(
 id uuid PRIMARY KEY,
 protocol_version_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.scope_protocol_versions(id),
 generation uuid NOT NULL UNIQUE,
 source_id uuid NOT NULL,
 source_revision uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 command_version integer NOT NULL CHECK(command_version=4),
 context_version integer NOT NULL CHECK(context_version=4),
 review_version integer NOT NULL CHECK(review_version=7),
 media_version integer NOT NULL CHECK(media_version=7),
 journal_version integer NOT NULL CHECK(journal_version=12),
 root_limit integer NOT NULL CHECK(root_limit=9),
 reply_limit integer NOT NULL CHECK(reply_limit=3),
 pure_image boolean NOT NULL CHECK(pure_image),
 schema_digest text NOT NULL CHECK(schema_digest ~ '^[a-f0-9]{64}$'),
 routes_digest text NOT NULL CHECK(routes_digest ~ '^[a-f0-9]{64}$'),
 native_digest text NOT NULL CHECK(native_digest ~ '^[a-f0-9]{64}$'),
 compatibility_digest text NOT NULL CHECK(compatibility_digest ~ '^[a-f0-9]{64}$'),
 adoption_digest text NOT NULL CHECK(adoption_digest ~ '^[a-f0-9]{64}$'),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),
 provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 valid_from timestamptz NOT NULL,
 valid_until timestamptz NOT NULL,
 CHECK(isfinite(valid_from) AND isfinite(valid_until) AND valid_until>valid_from),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision)
);
CREATE FUNCTION whaleu_ratings.discussion_media_capability_current(capability uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.valid_from<=instant AND c.valid_until>instant
 AND v.phase='adopted' AND h.version_id=v.id
 AND (v.capability_source_id,v.capability_source_revision)=(c.source_id,c.source_revision)
 AND s.source_kind='scope_capabilities' AND s.digest=c.source_digest
 AND whaleu_ratings.scoped_source_current(s.id,s.revision,instant)
 AND c.compatibility_digest=whaleu_ratings.scoped_digest('discussion-media-compatibility',jsonb_build_object(
   'commandVersion',4,'contextVersion',4,'reviewVersion',7,'mediaVersion',7,'journalVersion',12,
   'rootLimit',9,'replyLimit',3,'pureImage',true,'sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,
   'schemaDigest',c.schema_digest,'routesDigest',c.routes_digest,'nativeDigest',c.native_digest))
 AND c.adoption_digest=whaleu_ratings.scoped_digest('discussion-media-adoption',jsonb_build_object(
   'protocolVersionId',v.id,'protocolGeneration',v.generation,'generation',c.generation,
   'releaseId',v.release_id,'manifest',v.manifest,'compatibilityDigest',c.compatibility_digest))
 FROM whaleu_ratings.discussion_media_capability_sources c
 JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id
 JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=v.logical_scope_key
 JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(c.source_id,c.source_revision)
 WHERE c.id=capability),false)
$$;
CREATE TRIGGER a00_discussion_capability_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
CREATE TRIGGER a01_discussion_capability_source_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scoped_source_epoch();
CREATE TRIGGER a02_discussion_capability_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_discussion_media_capability_epoch();
CREATE TRIGGER discussion_capability_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.discussion_media_capability_sources FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER discussion_capability_retain BEFORE TRUNCATE ON whaleu_ratings.discussion_media_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
