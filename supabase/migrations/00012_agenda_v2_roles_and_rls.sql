-- Agenda V2 roles, voting audit fields, and RLS policies

-- =========
-- Enums
-- =========
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meeting_role') THEN
    CREATE TYPE meeting_role AS ENUM (
      'timer_officer',
      'grammarian',
      'ah_counter',
      'voting_admin',
      'viewer'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'voting_admin_op_type') THEN
    CREATE TYPE voting_admin_op_type AS ENUM (
      'create_session',
      'close_session',
      'delete_session',
      'update_group',
      'update_candidate',
      'reorder_group',
      'reorder_candidate'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vote_trace_mode') THEN
    CREATE TYPE vote_trace_mode AS ENUM (
      'anonymous',
      'auditable_private',
      'named'
    );
  END IF;
END $$;

-- =========
-- New tables
-- =========
CREATE TABLE IF NOT EXISTS meeting_user_roles_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_identity_profiles(user_id),
  role meeting_role NOT NULL,
  assigned_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  assigned_at BIGINT NOT NULL,
  UNIQUE (meeting_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS voting_admin_ops_v2 (
  op_id UUID PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  voting_session_id TEXT REFERENCES voting_sessions(id) ON DELETE CASCADE,
  op_type voting_admin_op_type NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID NOT NULL REFERENCES user_identity_profiles(user_id),
  actor_name TEXT NOT NULL DEFAULT '未知用户',
  server_ts BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_user_roles_v2_meeting_user
  ON meeting_user_roles_v2(meeting_id, user_id);

CREATE INDEX IF NOT EXISTS idx_meeting_user_roles_v2_user
  ON meeting_user_roles_v2(user_id);

CREATE INDEX IF NOT EXISTS idx_voting_admin_ops_v2_meeting
  ON voting_admin_ops_v2(meeting_id, server_ts DESC);

-- =========
-- Voting schema extension
-- =========
ALTER TABLE voting_sessions
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_name TEXT,
  ADD COLUMN IF NOT EXISTS vote_trace_mode vote_trace_mode NOT NULL DEFAULT 'anonymous';

ALTER TABLE voting_groups
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id);

ALTER TABLE voting_candidates
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id);

ALTER TABLE votes
  ADD COLUMN IF NOT EXISTS voter_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS voter_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS voter_fingerprint_hash TEXT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

UPDATE voting_sessions
SET updated_at = created_at
WHERE updated_at IS NULL;

UPDATE votes
SET updated_at = created_at,
    voter_name_snapshot = COALESCE(voter_name_snapshot, voter_name)
WHERE updated_at IS NULL OR voter_name_snapshot IS NULL;

UPDATE votes
SET voter_fingerprint_hash = md5(voter_fingerprint)
WHERE voter_fingerprint_hash IS NULL
  AND voter_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votes_voter_user_id
  ON votes(voter_user_id)
  WHERE voter_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votes_voter_fingerprint_hash
  ON votes(voter_fingerprint_hash)
  WHERE voter_fingerprint_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_voting_sessions_trace_mode
  ON voting_sessions(meeting_id, vote_trace_mode);

-- =========
-- Helper functions
-- =========
CREATE OR REPLACE FUNCTION public.is_meeting_member_v2(target_meeting_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM meeting_user_roles_v2 mur
    WHERE mur.meeting_id = target_meeting_id
      AND mur.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.has_meeting_role_v2(target_meeting_id TEXT, allowed_roles meeting_role[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM meeting_user_roles_v2 mur
    WHERE mur.meeting_id = target_meeting_id
      AND mur.user_id = auth.uid()
      AND mur.role = ANY (allowed_roles)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_meeting_roles_v2(target_meeting_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    (
      auth.uid() IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM meeting_user_roles_v2 mur
        WHERE mur.meeting_id = target_meeting_id
      )
    )
    OR public.has_meeting_role_v2(
      target_meeting_id,
      ARRAY['timer_officer', 'voting_admin']::meeting_role[]
    )
  );
$$;

-- =========
-- Replace update_vote_atomic with trace-mode checks
-- =========
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

  -- 1. 原子性删除旧投票（非匿名模式优先按登录用户定位）
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

  -- 3. 返回结果
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =========
-- RLS enable
-- =========
ALTER TABLE meeting_user_roles_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE voting_admin_ops_v2 ENABLE ROW LEVEL SECURITY;

-- =========
-- RLS policies: identity + meeting roles
-- =========
DROP POLICY IF EXISTS uip_select_self ON user_identity_profiles;
DROP POLICY IF EXISTS uip_insert_self ON user_identity_profiles;
DROP POLICY IF EXISTS uip_update_self ON user_identity_profiles;

CREATE POLICY uip_select_self ON user_identity_profiles
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY uip_insert_self ON user_identity_profiles
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY uip_update_self ON user_identity_profiles
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS mur_select_member ON meeting_user_roles_v2;
DROP POLICY IF EXISTS mur_insert_manager ON meeting_user_roles_v2;
DROP POLICY IF EXISTS mur_update_manager ON meeting_user_roles_v2;
DROP POLICY IF EXISTS mur_delete_manager ON meeting_user_roles_v2;

CREATE POLICY mur_select_member ON meeting_user_roles_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY mur_insert_manager ON meeting_user_roles_v2
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY mur_update_manager ON meeting_user_roles_v2
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY mur_delete_manager ON meeting_user_roles_v2
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

-- =========
-- RLS policies: agenda v2 tables
-- =========
DROP POLICY IF EXISTS agenda_items_v2_select_member ON agenda_items_v2;
DROP POLICY IF EXISTS agenda_items_v2_insert_timer ON agenda_items_v2;
DROP POLICY IF EXISTS agenda_items_v2_update_timer ON agenda_items_v2;
DROP POLICY IF EXISTS agenda_items_v2_delete_timer ON agenda_items_v2;

CREATE POLICY agenda_items_v2_select_member ON agenda_items_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY agenda_items_v2_insert_timer ON agenda_items_v2
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY agenda_items_v2_update_timer ON agenda_items_v2
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY agenda_items_v2_delete_timer ON agenda_items_v2
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

DROP POLICY IF EXISTS meeting_participants_v2_select_member ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_insert_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_update_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_delete_timer ON meeting_participants_v2;

CREATE POLICY meeting_participants_v2_select_member ON meeting_participants_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY meeting_participants_v2_insert_timer ON meeting_participants_v2
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY meeting_participants_v2_update_timer ON meeting_participants_v2
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY meeting_participants_v2_delete_timer ON meeting_participants_v2
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

DROP POLICY IF EXISTS live_cursor_v2_select_member ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_upsert_timer ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_update_timer ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_delete_timer ON meeting_live_cursor_v2;

CREATE POLICY live_cursor_v2_select_member ON meeting_live_cursor_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY live_cursor_v2_upsert_timer ON meeting_live_cursor_v2
FOR INSERT
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
);

CREATE POLICY live_cursor_v2_update_timer ON meeting_live_cursor_v2
FOR UPDATE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
)
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
);

