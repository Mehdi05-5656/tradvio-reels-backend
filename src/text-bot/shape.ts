// What a lookup hands to the AI. The routes answer for a web page: whole rows, every setting, every list in full. The
// AI needs a fraction of that, and every extra word is paid for on every step of the answer. Each helper's answer is
// cut down here to what a person would be told; anything else can be fetched on its own when it is needed.
const short = (v: unknown, n: number) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const day = (iso: unknown) => (typeof iso === "string" ? iso.slice(0, 16) : null);

/** Drops what says nothing (nulls, empty lists, empty objects), cuts long text, caps long lists. */
export function lean(v: any, depth = 0): any {
  if (v == null || depth > 7) return undefined;
  if (typeof v === "string") return v === "" ? undefined : v.length > 400 && !/^https?:\/\//.test(v) ? `${v.slice(0, 400)}…` : v;
  if (Array.isArray(v)) { const xs = v.slice(0, 25).map((x) => lean(x, depth + 1)).filter((x) => x !== undefined); if (!xs.length) return undefined; return v.length > 25 ? [...xs, `… ${v.length - 25} more`] : xs; }
  if (typeof v === "object") { const o: Record<string, any> = {}; for (const [k, x] of Object.entries(v)) { const y = lean(x, depth + 1); if (y !== undefined) o[k] = y; } return Object.keys(o).length ? o : undefined; }
  return v;
}

