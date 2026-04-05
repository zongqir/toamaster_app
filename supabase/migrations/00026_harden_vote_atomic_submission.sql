-- Harden vote submission/update against concurrent requests and invalid payloads.

CREATE OR REPLACE FUNCTION persist_vote_atomic(
  p_voting_session_id TEXT,
  p_voter_fingerprint TEXT,
  p_meeting_id TEXT,
  p_votes JSONB,
  p_allow_replace BOOLEAN DEFAULT true
) RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_deleted_count INTEGER := 0;
  v_inserted_count INTEGER := 0;
  v_trace_mode vote_trace_mode;
  v_status TEXT;
  v_auth_user_id UUID;
  v_existing_vote_count INTEGER := 0;
  v_identity_key TEXT;
  v_invalid_group_count INTEGER := 0;
  v_invalid_candidate_count INTEGER := 0;
  v_exceed_group_count INTEGER := 0;
  v_duplicate_candidate_count INTEGER := 0;
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

  IF p_votes IS NULL OR jsonb_typeof(p_votes) <> 'array' OR jsonb_array_length(p_votes) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'EMPTY_SELECTIONS'
    );
  END IF;

  v_identity_key := CASE
    WHEN v_trace_mode = 'anonymous' THEN p_voter_fingerprint
    WHEN v_auth_user_id IS NOT NULL THEN v_auth_user_id::TEXT
    ELSE p_voter_fingerprint
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_voting_session_id || ':' || v_identity_key, 0));

  WITH input_votes AS (
    SELECT
      value->>'id' AS id,
      value->>'voting_group_id' AS voting_group_id,
      value->>'candidate_id' AS candidate_id,
      value->>'voter_name_snapshot' AS voter_name_snapshot,
      COALESCE((value->>'created_at')::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000) AS created_at
    FROM jsonb_array_elements(p_votes)
  )
  SELECT COUNT(*)
  INTO v_invalid_group_count
  FROM input_votes iv
  LEFT JOIN voting_groups vg
    ON vg.id = iv.voting_group_id
   AND vg.voting_session_id = p_voting_session_id
   AND vg.meeting_id = p_meeting_id
  WHERE vg.id IS NULL;

  IF v_invalid_group_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_VOTING_GROUP'
    );
  END IF;

  WITH input_votes AS (
    SELECT
      value->>'voting_group_id' AS voting_group_id,
      value->>'candidate_id' AS candidate_id
    FROM jsonb_array_elements(p_votes)
  )
  SELECT COUNT(*)
  INTO v_invalid_candidate_count
  FROM input_votes iv
  LEFT JOIN voting_candidates vc
    ON vc.id = iv.candidate_id
   AND vc.voting_group_id = iv.voting_group_id
   AND vc.meeting_id = p_meeting_id
  WHERE vc.id IS NULL;

  IF v_invalid_candidate_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_CANDIDATE_GROUP_RELATION'
    );
  END IF;

  WITH input_votes AS (
    SELECT
      value->>'voting_group_id' AS voting_group_id,
      value->>'candidate_id' AS candidate_id
    FROM jsonb_array_elements(p_votes)
  ),
  grouped_votes AS (
    SELECT voting_group_id, candidate_id, COUNT(*) AS candidate_repeat_count
    FROM input_votes
    GROUP BY voting_group_id, candidate_id
  )
  SELECT COUNT(*)
  INTO v_duplicate_candidate_count
  FROM grouped_votes
  WHERE candidate_repeat_count > 1;

  IF v_duplicate_candidate_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DUPLICATE_CANDIDATE_SELECTION'
    );
  END IF;

  WITH input_votes AS (
    SELECT
      value->>'voting_group_id' AS voting_group_id,
      value->>'candidate_id' AS candidate_id
    FROM jsonb_array_elements(p_votes)
  ),
  grouped_votes AS (
    SELECT voting_group_id, COUNT(DISTINCT candidate_id) AS selected_count
    FROM input_votes
    GROUP BY voting_group_id
  )
  SELECT COUNT(*)
  INTO v_exceed_group_count
  FROM grouped_votes gv
  JOIN voting_groups vg
    ON vg.id = gv.voting_group_id
   AND vg.voting_session_id = p_voting_session_id
   AND vg.meeting_id = p_meeting_id
  WHERE gv.selected_count > vg.max_selections;

  IF v_exceed_group_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'MAX_SELECTIONS_EXCEEDED'
    );
  END IF;

  IF v_trace_mode = 'anonymous' THEN
    SELECT COUNT(*)
    INTO v_existing_vote_count
    FROM votes
    WHERE voting_session_id = p_voting_session_id
      AND voter_fingerprint = p_voter_fingerprint;
  ELSE
    SELECT COUNT(*)
    INTO v_existing_vote_count
    FROM votes
    WHERE voting_session_id = p_voting_session_id
      AND (
        voter_user_id = v_auth_user_id
        OR voter_fingerprint = p_voter_fingerprint
      );
  END IF;

  IF v_existing_vote_count > 0 AND NOT p_allow_replace THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ALREADY_SUBMITTED'
    );
  END IF;

  IF v_existing_vote_count > 0 THEN
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
  END IF;

  WITH input_votes AS (
    SELECT
      value->>'id' AS id,
      value->>'voting_group_id' AS voting_group_id,
      value->>'candidate_id' AS candidate_id,
      value->>'voter_name_snapshot' AS voter_name_snapshot,
      COALESCE((value->>'created_at')::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000) AS created_at
    FROM jsonb_array_elements(p_votes)
  )
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
  )
  SELECT
    iv.id,
    p_voting_session_id,
    iv.voting_group_id,
    iv.candidate_id,
    p_meeting_id,
    CASE
      WHEN v_trace_mode = 'named' THEN COALESCE(NULLIF(iv.voter_name_snapshot, ''), '微信用户')
      ELSE '匿名'
    END,
    p_voter_fingerprint,
    CASE WHEN v_trace_mode = 'anonymous' THEN NULL ELSE v_auth_user_id END,
    CASE
      WHEN v_trace_mode = 'named' THEN COALESCE(NULLIF(iv.voter_name_snapshot, ''), '微信用户')
      ELSE '匿名'
    END,
    md5(p_voter_fingerprint),
    iv.created_at,
    EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
  FROM input_votes iv;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  v_result := jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'inserted_count', v_inserted_count,
    'replaced_existing', v_existing_vote_count > 0
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
