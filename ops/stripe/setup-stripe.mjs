#!/usr/bin/env node
// One-time Stripe setup for Clone8 Studio. Idempotent: products are found by metadata, prices by lookup key,
// the webhook endpoint by URL. Reads STRIPE_SECRET_KEY from the environment (never from a file in the repo)
// and prints only ids. The webhook signing secret is written to the path in STRIPE_SECRETS_OUT (outside the
// repo) and never printed.
//
//   set -a; source ~/tradvio/.secrets/stripe.env; set +a
//   node ops/stripe/setup-stripe.mjs            # test or live, depending on the key
import Stripe from "stripe";
import { appendFileSync } from "node:fs";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("STRIPE_SECRET_KEY is not set"); process.exit(1); }
const live = key.startsWith("sk_live_");
const stripe = new Stripe(key);
const WEBHOOK_URL = process.env.STUDIO_WEBHOOK_URL || "https://tradvio-reels-backend.onrender.com/api/studio/stripe/webhook";
const OUT = process.env.STRIPE_SECRETS_OUT || `${process.env.HOME}/tradvio/.secrets/stripe.env`;

// Keep in step with PLANS in src/studio.ts.
const PLANS = [
  { id: "starter", name: "Clone8 Studio · Starter", monthly: 2900, annual: 28800, credits: 1000 },
  { id: "creator", name: "Clone8 Studio · Creator", monthly: 7900, annual: 79200, credits: 3500 },
  { id: "studio", name: "Clone8 Studio · Studio", monthly: 19900, annual: 199200, credits: 10000 },
];

async function product(p) {
  const found = await stripe.products.search({ query: `metadata['clone8_plan']:'${p.id}' AND active:'true'` });
  if (found.data[0]) return found.data[0];
  return stripe.products.create({ name: p.name, metadata: { clone8_plan: p.id, credits: String(p.credits) }, description: `${p.credits.toLocaleString("en-US")} credits a month for Blueprint and Recast` });
}
async function price(prod, p, interval) {
  const lookup_key = `clone8_${p.id}_${interval}`;
  const found = await stripe.prices.list({ lookup_keys: [lookup_key], active: true, limit: 1 });
  if (found.data[0]) return found.data[0];
  return stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: interval === "month" ? p.monthly : p.annual, recurring: { interval }, lookup_key, metadata: { clone8_plan: p.id } });
}
// One-off credit packs (keep in step with PACKS in src/studio-pricing.ts): one product each, a one-time price.
const PACKS = [
  { id: "pack_500", name: "Clone8 Studio · 500 credits", credits: 500, usd: 1900 },
  { id: "pack_2000", name: "Clone8 Studio · 2,000 credits", credits: 2000, usd: 5900 },
  { id: "pack_6000", name: "Clone8 Studio · 6,000 credits", credits: 6000, usd: 14900 },
];
async function packProduct(p) {
  const found = await stripe.products.search({ query: `metadata['clone8_pack']:'${p.id}' AND active:'true'` });
  if (found.data[0]) return found.data[0];
  return stripe.products.create({ name: p.name, metadata: { clone8_pack: p.id, credits: String(p.credits) }, description: `${p.credits.toLocaleString("en-US")} credits added to your Clone8 Studio balance, on top of your plan` });
}
async function packPrice(prod, p) {
  const lookup_key = `clone8_${p.id}`;
  const found = await stripe.prices.list({ lookup_keys: [lookup_key], active: true, limit: 1 });
  if (found.data[0]) return found.data[0];
  return stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: p.usd, lookup_key, metadata: { clone8_pack: p.id } });
}

async function webhook() {
  const events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid"];
  const all = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = all.data.find((w) => w.url === WEBHOOK_URL);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: events });
    return { id: existing.id, secret: null };
  }
  const created = await stripe.webhookEndpoints.create({ url: WEBHOOK_URL, enabled_events: events, description: "Clone8 Studio" });
  return { id: created.id, secret: created.secret };
}

const env = [];
for (const p of PLANS) {
  const prod = await product(p);
  for (const interval of ["month", "year"]) {
    const pr = await price(prod, p, interval);
    env.push(`STRIPE_PRICE_${p.id.toUpperCase()}_${interval.toUpperCase()}=${pr.id}`);
  }
}
for (const p of PACKS) {
  const pr = await packPrice(await packProduct(p), p);
  env.push(`STRIPE_PRICE_${p.id.toUpperCase()}=${pr.id}`);
}
const wh = await webhook();
console.log(`Stripe ${live ? "LIVE" : "test"} mode`);
console.log(env.join("\n"));
console.log(`webhook ${wh.id} → ${WEBHOOK_URL}${wh.secret ? " (new; signing secret written to " + OUT + ")" : " (already existed; signing secret unchanged)"}`);
if (wh.secret) appendFileSync(OUT, `\n# ${new Date().toISOString()} ${live ? "live" : "test"} webhook ${wh.id}\nSTRIPE_WEBHOOK_SECRET=${wh.secret}\n`, { mode: 0o600 });
