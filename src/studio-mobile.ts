// Clone8 Studio: what the iPhone app needs from the server beyond the Studio routes.
//
//  - GET  /api/studio/app-config   public: the app's update prompts. STUDIO_APP_LATEST_BUILD (a build number) shows a
//    dismissible "a new version is out" card to anyone on an older build; STUDIO_APP_MIN_BUILD blocks older builds with
//    an "Update to continue" screen. Both empty = no prompt. Changed on Render, no new app needed.
//  - GET  /api/studio/app-return   public: where the website's checkout lands when it was opened from the app. A small
//    page that sends the person back into the app (clone8://) with a button if Safari asks first.
//  - POST /api/studio/account/delete   the signed-in person deletes their account (Apple guideline 5.1.1(v)): a website
//    plan is cancelled at Stripe, the posting profile and stored files are removed, then the login itself, which removes
//    every Studio row with it. A plan billed through Apple can only be cancelled by the person in their Apple settings;
//    the answer says so and the app shows it.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export const APP_STORE_URL = "https://apps.apple.com/app/id6834117541";
const build = (v: string | undefined) => { const n = Number(String(v ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : null; };

/** The update prompts the app reads at start and when it comes back to the front. */
export function appConfig(env: Record<string, string | undefined>) {
  return {
    latest_build: build(env.STUDIO_APP_LATEST_BUILD),
    min_build: build(env.STUDIO_APP_MIN_BUILD),
    note: (env.STUDIO_APP_UPDATE_NOTE ?? "").trim().slice(0, 140) || null,
    store_url: APP_STORE_URL,
  };
}

const page = (ok: boolean) => {
  const to = ok ? "clone8://plans?checkout=success" : "clone8://plans?checkout=canceled";
  const title = ok ? "You're all set" : "Nothing was charged";
  const body = ok ? "Your plan is ready. Head back to Clone8 to start making." : "You can pick a plan any time in Clone8.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#05050B;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
.c{max-width:360px;padding:32px 24px;text-align:center}h1{font-size:28px;margin:0 0 10px}p{color:#9AA0AE;line-height:1.5;margin:0 0 28px}
a{display:block;padding:17px;border-radius:999px;background:#17CFB9;color:#03120F;font-weight:700;text-decoration:none;font-size:17px}</style></head>
<body><div class="c"><h1>${title}</h1><p>${body}</p><a href="${to}">Return to Clone8</a></div>
<script>setTimeout(function(){location.href=${JSON.stringify(to)}},350)</script></body></html>`;
};

/** Files a person keeps in a storage bucket live under their id; removed in pages. Best effort. */
async function removeFiles(sb: SupabaseClient, bucket: string, u: string, log: (m: string) => void): Promise<number> {
  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (let page = 0; page < 50; page++) {
      const r = await sb.storage.from(bucket).list(dir, { limit: 1000 });
      if (r.error || !r.data?.length) return;
      const files = r.data.filter((f: any) => f.id).map((f: any) => `${dir}/${f.name}`);
      const dirs = r.data.filter((f: any) => !f.id).map((f: any) => `${dir}/${f.name}`);
      for (const d of dirs) await walk(d, depth + 1);
      if (!files.length) return;
      const del = await sb.storage.from(bucket).remove(files);
      if (del.error) { log(`[account] could not remove files in ${bucket}/${dir}: ${del.error.message}`); return; }
      removed += files.length;
      if (files.length < 1000) return;
    }
  };
  await walk(u, 0);
  return removed;
}

type Deps = {
  sbFn: () => SupabaseClient; env: Record<string, string | undefined>; stripeOrNull: () => any | null;
  requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => void; log: (m: string) => void;
};

export function registerMobile(app: Express, d: Deps): void {
  app.get("/api/studio/app-config", (_req, res) => { res.set("Cache-Control", "no-store"); res.json(appConfig(d.env)); });
  app.get("/api/studio/app-return", (req, res) => { res.set("Cache-Control", "no-store").type("html").send(page(req.query.checkout !== "canceled")); });

  app.post("/api/studio/account/delete", async (req, res) => {
    const u = d.requireUser(req, res); if (!u) return;
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "confirm_required" });
    const sb = d.sbFn();
    try {
      const c = await sb.from("studio_customers").select("stripe_subscription_id,status,billing_source,owner_pass").eq("user_id", u).maybeSingle();
      if (c.error) throw c.error;
      const cust = c.data as any;
      if (cust?.owner_pass && /^support@clone8\.io$/i.test(String((req as any).auth?.email ?? ""))) return res.status(409).json({ error: "owner_account", detail: "The owner account cannot be deleted from the app." });
      // a website plan stops now; nothing more is charged
      if (cust?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(cust.status)) {
        const stripe = d.stripeOrNull();
        if (!stripe) return res.status(503).json({ error: "billing_unavailable", detail: "Try again in a moment." });
        await stripe.subscriptions.cancel(cust.stripe_subscription_id).catch((e: any) => { if (!/No such subscription|canceled/i.test(String(e?.message))) throw e; });
      }
      const apple = cust?.billing_source === "apple" && ["active", "trialing", "past_due"].includes(cust.status);
      try { const { releaseSocialProfile } = await import("./studio-social.js"); await releaseSocialProfile(sb, u); }
      catch (e: any) { console.error(`[account] ALERT posting profile of ${u} not removed on deletion: ${String(e?.message ?? e).slice(0, 160)}`); }
      let files = 0;
      for (const bucket of ["studio-outputs", "studio-uploads"]) files += await removeFiles(sb, bucket, u, d.log).catch(() => 0);
      const del = await sb.auth.admin.deleteUser(u);
      if (del.error) {
        // agency and managed records keep a login on purpose; those people are helped by hand
        if (/foreign key|violates|restrict/i.test(del.error.message)) return res.status(409).json({ error: "needs_support", detail: "This account is linked to a managed workspace. Email support@clone8.io and we will delete it for you." });
        throw del.error;
      }
      d.log(`[account] deleted ${u} (files ${files}${apple ? ", Apple plan still billed until the person cancels it" : ""})`);
      res.json({ deleted: true, apple_billed: apple });
    } catch (e) { d.fail(res, e); }
  });
}
