import test from "node:test";
import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {runGeneration} from "../src/managed-generation.js";
import {createModels,parseModelJSON} from "../src/video-models.js";
import {sha256} from "../src/video-plan.js";
const plan={version:1,angle:"Explain position sizing before placing a trade",title:"Risk comes first",
 caption:"Position sizing helps define risk before a trade. Losses remain possible.",audio:"source",
 segments:[{start:0,duration:4,text:"Decide your risk first"},{start:5,duration:4,text:"Then size the position"},
 {start:10,duration:4,text:"Losses remain possible"}]};
function harness(options:any={}) {
  const events:string[]=[];let payload:any;
  const job={id:"job",account_id:"account",customer_user_id:"customer",lease_token:"token",
    recipe:options.recipe??null,asset:{sha256:sha256("source"),bytes:6,duration:16,facts:"Approved fact notes"},
    blueprint:{voice:"Educational"},attempts:1};
  const db:any={rpc:async(name:string,args:any)=>{
    events.push(name);if(name==="managed_generation_claim")return {data:job};
    if(name==="managed_generation_renew")return {data:options.renew!==false};
    if(name==="managed_generation_complete")payload=args.p_result;
    if(name==="managed_generation_fail")payload=args;
    return {data:true};
  }};
  const deps:any={db,enabled:()=>options.enabled!==false,
    storage:{check:async()=>events.push("storage-check"),download:async(_j:any,path:string)=>{events.push("download");await writeFile(path,options.badSource?"wrong!":"source");},
      upload:async()=>events.push("upload")},
    models:{plan:async()=>{events.push("plan");return plan;},review:async()=>{events.push("review");return {approved:options.review!==false,reasons:options.review===false?["unsupported_claim"]:[]};}},
    media:{inspect:async()=>({duration:16}),render:async(_s:any,_p:any,dir:string)=>{events.push("render");const p=dir+"/output.mp4";await writeFile(p,"output");return p;},
      quality:async()=>{events.push("quality");if(options.qcFail)throw new Error("quality_failed");
        return {technical_pass:true,duration:12,mean_db:-20,peak_db:-2,fingerprints:Array(8).fill("0".repeat(64)),frames:["frame"]};}}
  };
  return {deps,events,payload:()=>payload};
}
test("worker is inert when disabled; accepted media remains private and unscheduled",async()=>{
  const off=harness({enabled:false});assert.equal(await runGeneration(off.deps,"test"),"disabled");assert.deepEqual(off.events,[]);
  const s=harness();assert.equal(await runGeneration(s.deps,"test"),"quality_passed");
  assert.ok(s.events.indexOf("managed_generation_reserve")<s.events.indexOf("render"));
  assert.ok(s.events.indexOf("review")<s.events.indexOf("upload"));
  assert.equal(s.payload().object_key,"customer/account/job/token/output.mp4");
  assert.equal(s.payload().qc.content_pass,true);
  assert.ok(!s.events.some(e=>/publish|schedule/.test(e)));
});
test("hash mismatch, negative review and technical failure never upload",async()=>{
  for(const opts of [{badSource:true},{review:false},{qcFail:true}]) {
    const s=harness(opts);assert.equal(await runGeneration(s.deps,"test"),"blocked");
    assert.ok(!s.events.includes("upload"));assert.equal(s.payload().p_retry,false);
  }
});
test("lost lease blocks upload; persisted recipes avoid another planning request",async()=>{
  const lost=harness({renew:false});assert.equal(await runGeneration(lost.deps,"test"),"blocked");
  assert.ok(!lost.events.includes("upload"));
  const saved=harness({recipe:plan});assert.equal(await runGeneration(saved.deps,"test"),"quality_passed");
  assert.ok(!saved.events.includes("plan"));assert.ok(saved.events.includes("review"));
});
test("model parser fails closed for malformed, refusal, truncated and extra review fields",async()=>{
  assert.throws(()=>parseModelJSON({stop_reason:"max_tokens",content:[{type:"text",text:"{}"}]}),/model_failed/);
  assert.throws(()=>parseModelJSON({stop_reason:"end_turn",content:[{type:"text",text:"```json {} ```"}]}),/model_failed/);
  let calls=0;
  const models=createModels({key:"test-fixture",plannerModel:"fixture-planner",reviewModel:"fixture-review",
    fetch:async(_url:any,init:any)=>{
      calls++;const b=JSON.parse(init.body);assert.ok(b.system.includes("untrusted"));
      return new Response(JSON.stringify({stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify({approved:true,reasons:[],extra:true})}]}),
        {status:200,headers:{"content-type":"application/json"}});
    }});
  await assert.rejects(models.review({asset:{facts:"facts"},blueprint:{}},plan,["frame"],new AbortController().signal),/quality_failed/);
  assert.equal(calls,1);
});
