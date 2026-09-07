// Render entry point: full Express app with routes + Publer routes.
// Runs as a normal always-on Node server (no serverless cold-start concerns).
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes.js";
import { registerV2Routes } from "./v2-routes.js";
import { registerCreatorVaultRoutes } from "./creatorvault.js";
import { registerReelsScheduleRoutes } from "./reels-schedule.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
if (typeof (globalThis as any).WebSocket === "undefined") (globalThis as any).WebSocket = WebSocket;

function cors(req: Request, res: Response, next: (err?: any) => void) {
  const origin = req.header("origin") || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-app-secret,authorization,x-creatorvault-signature",
  );
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

async function main() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  // Capture raw body for HMAC verification (needed by the CreatorVault webhook).
  // Attaching a verify fn to express.json makes rawBody available on req without
  // installing a separate body-consuming middleware, which would hang after json parsed.
  app.use(express.json({
    limit: "5mb",
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); },
  }));

  const http = createServer(app);
  await registerRoutes(http, app);

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
  registerV2Routes(app, getSb);
  registerCreatorVaultRoutes(app, getSb);
  registerReelsScheduleRoutes(app, getSb);

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
