// Re-deliver specific Stripe events to our webhook, signed with our own webhook secret, after the endpoint
// was fixed. The handler is idempotent (studio_stripe_events), so a replay of an event Stripe later retries
// is a no-op. Usage: set -a; source ~/tradvio/.secrets/stripe.env; set +a; node ops/stripe/replay-events.mjs evt_1 evt_2
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, WEBHOOK_URL (default production). Prints status only, never secrets.
import Stripe from "stripe";
const key = process.env.STRIPE_SECRET_KEY, secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!key || !secret) { console.error("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required"); process.exit(2); }
const url = process.env.WEBHOOK_URL || "https://tradvio-reels-backend.onrender.com/api/studio/stripe/webhook";
const stripe = new Stripe(key);
const ids = process.argv.slice(2);
if (!ids.length) { console.error("pass event ids"); process.exit(2); }
for (const id of ids) {
  const event = await stripe.events.retrieve(id);
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature, "user-agent": "clone8-replay/1.0" }, body: payload });
  console.log(id, event.type, "→", res.status, await res.text());
}
