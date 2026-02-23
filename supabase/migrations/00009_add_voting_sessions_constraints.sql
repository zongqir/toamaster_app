-- 1. 为 voting_sessions 表的 meeting_id 添加外键约束和唯一约束
-- 首先删除可能存在的孤立数据
DELETE FROM voting_sessions WHERE meeting_id NOT IN (SELECT id FROM meetings);

-- 添加外键约束（级联删除）
ALTER TABLE voting_sessions
DROP CONSTRAINT IF EXISTS voting_sessions_meeting_id_fkey;

ALTER TABLE voting_sessions
ADD CONSTRAINT voting_sessions_meeting_id_fkey
FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

-- 添加唯一约束（一个会议只能有一个投票会话）
ALTER TABLE voting_sessions
DROP CONSTRAINT IF EXISTS voting_sessions_meeting_id_unique;

ALTER TABLE voting_sessions
ADD CONSTRAINT voting_sessions_meeting_id_unique UNIQUE (meeting_id);

-- 添加注释
COMMENT ON CONSTRAINT voting_sessions_meeting_id_fkey ON voting_sessions IS '投票会话关联会议，删除会议时级联删除投票会话';
COMMENT ON CONSTRAINT voting_sessions_meeting_id_unique ON voting_sessions IS '每个会议只能有一个投票会话';