import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_TRENDS, trendClipUrl, trendPosterUrl } from "../src/studio-trends.ts";

test("trend clips come from the demo store, never from the app (whose deploys dropped them); posters stay with the app", () => {
  assert.equal(trendClipUrl("https://app.clone8.io", "thumbs-up", {}), "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com/trends/thumbs-up.mp4");
  assert.equal(trendClipUrl("https://app.clone8.io", "thumbs-up", { STUDIO_TREND_BASE: "https://cdn.example/" }), "https://cdn.example/trends/thumbs-up.mp4");
  assert.equal(trendPosterUrl("https://app.clone8.io/", "thumbs-up"), "https://app.clone8.io/trends/thumbs-up.jpg");
});

test("every trend has a unique id, a length and a line", () => {
  const ids = STUDIO_TRENDS.map((t) => t.id); assert.equal(new Set(ids).size, ids.length);
  for (const t of STUDIO_TRENDS) { assert.ok(t.seconds > 0 && t.seconds <= 30, t.id); assert.ok(t.lede.length > 20, t.id); assert.match(t.id, /^[a-z0-9-]+$/); }
});
