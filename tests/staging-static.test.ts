import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {stagingApp} from "../src/staging-app.js";
test("staging static login is public but cannot bypass API auth or mutation blocks",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"staging-static-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,"index.html"),"<!doctype html><h1>Synthetic staging</h1>");
  const app=stagingApp({db:{},auth:(_req,_res,next)=>next(),frontendDir:dir,
    config:{project_ref:"abcdefghijklmnopqrst",frontend_origin:"https://ui-staging.example.test",build_sha:"a".repeat(40)}});
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  for(const route of ["/","/login","/verify"]) {
    const r=await fetch(origin+route);assert.equal(r.status,200);
    assert.match(await r.text(),/Synthetic staging/);
    assert.equal(r.headers.get("cache-control"),"private, no-store");
  }
  assert.equal((await fetch(origin+"/api/me")).status,401);
  assert.equal((await fetch(origin+"/",{method:"POST"})).status,405);
  assert.equal((await fetch(origin+"/.env")).status,404);
  assert.equal((await fetch(origin+"/missing-secret.json")).status,404);
});
