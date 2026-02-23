-- 创建会议表
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT,
  theme TEXT,
  word_of_the_day TEXT,
  start_time TEXT,
  location TEXT,
  is_completed BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  created_by TEXT DEFAULT 'anonymous',
  total_planned_duration INTEGER DEFAULT 0,
  total_actual_duration INTEGER DEFAULT 0
);

-- 创建会议环节表
CREATE TABLE meeting_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  speaker TEXT,
  planned_duration INTEGER NOT NULL,
  actual_duration INTEGER,
  actual_start_time BIGINT,
  actual_end_time BIGINT,
  start_time TEXT,
  item_type TEXT DEFAULT 'other',
  rule_id TEXT DEFAULT 'short',
  disabled BOOLEAN DEFAULT FALSE,
  order_index INTEGER NOT NULL,
  CONSTRAINT fk_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX idx_meetings_created_at ON meetings(created_at DESC);
CREATE INDEX idx_meetings_is_completed ON meetings(is_completed);
CREATE INDEX idx_meeting_items_meeting_id ON meeting_items(meeting_id);
CREATE INDEX idx_meeting_items_order ON meeting_items(meeting_id, order_index);

-- 启用 RLS
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_items ENABLE ROW LEVEL SECURITY;

-- RLS 策略：所有人可读
CREATE POLICY "所有人可以查看会议"
  ON meetings FOR SELECT
  USING (true);

CREATE POLICY "所有人可以查看会议环节"
  ON meeting_items FOR SELECT
  USING (true);

-- RLS 策略：所有人可以创建（匿名用户）
CREATE POLICY "所有人可以创建会议"
  ON meetings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "所有人可以创建会议环节"
  ON meeting_items FOR INSERT
  WITH CHECK (true);

-- RLS 策略：所有人可以更新（用于完成会议）
CREATE POLICY "所有人可以更新会议"
  ON meetings FOR UPDATE
  USING (true);

CREATE POLICY "所有人可以更新会议环节"
  ON meeting_items FOR UPDATE
  USING (true);

-- RLS 策略：所有人可以删除
CREATE POLICY "所有人可以删除会议"
  ON meetings FOR DELETE
  USING (true);

CREATE POLICY "所有人可以删除会议环节"
  ON meeting_items FOR DELETE
  USING (true);

-- 添加注释
COMMENT ON TABLE meetings IS '会议表，存储会议基本信息';
COMMENT ON TABLE meeting_items IS '会议环节表，存储每个会议的环节详情';
