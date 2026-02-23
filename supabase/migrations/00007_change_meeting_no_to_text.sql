-- 修改meeting_no字段类型为TEXT，以支持带后缀的会议号（如"123(1)"）
ALTER TABLE meetings 
ALTER COLUMN meeting_no TYPE TEXT USING meeting_no::TEXT;