CREATE POLICY live_cursor_v2_delete_timer ON meeting_live_cursor_v2
FOR DELETE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
);

DROP POLICY IF EXISTS agenda_ops_v2_select_member ON agenda_ops_v2;
DROP POLICY IF EXISTS agenda_ops_v2_insert_writer ON agenda_ops_v2;

CREATE POLICY agenda_ops_v2_select_member ON agenda_ops_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY agenda_ops_v2_insert_writer ON agenda_ops_v2
FOR INSERT
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
);

DROP POLICY IF EXISTS grammarian_notes_v2_select_member ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_insert_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_update_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_delete_writer ON grammarian_notes_v2;

CREATE POLICY grammarian_notes_v2_select_member ON grammarian_notes_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY grammarian_notes_v2_insert_writer ON grammarian_notes_v2
FOR INSERT
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    public.has_meeting_role_v2(meeting_id, ARRAY['grammarian']::meeting_role[])
    AND (observer_user_id IS NULL OR observer_user_id = auth.uid())
  )
);

CREATE POLICY grammarian_notes_v2_update_writer ON grammarian_notes_v2
FOR UPDATE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['grammarian']::meeting_role[])
  )
)
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['grammarian']::meeting_role[])
  )
);

CREATE POLICY grammarian_notes_v2_delete_writer ON grammarian_notes_v2
FOR DELETE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['grammarian']::meeting_role[])
  )
);

DROP POLICY IF EXISTS ah_counter_records_v2_select_member ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_insert_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_update_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_delete_writer ON ah_counter_records_v2;

CREATE POLICY ah_counter_records_v2_select_member ON ah_counter_records_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY ah_counter_records_v2_insert_writer ON ah_counter_records_v2
FOR INSERT
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    public.has_meeting_role_v2(meeting_id, ARRAY['ah_counter']::meeting_role[])
    AND (observer_user_id IS NULL OR observer_user_id = auth.uid())
  )
);

CREATE POLICY ah_counter_records_v2_update_writer ON ah_counter_records_v2
FOR UPDATE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['ah_counter']::meeting_role[])
  )
)
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['ah_counter']::meeting_role[])
  )
);

CREATE POLICY ah_counter_records_v2_delete_writer ON ah_counter_records_v2
FOR DELETE
USING (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
  OR (
    observer_user_id = auth.uid()
    AND public.has_meeting_role_v2(meeting_id, ARRAY['ah_counter']::meeting_role[])
  )
);

DROP POLICY IF EXISTS voting_admin_ops_v2_select_member ON voting_admin_ops_v2;
DROP POLICY IF EXISTS voting_admin_ops_v2_insert_admin ON voting_admin_ops_v2;

CREATE POLICY voting_admin_ops_v2_select_member ON voting_admin_ops_v2
FOR SELECT
USING (public.is_meeting_member_v2(meeting_id));

