-- All dashboard data flows through authenticated, ownership-scoped backend
-- handlers using service_role. Browser roles must not bypass those handlers.
-- No rows are changed or deleted. Service-role workers and signed webhooks
-- retain access. Apply only after production approval.
BEGIN;
ALTER TABLE public.creatorvault_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatorvault_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatorvault_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatorvault_video_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatorvault_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_video_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_content_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.creatorvault_accounts,
  public.creatorvault_config,
  public.creatorvault_videos,
  public.creatorvault_video_snapshots,
  public.creatorvault_webhook_events,
  public.source_video_stats,
  public.content_fingerprints,
  public.scheduled_reels,
  public.video_content_features,
  public.reels_dashboard_summary,
  public.posted_reel_performance
FROM PUBLIC, anon, authenticated;
COMMIT;
