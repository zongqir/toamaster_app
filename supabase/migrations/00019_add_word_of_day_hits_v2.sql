CREATE TABLE IF NOT EXISTS word_of_day_hits_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  word_text TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  related_item_key TEXT,
  observer_user_id UUID,
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'grammarian',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT uq_word_of_day_hits_v2 UNIQUE (meeting_id, participant_key, word_text),
  CONSTRAINT fk_word_of_day_hits_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT fk_word_of_day_hits_v2_item
    FOREIGN KEY (meeting_id, related_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_word_of_day_hits_v2_meeting_created
  ON word_of_day_hits_v2(meeting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_word_of_day_hits_v2_meeting_participant_created
  ON word_of_day_hits_v2(meeting_id, participant_key, created_at DESC);

ALTER TABLE word_of_day_hits_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS word_of_day_hits_v2_select_live_mode ON word_of_day_hits_v2;
DROP POLICY IF EXISTS word_of_day_hits_v2_insert_live_mode ON word_of_day_hits_v2;
DROP POLICY IF EXISTS word_of_day_hits_v2_update_live_mode ON word_of_day_hits_v2;
DROP POLICY IF EXISTS word_of_day_hits_v2_delete_live_mode ON word_of_day_hits_v2;

CREATE POLICY word_of_day_hits_v2_select_live_mode ON word_of_day_hits_v2
FOR SELECT
USING (true);

CREATE POLICY word_of_day_hits_v2_insert_live_mode ON word_of_day_hits_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY word_of_day_hits_v2_update_live_mode ON word_of_day_hits_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY word_of_day_hits_v2_delete_live_mode ON word_of_day_hits_v2
FOR DELETE
USING (true);

COMMENT ON TABLE word_of_day_hits_v2 IS 'Word-of-the-day per-participant aggregate counts for grammarian tracking';
