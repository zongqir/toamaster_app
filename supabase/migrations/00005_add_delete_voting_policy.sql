-- 添加删除投票会话的策略
-- 允许任何人删除投票会话（前端会通过密码验证控制）
CREATE POLICY "Anyone can delete voting sessions" ON voting_sessions FOR DELETE USING (true);

-- 添加更新投票会话的策略（用于关闭投票）
CREATE POLICY "Anyone can update voting sessions" ON voting_sessions FOR UPDATE USING (true);