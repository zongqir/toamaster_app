
-- 为 meetings 表添加 voting_id 字段
ALTER TABLE meetings 
ADD COLUMN IF NOT EXISTS voting_id TEXT;

-- 添加注释
COMMENT ON COLUMN meetings.voting_id IS '投票ID（6位字符）';

-- 创建索引以便快速查询
CREATE INDEX IF NOT EXISTS idx_meetings_voting_id ON meetings(voting_id);
