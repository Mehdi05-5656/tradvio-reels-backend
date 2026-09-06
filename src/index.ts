// Render entry point: full Express app with routes + Publer routes.
// Runs as a normal always-on Node server (no serverless cold-start concerns).
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes.js";

function cors(req: Request, res: Response, next: (err?: any) => void) {
  const origin = req.header("origin") || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-app-secret,authorization",
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
  app.use(express.json({ limit: "5mb" }));

  const http = createServer(app);
  await registerRoutes(http, app);

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
