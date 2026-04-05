DROP TABLE IF EXISTS ah_counter_records_v2;

CREATE TABLE IF NOT EXISTS ah_counter_records_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  filler_word TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  sample_quote TEXT,
  related_item_key TEXT,
  observer_user_id UUID,
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'ah_counter',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT uq_ah_counter_records_v2 UNIQUE (meeting_id, participant_key, filler_word),
  CONSTRAINT fk_ah_counter_records_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT fk_ah_counter_records_v2_item
    FOREIGN KEY (meeting_id, related_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_ah_counter_records_v2_meeting_updated
  ON ah_counter_records_v2(meeting_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ah_counter_records_v2_meeting_participant_updated
  ON ah_counter_records_v2(meeting_id, participant_key, updated_at DESC);

ALTER TABLE ah_counter_records_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ah_counter_records_v2_select_live_mode ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_insert_live_mode ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_update_live_mode ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_delete_live_mode ON ah_counter_records_v2;

CREATE POLICY ah_counter_records_v2_select_live_mode ON ah_counter_records_v2
FOR SELECT
USING (true);

CREATE POLICY ah_counter_records_v2_insert_live_mode ON ah_counter_records_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY ah_counter_records_v2_update_live_mode ON ah_counter_records_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY ah_counter_records_v2_delete_live_mode ON ah_counter_records_v2
FOR DELETE
USING (true);

COMMENT ON TABLE ah_counter_records_v2 IS 'Ah-counter per-participant aggregate counts for one-tap officer tracking';
