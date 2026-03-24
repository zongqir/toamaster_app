-- Live mode: relax officer-related RLS to reduce on-site setup friction.
-- Goal: authenticated users can read/write officer records without pre-assigning meeting roles.

-- =========
-- meeting_participants_v2
-- =========
DROP POLICY IF EXISTS meeting_participants_v2_select_member ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_insert_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_update_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_delete_timer ON meeting_participants_v2;

CREATE POLICY meeting_participants_v2_select_authenticated ON meeting_participants_v2
FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY meeting_participants_v2_insert_authenticated ON meeting_participants_v2
FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY meeting_participants_v2_update_authenticated ON meeting_participants_v2
FOR UPDATE
USING (auth.uid() IS NOT NULL)
WITH CHECK (auth.uid() IS NOT NULL);

-- Keep delete stricter than insert/update to reduce accidental mass cleanup.
CREATE POLICY meeting_participants_v2_delete_manager ON meeting_participants_v2
FOR DELETE
USING (public.can_manage_meeting_roles_v2(meeting_id));

-- =========
-- meeting_live_cursor_v2 (read relaxed, write still timer/admin controlled)
-- =========
DROP POLICY IF EXISTS live_cursor_v2_select_member ON meeting_live_cursor_v2;

CREATE POLICY live_cursor_v2_select_authenticated ON meeting_live_cursor_v2
FOR SELECT
USING (auth.uid() IS NOT NULL);

-- =========
-- grammarian_notes_v2
-- =========
DROP POLICY IF EXISTS grammarian_notes_v2_select_member ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_insert_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_update_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_delete_writer ON grammarian_notes_v2;

CREATE POLICY grammarian_notes_v2_select_authenticated ON grammarian_notes_v2
FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY grammarian_notes_v2_insert_authenticated ON grammarian_notes_v2
FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (observer_user_id IS NULL OR observer_user_id = auth.uid())
);

CREATE POLICY grammarian_notes_v2_update_owner ON grammarian_notes_v2
FOR UPDATE
USING (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()))
WITH CHECK (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()));

CREATE POLICY grammarian_notes_v2_delete_owner ON grammarian_notes_v2
FOR DELETE
USING (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()));

-- =========
-- ah_counter_records_v2
-- =========
DROP POLICY IF EXISTS ah_counter_records_v2_select_member ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_insert_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_update_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_delete_writer ON ah_counter_records_v2;

CREATE POLICY ah_counter_records_v2_select_authenticated ON ah_counter_records_v2
FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY ah_counter_records_v2_insert_authenticated ON ah_counter_records_v2
FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (observer_user_id IS NULL OR observer_user_id = auth.uid())
);

CREATE POLICY ah_counter_records_v2_update_owner ON ah_counter_records_v2
FOR UPDATE
USING (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()))
WITH CHECK (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()));

CREATE POLICY ah_counter_records_v2_delete_owner ON ah_counter_records_v2
FOR DELETE
USING (auth.uid() IS NOT NULL AND (observer_user_id IS NULL OR observer_user_id = auth.uid()));
