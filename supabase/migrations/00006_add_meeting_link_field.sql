-- 添加会议链接字段
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_link TEXT;