CREATE TABLE IF NOT EXISTS public.parse_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  input_text TEXT NOT NULL,
  input_length INTEGER NOT NULL DEFAULT 0,
  result_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_parse_jobs_status_created_at
  ON public.parse_jobs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_parse_jobs_created_at
  ON public.parse_jobs(created_at DESC);

ALTER TABLE public.parse_jobs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.parse_jobs IS 'AI 导入解析任务表';
COMMENT ON COLUMN public.parse_jobs.status IS '任务状态: queued/processing/succeeded/failed';
