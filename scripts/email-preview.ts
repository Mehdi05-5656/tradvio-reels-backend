// Writes every Studio email we can render without a database to HTML files, plus an index that shows each one in
// light and dark side by side. Nothing is sent.
//   npx esbuild scripts/email-preview.ts --bundle --packages=external --platform=node --format=esm --outfile=.email-preview.mjs && node .email-preview.mjs <out dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nudgeEmail } from "../src/studio-nudges.js";
import { renderEmail } from "../src/studio-mail.js";

const out = process.argv[2] || "email-preview";
mkdirSync(out, { recursive: true });
const env = { STUDIO_MAIL_SECRET: "preview", DASHBOARD_URL: "https://app.clone8.io", STUDIO_CLIPS_LEAN: "on", STUDIO_YT_PROXY: "https://p", STUDIO_YT_PROXY_USD_PER_GB: "6.25", ELEVENLABS_API_KEY: "e" } as Record<string, string>;
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const who = (onboarding: any) => ({ userId: U, onboarding });
const mails: Array<{ name: string; subject: string; html: string }> = [];
for (const [name, ob] of [
  ["clipper", { role: "clipper", goal: "clips", goals: ["clips", "earn"] }],
  ["earn", { role: "creator", goal: "earn", goals: ["earn"] }],
  ["stories", { role: "creator", goal: "stories", goals: ["stories"] }],
  ["films", { role: "yt_automation", goal: "films", goals: ["films"] }],
  ["no-goal", {}],
] as Array<[string, any]>) {
  for (const step of ["plan_30m", "plan_day1"] as const) {
    const m = nudgeEmail(step, who(ob), env);
    mails.push({ name: `${step}-${name}`, subject: m.subject, html: m.html });
  }
}
// a notice with rows, as the job emails use
const sample = renderEmail({ preheader: "Your 8 clips are ready.", heading: "Your 8 clips are ready", paragraphs: ["From \"Inside the Mind of a Master Procrastinator\". Each one is framed, captioned and ready to post."], rows: [{ label: "Clips made", value: "8 of 10 asked" }, { label: "Charged", value: "110 credits" }], button: { label: "Open your clips", url: "https://app.clone8.io/#studio/clips" }, signoff: "The Clone8 team", footer: ["You are getting this because a run you started finished."], unsubscribeUrl: "https://example.com/unsub" });
mails.push({ name: "notice-jobs-done", subject: "Your 8 clips are ready", html: sample.html });

for (const m of mails) writeFileSync(join(out, `${m.name}.html`), m.html);
const frame = (f: string, dark: boolean) => `<iframe src="${f}" style="width:420px;height:760px;border:1px solid #888;border-radius:10px;background:${dark ? "#000" : "#fff"};color-scheme:${dark ? "dark" : "light"}"></iframe>`;
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Clone8 emails</title><body style="font-family:system-ui;margin:20px;background:#ddd">${mails.map((m) => `<h3 style="margin:24px 0 8px">${m.name} · <span style="font-weight:400">${m.subject}</span></h3><div style="display:flex;gap:16px">${frame(`${m.name}.html`, false)}${frame(`${m.name}.html`, true)}</div>`).join("")}</body>`);
console.log(`${mails.length} emails written to ${out}`);