const who = (p: any): string => (Array.isArray(p?.options?.accounts) && p.options.accounts.length ? p.options.accounts.map((a: any) => `${a.platform}${a.username ? ` @${a.username}` : ""}`).join(", ") : (p?.platforms ?? []).join(", "));
const post = (p: any) => lean({ id: p.id, when: day(p.schedule_at) ?? "now", status: p.status, to: who(p), caption: short(p.caption, 140), video: p.asset_id ? `f:${p.asset_id}` : p.job_id ? `r:${p.job_id}` : undefined, auto_reply: p.options?.autoreply?.keywords ?? p.options?.autoreply?.keyword, error: p.error ? short(p.error, 120) : undefined,
  own_captions: (p.options?.accounts ?? []).some((a: any) => a?.own && a?.caption) || undefined, poster_url: p.poster_url,
  // where it went live, per network (a file removed after posting can still be shown through these)
  links: (Array.isArray(p.results) ? p.results : []).map((r: any) => r?.url).filter((u: unknown) => typeof u === "string" && /^https:\/\//.test(u)) });

export function shape(name: string, j: any, args: Record<string, any> = {}): any {
  if (!j || typeof j !== "object") return j;
  if (name === "posts") {
    const all: any[] = j.posts ?? [], waiting = all.filter((p) => ["scheduled", "queued", "sending"].includes(p.status)), rest = all.filter((p) => !waiting.includes(p));
    // a day or an account asked for: only those, so a long calendar is not read to answer about tomorrow
    const on = typeof args.day === "string" ? args.day.slice(0, 10) : null, acct = typeof args.account === "string" ? args.account.toLowerCase().replace(/^@/, "") : null;
    const keep = (p: any) => (!on || String(p.schedule_at ?? p.created_at ?? "").slice(0, 10) === on) && (!acct || who(p).toLowerCase().includes(acct));
    const w = waiting.filter(keep);
    return lean({ times_are: "UTC; convert to the person's time zone", waiting_total: waiting.length, waiting: w.slice(0, 40).map(post), ...(w.length > 40 ? { more_waiting: w.length - 40 } : {}), recent: rest.filter(keep).slice(0, args.recent === false ? 0 : 8).map(post) });
  }
  if (name === "socials") return lean({ linked: (j.accounts ?? []).map((a: any) => ({ id: a.id, network: a.platform, handle: a.username, needs_relink: a.refresh_required || undefined, followers: a.followers })), groups: (j.groups ?? []).map((g: any) => ({ name: g.name, account_ids: g.account_ids, missing: g.missing || undefined, times: g.defaults?.times, days: g.defaults?.days, time_zone: g.defaults?.timezone, per_day: g.defaults?.per_day })), posts_today: j.usage_today, per_account_daily: j.per_account_daily, allowance: j.allowance ? { accounts_in_plan: j.allowance.total } : undefined });
  if (name === "plans") return lean({ plans: (j.plans ?? []).map((p: any) => ({ id: p.id, name: p.name, monthly_usd: p.monthly_usd, annual_usd_per_month: p.annual_usd_per_month, credits: p.credits, runs_at_once: p.parallel, hd_clips: p.hd_clips || undefined, includes: (p.features ?? []).slice(0, 8).map((f: any) => short(f, 90)) })), open_features: Object.entries(j.tools ?? {}).filter(([, v]) => v === true).map(([k]) => k) });
  if (name === "instruments") {
    const list: any[] = j.instruments ?? j.models ?? (Array.isArray(j) ? j : []);
    // one model asked for: everything about it; otherwise the menu only
    const want = typeof args.id === "string" ? args.id.toLowerCase() : null;
    const one = want ? list.find((m) => String(m.id).toLowerCase() === want || String(m.title).toLowerCase() === want) : null;
    if (one) return lean({ model: { id: one.id, title: one.title, kind: one.kind, makes: one.output, media_fields: one.media_fields, required: one.required, settings: one.schema?.properties, price_hint: one.price ?? one.pricing } });
    return lean({ models: list.slice(0, 80).map((m) => ({ id: m.id, title: m.title, kind: m.kind, makes: m.output })), note: "For one model's settings and price hint, look it up again with args {id}." });
  }
  if (name === "collection") { const c = j.collection ?? {}; return lean({ id: c.id, name: c.name, kind: c.kind, status: c.status, note: c.note, files: (j.assets ?? []).slice(0, 30).map((a: any) => ({ ref: `f:${a.id}`, asset_id: a.id, title: short(a.probe?.title ?? a.name, 80), seconds: Math.round(Number(a.probe?.duration) || 0) || undefined, score: a.probe?.score ? Math.round(a.probe.score) : undefined, hook: a.probe?.hook ? short(a.probe.hook, 80) : undefined, poster_url: a.poster_url })), total: (j.assets ?? []).length }); }
  if (name === "job") { const x = j.job ?? {}; return lean({ id: x.id, tool: x.tool, status: x.status, step: x.progress?.step ?? x.progress?.stage ?? x.progress?.message, credits: x.credits_charged ?? x.credits_reserved, error: x.error_code, results: (x.outputs ?? []).slice(0, 12).map((o: any) => ({ output_key: o.key, title: o.title ? short(o.title, 80) : undefined, kind: o.kind, seconds: Math.round(Number(o.duration ?? o.seconds) || 0) || undefined, in_library_as: o.asset_id, url: o.url, poster_url: o.poster_url })) }); }
  if (name === "characters") return lean({ characters: (j.characters ?? []).slice(0, 20).map((c: any) => ({ asset_id: c.asset_id, name: short(c.name, 50), about: c.prompt ? short(c.prompt, 80) : undefined, used: c.uses, url: c.url })),
    // the presets anyone can use, passed as options.character by id
    presets: [{ id: "noah", about: "a man in his 30s, short dark hair" }, { id: "maya", about: "a woman in her 20s, long dark hair" }, { id: "elias", about: "a man in his 40s, grey beard" }, { id: "yuki", about: "a woman in her 20s, black bob" }, { id: "amara", about: "a woman in her 30s, braids" }, { id: "theo", about: "a man in his 20s, blond" }] });
  if (name === "styles") return lean({ styles: (j.styles ?? []).slice(0, 40).map((s: any) => ({ id: s.id, name: s.name, preview_url: s.preview_url })) });
  if (name === "trends") return lean({ trends: (j.trends ?? []).slice(0, 30).map((t: any) => ({ id: t.id, name: t.name, seconds: t.seconds, video: t.video ?? t.url, poster: t.poster })) });
  if (name === "voices") return lean({ voices: (j.voices ?? []).slice(0, 12).map((v: any) => ({ id: v.id, name: v.name, labels: v.labels, preview_url: v.preview_url })) });
  if (name === "splitscreen_loops") return lean({ price_credits: j.price?.credits, limits: j.limits, loops: (j.loops ?? []).map((l: any) => ({ id: l.id, kind: l.kind, name: l.name, poster: l.poster, video: l.video })) });
  if (name === "automations") return lean({ automations: (j.automations ?? []).slice(0, 30).map((a: any) => ({ id: a.id, name: a.name, runs: a.runs, inputs: (a.inputs ?? []).filter((i: any) => i.each_run).map((i: any) => ({ key: i.key, what: i.label, kind: i.kind })) })) });
  if (name === "autoreplies") {
    const acc = (id: unknown) => (j.accounts ?? []).find((a: any) => String(a.id) === String(id));
    return lean({ limit: j.limit, used: j.used, rules: (j.rules ?? []).slice(0, 30).map((r: any) => { const a = acc(r.account_id); return { id: r.id, account: a ? `${a.platform} @${a.username ?? "?"}` : r.platform, account_id: r.account_id, on: r.active, keywords: r.keywords,
      where: r.post ? `one post${r.post.title ? `: "${short(r.post.title, 50)}"` : ""}` : "every post", dm: r.dm_message ? short(r.dm_message, 100) : undefined, reply: r.comment_reply ? short(r.comment_reply, 80) : undefined }; }) });
  }
  if (name === "live_lookup") return lean({ platform: j.platform, channel: j.channel ? { name: j.channel.channel, login: j.channel.login, url: j.channel.url, live: j.channel.live, viewers: j.channel.viewers, title: j.channel.title ? short(j.channel.title, 100) : undefined, permission: j.channel.permission } : undefined, broadcasts: (j.broadcasts ?? []).slice(0, 8).map((b: any) => ({ url: b.url, title: short(b.title, 80), live: b.live || undefined, minutes: Math.round(Number(b.seconds) / 60) || undefined, started: day(b.started_at) })) });
  if (name === "live_now") return lean({ streams: (j.streams ?? []).slice(0, 15).map((s: any) => ({ channel: s.channel ?? s.login, platform: s.platform, url: s.url, viewers: s.viewers, title: short(s.title, 70), category: s.category })) });
  return lean(j);
}
