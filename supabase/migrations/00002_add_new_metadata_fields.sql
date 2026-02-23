
-- 为 meetings 表添加新的元数据字段
ALTER TABLE meetings 
ADD COLUMN IF NOT EXISTS club_name TEXT,
ADD COLUMN IF NOT EXISTS meeting_no INTEGER,
ADD COLUMN IF NOT EXISTS time_range TEXT,
ADD COLUMN IF NOT EXISTS end_time TEXT;

-- 为 meeting_items 表添加 parent_title 字段
ALTER TABLE meeting_items 
ADD COLUMN IF NOT EXISTS parent_title TEXT;

-- 添加注释
COMMENT ON COLUMN meetings.club_name IS '俱乐部名称';
COMMENT ON COLUMN meetings.meeting_no IS '会议次数';
COMMENT ON COLUMN meetings.time_range IS '会议时段（如 15:00-17:30）';
COMMENT ON COLUMN meetings.end_time IS '结束时间';
COMMENT ON COLUMN meeting_items.parent_title IS '父级标题（用于子活动）';
