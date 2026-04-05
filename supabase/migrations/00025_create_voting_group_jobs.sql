CREATE TABLE IF NOT EXISTS public.voting_group_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  input_json JSONB NOT NULL,
  result_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_voting_group_jobs_status_created_at
  ON public.voting_group_jobs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_voting_group_jobs_meeting_id_created_at
  ON public.voting_group_jobs(meeting_id, created_at DESC);

ALTER TABLE public.voting_group_jobs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.voting_group_jobs IS 'AI 投票分组任务表';
COMMENT ON COLUMN public.voting_group_jobs.status IS '任务状态: queued/processing/succeeded/failed';
