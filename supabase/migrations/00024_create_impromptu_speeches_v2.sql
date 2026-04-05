CREATE TABLE IF NOT EXISTS impromptu_speeches_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_item_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  speaker_name TEXT NOT NULL,
  speaker_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pool_duration_seconds INTEGER NOT NULL DEFAULT 1500,
  pool_remaining_seconds_at_start INTEGER,
  started_with_low_remaining BOOLEAN NOT NULL DEFAULT false,
  speech_planned_duration_seconds INTEGER NOT NULL DEFAULT 120,
  speech_started_at BIGINT,
  speech_ended_at BIGINT,
  speech_duration_seconds INTEGER,
  is_overtime BOOLEAN,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT fk_impromptu_speeches_v2_agenda_item
    FOREIGN KEY (meeting_id, agenda_item_id)
    REFERENCES agenda_items_v2(meeting_id, item_key)
    ON DELETE CASCADE,
  CONSTRAINT fk_impromptu_speeches_v2_participant
    FOREIGN KEY (meeting_id, speaker_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT chk_impromptu_speeches_v2_status
    CHECK (status IN ('pending', 'speaking', 'completed', 'cancelled')),
  CONSTRAINT chk_impromptu_speeches_v2_pool_duration
    CHECK (pool_duration_seconds > 0),
  CONSTRAINT chk_impromptu_speeches_v2_speech_planned_duration
    CHECK (speech_planned_duration_seconds > 0),
  CONSTRAINT chk_impromptu_speeches_v2_duration_non_negative
    CHECK (speech_duration_seconds IS NULL OR speech_duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_impromptu_speeches_v2_meeting_agenda_sort
  ON impromptu_speeches_v2(meeting_id, agenda_item_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_impromptu_speeches_v2_meeting_status
  ON impromptu_speeches_v2(meeting_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_impromptu_speeches_v2_single_active
  ON impromptu_speeches_v2(meeting_id, agenda_item_id)
  WHERE deleted_at IS NULL AND status IN ('pending', 'speaking');

ALTER TABLE impromptu_speeches_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impromptu_speeches_v2_select_live_mode ON impromptu_speeches_v2;
DROP POLICY IF EXISTS impromptu_speeches_v2_insert_live_mode ON impromptu_speeches_v2;
DROP POLICY IF EXISTS impromptu_speeches_v2_update_live_mode ON impromptu_speeches_v2;
DROP POLICY IF EXISTS impromptu_speeches_v2_delete_live_mode ON impromptu_speeches_v2;

CREATE POLICY impromptu_speeches_v2_select_live_mode ON impromptu_speeches_v2
FOR SELECT
USING (true);

CREATE POLICY impromptu_speeches_v2_insert_live_mode ON impromptu_speeches_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY impromptu_speeches_v2_update_live_mode ON impromptu_speeches_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY impromptu_speeches_v2_delete_live_mode ON impromptu_speeches_v2
FOR DELETE
USING (true);

COMMENT ON TABLE impromptu_speeches_v2 IS 'Live impromptu speech records tracked under one agenda item pool';