CREATE POLICY voting_admin_ops_v2_insert_admin ON voting_admin_ops_v2
FOR INSERT
WITH CHECK (
  public.has_meeting_role_v2(
    meeting_id,
    ARRAY['timer_officer', 'voting_admin']::meeting_role[]
  )
);

-- =========
-- Replace old voting policies
-- =========
DROP POLICY IF EXISTS "Anyone can read voting sessions" ON voting_sessions;
DROP POLICY IF EXISTS "Anyone can create voting sessions" ON voting_sessions;
DROP POLICY IF EXISTS "Anyone can update voting sessions" ON voting_sessions;
DROP POLICY IF EXISTS "Anyone can delete voting sessions" ON voting_sessions;

DROP POLICY IF EXISTS "Anyone can read voting groups" ON voting_groups;
DROP POLICY IF EXISTS "Anyone can create voting groups" ON voting_groups;

DROP POLICY IF EXISTS "Anyone can read voting candidates" ON voting_candidates;
DROP POLICY IF EXISTS "Anyone can create voting candidates" ON voting_candidates;

DROP POLICY IF EXISTS "Anyone can insert votes" ON votes;
DROP POLICY IF EXISTS "Anyone can read votes" ON votes;

DROP POLICY IF EXISTS voting_sessions_select_public ON voting_sessions;
DROP POLICY IF EXISTS voting_sessions_insert_admin ON voting_sessions;
DROP POLICY IF EXISTS voting_sessions_update_admin ON voting_sessions;
DROP POLICY IF EXISTS voting_sessions_delete_admin ON voting_sessions;

CREATE POLICY voting_sessions_select_public ON voting_sessions
FOR SELECT
USING (true);

CREATE POLICY voting_sessions_insert_admin ON voting_sessions
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_sessions_update_admin ON voting_sessions
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_sessions_delete_admin ON voting_sessions
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

DROP POLICY IF EXISTS voting_groups_select_public ON voting_groups;
DROP POLICY IF EXISTS voting_groups_insert_admin ON voting_groups;
DROP POLICY IF EXISTS voting_groups_update_admin ON voting_groups;
DROP POLICY IF EXISTS voting_groups_delete_admin ON voting_groups;

CREATE POLICY voting_groups_select_public ON voting_groups
FOR SELECT
USING (true);

CREATE POLICY voting_groups_insert_admin ON voting_groups
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_groups_update_admin ON voting_groups
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_groups_delete_admin ON voting_groups
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

DROP POLICY IF EXISTS voting_candidates_select_public ON voting_candidates;
DROP POLICY IF EXISTS voting_candidates_insert_admin ON voting_candidates;
DROP POLICY IF EXISTS voting_candidates_update_admin ON voting_candidates;
DROP POLICY IF EXISTS voting_candidates_delete_admin ON voting_candidates;

CREATE POLICY voting_candidates_select_public ON voting_candidates
FOR SELECT
USING (true);

CREATE POLICY voting_candidates_insert_admin ON voting_candidates
FOR INSERT
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_candidates_update_admin ON voting_candidates
FOR UPDATE
USING (public.can_manage_meeting_roles_v2(meeting_id))
WITH CHECK (public.can_manage_meeting_roles_v2(meeting_id));

CREATE POLICY voting_candidates_delete_admin ON voting_candidates
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

DROP POLICY IF EXISTS votes_select_public ON votes;
DROP POLICY IF EXISTS votes_insert_by_mode ON votes;

CREATE POLICY votes_select_public ON votes
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM voting_sessions vs
    WHERE vs.id = votes.voting_session_id
      AND vs.meeting_id = votes.meeting_id
      AND (
        vs.vote_trace_mode = 'anonymous'
        OR (
          vs.vote_trace_mode = 'named'
          AND public.is_meeting_member_v2(vs.meeting_id)
        )
        OR (
          vs.vote_trace_mode = 'auditable_private'
          AND public.has_meeting_role_v2(
            vs.meeting_id,
            ARRAY['timer_officer', 'voting_admin']::meeting_role[]
          )
        )
      )
  )
);

CREATE POLICY votes_insert_by_mode ON votes
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM voting_sessions vs
    WHERE vs.id = votes.voting_session_id
      AND vs.meeting_id = votes.meeting_id
      AND vs.status = 'active'
      AND (
        vs.vote_trace_mode = 'anonymous'
        OR (
          auth.uid() IS NOT NULL
          AND votes.voter_user_id = auth.uid()
        )
      )
  )
  AND (
    votes.voter_user_id IS NULL
    OR votes.voter_user_id = auth.uid()
  )
);

COMMENT ON TABLE meeting_user_roles_v2 IS 'Meeting role assignments for Agenda V2 and voting control';
COMMENT ON TABLE voting_admin_ops_v2 IS 'Voting admin operation audit log';
COMMENT ON COLUMN voting_sessions.vote_trace_mode IS 'anonymous/auditable_private/named';
