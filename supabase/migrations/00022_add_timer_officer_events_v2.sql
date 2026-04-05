DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timer_officer_event_type') THEN
    CREATE TYPE timer_officer_event_type AS ENUM (
      'start_item',
      'pause_item',
      'adjust_time',
      'reset_item',
      'next_item',
      'prev_item',
      'jump_item',
      'complete_meeting'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS timer_officer_events_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key TEXT,
  participant_key TEXT,
  event_type timer_officer_event_type NOT NULL,
  current_phase agenda_live_phase NOT NULL DEFAULT 'other',
  remaining_seconds INTEGER,
  agenda_version BIGINT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  operator_user_id UUID,
  operator_name TEXT NOT NULL DEFAULT '未知用户',
  operator_name_source actor_name_source NOT NULL DEFAULT 'unknown',
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_timer_officer_events_v2_item
    FOREIGN KEY (meeting_id, item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key),
  CONSTRAINT fk_timer_officer_events_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key)
);

CREATE INDEX IF NOT EXISTS idx_timer_officer_events_v2_meeting_created
  ON timer_officer_events_v2(meeting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_timer_officer_events_v2_meeting_item_created
  ON timer_officer_events_v2(meeting_id, item_key, created_at DESC);

ALTER TABLE timer_officer_events_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timer_officer_events_v2_select_live_mode ON timer_officer_events_v2;
DROP POLICY IF EXISTS timer_officer_events_v2_insert_live_mode ON timer_officer_events_v2;
DROP POLICY IF EXISTS timer_officer_events_v2_update_live_mode ON timer_officer_events_v2;
DROP POLICY IF EXISTS timer_officer_events_v2_delete_live_mode ON timer_officer_events_v2;

CREATE POLICY timer_officer_events_v2_select_live_mode ON timer_officer_events_v2
FOR SELECT
USING (true);

CREATE POLICY timer_officer_events_v2_insert_live_mode ON timer_officer_events_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY timer_officer_events_v2_update_live_mode ON timer_officer_events_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY timer_officer_events_v2_delete_live_mode ON timer_officer_events_v2
FOR DELETE
USING (true);

COMMENT ON TABLE timer_officer_events_v2 IS 'Append-only timer officer actions for live flow replay and audit';
