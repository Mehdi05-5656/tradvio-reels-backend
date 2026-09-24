import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,copyFile,readFile,stat,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generationDb,OP} from "./helpers/generation-db.js";
import {command} from "../src/video-render.js";
import {runGeneration} from "../src/managed-generation.js";
import {sha256} from "../src/video-plan.js";
test("assignment through real rendering and fenced private completion, with simulated model review",async t=>{
  const s=await generationDb(t),account=await s.account();
  const dir=await mkdtemp(join(tmpdir(),"managed-e2e-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"source.mp4");
  await command("ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=size=320x240:rate=30",
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","16","-c:v","libx264","-threads","1",
    "-preset","ultrafast","-c:a","aac","-y",source]);
  const asset=await s.rpc("managed_register_asset",{p_actor:OP,p_source:{bucket:"managed-raw",
    object_key:"approved/synthetic.mp4",sha256:sha256(await readFile(source)),bytes:(await stat(source)).size,
    duration:16,facts:"Synthetic diagnostic source. Teach position sizing and that losses remain possible.",
    audio_rights:true,editorial_approved:true,license_ref:"synthetic-test-only"}});
  await s.rpc("managed_grant_asset",{p_actor:OP,p_account:account,p_asset:asset,p_consent:"test-only",
    p_expires:new Date(Date.now()+86400000).toISOString(),p_enabled:true});
  await s.rpc("managed_generation_configure",{p_actor:OP,p_enabled:true,p_max_active:1,p_daily:2});
  let uploaded=false;
  const status=await runGeneration({db:s.adapter,enabled:()=>true,storage:{
    check:async()=>{},download:async(_job,path)=>{await copyFile(source,path);},
    upload:async(key,path)=>{assert.ok(key.endsWith("/output.mp4"));await copyFile(path,join(dir,"stored.mp4"));uploaded=true;}},
    models:{plan:async()=>({version:1,angle:"Explain position sizing before placing a trade",title:"Risk comes first",
      caption:"Position sizing helps define risk before a trade. Losses remain possible.",audio:"source",
      segments:[{start:0,duration:4,text:"Decide your risk first"},{start:5,duration:4,text:"Then size the position"},
        {start:10,duration:4,text:"Losses remain possible"}]}),
      review:async(_job,_plan,frames)=>{assert.equal(frames.length,4);return {approved:true,reasons:[]};}}},
    "local-integration");
  assert.equal(status,"quality_passed");assert.equal(uploaded,true);
  const j=(await s.db.query<any>("SELECT * FROM managed_generation_jobs")).rows[0];
  assert.equal(j.state,"quality_passed");assert.equal(j.result.sha256,sha256(await readFile(join(dir,"stored.mp4"))));
  assert.equal((await s.db.query<any>("SELECT publishing_enabled FROM managed_accounts")).rows[0].publishing_enabled,false);
  if(process.env.GENERATION_TEST_EVIDENCE_DIR) {
    const evidence=process.env.GENERATION_TEST_EVIDENCE_DIR;
    await mkdir(evidence,{recursive:true});
    await copyFile(join(dir,"stored.mp4"),join(evidence,"synthetic-diagnostic.mp4"));
    await command("ffmpeg",["-v","error","-ss","6","-i",join(dir,"stored.mp4"),"-frames:v","1","-y",join(evidence,"frame.jpg")]);
  }
});
