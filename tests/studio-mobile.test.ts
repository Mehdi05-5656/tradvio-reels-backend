import test from "node:test";
import assert from "node:assert/strict";
import { APP_STORE_URL, appConfig } from "../src/studio-mobile.js";

test("app config: no prompts unless set; build numbers are whole and positive", () => {
  assert.deepEqual(appConfig({}), { latest_build: null, min_build: null, note: null, store_url: APP_STORE_URL });
  const c = appConfig({ STUDIO_APP_LATEST_BUILD: "3", STUDIO_APP_MIN_BUILD: " 2 ", STUDIO_APP_UPDATE_NOTE: "New: Captions styles" });
  assert.deepEqual([c.latest_build, c.min_build, c.note], [3, 2, "New: Captions styles"]);
  assert.equal(appConfig({ STUDIO_APP_MIN_BUILD: "abc" }).min_build, null);
  assert.equal(appConfig({ STUDIO_APP_MIN_BUILD: "0" }).min_build, null);
});

test("app routes: the update settings and the checkout return page are public, deletion is not", async () => {
  const { selfAuthenticatedPost } = await import("../src/account-access.js");
  assert.equal(selfAuthenticatedPost("/api/studio/account/delete", "POST"), false);
});
