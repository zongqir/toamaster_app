-- Agenda V2 core schema

-- =========
-- Enums
-- =========
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_status_code') THEN
    CREATE TYPE agenda_status_code AS ENUM (
      'initial',
      'qualified',
      'warning',
      'overtime',
      'severe_overtime'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_status_color') THEN
    CREATE TYPE agenda_status_color AS ENUM (
      'blue',
      'green',
      'yellow',
      'red',
      'red_soft',
      'purple'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_rule_profile') THEN
    CREATE TYPE agenda_rule_profile AS ENUM ('gt5m', 'lte5m');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_node_kind') THEN
    CREATE TYPE agenda_node_kind AS ENUM ('segment', 'leaf');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_budget_mode') THEN
    CREATE TYPE agenda_budget_mode AS ENUM ('independent', 'hard_cap');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_speaker_role') THEN
    CREATE TYPE agenda_speaker_role AS ENUM ('host', 'speaker', 'guest', 'other');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_op_type') THEN
    CREATE TYPE agenda_op_type AS ENUM (
      'create_item',
      'update_item',
      'delete_item',
      'move_item',
      'timer_checkpoint',
      'status_change'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_op_apply_status') THEN
    CREATE TYPE agenda_op_apply_status AS ENUM (
      'applied',
      'conflict',
      'rejected',
      'replayed'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agenda_live_phase') THEN
    CREATE TYPE agenda_live_phase AS ENUM (
      'host_opening',
      'prep',
      'speech',
      'host_bridge',
      'host_closing',
      'other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_name_source') THEN
    CREATE TYPE actor_name_source AS ENUM (
      'wechat_profile',
      'manual_input',
      'unknown'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'observer_role') THEN
    CREATE TYPE observer_role AS ENUM (
      'timer_officer',
      'grammarian',
      'ah_counter',
      'host',
      'other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grammar_note_type') THEN
    CREATE TYPE grammar_note_type AS ENUM (
      'good_word',
      'good_phrase',
      'great_sentence',
      'grammar_issue'
    );
  END IF;
END $$;

-- =========
-- Base tables
-- =========
ALTER TABLE meetings
ADD COLUMN IF NOT EXISTS agenda_version BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS user_identity_profiles (
  user_id UUID PRIMARY KEY,
  app_id TEXT NOT NULL,
  wechat_openid TEXT,
  wechat_unionid TEXT,
  display_name TEXT NOT NULL DEFAULT '微信用户',
  avatar_url TEXT,
  name_source actor_name_source NOT NULL DEFAULT 'unknown',
  profile_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (app_id, wechat_openid)
);

CREATE TABLE IF NOT EXISTS agenda_items_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  parent_item_key TEXT,
  node_kind agenda_node_kind NOT NULL DEFAULT 'leaf',
  depth SMALLINT NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  speaker TEXT,
  speaker_role agenda_speaker_role NOT NULL DEFAULT 'speaker',
  slot_group_key TEXT,
  planned_duration INTEGER NOT NULL,
  budget_mode agenda_budget_mode NOT NULL DEFAULT 'independent',
  budget_limit_seconds INTEGER,
  consume_parent_budget BOOLEAN NOT NULL DEFAULT TRUE,
  actual_duration INTEGER,
  actual_start_time BIGINT,
  actual_end_time BIGINT,
  start_time TEXT,
  item_type TEXT NOT NULL DEFAULT 'other',
  rule_id TEXT NOT NULL DEFAULT 'short',
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  parent_title TEXT,
  status_code agenda_status_code NOT NULL DEFAULT 'initial',
  status_color agenda_status_color NOT NULL DEFAULT 'blue',
  status_rule_profile agenda_rule_profile NOT NULL DEFAULT 'lte5m',
  status_updated_at BIGINT,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  created_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  updated_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_by_name_source actor_name_source NOT NULL DEFAULT 'unknown',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT uq_agenda_items_v2_meeting_item_key UNIQUE (meeting_id, item_key),
  CONSTRAINT fk_agenda_items_v2_parent
    FOREIGN KEY (meeting_id, parent_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
    ON DELETE CASCADE,
  CONSTRAINT chk_agenda_items_v2_parent_not_self
    CHECK (parent_item_key IS NULL OR parent_item_key <> item_key),
  CONSTRAINT chk_agenda_items_v2_item_key_reserved
    CHECK (item_key <> '__root__'),
  CONSTRAINT chk_agenda_items_v2_depth
    CHECK (depth >= 1),
  CONSTRAINT chk_agenda_items_v2_segment_budget
    CHECK (
      (node_kind = 'segment' AND budget_mode = 'hard_cap' AND budget_limit_seconds IS NOT NULL)
      OR (node_kind = 'leaf' AND budget_mode = 'independent')
    )
);

CREATE TABLE IF NOT EXISTS meeting_participants_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  linked_user_id UUID REFERENCES user_identity_profiles(user_id),
  role_tags TEXT[] NOT NULL DEFAULT '{}',
  created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT uq_meeting_participants_v2 UNIQUE (meeting_id, participant_key)
);

CREATE TABLE IF NOT EXISTS grammarian_notes_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  note_type grammar_note_type NOT NULL,
  content TEXT NOT NULL,
  related_item_key TEXT,
  observer_user_id UUID REFERENCES user_identity_profiles(user_id),
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'grammarian',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT fk_grammarian_notes_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT fk_grammarian_notes_v2_item
    FOREIGN KEY (meeting_id, related_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
);

CREATE TABLE IF NOT EXISTS ah_counter_records_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  filler_word TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  sample_quote TEXT,
  related_item_key TEXT,
  observer_user_id UUID REFERENCES user_identity_profiles(user_id),
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'ah_counter',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT fk_ah_counter_records_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT fk_ah_counter_records_v2_item
    FOREIGN KEY (meeting_id, related_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
);

CREATE TABLE IF NOT EXISTS meeting_live_cursor_v2 (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  current_item_key TEXT,
  current_participant_key TEXT,
  current_phase agenda_live_phase NOT NULL DEFAULT 'other',
  remaining_seconds INTEGER,
  agenda_version BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  updated_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_meeting_live_cursor_v2_item
    FOREIGN KEY (meeting_id, current_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key),
  CONSTRAINT fk_meeting_live_cursor_v2_participant
    FOREIGN KEY (meeting_id, current_participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key),
  CONSTRAINT chk_meeting_live_cursor_v2_phase_participant
    CHECK (
      current_phase = 'other'
      OR current_participant_key IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS agenda_ops_v2 (
  op_id UUID PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key TEXT,
  op_type agenda_op_type NOT NULL,
  base_agenda_version BIGINT NOT NULL,
  applied_agenda_version BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES user_identity_profiles(user_id),
  actor_name TEXT NOT NULL DEFAULT '未知用户',
  actor_name_source actor_name_source NOT NULL DEFAULT 'unknown',
  client_ts BIGINT,
  server_ts BIGINT NOT NULL,
  apply_status agenda_op_apply_status NOT NULL DEFAULT 'applied',
  conflict_reason TEXT
);

-- =========
-- Indexes
-- =========
CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_order
  ON agenda_items_v2(meeting_id, order_index)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_parent_order
  ON agenda_items_v2(meeting_id, parent_item_key, order_index)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agenda_items_v2_sibling_order
  ON agenda_items_v2(meeting_id, COALESCE(parent_item_key, '__root__'), order_index)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_status
  ON agenda_items_v2(meeting_id, status_code, status_color)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_participants_v2_meeting
  ON meeting_participants_v2(meeting_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_participants_v2_meeting_updated
  ON meeting_participants_v2(meeting_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_grammarian_notes_v2_meeting
  ON grammarian_notes_v2(meeting_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ah_counter_records_v2_meeting
  ON ah_counter_records_v2(meeting_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_live_cursor_v2_updated_at
  ON meeting_live_cursor_v2(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agenda_ops_v2_meeting
  ON agenda_ops_v2(meeting_id, server_ts DESC);

-- =========
-- RLS enabled; policies are defined in 00012
-- =========
ALTER TABLE user_identity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_items_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE grammarian_notes_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ah_counter_records_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_live_cursor_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_ops_v2 ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE agenda_items_v2 IS 'Agenda V2: hierarchy + budget pool + status + audit';
COMMENT ON TABLE meeting_participants_v2 IS 'Agenda V2: participants in one meeting';
COMMENT ON TABLE grammarian_notes_v2 IS 'Grammarian notes, decoupled from timer pipeline';
COMMENT ON TABLE ah_counter_records_v2 IS 'Ah-counter event records, append-first model';
COMMENT ON TABLE meeting_live_cursor_v2 IS 'Current speaker cursor maintained by timer officer';
COMMENT ON TABLE agenda_ops_v2 IS 'Agenda V2 operation log with idempotent op_id';
