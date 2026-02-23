-- 1. 创建会议链接表
CREATE TABLE IF NOT EXISTS meeting_links (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  meeting_id TEXT NOT NULL UNIQUE,
  link TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  CONSTRAINT fk_meeting_link FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- 2. 迁移现有的会议链接数据（如果 meeting_link 字段存在）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'meetings' AND column_name = 'meeting_link'
  ) THEN
    INSERT INTO meeting_links (id, meeting_id, link, created_at, updated_at)
    SELECT 
      gen_random_uuid()::TEXT,
      id,
      meeting_link,
      created_at,
      created_at
    FROM meetings
    WHERE meeting_link IS NOT NULL AND meeting_link != ''
    ON CONFLICT (meeting_id) DO NOTHING;
  END IF;
END $$;

-- 3. 为投票相关表添加 meeting_id 字段（如果不存在）
ALTER TABLE voting_groups ADD COLUMN IF NOT EXISTS meeting_id TEXT;
ALTER TABLE voting_candidates ADD COLUMN IF NOT EXISTS meeting_id TEXT;
ALTER TABLE votes ADD COLUMN IF NOT EXISTS meeting_id TEXT;

-- 4. 迁移现有数据：从 voting_sessions 获取 meeting_id
UPDATE voting_groups vg
SET meeting_id = vs.meeting_id
FROM voting_sessions vs
WHERE vg.voting_session_id = vs.id
AND vg.meeting_id IS NULL;

UPDATE voting_candidates vc
SET meeting_id = vg.meeting_id
FROM voting_groups vg
WHERE vc.voting_group_id = vg.id
AND vc.meeting_id IS NULL;

UPDATE votes v
SET meeting_id = vs.meeting_id
FROM voting_sessions vs
WHERE v.voting_session_id = vs.id
AND v.meeting_id IS NULL;

-- 5. 清理孤立数据：删除 meeting_id 不在 meetings 表中的记录
DELETE FROM votes WHERE meeting_id NOT IN (SELECT id FROM meetings);
DELETE FROM voting_candidates WHERE meeting_id NOT IN (SELECT id FROM meetings);
DELETE FROM voting_groups WHERE meeting_id NOT IN (SELECT id FROM meetings);
DELETE FROM voting_sessions WHERE meeting_id NOT IN (SELECT id FROM meetings);

-- 6. 设置 meeting_id 为 NOT NULL（在迁移和清理数据后）
ALTER TABLE voting_groups ALTER COLUMN meeting_id SET NOT NULL;
ALTER TABLE voting_candidates ALTER COLUMN meeting_id SET NOT NULL;
ALTER TABLE votes ALTER COLUMN meeting_id SET NOT NULL;

-- 7. 创建索引
CREATE INDEX IF NOT EXISTS idx_meeting_links_meeting_id ON meeting_links(meeting_id);
CREATE INDEX IF NOT EXISTS idx_voting_groups_meeting_id ON voting_groups(meeting_id);
CREATE INDEX IF NOT EXISTS idx_voting_candidates_meeting_id ON voting_candidates(meeting_id);
CREATE INDEX IF NOT EXISTS idx_votes_meeting_id ON votes(meeting_id);

-- 8. 添加外键约束
ALTER TABLE voting_groups ADD CONSTRAINT fk_voting_groups_meeting 
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

ALTER TABLE voting_candidates ADD CONSTRAINT fk_voting_candidates_meeting 
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

ALTER TABLE votes ADD CONSTRAINT fk_votes_meeting 
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

-- 9. RLS 策略：meeting_links 表
ALTER TABLE meeting_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "所有人可以查看会议链接" ON meeting_links FOR SELECT USING (true);
CREATE POLICY "所有人可以创建会议链接" ON meeting_links FOR INSERT WITH CHECK (true);
CREATE POLICY "所有人可以更新会议链接" ON meeting_links FOR UPDATE USING (true);
CREATE POLICY "所有人可以删除会议链接" ON meeting_links FOR DELETE USING (true);

-- 10. 添加注释
COMMENT ON TABLE meeting_links IS '会议链接表';
COMMENT ON COLUMN voting_groups.meeting_id IS '关联的会议ID';
COMMENT ON COLUMN voting_candidates.meeting_id IS '关联的会议ID';
COMMENT ON COLUMN votes.meeting_id IS '关联的会议ID';