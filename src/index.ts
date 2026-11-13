// Render entry point: full Express app with routes + Publer routes.
// Runs as a normal always-on Node server (no serverless cold-start concerns).
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes.js";
import { registerV2Routes } from "./v2-routes.js";
import { registerCreatorVaultRoutes } from "./creatorvault.js";
import { registerReelsScheduleRoutes } from "./reels-schedule.js";
import { registerOnboardingRoutes } from "./onboarding-routes.js";
import { registerAccountInventory } from "./account-inventory.js";
import { registerAccountHistory } from "./account-history.js";
import { registerOpsPipeline } from "./ops-pipeline.js";
import { registerOpsActions } from "./ops-actions.js";
import { registerClientOnboarding, startIntakeLoop } from "./client-onboarding.js";
import { registerClientOrgRoutes } from "./client-orgs.js";
import { registerClientLearning } from "./client-learning.js";
import { registerLibraryArchive } from "./library-archive.js";
import { registerPublicRoutes, registerInviteRequestInbox } from "./public-routes.js";
import { metaConfig, startMetaCapiLoop } from "./meta-capi.js";
import { registerLibraryImport } from "./library-import.js";
import { registerManagedRoutes } from "./managed-routes.js";
import { registerGenerationRoutes } from "./generation-routes.js";
import { registerHandoffRoutes } from "./handoff-routes.js";
import { startManagedProvisioningWorker } from "./managed-provisioning.js";
import { startIngestionWorker } from "./ingestion-worker.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { configurePublerRate } from "./publer-rate.js";
import { corsMiddleware } from "./cors.js";
import { registerStudio } from "./studio.js";
import { registerMcp } from "./studio-mcp.js";
import { startRecastLoop } from "./studio-recast.js";
import { startCharacterLoop } from "./studio-characters.js";
import { startInstrumentLoop, instrumentLoopSettings } from "./studio-instruments.js";
import { startClipsLoop } from "./studio-clips.js";
import { startCaptionsLoop } from "./studio-caption-video.js";
import { startStuntsLoop } from "./studio-stunts.js";
import { startSplitLoop } from "./studio-splitscreen-job.js";
import { startKageLoop } from "./studio-kage.js";
import { startImportLoop } from "./studio-library.js";
import { PLANS } from "./studio.js";
import { registerAssistant, startAssistantLoop } from "./studio-assistant.js";
import { registerAutomations } from "./studio-automations.js";
import { registerSocial, startSocialLoop } from "./studio-social.js";
import { registerPerformance, startPerformanceLoop } from "./studio-performance-routes.js";
import { registerOutputAsset } from "./studio-output-asset.js";
import { registerPeople } from "./studio-people.js";
import { registerCharacters } from "./studio-character-library.js";
import { registerCreators, startCreatorLoop } from "./studio-creators.js";
import { registerVoices } from "./studio-eleven.js";
import { startNoticesLoop } from "./studio-notices.js";
import { startPushLoop } from "./studio-push.js";
import { startNudgesLoop } from "./studio-nudges.js";
import { initEvents } from "./studio-events.js";
import { registerStudioAdmin } from "./studio-admin.js";
import { registerCommunity } from "./studio-community.js";
import { initCosts, registerStudioCosts } from "./studio-costs.js";
import { registerStoryExam } from "./studio-story-exam.js";
import compression from "compression";
import WebSocket from "ws";
if (typeof (globalThis as any).WebSocket === "undefined") (globalThis as any).WebSocket = WebSocket;

