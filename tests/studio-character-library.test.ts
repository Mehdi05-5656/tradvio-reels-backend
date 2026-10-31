import test from "node:test";
import assert from "node:assert/strict";
import { characterName, rankCharacters } from "../src/studio-character-library.js";

test("character names: camera and download names say nothing and become Photo; real names and made characters stay", () => {
  for (const n of ["images-2.jpg", "images.jpg", "gettyimages-2250451393-612x612.jpg", "IMG_0412.JPG", "download (3).jpeg", "Screenshot 2026-10-31 at 13.22.10.png", "WhatsApp Image 2026-10-01 at 12.00.jpeg", "1234.png"]) assert.equal(characterName(n), "Photo", n);
  assert.equal(characterName("Character: a tabby cat in a watermelon helmet"), "a tabby cat in a watermelon helmet");
  assert.equal(characterName("Sarah headshot.png"), "Sarah headshot");
});

test("the same photo added several times shows once, with every copy's uses; the most used copy is the one kept", () => {
  const img = (id: string, name: string, bytes: number, created_at: string, probe: any = {}) => ({ id, name, bytes, created_at, probe });
  const images = [img("a1a1a1a1-0000-4000-8000-000000000001", "images-1.jpg", 24765, "2026-10-31T10:00:00Z"), img("a2a2a2a2-0000-4000-8000-000000000002", "images-1.jpg", 24765, "2026-10-31T11:00:00Z"), img("a3a3a3a3-0000-4000-8000-000000000003", "images.jpg", 24765, "2026-10-31T12:00:00Z"), img("b1b1b1b1-0000-4000-8000-000000000004", "images-2.jpg", 22996, "2026-10-31T09:00:00Z"), img("c1c1c1c1-0000-4000-8000-000000000005", "Character: cat", 400000, "2026-10-30T09:00:00Z", { character: true })];
  const jobs = [{ options: { character_asset_id: "a2a2a2a2-0000-4000-8000-000000000002" }, created_at: "2026-10-31T13:00:00Z" }, { options: { character_asset_id: "a2a2a2a2-0000-4000-8000-000000000002" }, created_at: "2026-10-31T13:05:00Z" }, { options: { character_asset_id: "a1a1a1a1-0000-4000-8000-000000000001" }, created_at: "2026-10-31T13:10:00Z" }, { options: { cast: [{ character_asset_id: "b1b1b1b1-0000-4000-8000-000000000004" }, { character_asset_id: "a3a3a3a3-0000-4000-8000-000000000003" }] }, created_at: "2026-10-31T13:20:00Z" }];
  const out = rankCharacters(images, jobs);
  assert.deepEqual(out.map((c) => [c.asset_id, c.uses, c.name]), [["a2a2a2a2-0000-4000-8000-000000000002", 4, "Photo"], ["b1b1b1b1-0000-4000-8000-000000000004", 1, "Photo"], ["c1c1c1c1-0000-4000-8000-000000000005", 0, "cat"]]);
  assert.equal(out[0].last_used_at, "2026-10-31T13:20:00Z");
});
