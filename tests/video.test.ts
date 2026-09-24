import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {validatePlan,planIdentity} from "../src/video-plan.js";
import {command,renderVideo,inspectSource,qualityCheck} from "../src/video-render.js";
export const plan={version:1,angle:"Explain position sizing before placing a trade",title:"Risk comes first",
  caption:"Position sizing helps define risk before a trade. Losses remain possible.",
  audio:"source",segments:[
    {start:0,duration:4,text:"Decide your risk first"},
    {start:5,duration:4,text:"Then size the position"},
    {start:10,duration:4,text:"Losses remain possible"},
  ]};
test("plan validation rejects unsafe, unreadable, overlapping and out-of-bounds plans",()=>{
  assert.deepEqual(validatePlan(plan,20),plan);
  for(const x of [{...plan,url:"https://example.com"},{...plan,title:"a".repeat(90)},
    {...plan,audio:"remote"},{...plan,title:"Click https://evil.test"},
    {...plan,segments:[...plan.segments.slice(0,2),{start:6,duration:4,text:"Another idea"}]},
    {...plan,segments:[...plan.segments.slice(0,2),{start:19,duration:4,text:"Another idea"}]},
    {...plan,segments:plan.segments.map(s=>({...s,text:"$;\\\n unsafe"}))}])
    assert.throws(()=>validatePlan(x,20),/invalid_plan/);
  assert.equal(planIdentity(plan).hash,planIdentity({...plan}).hash);
  assert.ok(planIdentity(plan).tokens.length>=5);
});
test("real FFmpeg rendering produces a decodable portrait video; silence and corruption fail",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"managed-video-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,"source.mp4");
  await command("ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=size=320x240:rate=30",
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","16","-c:v","libx264","-threads","1","-preset","ultrafast","-c:a","aac","-y",input]);
  assert.ok((await inspectSource(input)).duration>=16);
  const output=await renderVideo(input,validatePlan(plan,16),dir);
  const qc=await qualityCheck(output,12,dir);
  assert.equal(qc.technical_pass,true);assert.equal(qc.fingerprints.length,8);assert.equal(qc.frames.length,4);
  const silent=join(dir,"silent.mp4");
  await command("ffmpeg",["-v","error","-i",output,"-af","volume=0","-c:v","copy","-c:a","aac","-y",silent]);
  await assert.rejects(qualityCheck(silent,12,dir),/quality_failed/);
  const black=join(dir,"black.mp4");
  await command("ffmpeg",["-v","error","-i",output,"-vf","drawbox=color=black:t=fill",
    "-c:v","libx264","-threads","1","-preset","ultrafast","-c:a","copy","-y",black]);
  await assert.rejects(qualityCheck(black,12,dir),/quality_failed/);
  await assert.rejects(qualityCheck(input,16,dir),/quality_failed/); // Wrong output geometry.
  const bad=join(dir,"corrupt.mp4");await writeFile(bad,"not a movie");
  await assert.rejects(inspectSource(bad));
});
