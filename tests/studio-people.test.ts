import test from "node:test";
import assert from "node:assert/strict";
import { parsePeople, targetsPrompt, detectPeople, stillTimes, cropRect, cachedPeople, PEOPLE_VERSION } from "../src/studio-people.js";
import { quote } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("the model's answer becomes a clean list: bad boxes dropped, labels tidy and distinct, stills checked, left to right", () => {
  const out = parsePeople('{"people":[{"label":"woman with glasses","still":2,"box":{"x":0.6,"y":0.2,"w":0.1,"h":0.15},"speaking":false},{"label":"x","still":1,"box":{"x":2,"y":0,"w":0.1,"h":0.1}},{"label":"   denim   jacket ","still":9,"box":{"x":0.1,"y":0.2,"w":0.12,"h":0.18},"speaking":true},{"label":"Denim jacket","still":1,"box":{"x":0.3,"y":0.2,"w":0.1,"h":0.1},"speaking":false}]}', 3);
  assert.deepEqual(out.map((p) => p.label), ["denim jacket", "Denim jacket (2)", "woman with glasses"], "left to right; a repeated description is told apart");
  assert.deepEqual(out.map((p) => p.frame), [1, 1, 2], "a still that does not exist falls back to the first");
  assert.equal(out[0].speaking, true);
  assert.deepEqual(parsePeople("no json here"), []);
  assert.deepEqual(parsePeople({ people: [] }), []);
});

test("stills come from the longest shots, or spread out when there are few cuts; faces are cut square inside the picture", () => {
  assert.deepEqual(stillTimes([], 17.4).map((t) => +t.toFixed(2)), [1.04, 3.83, 6.61, 8.7, 12.18, 14.96], "no cuts found: six moments, the opening included");
  const t = stillTimes([2, 2.3, 9, 15, 30], 40);
  assert.equal(t.length, 5, "every shot long enough (the 0.3 s flash is skipped)");
  assert.ok(t.includes(5.65) && t.includes(35), "the middle of each shot");
  assert.equal(stillTimes(Array.from({ length: 20 }, (_, k) => k * 3 + 3), 63).length, 6, "at most six");
  const r = cropRect({ x: 0.45, y: 0.3, w: 0.1, h: 0.08 }, 1920, 1080);
  assert.equal(r.side, Math.round(Math.max(0.1 * 1920, 0.08 * 1080) * 2.1));
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.side <= 1920 && r.y + r.side <= 1080);
  const edge = cropRect({ x: 0.97, y: 0.95, w: 0.03, h: 0.05 }, 576, 1024);
  assert.ok(edge.x + edge.side <= 576 && edge.y + edge.side <= 1024, "a face at the corner stays inside");
  assert.equal(cachedPeople({ people: [{ label: "a" }] }), null, "lists found the old way are found again");
  assert.equal(cachedPeople({ people: [], people_v: PEOPLE_VERSION })?.length, 0);
});

test("targets become plain words for the renderer; none leaves the prompt alone", () => {
  assert.equal(targetsPrompt("Replace the person.", null), "Replace the person.");
  assert.equal(targetsPrompt("Replace the person.", ["man in blue shirt, left"]), "Replace the person. Replace only this person: man in blue shirt, left. Leave every other person exactly as they are.");
  assert.match(targetsPrompt("R.", ["a", "b"]), /these people: a; b/);
  const q = quote("swap", { model: "light", character: "noah", targets: ["  man in blue  ", "", "woman"] }, { kind: "video", probe: { duration: 5 } });
  assert.deepEqual(q.options.targets, ["man in blue", "woman"]);
  assert.equal("targets" in quote("swap", { model: "light", character: "noah" }, { kind: "video", probe: { duration: 5 } }).options, false);
});

test("people are found once from several stills, cropped from the still where each is clearest, stored on the asset and signed; a second call reads the cache", async () => {
  const asset: any = { id: VID, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${VID}.mp4`, probe: { duration: 12, people: [{ label: "old way" }] } };
  const uploads: string[] = []; const updates: any[] = []; const crops: string[] = [];
  const sb: any = {
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "studio_assets" ? asset : null, error: null }) }) }) }), update: (v: any) => ({ eq: () => ({ eq: async () => { updates.push(v); Object.assign(asset, v); return { error: null }; } }) }) }),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer }, error: null }), upload: async (key: string) => { uploads.push(key); return { error: null }; }, createSignedUrls: async (keys: string[]) => ({ data: keys.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }) }) },
  };
  let claudeCalls = 0, images = 0;
  const fetchFn: any = async (_url: string, init: any) => {
    claudeCalls++; const body = JSON.parse(init.body);
    images = body.messages[0].content.filter((c: any) => c.type === "image").length;
    assert.equal(body.output_config.format.type, "json_schema");
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"people":[{"label":"red hoodie, glasses","still":3,"box":{"x":0.6,"y":0.2,"w":0.1,"h":0.15},"speaking":false},{"label":"denim jacket, dark hair","still":2,"box":{"x":0.1,"y":0.2,"w":0.12,"h":0.18},"speaking":true}]}' }] }));
  };
  const write = async (target: string) => { const { writeFile } = await import("node:fs/promises"); await writeFile(target, Buffer.from([0xff, 0xd8])); };
  const deps = { fetch: fetchFn, env: { ANTHROPIC_API_KEY: "k" }, cuts: async () => [4, 8], frame: async (_v: string, _at: number, target: string) => write(target), small: async (_i: string, target: string) => write(target), crop: async (image: string, _b: any, target: string) => { crops.push(image.split("/").pop()!); await write(target); } };
  const people = await detectPeople(sb, deps as any, ANN, VID);
  assert.equal(images, 4, "one still per shot, and an early one: three shots are few");
  assert.deepEqual(people.map((p) => p.label), ["denim jacket, dark hair", "red hoodie, glasses"], "left to right");
  assert.deepEqual(crops, ["s2.jpg", "s3.jpg"], "each face from its clearest still");
  assert.deepEqual([people[0].at, people[1].at], [6, 8.4]);
  assert.deepEqual(uploads, [`${ANN}/assets/${VID}/people/1.jpg`, `${ANN}/assets/${VID}/people/2.jpg`]);
  assert.match(people[0].url!, /^https:\/\/signed\//);
  assert.equal(updates.length, 1); assert.equal(asset.probe.people_v, PEOPLE_VERSION); assert.ok(asset.probe.people_at);
  const again = await detectPeople(sb, deps as any, ANN, VID);
  assert.equal(claudeCalls, 1, "the second call reads the cache"); assert.equal(again.length, 2);
  await detectPeople(sb, deps as any, ANN, VID, { refresh: true });
  assert.equal(claudeCalls, 2, "refresh looks again");
});
