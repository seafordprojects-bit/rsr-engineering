-- Job → vessel link for the Job Monitoring vessel integration (Project A).
-- Additive + idempotent. Existing rows keep voyage_id NULL (legacy free-text jobs, never flagged).
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS voyage_id uuid REFERENCES public.voyages(id);
CREATE INDEX IF NOT EXISTS idx_jobs_voyage ON public.jobs(voyage_id);
