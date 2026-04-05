-- Replace update_vote_atomic with trace-mode aware checks.

CREATE OR REPLACE FUNCTION update_vote_atomic(
  p_voting_session_id TEXT,
  p_voter_fingerprint TEXT,
  p_meeting_id TEXT,
  p_votes JSONB
) RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_vote JSONB;
  v_deleted_count INTEGER;
  v_inserted_count INTEGER := 0;
  v_trace_mode vote_trace_mode;
  v_status TEXT;
  v_auth_user_id UUID;
BEGIN
  v_auth_user_id := auth.uid();

  SELECT vote_trace_mode, status
  INTO v_trace_mode, v_status
  FROM voting_sessions
  WHERE id = p_voting_session_id
    AND meeting_id = p_meeting_id
  LIMIT 1;

  IF v_trace_mode IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VOTING_SESSION_NOT_FOUND'
    );
  END IF;

  IF v_status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VOTING_SESSION_CLOSED'
    );
  END IF;

  IF v_trace_mode <> 'anonymous' AND v_auth_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'AUTH_REQUIRED_FOR_TRACE_MODE'
    );
  END IF;

  IF v_trace_mode = 'anonymous' THEN
    DELETE FROM votes
    WHERE voting_session_id = p_voting_session_id
      AND voter_fingerprint = p_voter_fingerprint;
  ELSE
    DELETE FROM votes
    WHERE voting_session_id = p_voting_session_id
      AND (
        voter_user_id = v_auth_user_id
        OR voter_fingerprint = p_voter_fingerprint
      );
  END IF;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  FOR v_vote IN SELECT * FROM jsonb_array_elements(p_votes)
  LOOP
    INSERT INTO votes (
      id,
      voting_session_id,
      voting_group_id,
      candidate_id,
      meeting_id,
      voter_name,
      voter_fingerprint,
      voter_user_id,
      voter_name_snapshot,
      voter_fingerprint_hash,
      created_at,
      updated_at
    ) VALUES (
      v_vote->>'id',
      p_voting_session_id,
      v_vote->>'voting_group_id',
      v_vote->>'candidate_id',
      p_meeting_id,
      '匿名',
      p_voter_fingerprint,
      CASE WHEN v_trace_mode = 'anonymous' THEN NULL ELSE v_auth_user_id END,
      CASE WHEN v_trace_mode = 'named' THEN COALESCE(v_vote->>'voter_name_snapshot', '匿名') ELSE '匿名' END,
      md5(p_voter_fingerprint),
      COALESCE((v_vote->>'created_at')::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
      EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    );

    v_inserted_count := v_inserted_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'inserted_count', v_inserted_count
  );

  RETURN v_result;
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
