import test from "node:test";
import assert from "node:assert/strict";
import { parsePeople, targetsPrompt, detectPeople } from "../src/studio-people.js";
import { quote } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("the model's answer becomes a clean list: bad boxes dropped, labels trimmed, at most six", () => {
  const out = parsePeople('Sure. {"people":[{"label":"man in blue shirt, left","box":{"x":0.1,"y":0.2,"w":0.12,"h":0.18},"speaking":true},{"label":"x","box":{"x":2,"y":0,"w":0.1,"h":0.1}},{"label":"   woman   with glasses ","box":{"x":0.6,"y":0.2,"w":0.1,"h":0.15}}]}');
  assert.deepEqual(out.map((p) => p.label), ["man in blue shirt, left", "woman with glasses"]);
  assert.equal(out[0].speaking, true); assert.equal(out[1].speaking, false);
  assert.deepEqual(parsePeople("no json here"), []);
  assert.deepEqual(parsePeople('{"people":[]}'), []);
});

test("targets become plain words for the renderer; none leaves the prompt alone", () => {
  assert.equal(targetsPrompt("Replace the person.", null), "Replace the person.");
  assert.equal(targetsPrompt("Replace the person.", ["man in blue shirt, left"]), "Replace the person. Replace only this person: man in blue shirt, left. Leave every other person exactly as they are.");
  assert.match(targetsPrompt("R.", ["a", "b"]), /these people: a; b/);
  const q = quote("swap", { model: "light", character: "noah", targets: ["  man in blue  ", "", "woman"] }, { kind: "video", probe: { duration: 5 } });
  assert.deepEqual(q.options.targets, ["man in blue", "woman"]);
  assert.equal("targets" in quote("swap", { model: "light", character: "noah" }, { kind: "video", probe: { duration: 5 } }).options, false);
});

test("people are found once, cropped, stored on the asset and signed; a second call reads the cache", async () => {
  const asset: any = { id: VID, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${VID}.mp4`, probe: { duration: 12 } };
  const uploads: string[] = []; const updates: any[] = [];
  const sb: any = {
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "studio_assets" ? asset : null, error: null }) }) }) }), update: (v: any) => ({ eq: () => ({ eq: async () => { updates.push(v); Object.assign(asset, v); return { error: null }; } }) }) }),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer }, error: null }), upload: async (key: string) => { uploads.push(key); return { error: null }; }, createSignedUrls: async (keys: string[]) => ({ data: keys.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }) }) },
  };
  let claudeCalls = 0;
  const fetchFn: any = async (url: string, init: any) => { claudeCalls++; const body = JSON.parse(init.body); assert.equal(body.messages[0].content[0].type, "image"); return new Response(JSON.stringify({ content: [{ type: "text", text: '{"people":[{"label":"man in blue shirt, left","box":{"x":0.1,"y":0.2,"w":0.12,"h":0.18},"speaking":true},{"label":"woman with glasses, right","box":{"x":0.6,"y":0.2,"w":0.1,"h":0.15}}]}' }] })); };
  const deps = { fetch: fetchFn, env: { ANTHROPIC_API_KEY: "k" }, frame: async (_v: string, _at: number, target: string) => { const { writeFile } = await import("node:fs/promises"); await writeFile(target, Buffer.from([0xff, 0xd8])); }, crop: async (_i: string, _b: any, target: string) => { const { writeFile } = await import("node:fs/promises"); await writeFile(target, Buffer.from([0xff, 0xd8])); } };
  const people = await detectPeople(sb, deps as any, ANN, VID);
  assert.equal(people.length, 2); assert.equal(people[0].index, 1); assert.equal(people[1].label, "woman with glasses, right");
  assert.deepEqual(uploads, [`${ANN}/assets/${VID}/people/1.jpg`, `${ANN}/assets/${VID}/people/2.jpg`]);
  assert.match(people[0].url!, /^https:\/\/signed\//);
  assert.equal(updates.length, 1); assert.equal(asset.probe.people.length, 2); assert.ok(asset.probe.people_at);
  const again = await detectPeople(sb, deps as any, ANN, VID);
  assert.equal(claudeCalls, 1, "the second call reads the cache"); assert.equal(again.length, 2);
  await detectPeople(sb, deps as any, ANN, VID, { refresh: true });
  assert.equal(claudeCalls, 2, "refresh looks again");
});
