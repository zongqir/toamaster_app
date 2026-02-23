-- 创建原子性更新投票的RPC函数
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
BEGIN
  -- 1. 原子性删除旧投票
  DELETE FROM votes 
  WHERE voting_session_id = p_voting_session_id 
    AND voter_fingerprint = p_voter_fingerprint;
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  -- 2. 批量插入新投票
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
      created_at
    ) VALUES (
      v_vote->>'id',
      p_voting_session_id,
      v_vote->>'voting_group_id',
      v_vote->>'candidate_id',
      p_meeting_id,
      '匿名',
      p_voter_fingerprint,
      (v_vote->>'created_at')::BIGINT
    );
  END LOOP;
  
  -- 3. 返回结果
  v_result := jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'inserted_count', jsonb_array_length(p_votes)
  );
  
  RETURN v_result;
EXCEPTION
  WHEN OTHERS THEN
    -- 发生错误时回滚
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;