async function main() {
  const app = express();
  app.disable("x-powered-by");
  // Browser origins are allowlisted (src/cors.ts); curl/cron callers never send Origin and are unaffected.
  app.use(corsMiddleware());
  // Reports are large JSON (a 30-day range is ~1.8 MB raw); gzip cuts the transfer by about 10x.
  app.use(compression({ threshold: 1024 }));
  // Capture raw body for HMAC verification (needed by the CreatorVault webhook).
  // Attaching a verify fn to express.json makes rawBody available on req without
  // installing a separate body-consuming middleware, which would hang after json parsed.
  app.use(express.json({
    limit: "5mb",
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); },
  }));

  const http = createServer(app);

  // v2 routes: devices, alerts, overview. Auth middleware from routes.ts applies to POSTs.
  let sb: SupabaseClient | null = null;
  const getSb = () => {
    if (!sb) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
      sb = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 0 } },
      });
    }
    return sb;
  };
  // Capability handler owns its auth; disabled unless explicitly rolled out.
  // All existing /api routes retain their existing default-deny middleware.
  // Every Publer call from this process shares the database-backed request budget.
  configurePublerRate(getSb, "publish");
  registerLibraryImport(app,getSb);
  await registerRoutes(http, app);
  registerV2Routes(app, getSb);
  registerAccountInventory(app, getSb);
  registerAccountHistory(app, getSb);
  registerOpsPipeline(app, getSb);
  registerOpsActions(app, getSb);
  registerClientOnboarding(app, getSb);
  if (process.env.INTAKE_PROCESSOR !== "0") startIntakeLoop(getSb);
  startMetaCapiLoop(getSb, metaConfig()); // retries Lead events for clone8.io applications; off without META_* env
  registerClientOrgRoutes(app, getSb);
  registerClientLearning(app, getSb);
  registerLibraryArchive(app, getSb);
  initEvents(getSb); // the Studio admin panel's event record (studio_events): costs, checkouts, emails, page views
  initCosts(getSb); // the cost ledger (studio_costs): every paid call, with its source
  registerStudio(app, getSb);
  registerMcp(app, getSb); // the Clone8 connector for Claude/ChatGPT (docs/mcp/PLAN.md); off unless STUDIO_MCP_ENABLED, owner-only unless STUDIO_MCP_OPEN
  registerStudioAdmin(app, getSb); // the owner's Studio admin panel (support@clone8.io only)
  registerCommunity(app, getSb); // Community: the shared library of generative films (off unless STUDIO_COMMUNITY_ENABLED)
  registerStudioCosts(app, getSb); // the admin panel's Money tab: what Clone8 paid, by vendor, tool and step
  registerStoryExam(app, getSb, { plans: PLANS }); // the Stories practice exam (admin only; STORY_MASTER_PLAN.md phase 0)
  registerAssistant(app, getSb); // Studio assistant: chat that plans and runs Studio jobs; off without ANTHROPIC_API_KEY
  registerAutomations(app, getSb); // Studio automations: saved plans run again on new files
  registerSocial(app, getSb); // Studio self-serve posting to the person's own socials; off until STUDIO_SOCIAL_ENABLED=true. Not Publer.
  registerPerformance(app, getSb); // performance dashboard of the person's linked accounts, the AI overview, chat suggestions
  registerOutputAsset(app, getSb); // a finished video into the library, so any other tool can take it
  registerPeople(app, getSb); // who is in a clip: faces for the chat card and the Swap page
  registerCharacters(app, getSb); // the pictures a person uses as characters, most used first
  registerCreators(app, getSb); // the Creator Program: paid views on creators' own TikTok / Instagram; off until STUDIO_CREATORS_ENABLED=true
  startCreatorLoop(getSb); // reads enrolled accounts' videos and views every few hours (off with the program)
  registerVoices(app); // the voice library for the picker and the chat's voice card; empty without ELEVENLABS_API_KEY
  startRecastLoop(getSb); // Clone8 Studio Recast: only runs when HIGGSFIELD_API_KEY is set
  startCharacterLoop(getSb); // Studio characters (Soul portraits); off without HIGGSFIELD_API_KEY
  { const l = instrumentLoopSettings(process.env); startInstrumentLoop(getSb, {}, l.tickMs, l.parallel); } // Studio instruments (every other platform model); off until STUDIO_INSTRUMENTS_ENABLED=true
  startClipsLoop(getSb, { plans: PLANS });
  startCaptionsLoop(getSb); // captions burned into videos; one at a time, never while clips are cutting
  startKageLoop(getSb); // Kage remixes (Claude plans, the platform renders every shot at once); off until STUDIO_KAGE_ENABLED=true
  void import("./studio-youtube.js").then((m) => m.ffmpegReport()).then((r) => console.log(`[clips] ffmpeg: ${r}`)).catch(() => undefined); // Clips from long videos, one run at a time; needs ANTHROPIC_API_KEY plus ScrapeCreators or ElevenLabs
  startImportLoop(getSb, { plans: PLANS }); // bulk link imports into the library; needs SCRAPECREATORS_API_KEY
  startAssistantLoop(getSb); // Studio assistant runs: chains one job per confirmed step
  startSocialLoop(getSb); // reads back post statuses the social webhook left behind
  startPerformanceLoop(getSb); // daily refresh for people who opened the dashboard this week
  startNoticesLoop(getSb); // Clone8 Studio emails: only runs when RESEND_API_KEY is set
  startPushLoop(getSb); // iPhone push notices: only runs when the APNS_* settings are set
  startNudgesLoop(getSb); // emails to sign-ups without a plan (30 minutes, then a day); off unless STUDIO_NUDGES=on
  startStuntsLoop(getSb); // Studio stunts (impossible endings on a person's clip); off until STUDIO_STUNTS_ENABLED=true
  startSplitLoop(getSb); // Studio split screen (a clip over a gameplay loop); off until STUDIO_SPLITSCREEN_ENABLED=true
  registerPublicRoutes(app, getSb);
  registerInviteRequestInbox(app, getSb);
  registerManagedRoutes(app, getSb);
  registerGenerationRoutes(app, getSb);
  registerHandoffRoutes(app, getSb);
  registerCreatorVaultRoutes(app, getSb);
  registerReelsScheduleRoutes(app, getSb);
  registerOnboardingRoutes(app, getSb);

  // Sprint 3.3: background ingestion worker (setInterval poller).
  // Disabled by setting INGESTION_WORKER_DISABLED=1 (e.g. in tests).
  startIngestionWorker(getSb);
  startManagedProvisioningWorker(getSb);

  app.get("/", (_req, res) => res.json({ ok: true, service: "tradvio-reels-backend" }));
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  const port = Number(process.env.PORT || 10000);
  http.listen(port, "0.0.0.0", () => {
    console.log(`[server] listening on :${port}`);
  });
}

main().catch((e) => {
  console.error("[server] fatal:", e);
  process.exit(1);
});
