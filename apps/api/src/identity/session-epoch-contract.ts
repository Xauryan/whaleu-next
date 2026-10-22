// Exact 0180 trigger bodies. Catalog qualification never executes a marker.
export const sessionEpochAccountBody =
  "BEGIN\n IF TG_OP='INSERT' THEN\n  IF NEW.session_revocation_epoch IS DISTINCT FROM 0::bigint THEN\n   RAISE EXCEPTION 'New accounts require the initial session epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';\n  END IF;\n ELSIF NEW.session_revocation_epoch IS DISTINCT FROM OLD.session_revocation_epoch THEN\n  RAISE EXCEPTION 'Real accepted deletion authority is not installed' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';\n END IF;\n RETURN NEW;\nEND";

export const sessionEpochIssuedBody =
  "DECLARE current_epoch bigint;BEGIN\n IF TG_OP='UPDATE' THEN\n  IF (NEW.id,NEW.account_id,NEW.issued_revocation_epoch) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.issued_revocation_epoch) THEN\n   RAISE EXCEPTION 'Session identity and issued epoch are immutable' USING ERRCODE='23514',CONSTRAINT='session_epoch_issued';\n  END IF;\n ELSE\n  SELECT session_revocation_epoch INTO current_epoch FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR SHARE NOWAIT;\n  IF current_epoch IS NULL OR NEW.issued_revocation_epoch IS DISTINCT FROM current_epoch THEN\n   RAISE EXCEPTION 'Session requires the exact current account epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_issued';\n  END IF;\n END IF;\n RETURN NEW;\nEND";

export const sessionEpochMarkerBody =
  'SELECT \'{"version":1,"protocol":"identity-session-revocation-epoch-v1","bumpAuthority":"unavailable"}\'::jsonb';
