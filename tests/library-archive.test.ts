import test from "node:test";
import assert from "node:assert/strict";
import { parseLoudness, summarizeProbe, purgeTick } from "../src/library-archive.js";

test("parseLoudness reads ffmpeg's ebur128 summary", () => {
  const tail = "...\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.5 LUFS\n\n  Loudness range:\n    LRA:         6.1 LU\n    Threshold: -34.6 LUFS\n    LRA low:   -18.9 LUFS\n    LRA high:  -12.8 LUFS\n\n  True peak:\n    Peak:       -0.9 dBFS\n";
  assert.deepEqual(parseLoudness(tail), { integrated_lufs: -14.2, range_lu: 6.1, true_peak_dbfs: -0.9 });
  assert.deepEqual(parseLoudness("nothing"), { integrated_lufs: null, range_lu: null, true_peak_dbfs: null });
});

test("summarizeProbe keeps the cheap technical facts", () => {
  const p = summarizeProbe({ format: { duration: "23.27", bit_rate: "1560000", size: "4548162" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", pix_fmt: "yuv420p" }, { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, bit_rate: "128000" }] });
  assert.deepEqual(p, { duration: 23.27, bitrate: 1560000, size: 4548162, video_codec: "h264", width: 1080, height: 1920, fps: 30, pix_fmt: "yuv420p", audio_codec: "aac", sample_rate: 48000, channels: 2, audio_bitrate: 128000 });
});

test("purgeTick never deletes while disabled, and a dry run only counts candidates", async () => {
  const calls: string[] = [];
  const sb: any = {
    from(table: string) { const q: any = { select() { return q; }, async maybeSingle() { calls.push(`select ${table}`); return { data: { purge_enabled: false, purge_grace_days: 14 }, error: null }; } }; return q; },
    rpc: async (fn: string) => { calls.push(`rpc ${fn}`); return { data: [{ variant_id: "v1", object_key: "library/x.mp4" }], error: null }; },
    storage: { from() { return { remove: async () => { calls.push("remove"); return { error: null }; }, createSignedUrl: async () => { calls.push("sign"); return { data: null, error: null }; } }; } },
  };
  const off = await purgeTick(sb, { limit: 5, log: () => {} });
  assert.deepEqual({ enabled: off.enabled, purged: off.purged, reason: off.reason }, { enabled: false, purged: 0, reason: "purge_disabled" });
  assert.ok(!calls.includes("remove") && !calls.includes("rpc library_purge_candidates"));
  const dry = await purgeTick(sb, { limit: 5, dryRun: true, log: () => {} });
  assert.equal(dry.checked, 1); assert.equal(dry.purged, 0); assert.equal(dry.dry_run, true);
  assert.ok(!calls.includes("remove"), "a dry run removes nothing");
});
