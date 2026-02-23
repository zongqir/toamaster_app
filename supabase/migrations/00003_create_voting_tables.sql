
-- 投票会话表
CREATE TABLE IF NOT EXISTS voting_sessions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active, closed
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  created_by TEXT
);

-- 投票分组表
CREATE TABLE IF NOT EXISTS voting_groups (
  id TEXT PRIMARY KEY,
  voting_session_id TEXT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  group_type TEXT NOT NULL, -- preparedSpeech, evaluation, tableTopics, officials, others
  max_selections INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0
);

-- 候选人表
CREATE TABLE IF NOT EXISTS voting_candidates (
  id TEXT PRIMARY KEY,
  voting_group_id TEXT NOT NULL REFERENCES voting_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  item_id TEXT, -- 关联到 meeting_item，可为空（临时添加的候选人）
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 0
);

-- 投票记录表
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  voting_session_id TEXT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
  voting_group_id TEXT NOT NULL REFERENCES voting_groups(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES voting_candidates(id) ON DELETE CASCADE,
  voter_name TEXT NOT NULL,
  voter_fingerprint TEXT NOT NULL, -- 设备指纹
  created_at BIGINT NOT NULL,
  UNIQUE(voting_session_id, voting_group_id, voter_fingerprint, candidate_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_voting_sessions_meeting_id ON voting_sessions(meeting_id);
CREATE INDEX IF NOT EXISTS idx_voting_groups_session_id ON voting_groups(voting_session_id);
CREATE INDEX IF NOT EXISTS idx_voting_candidates_group_id ON voting_candidates(voting_group_id);
CREATE INDEX IF NOT EXISTS idx_votes_session_id ON votes(voting_session_id);
CREATE INDEX IF NOT EXISTS idx_votes_group_id ON votes(voting_group_id);
CREATE INDEX IF NOT EXISTS idx_votes_candidate_id ON votes(candidate_id);
CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes(voter_fingerprint);

-- RLS 策略（投票功能公开访问）
ALTER TABLE voting_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voting_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE voting_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;

-- 所有人可以读取投票会话
CREATE POLICY "Anyone can read voting sessions" ON voting_sessions FOR SELECT USING (true);

-- 所有人可以读取投票分组
CREATE POLICY "Anyone can read voting groups" ON voting_groups FOR SELECT USING (true);

-- 所有人可以读取候选人
CREATE POLICY "Anyone can read voting candidates" ON voting_candidates FOR SELECT USING (true);

-- 所有人可以提交投票
CREATE POLICY "Anyone can insert votes" ON votes FOR INSERT WITH CHECK (true);

-- 所有人可以读取投票结果
CREATE POLICY "Anyone can read votes" ON votes FOR SELECT USING (true);

-- 创建者可以创建投票会话
CREATE POLICY "Anyone can create voting sessions" ON voting_sessions FOR INSERT WITH CHECK (true);

-- 创建者可以创建投票分组
CREATE POLICY "Anyone can create voting groups" ON voting_groups FOR INSERT WITH CHECK (true);

-- 创建者可以创建候选人
CREATE POLICY "Anyone can create voting candidates" ON voting_candidates FOR INSERT WITH CHECK (true);

-- 添加注释
COMMENT ON TABLE voting_sessions IS '投票会话表';
COMMENT ON TABLE voting_groups IS '投票分组表';
COMMENT ON TABLE voting_candidates IS '候选人表';
COMMENT ON TABLE votes IS '投票记录表';
