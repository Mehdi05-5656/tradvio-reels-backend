import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {spawn} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("normal production entry starts dark without provider or database work",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tradvio-dark-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await build({entryPoints:["src/index.ts"],bundle:true,platform:"node",format:"cjs",
    outfile:join(dir,"index.cjs"),external:["pg-native","cardinal","@babel/preset-typescript"]});
  await writeFile(join(dir,"guard.cjs"),`
    globalThis.fetch=async()=>{console.error("UNEXPECTED_OUTBOUND_FETCH");throw new Error("network forbidden in dark boot");};
    const http=require("node:http");
    const original=http.Server.prototype.listen;
    http.Server.prototype.listen=function(...args){
      this.once("listening",()=>console.log("TEST_PORT="+this.address().port));
      return original.apply(this,args);
    };
  `);
  const child=spawn(process.execPath,["--require",join(dir,"guard.cjs"),join(dir,"index.cjs")],{
    // Deliberately no inherited environment credentials or feature flags.
    env:{PATH:process.env.PATH,PORT:"0",INGESTION_WORKER_DISABLED:"1",
      MANAGED_PROVISIONING_ENABLED:"0",MANAGED_GENERATION_ENABLED:"0",MANAGED_HANDOFF_ENABLED:"0"},
    stdio:["ignore","pipe","pipe"],
  });
  t.after(async()=>{
    if(child.exitCode===null){child.kill();await new Promise<void>(r=>child.once("exit",()=>r()));}
  });
  let output="";
  child.stdout.on("data",d=>{output+=String(d);});
  child.stderr.on("data",d=>{output+=String(d);});
  const deadline=Date.now()+10000;
  while(!/TEST_PORT=\d+/.test(output)&&child.exitCode===null&&Date.now()<deadline)
    await new Promise(r=>setTimeout(r,25));
  const port=output.match(/TEST_PORT=(\d+)/)?.[1];
  assert.ok(port,output);
  const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/healthz`)).status,200);
  assert.deepEqual(await (await fetch(base)).json(),{ok:true,service:"tradvio-reels-backend"});
  for(const path of ["/api/me","/api/managed/accounts","/api/v2/accounts"])
    assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(`${base}/api/admin/managed/assign`,{
    method:"POST",headers:{"content-type":"application/json"},body:"{}",
  })).status,401);
  assert.ok(!output.includes("UNEXPECTED_OUTBOUND_FETCH"),output);
});
