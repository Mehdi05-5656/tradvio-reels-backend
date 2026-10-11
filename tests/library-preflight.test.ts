import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
test("private handoff entry point cannot publish and defaults to disabled",async()=>{
  const code=await readFile("src/library-preflight.ts","utf8");
  assert.ok(!/\bpublishNow\s*\(/.test(code));
  assert.ok(!/publisherTick\s*\(/.test(code));
  execFileSync("node_modules/.bin/esbuild",["src/library-preflight.ts","--bundle","--platform=node",
    "--format=cjs","--outfile=.test-build/private-preflight.cjs"],{stdio:"pipe"});
  assert.throws(()=>execFileSync(process.execPath,[".test-build/private-preflight.cjs"],
    {env:{...process.env,LIBRARY_PRIVATE_PREFLIGHT:"0",SUPABASE_URL:""},stdio:"pipe"}),
    (e:any)=>e.status===1&&String(e.stderr).includes("private_preflight_failed"));
});
