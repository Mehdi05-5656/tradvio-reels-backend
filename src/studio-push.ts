// Clone8 Studio: "Your video is ready" on the iPhone, even with the app closed. The app registers its Apple push
// token (POST /api/studio/devices); a loop here looks every 20 s for jobs that finished since and sends one push per
// job to each of that person's phones, straight to Apple (APNs over HTTP/2, signed with the team's push key).
//
// Settings (Render, web service only): APNS_KEY (the .p8 key's text), APNS_KEY_ID, APNS_TEAM_ID (YZP4MFJ47H).
// Without them the loop does not start and nothing changes. Tokens Apple rejects as gone are deleted.
import { connect, type ClientHttp2Session } from "node:http2";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { importPKCS8, SignJWT } from "jose";

export const TOPIC = "io.clone8.app";
const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
const TOOL_NAME: Record<string, string> = {
  story: "Story", stories: "Story", story_explainer: "Story", motivation: "Motivation", longform: "Film", clips: "Clips",
  captions: "Captions", blueprint: "Blueprint", swap: "Swap", stunts: "Stunt", kage: "Motion", kage_motion: "Motion",
};

export const pushReady = (env: Record<string, string | undefined>) => !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);

/** What the notice says for a finished or failed job. */
export function message(job: { tool: string; status: string; options?: any }): { title: string; body: string } {
  const name = TOOL_NAME[job.tool] ?? "Video";
  const about = String(job.options?.prompt ?? job.options?.topic ?? job.options?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (job.status === "failed") return { title: `Your ${name.toLowerCase()} did not finish`, body: "Your credits came back. Tap to see what happened." };
  return { title: "Your video is ready", body: about ? `${name} · ${about}` : `${name} · tap to watch` };
}

let jwt: { token: string; at: number } | null = null;
async function authToken(env: Record<string, string | undefined>): Promise<string> {
  // Apple accepts a token for an hour and asks that it is not remade more than every 20 minutes
  if (jwt && Date.now() - jwt.at < 40 * 60_000) return jwt.token;
  const key = await importPKCS8(String(env.APNS_KEY).replace(/\\n/g, "\n").trim(), "ES256");
  const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: String(env.APNS_KEY_ID) }).setIssuer(String(env.APNS_TEAM_ID)).setIssuedAt().sign(key);
  jwt = { token, at: Date.now() };
  return token;
}

const sessions: Partial<Record<keyof typeof HOSTS, ClientHttp2Session>> = {};
function session(where: keyof typeof HOSTS): ClientHttp2Session {
  const s = sessions[where];
  if (s && !s.closed && !s.destroyed) return s;
  const fresh = connect(HOSTS[where]);
  fresh.on("error", () => { delete sessions[where]; });
  fresh.on("goaway", () => { delete sessions[where]; });
  sessions[where] = fresh;
  return fresh;
}

/** One push. Resolves Apple's status and reason (410 / BadDeviceToken mean the token is gone). */
export async function sendPush(env: Record<string, string | undefined>, device: { token: string; sandbox: boolean }, note: { title: string; body: string; jobId: string }): Promise<{ status: number; reason: string | null }> {
  const auth = await authToken(env);
  const body = JSON.stringify({ aps: { alert: { title: note.title, body: note.body }, sound: "default" }, jobId: note.jobId, body: { jobId: note.jobId } });
  return new Promise((resolve) => {
    const req = session(device.sandbox ? "sandbox" : "production").request({
      ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${auth}`,
      "apns-topic": TOPIC, "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": note.jobId.slice(0, 64), "content-type": "application/json",
    });
    let status = 0, data = "";
    req.setTimeout(10_000, () => { req.close(); resolve({ status: 0, reason: "timeout" }); });
    req.on("response", (h) => { status = Number(h[":status"] ?? 0); });
    req.on("data", (c) => { data += c; });
    req.on("end", () => { let reason: string | null = null; try { reason = data ? JSON.parse(data).reason ?? null : null; } catch {} resolve({ status, reason }); });
    req.on("error", (e) => resolve({ status: 0, reason: String(e?.message ?? e).slice(0, 80) }));
    req.end(body);
  });
}

/** Jobs that ended since the last look, pushed once each (push_notified_at marks them, so a restart sends nothing twice). */
export async function pushTick(sb: SupabaseClient, env: Record<string, string | undefined>, log: (m: string) => void, send = sendPush): Promise<number> {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const jobs = await sb.from("studio_jobs").select("id,user_id,tool,status,options,finished_at").in("status", ["done", "failed"]).gte("finished_at", since).is("push_notified_at", null).limit(100);
  if (jobs.error) throw jobs.error;
  let sent = 0;
  for (const j of (jobs.data ?? []) as any[]) {
    // claimed first, so two servers never push the same job
    const claim = await sb.from("studio_jobs").update({ push_notified_at: new Date().toISOString() }).eq("id", j.id).is("push_notified_at", null).select("id");
    if (claim.error || !(claim.data ?? []).length) continue;
    const devs = await sb.from("studio_devices").select("token,sandbox,created_at").eq("user_id", j.user_id);
    if (devs.error) throw devs.error;
    // only phones registered before the job ended (a job from last week never pings a new phone)
    for (const d of ((devs.data ?? []) as any[]).filter((x) => !j.finished_at || x.created_at <= j.finished_at)) {
      const r = await send(env, { token: d.token, sandbox: !!d.sandbox }, { ...message(j), jobId: j.id });
      if (r.status === 200) sent++;
      else if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") await sb.from("studio_devices").delete().eq("token", d.token);
      else log(`[push] ${j.id} → ${r.status} ${r.reason ?? ""}`);
    }
  }
  if (sent) log(`[push] sent ${sent}`);
  return sent;
}

export function startPushLoop(sbFn: () => SupabaseClient, env: Record<string, string | undefined> = process.env, log: (m: string) => void = console.log, intervalMs = 20_000): NodeJS.Timeout | null {
  if (!pushReady(env)) return null;
  let busy = false;
  const t = setInterval(() => {
    if (busy) return; busy = true;
    pushTick(sbFn(), env, log).catch((e) => console.error("[push]", String(e?.message ?? e).slice(0, 200))).finally(() => { busy = false; });
  }, intervalMs);
  t.unref?.();
  log("[push] loop on");
  return t;
}

type Deps = { sbFn: () => SupabaseClient; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => void };
/** The app registers (or moves) its push token to the signed-in person; sign-out removes it. */
export function registerDevices(app: Express, d: Deps): void {
  app.post("/api/studio/devices", async (req, res) => {
    const u = d.requireUser(req, res); if (!u) return;
    const token = String(req.body?.token ?? "").trim();
    if (!/^[0-9a-f]{32,200}$/i.test(token)) return res.status(400).json({ error: "bad_token" });
    try {
      const r = await d.sbFn().from("studio_devices").upsert({ token, user_id: u, sandbox: req.body?.sandbox === true, platform: "ios", created_at: new Date().toISOString() }, { onConflict: "token" });
      if (r.error) throw r.error;
      res.json({ ok: true });
    } catch (e) { d.fail(res, e); }
  });
  app.post("/api/studio/devices/remove", async (req, res) => {
    const u = d.requireUser(req, res); if (!u) return;
    try {
      const r = await d.sbFn().from("studio_devices").delete().eq("user_id", u).eq("token", String(req.body?.token ?? ""));
      if (r.error) throw r.error;
      res.json({ ok: true });
    } catch (e) { d.fail(res, e); }
  });
}
