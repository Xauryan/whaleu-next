-- Keep the complete original release budget and every proof/currentness call.
-- This sum needs UTF-8 length, not a hash: the existing C1 counter preserves
-- whole quoted JSONB tokens and removes only whitespace outside those tokens.
-- Object key sorting cannot change length. Do not replace any hash serializer.
SET LOCAL lock_timeout='5s';
DO $$DECLARE definition text;needle text;replacement text;original_oid oid;BEGIN
 original_oid:='whaleu_ratings.verify_scoped_release(uuid)'::regprocedure::oid;
 SELECT pg_get_functiondef(original_oid) INTO definition;
 needle:='octet_length(whaleu_ratings.creation_canonical_json(to_jsonb(x)))';
 replacement:='whaleu_ratings.category_icon_canonical_octets(to_jsonb(x))';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'Original whole-release canonical budget expression has changed';
 END IF;
 EXECUTE replace(definition,needle,replacement);
 IF 'whaleu_ratings.verify_scoped_release(uuid)'::regprocedure::oid<>original_oid THEN
  RAISE EXCEPTION 'Original whole-release verifier OID changed';
 END IF;
END$$;
